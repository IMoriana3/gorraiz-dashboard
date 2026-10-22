import test from 'node:test';
import assert from 'node:assert/strict';
import {contrastDay,contrastCsv} from '../scada-contrast.mjs';

const DAY='2026-10-21';
const label=n=>DAY+'T'+String(Math.floor(n/12)).padStart(2,'0')+':'+
  String((n%12)*5).padStart(2,'0');
function day(){
 const keys=Array.from({length:288},(_,i)=>label(i));
 return {dates:[DAY],keys,
   series:{generation:Array(288).fill(null),
     import:Array(288).fill(null),export:Array(288).fill(null)},
   summary:{generation:413.3,import:409.91,export:143.71,spcAutoconsumption:268.29},
   gridState:{[DAY]:{meta:{completo:true,timezoneVerified:false}}}};
}
test('contraste: A+B PV y red positiva originan consumo diario y por tramo EXPLORATORIO',()=>{
 const d=day();
 d.series.generation[120]=45;d.series.import[120]=20;d.series.export[120]=0;
 d.series.generation[144]=70;d.series.import[144]=0;d.series.export[144]=20;
 const c=contrastDay(d);
 assert.equal(c.day,DAY);
 assert.equal(c.fields.solarmanPoints,2);
 assert.equal(c.fields.spcPoints,2);
 assert.equal(c.fields.simultaneous,2);
 assert.equal(c.fields.negativeLoad,0);
 assert.equal(c.readings.load[120],65);
 assert.equal(c.readings.load[144],50);
 assert.equal(c.readings.netGrid[144],-20);
 assert.ok(Math.abs(c.daily.inferredConsumption-679.5)<1e-9);
 assert.ok(Math.abs(c.daily.inferredSelfConsumed-269.59)<1e-9);
 assert.ok(Math.abs(c.daily.selfConsumptionDifference+1.3)<1e-9);
 assert.equal(c.fields.spcClockVerified,false,
   'una ecuación correcta no valida por sí sola las marcas horarias');
});
test('desfase positivo SPC: la muestra original 09:55 se representa a las 10:00',()=>{
 const d=day();
 d.series.generation[120]=40;
 d.series.import[119]=30;d.series.export[119]=0;
 const noShift=contrastDay(d,{offsetMinutes:0});
 assert.equal(noShift.fields.simultaneous,0);
 const shift=contrastDay(d,{offsetMinutes:5});
 assert.equal(shift.fields.simultaneous,1);
 assert.equal(shift.readings.import[120],30);
 assert.equal(shift.readings.import[119],null);
 assert.equal(shift.readings.load[120],70);
 assert.deepEqual(d.series.import.filter(v=>v!==null),[30],
   'no se modifica ni el array original ni el histórico almacenado');
});
test('desfase negativo no envuelve intervalos a la víspera ni da falsos pares',()=>{
 const d=day();
 d.series.generation[0]=20;d.series.import[0]=30;d.series.export[0]=0;
 const shifted=contrastDay(d,{offsetMinutes:-60});
 assert.equal(shifted.readings.import[0],null);
 assert.equal(shifted.fields.simultaneous,0);
});
test('demanda negativa por diferencia o reloj no se etiqueta como consumo medido',()=>{
 const d=day();
 d.series.generation[150]=10;d.series.import[150]=0;d.series.export[150]=35;
 const c=contrastDay(d);
 assert.equal(c.fields.negativeLoad,1);
 assert.equal(c.fields.minimumLoad,-25);
 assert.equal(c.fields.nonnegativeLoad,0);
 assert.equal(c.readings.load[150],null);
});
test('no crea balance diario si SPC es parcial o faltan energías de origen',()=>{
 const d=day();
 d.gridState[DAY].meta.completo=false;
 assert.equal(contrastDay(d).daily.inferredConsumption,null);
 d.gridState[DAY].meta.completo=true;
 d.summary.generation=null;
 assert.equal(contrastDay(d).daily.inferredSelfConsumed,null);
 assert.equal(contrastDay(d).daily.selfConsumptionDifference,null);
});
test('casillas ausentes no son cero y no se interpolan ni se extrapolan',()=>{
 const d=day();
 d.series.generation[140]=55;
 d.series.import[139]=7;
 d.series.export[139]=0;
 const c=contrastDay(d);
 assert.equal(c.fields.simultaneous,0);
 assert.equal(c.readings.load.filter(x=>x!==null).length,0);
 assert.equal(c.hourly[11].load,null);
 assert.equal(c.hourly[11].comparedCount,0);
});
test('CSV de 5 minutos preserva unidad, vacíos, desfase y advertencia de no validado',()=>{
 const d=day();
 d.series.generation[120]=35;
 d.series.import[119]=20;d.series.export[119]=0;
 const c=contrastDay(d,{offsetMinutes:5});
 const csv=contrastCsv(c,{showLoad:true});
 assert.ok(csv.startsWith('\ufeff'));
 assert.match(csv,/consumo_estimado_kW_no_validado/);
 assert.match(csv,/2026-10-21T10:00;35.000;20.000;0.000;55.000;5;NO/);
 assert.equal(csv.split('\r\n').length,290);
 const blank=contrastCsv(c,{showLoad:false});
 assert.match(blank,/2026-10-21T10:00;35.000;20.000;0.000;;5;NO/);
});
test('no inventar offsets subminutales, ni aceptar 7 días como jornada única',()=>{
 const d=day();
 assert.throws(()=>contrastDay(d,{offsetMinutes:7}),/desfase SPC/);
 assert.throws(()=>contrastDay(d,{offsetMinutes:185}),/desfase SPC/);
 assert.throws(()=>contrastDay({...d,dates:['2026-10-20',DAY]}),/único día/);
});

test('CSV de comparación usa exportación negativa sin cambiar los cálculos de energía',()=>{
 const d=day();
 d.series.generation[130]=60;
 d.series.import[130]=0;
 d.series.export[130]=12.75;
 const result=contrastDay(d);
 assert.equal(result.readings.export[130],12.75,
   'el contador SPC almacena exportación como magnitud positiva');
 assert.equal(result.readings.netGrid[130],-12.75);
 assert.equal(result.readings.load[130],47.25);
 const csv=contrastCsv(result,{showLoad:true});
 assert.match(csv,/exportacion_SPC_kW_signo_negativo/);
 assert.match(csv,/2026-10-21T10:50;60.000;0.000;-12.750;47.250;0;NO/);
});
