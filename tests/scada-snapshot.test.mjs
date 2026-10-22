import test from 'node:test';
import assert from 'node:assert/strict';
import {coherentPowerSnapshot,independentLatestTimes} from '../scada-snapshot.mjs';

function result({keys=['2026-10-21T19:25','2026-10-21T23:55'],
 generation=[0,null],importKW=[35.9,11.8],exportKW=[0,0],
 verified=false}={}){
 const last=v=>{
  for(let i=v.length-1;i>=0;i--)if(v[i]!==null)return {value:v[i],key:keys[i]};
  return null;
 };
 return {keys,series:{generation,import:importKW,export:exportKW},
  last:{generation:last(generation),import:last(importKW),export:last(exportKW)},
  gridState:{'2026-10-21':{ready:true,meta:{timezoneVerified:verified}}}};
}
test('reproduce Gorraiz: FV 0 y consumo 35,9 a las 19:25; SPC 11,8 a las 23:55 no se mezcla',()=>{
 const data=result();
 const snap=coherentPowerSnapshot(data);
 assert.equal(snap.key,'2026-10-21T19:25');
 assert.equal(snap.generation,0);
 assert.equal(snap.importKW,35.9,'no elegir el SPC más reciente de 23:55');
 assert.equal(snap.exportKW,0);
 assert.equal(snap.signedExportKW,0);
 assert.equal(snap.consumptionKW,35.9);
 assert.equal(snap.gridClockVerified,false);
 const latest=independentLatestTimes(data);
 assert.equal(latest.solar,'2026-10-21T19:25');
 assert.equal(latest.grid,'2026-10-21T23:55');
});
test('si no hay casilla común, tarjetas de potencia se mantienen sin valor',()=>{
 const data=result({generation:[20,null],importKW:[null,12],exportKW:[null,0]});
 assert.equal(coherentPowerSnapshot(data),null);
 assert.ok(independentLatestTimes(data).grid.endsWith('23:55'));
});
test('un cero FV real es válido; null de FV o SPC no se interpreta como 0',()=>{
 const data=result({generation:[0,null],importKW:[13,11],exportKW:[0,0]});
 const snap=coherentPowerSnapshot(data);
 assert.equal(snap.consumptionKW,13);
 assert.equal(snap.time,'19:25');
});
test('el último balance negativo se excluye y se mantiene el anterior físicamente admisible',()=>{
 const keys=['2026-10-21T12:05','2026-10-21T12:10'];
 const data=result({keys,generation:[30,5],importKW:[10,0],
   exportKW:[0,17]});
 const snap=coherentPowerSnapshot(data);
 assert.equal(snap.key,keys[0]);
 assert.equal(snap.consumptionKW,40);
});
test('no hay punto elegible si solo existen balances negativos',()=>{
 assert.equal(coherentPowerSnapshot(result({
  generation:[5,null],importKW:[0,12],exportKW:[20,0]})),null);
});
test('flujos del mismo instante: exportación con signo negativo sin modificar el dato origen',()=>{
 const data=result({generation:[50,null],importKW:[0,13],exportKW:[18,0]});
 const snap=coherentPowerSnapshot(data);
 assert.equal(snap.generation,50);
 assert.equal(snap.importKW,0);
 assert.equal(snap.exportKW,18,'datos fuente siempre positivos');
 assert.equal(snap.signedExportKW,-18,'SCADA representa flujo saliente');
 assert.equal(snap.consumptionKW,32,'50+0−18 = 32 kW');
 assert.equal(data.series.export[0],18,'nunca modificar acumulados');
});
test('el metadato de reloj se conserva sin declarar sincronismo físico por el selector',()=>{
 const snap=coherentPowerSnapshot(result({verified:true}));
 assert.equal(snap.gridClockVerified,true);
});
test('última casilla elegida dentro de una semana siempre queda identificada por fecha',()=>{
 const d=result({
  keys:['2026-10-20T19:00','2026-10-21T19:25','2026-10-21T23:55'],
  generation:[20,0,null],importKW:[13,35.9,11.8],exportKW:[0,0,0]});
 const snap=coherentPowerSnapshot(d);
 assert.equal(snap.date,'2026-10-21');
 assert.equal(snap.time,'19:25');
});
