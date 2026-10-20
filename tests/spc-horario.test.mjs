import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analizarDia,agruparDias} from '../spc-horario.js';

const day='2026-10-19';
function fiveMinDay(date,startPos=146977.375,startRev=2140.5901){
  const out=[];
  for(let i=0;i<288;i++){
    const moment=new Date(Date.parse(date+'T00:02:00Z')+i*5*60000);
    const literal=moment.toISOString().replace('T',' ').slice(0,19);
    out.push({saveTime:literal,positiveActiveElec:startPos+i*0.04,
      reverseActiveElec:startRev+i*0.01});
  }
  return out;
}
const measured=(date,rows)=>({date,importKWh:rows.at(-1).positiveActiveElec-rows[0].positiveActiveElec,
  exportKWh:rows.at(-1).reverseActiveElec-rows[0].reverseActiveElec});
const near=(a,b,tol=1e-5)=>assert.ok(Math.abs(a-b)<=tol,a+' no coincide con '+b);

test('P1-P6: calcula deltas de acumulados y reparte por horario, sin €',()=>{
  const rows=fiveMinDay(day),info=analizarDia([...rows].reverse(),measured(day,rows));
  assert.equal(info.calidad,'compatible');
  assert.equal(info.registros,288);
  assert.equal(info.huecos,0);
  assert.equal(info.intervalos,287);
  assert.ok(info.minutosCubiertos>1400);
  near(Object.values(info.periodos).reduce((s,p)=>s+p.importKWh,0),info.totalImportCalculado);
  near(Object.values(info.periodos).reduce((s,p)=>s+p.exportKWh,0),info.totalExportCalculado);
  assert.ok(info.periodos.P4.importKWh>0);
  assert.ok(info.periodos.P5.importKWh>0);
  assert.ok(info.periodos.P6.importKWh>0);
  assert.equal(info.periodos.P1.importKWh,0);
  assert.equal(info.precioEUR,undefined);
});
test('domingos: toda la energia por P6',()=>{
  const date='2026-10-18',rows=fiveMinDay(date);
  const info=analizarDia(rows,measured(date,rows));
  assert.equal(info.calidad,'compatible');
  assert.ok(info.periodos.P6.importKWh>0);
  for(const p of ['P1','P2','P3','P4','P5'])assert.equal(info.periodos[p].importKWh,0);
});
test('falta de registros o reversa incorrecta no se da por completa',()=>{
  const rows=fiveMinDay(day);
  const gaps=rows.filter((_,i)=>i<80||i>120);
  const gap=analizarDia(gaps,measured(day,rows));
  assert.equal(gap.calidad,'provisional-incompleto');
  assert.ok(gap.huecos>0);
  const bad=analizarDia(rows,{date:day,importKWh:999,exportKWh:0});
  assert.equal(bad.calidad,'provisional-incompleto');
  assert.ok(bad.diferenciaImportKWh!==999);
  const reset=rows.map(x=>({...x}));reset[120].positiveActiveElec=0;
  assert.equal(analizarDia(reset,measured(day,rows)).calidad,'provisional-incompleto');
});
test('los 287 puntos KSTAR solo se consideraran compatibles si estan bien repartidos',()=>{
  const rows=fiveMinDay(day).filter((_,i)=>i!==50);
  const info=analizarDia(rows,measured(day,rows));
  assert.equal(info.registros,287);
  assert.equal(info.calidad,'provisional-incompleto');
  assert.ok(info.huecos>=1);
});
test('cambio de hora, timestamp con TZ desconocido o lecturas parciales no se facturan',()=>{
  const r=fiveMinDay('2026-10-25');
  assert.equal(analizarDia(r,measured('2026-10-25',r)).calidad,'cambio-horario');
  const offset=fiveMinDay(day).map(x=>({...x,saveTime:x.saveTime+'+02:00'}));
  assert.equal(analizarDia(offset,measured(day,offset)).calidad,'sin-intervalos');
  const source=[{date:day,rows:fiveMinDay(day),daily:[measured(day,fiveMinDay(day))],meta:{completo:true}},
    {date:'2026-10-20',rows:[],daily:[],meta:{completo:false}}];
  const agg=agruparDias(source,'2026-10-19','2026-10-20');
  assert.equal(agg.diasCompatibles,1);
  assert.equal(agg.rechazados.length,1);
  assert.equal(agg.estimado,true);
});
