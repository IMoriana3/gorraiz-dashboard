import test from 'node:test';
import assert from 'node:assert/strict';
import {spcBacklog,dailyCoverage} from '../scada-coverage.mjs';
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
