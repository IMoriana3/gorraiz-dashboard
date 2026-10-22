import test from 'node:test';
import assert from 'node:assert/strict';
import {spcBacklog,dailyCoverage,dailyPvInventory,pvDayDiagnosis,solarGapAudit,solarGapCsv} from '../scada-coverage.mjs';
import {buildSeries} from '../scada-data.mjs';
const day='2026-10-20';
const spc=(date,complete=true)=>({tipo:'S',fecha:date,payload:{meta:{completo:complete},rows:[]}});
test('SPC 19 y 20 de octubre: el día 21 cerrado queda pendiente al 22',()=>{
 const out=spcBacklog([spc('2026-10-19'),spc('2026-10-20')],'2026-10-22');
 assert.deepEqual({last:out.lastComplete,yesterday:out.lastClosed,
  next:out.firstPending,count:out.pendingCount},
 {last:'2026-10-20',yesterday:'2026-10-21',
  next:'2026-10-21',count:1});
});
test('SPC descarga del último día cerrado: sin pendientes ni duplicados',()=>{
 const out=spcBacklog([spc('2026-10-19'),spc('2026-10-20'),spc('2026-10-21')],'2026-10-22');
 assert.equal(out.pendingCount,0);
 assert.equal(out.firstPending,null);
});
test('si SPC tiene varios días atrasados propone el primero sin descargar',()=>{
 const out=spcBacklog([spc('2026-10-17'),spc('2026-10-19'),spc('2026-10-20',false)],'2026-10-22');
 assert.equal(out.lastComplete,'2026-10-19');
 assert.equal(out.firstPending,'2026-10-20');
 assert.equal(out.pendingCount,2);
});
test('día actual no es día SPC cerrado y jamás se propone automáticamente',()=>{
 const out=spcBacklog([spc('2026-10-21')],'2026-10-22');
 assert.equal(out.pendingCount,0);
 assert.equal(out.lastClosed,'2026-10-21');
});
test('sin SPC no inventa fecha de partida para descargar',()=>{
 const out=spcBacklog([],'2026-10-22');
 assert.equal(out.lastComplete,null);
 assert.equal(out.firstPending,null);
 assert.equal(out.pendingCount,0);
});
test('huecos interiores de FV no incluyen la noche y SPC ausente se distingue',()=>{
 const A={tipo:'A',unidadPotencia:'kW',rows:[
   {ts:new Date(day+'T08:00:00Z'),pot:20,dia:50,acum:10},
   {ts:new Date(day+'T08:10:00Z'),pot:22,dia:55,acum:15}]};
 const B={tipo:'B',unidadPotencia:'kW',rows:[
   {ts:new Date(day+'T08:00:00Z'),pot:10,dia:22,acum:100},
   {ts:new Date(day+'T08:10:00Z'),pot:11,dia:24,acum:102}]};
 const result=buildSeries([A,B],{date:day});
 const coverage=dailyCoverage(result,[A,B]);
 assert.equal(coverage.length,1);
 assert.equal(coverage[0].a,2);
 assert.equal(coverage[0].b,2);
 assert.equal(coverage[0].paired,2);
 assert.equal(coverage[0].gapsInside,1,'un intervalo de 5 min intermedio ausente');
 assert.equal(coverage[0].spc,0);
 assert.equal(coverage[0].status,'sin-descarga');
});

test('21/10 con SPC y sin filas originales FV: no afirmar potencia no validada',()=>{
 const date='2026-10-21';
 const spcOnly={tipo:'S',fecha:date,payload:{meta:{completo:true},rows:[]}};
 const data=[spcOnly],result=buildSeries(data,{date});
 const diagnostics=pvDayDiagnosis(data,result,date);
 assert.equal(diagnostics.kind,'not-downloaded');
 assert.equal(diagnostics.inventory.A.raw,0);
 assert.equal(diagnostics.inventory.B.raw,0);
 assert.match(diagnostics.message,/No constan filas originales FV/);
});
test('21/10 con potencia en cuarentena: distinguir de ausencia de descarga',()=>{
 const date='2026-10-21';
 const mk=(tipo,power)=>({tipo,unidadPotencia:'kW',origen:'datos-compartidos',
   rows:[{ts:date+'T12:00:00+02:00',pot:null,potSinValidar:power,dia:160,acum:2300},
         {ts:date+'T12:05:00+02:00',pot:null,potSinValidar:power+1000,dia:162,acum:2302}]});
 const data=[mk('A',32000),mk('B',27000)];
 const r=buildSeries(data,{date}),stats=dailyPvInventory(data,date);
 const diag=pvDayDiagnosis(data,r,date);
 assert.equal(stats.A.raw,2);
 assert.equal(stats.B.raw,2);
 assert.equal(stats.A.unverified,2);
 assert.equal(stats.B.unverified,2);
 assert.equal(diag.plotted.A,0);
 assert.equal(diag.plotted.B,0);
 assert.equal(diag.kind,'unverified');
 assert.match(diag.message,/potencias están pendientes de validar/);
});
test('día parcialmente descargado y día completamente válido',()=>{
 const date='2026-10-21';
 const mk=(tipo,pot)=>({tipo,unidadPotencia:'kW',nombre:'QA',
   rows:[{ts:date+'T11:00:00+02:00',pot,dia:99,acum:500}]});
 const A=mk('A',30),B=mk('B',25);
 const first=pvDayDiagnosis([A],buildSeries([A],{date}),date);
 assert.equal(first.kind,'partial-source');
 assert.match(first.message,/Falta el otro inversor/);
 const all=pvDayDiagnosis([A,B],buildSeries([A,B],{date}),date);
 assert.equal(all.kind,'complete');
 assert.equal(all.message,'');
 assert.equal(all.plotted.joint,1);
});
test('una copia duplicada no duplica el recuento de filas originales',()=>{
 const date='2026-10-21';
 const A={tipo:'A',nombre:'Ficheros',rows:[{ts:date+'T11:00:00+02:00',pot:31000,dia:80}]};
 const other={tipo:'A',nombre:'Histórico central Gorraiz',
   unidadPotencia:'kW',rows:[{ts:date+'T11:00:00+02:00',pot:31,dia:80}]};
 const stats=dailyPvInventory([A,other],date);
 assert.equal(stats.A.raw,1);
 assert.equal(stats.A.validPower,1);
 assert.equal(stats.A.unverified,0,'una potencia validada en otra fuente resuelve ese instante');
});

const makePV=(date,type,readings)=>({
 tipo:type,nombre:'Test INV '+type,unidadPotencia:'kW',
 rows:readings.map(({minute,pot,raw})=>{
   const hour=String(Math.floor(minute/60)).padStart(2,'0');
   const mm=String(minute%60).padStart(2,'0');
   return {ts:date+'T'+hour+':'+mm+':00+02:00',
     pot:pot===undefined?null:pot,
     ...(raw===undefined?{}:{potSinValidar:raw}),
     dia:8,acum:2010};
 })
});
test('diagnóstico del día: huecos por falta del inversor B sin contar las horas nocturnas',()=>{
 const d='2026-10-21';
 const a=makePV(d,'A',[{minute:600,pot:20},{minute:605,pot:21},
  {minute:610,pot:22},{minute:615,pot:21},{minute:620,pot:26},{minute:625,pot:23}]);
 const b=makePV(d,'B',[{minute:600,pot:18},{minute:610,pot:19},
  {minute:620,pot:20},{minute:625,pot:21}]);
 const report=solarGapAudit([a,b],d);
 assert.equal(report.first,'10:00');
 assert.equal(report.last,'10:25');
 assert.equal(report.joint,4);
 assert.equal(report.issues.length,2);
 assert.equal(report.totals.onlyA,2);
 assert.equal(report.totals.onlyB,0);
 assert.equal(report.totals.bothMissing,0);
 assert.equal(report.totals.possibleOffset,2);
 assert.deepEqual(report.issues.map(x=>x.time),['10:05','10:15']);
 assert.ok(report.issues.every(x=>x.reason==='sin-B'));
});
test('diagnóstico distingue ambos ausentes de muestras descartadas por potencia',()=>{
 const d='2026-10-21';
 const a=makePV(d,'A',[{minute:600,pot:20},{minute:605,pot:22},
  {minute:615,pot:20}]);
 const b=makePV(d,'B',[{minute:600,pot:20},
  {minute:605,pot:null,raw:38000},
  {minute:615,pot:21}]);
 const r=solarGapAudit([a,b],d);
 assert.equal(r.joint,2);
 assert.equal(r.issues.length,2);
 assert.equal(r.issues[0].reason,'B-invalidado');
 assert.equal(r.issues[0].b,'Potencia pendiente');
 assert.equal(r.issues[1].reason,'sin-A-ni-B');
 assert.equal(r.totals.invalid,1);
 assert.equal(r.totals.bothMissing,1);
});
test('marcas cercanas a límite de casilla pueden desalinear muestras A/B',()=>{
 const d='2026-10-21';
 const a={tipo:'A',unidadPotencia:'kW',rows:[
  {ts:d+'T11:00:00+02:00',pot:20},
  {ts:d+'T11:12:29+02:00',pot:27},
  {ts:d+'T11:25:00+02:00',pot:24}]};
 const b={tipo:'B',unidadPotencia:'kW',rows:[
  {ts:d+'T11:00:00+02:00',pot:18},
  {ts:d+'T11:12:31+02:00',pot:25},
  {ts:d+'T11:25:00+02:00',pot:23}]};
 const report=solarGapAudit([a,b],d);
 assert.equal(report.joint,2);
 assert.equal(report.totals.onlyA,1);
 assert.equal(report.totals.onlyB,1);
 assert.equal(report.totals.possibleOffset,2);
 assert.match(report.interpretation,/no prueba/);
});
test('CSV de huecos solo contiene fecha hora motivo y diagnóstico no validador',()=>{
 const d='2026-10-21';
 const a=makePV(d,'A',[{minute:600,pot:21},{minute:605,pot:24},{minute:610,pot:25}]);
 const b=makePV(d,'B',[{minute:600,pot:12},{minute:610,pot:13}]);
 const report=solarGapAudit([a,b],d);
 const csv=solarGapCsv(report);
 assert.match(csv,/2026-10-21;10:05;B sin fila; A con potencia válida/);
 assert.equal(report.issues.length,1);
 assert.equal(csv.trim().split('\r\n').length,2);
});
