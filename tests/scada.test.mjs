import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {availableDays,buildSeries,daysFor,gridIntervals,invStamp,spcStamp} from '../scada-data.mjs';

const day='2026-10-19';
const inv=(type,entries)=>({tipo:type,unidadPotencia:'kW',rows:entries.map(([time,pot,dia=50])=>
 ({ts:new Date(day+'T'+time+':00+02:00'),pot,dia}))});
const source=(date=day,rows=[
 {saveTime:date+' 10:00:00',positiveActiveElec:100,reverseActiveElec:10},
 {saveTime:date+' 10:05:00',positiveActiveElec:100.5,reverseActiveElec:10.1},
 {saveTime:date+' 10:10:00',positiveActiveElec:101,reverseActiveElec:10.2}
],daily={date,importKWh:1,exportKWh:.2,selfConsumptionKWh:7},meta={})=>
 ({tipo:'S',fecha:date,payload:{rows,daily:[daily],meta:{completo:true,medidoresEstacion:1,
     timezoneVerified:false,actualizado:'2026-10-20T10:00:00Z',...meta}}});

test('SPC conserva las marcas literales cuando el huso no está verificado',()=>{
 assert.deepEqual(spcStamp('2026-10-19 10:05:00'),{date:day,minute:605,second:0});
 assert.equal(spcStamp('2026-10-19 25:05:00'),null);
 assert.equal(spcStamp('bad'),null);
 assert.deepEqual(spcStamp('2026-10-19T08:05:00Z'),{date:day,minute:605,second:0});
});
test('Solarman usa marcas Date, no clasifica un fichero por nombre',()=>{
 assert.deepEqual(invStamp(new Date('2026-10-19T08:05:00Z')),{date:day,minute:605,second:0});
 assert.equal(invStamp('nada'),null);
 assert.deepEqual(availableDays([inv('A',[['10:05',23]]),source()]),[day]);
});
test('intervalos SPC kWh acumulados conciliados → media kW, no totalActivePower',()=>{
 const s=source();
 s.payload.rows.forEach(x=>x.totalActivePower=99999);
 const r=gridIntervals(s);
 assert.equal(r.ready,true);
 assert.equal(r.intervals.length,2);
 assert.equal(r.intervals[0].key,day+'T10:05');
 assert.ok(Math.abs(r.intervals[0].importKW-6)<1e-10);
 assert.ok(Math.abs(r.intervals[0].exportKW-1.2)<1e-10);
 assert.equal(r.intervals[0].clockVerified,false);
});
test('sin dos inversores simultáneos no se inventa generación total',()=>{
 const r=buildSeries([inv('A',[['10:05',15]]),source()],{date:day});
 const i=r.keys.indexOf(day+'T10:05');
 assert.equal(r.series.a[i],15);
 assert.equal(r.series.generation[i],null);
 assert.equal(r.series.consumption[i],null);
 assert.equal(r.last.generation,null);
});
test('relojes no validados: muestra importación/exportación, no inventa consumo',()=>{
 const r=buildSeries([inv('A',[['10:05',2.5]]),inv('B',[['10:05',4.5]]),source()],{date:day});
 const i=r.keys.indexOf(day+'T10:05');
 assert.equal(r.series.generation[i],7);
 assert.equal(r.series.import[i],6);
 assert.equal(r.series.export[i],1.1999999999999957);
 assert.equal(r.series.consumption[i],null);
 assert.equal(r.common,0);assert.equal(r.provisional,false);
});
test('el cruce provisional es opt-in y queda identificado; no afecta al informe',()=>{
 const items=[inv('A',[['10:05',2.5]]),inv('B',[['10:05',4.5]]),source()];
 const r=buildSeries(items,{date:day,allowProvisional:true});
 const i=r.keys.indexOf(day+'T10:05');
 assert.ok(Math.abs(r.series.consumption[i]-11.8)<1e-9);
 assert.equal(r.provisional,true);assert.equal(r.common,1);
 assert.ok(r.warnings.some(t=>t.includes('provisional')));
 const verified=source(day,undefined,undefined,{timezoneVerified:true});
 const v=buildSeries([items[0],items[1],verified],{date:day});
 assert.ok(Math.abs(v.series.consumption[i]-11.8)<1e-9);
 assert.equal(v.provisional,false);
});
test('sin día completo o con descuadre acumulados/resumen: sin línea de red',()=>{
 const incomplete=source(day,undefined,undefined,{completo:false});
 assert.equal(gridIntervals(incomplete).ready,false);
 const mismatch=source(day,undefined,{date:day,importKWh:30,exportKWh:.2});
 assert.equal(gridIntervals(mismatch).ready,false);
 const r=buildSeries([incomplete],{date:day});
 assert.equal(r.series.import.filter(v=>v!==null).length,0);
 assert.equal(r.summary.import,1);
});
test('saltos grandes, negativos o reset de contador NO interpolan ni generan picos',()=>{
 const r=source(day,[
  {saveTime:day+' 10:00',positiveActiveElec:100,reverseActiveElec:10},
  {saveTime:day+' 10:05',positiveActiveElec:100.5,reverseActiveElec:10},
  {saveTime:day+' 10:30',positiveActiveElec:100.8,reverseActiveElec:10},
  {saveTime:day+' 10:35',positiveActiveElec:101,reverseActiveElec:10}
 ],{date:day,importKWh:1,exportKWh:0});
 const g=gridIntervals(r);
 assert.equal(g.ready,true);
 assert.deepEqual(g.intervals.map(x=>x.key),[day+'T10:05',day+'T10:35']);
 const bad=source(day,[
  {saveTime:day+' 10:00',positiveActiveElec:100,reverseActiveElec:10},
  {saveTime:day+' 10:05',positiveActiveElec:90,reverseActiveElec:10}
 ],{date:day,importKWh:1,exportKWh:0});
 assert.equal(gridIntervals(bad).ready,false);
});
test('descarta valores no plausibles y consume únicamente medidas compatibles',()=>{
 const s=source();
 const result=buildSeries([inv('A',[['10:05',600]]),inv('B',[['10:05',20]]),s],{date:day,allowProvisional:true});
 const i=result.keys.indexOf(day+'T10:05');
 assert.equal(result.series.generation[i],null);
 assert.equal(result.series.consumption[i],null);
});
test('ventana de 7 días conserva huecos y evita rellenar curvas',()=>{
 const d=daysFor(day,7);
 assert.equal(d.length,7);assert.equal(d.at(-1),day);
 const r=buildSeries([source()],{date:day,range:7});
 assert.equal(r.keys.length,7*288);
 assert.equal(r.series.generation.filter(x=>x!==null).length,0);
 assert.equal(r.series.import.filter(x=>x!==null).length,2);
});
test('un refresco posterior de Solarman gana al histórico anterior por updatedAt',()=>{
 const newer=inv('A',[['10:05',19,40]]);
 newer.updatedAt='2026-10-22T12:00:00Z';
 const older=inv('A',[['10:05',27,55]]);
 older.updatedAt='2026-10-20T12:00:00Z';
 const result=buildSeries([newer,older,inv('B',[['10:05',5,30]])],{date:day});
 const i=result.keys.indexOf(day+'T10:05');
 assert.equal(result.series.generation[i],24);
 assert.equal(result.summary.generation,70);
});
test('código e interfaz siguen enlazados y no representan SPC en directo',()=>{
 const html=readFileSync(new URL('../scada.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../scada-app.mjs',import.meta.url),'utf8');
 assert.match(html,/scada-app\.mjs/);
 for(const id of ['mainChart','pvChart','consChart','gridChart','powerGen','powerCons',
   'powerImp','powerExp','flowLoad','day','provisional','updatePV']){
  assert.ok(html.includes('id="'+id+'"'),id);
 }
 assert.match(app,/\/produccion/);
 assert.doesNotMatch(app,/\/spc\/intercambio/);
 assert.doesNotMatch(app,/KSTAR_TEST_KEY/);
});

test('la estimación solo aparece si se solicita y las tres potencias se corresponden',()=>{
 const items=[inv('A',[['10:05',10]]),inv('B',[['10:05',15]]),source()];
 const off=buildSeries(items,{date:day,allowProvisional:false});
 const on=buildSeries(items,{date:day,allowProvisional:true});
 const i=on.keys.indexOf(day+'T10:05');
 assert.equal(off.series.consumption[i],null);
 assert.ok(on.series.consumption[i]>0);
 assert.equal(on.series.export[i]>0,true,'el dato origen SPC permanece positivo');
 assert.equal(on.provisional,true);
 assert.equal(on.common,1);
});
test('intervalo FV+SPC incompatible conserva fuentes pero excluye consumo negativo',()=>{
 const s=source(day,[
  {saveTime:day+' 10:00',positiveActiveElec:100,reverseActiveElec:10},
  {saveTime:day+' 10:05',positiveActiveElec:100,reverseActiveElec:10.5}
 ],{date:day,importKWh:0,exportKWh:0.5});
 const data=buildSeries([inv('A',[['10:05',1]]),inv('B',[['10:05',1]]),s],
  {date:day,allowProvisional:true});
 const i=data.keys.indexOf(day+'T10:05');
 assert.equal(data.series.generation[i],2);
 assert.ok(data.series.export[i]>0);
 assert.equal(data.series.consumption[i],null);
 assert.equal(data.negativePairs,1);
 assert.ok(data.warnings.some(x=>x.includes('balance negativo')));
});
test('resumen de día parcial SPC no se declara como consumo diario de cierre',()=>{
 const old=source(day,undefined,undefined,{completo:false});
 const r=buildSeries([inv('A',[['10:05',10,30]]),inv('B',[['10:05',20,40]]),old],
  {date:day,allowProvisional:true});
 assert.equal(r.summary.generation,70);
 assert.equal(r.summary.import,1);
 assert.equal(r.summary.export,.2);
 assert.equal(r.summary.consumption,null,'SPC no acredita día completo');
});
