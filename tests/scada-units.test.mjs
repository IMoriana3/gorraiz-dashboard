import test from 'node:test';
import assert from 'node:assert/strict';
import {sourcePowerUnit,normalizeSourcePower} from '../scada-units.mjs';
import {buildSeries} from '../scada-data.mjs';

test('fuentes antiguas Solarman APo_t1 se interpretan como W, no kW',()=>{
 const old={tipo:'A',nombre:'Solarman 19/10/2026 → 20/10/2026'};
 assert.equal(sourcePowerUnit(old),'W');
 assert.deepEqual(normalizeSourcePower(old,35000),{pot:35,potSinValidar:null});
 assert.deepEqual(normalizeSourcePower(old,65),{pot:0.065,potSinValidar:null});
 const scadaOld={nombre:'SCADA Solarman 2026-10-19'};
 assert.equal(normalizeSourcePower(scadaOld,52000).pot,52);
});
test('la unidad kW explícita predomina sobre el nombre antiguo',()=>{
 const fixed={nombre:'Solarman 2026-10-19',unidadPotencia:'kW'};
 assert.equal(sourcePowerUnit(fixed),'kW');
 assert.equal(normalizeSourcePower(fixed,31.5).pot,31.5);
 assert.equal(normalizeSourcePower({nombre:'Ficheros',unidadPotencia:'kW'},31.5).pot,31.5);
});
test('datos de XLSX antiguo sin unidad conservan bruto pero no inventan kW',()=>{
 const old={nombre:'Ficheros'};
 assert.equal(sourcePowerUnit(old),'desconocida');
 assert.deepEqual(normalizeSourcePower(old,35000),{pot:null,potSinValidar:35000});
 assert.deepEqual(normalizeSourcePower(old,31.5),{pot:null,potSinValidar:31.5});
});
test('picos físicamente imposibles quedan separados de la potencia mostrada',()=>{
 assert.deepEqual(normalizeSourcePower({unidadPotencia:'W'},95000),
   {pot:null,potSinValidar:95000});
 assert.deepEqual(normalizeSourcePower({unidadPotencia:'kW'},900),
   {pot:null,potSinValidar:900});
});
test('SCADA traza 35 kW de un registro antiguo 35000 W, sin consumir API',()=>{
 const d='2026-10-19',make=(tipo,pot,nombre)=>({tipo,nombre,rows:[
  {ts:new Date(d+'T10:05:00+02:00'),pot,dia:50,acum:1200}
 ]});
 const items=[make('A',35000,'Solarman import antiguo'),
   make('B',12000,'Solarman import antiguo')];
 const r=buildSeries(items,{date:d});
 const i=r.keys.indexOf(d+'T10:05');
 assert.equal(r.series.a[i],35);
 assert.equal(r.series.b[i],12);
 assert.equal(r.series.generation[i],47);
});
