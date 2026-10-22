import test from 'node:test';
import assert from 'node:assert/strict';
import {SPC_MANUAL_MAX_DAYS,spcManualRange} from '../scada-spc-range.mjs';
test('rango SPC de un día permanece válido sin consumir Solarman',()=>{
 assert.deepEqual(spcManualRange('2026-10-21','2026-10-21','2026-10-22'),['2026-10-21']);
});
test('rango SPC con ambos extremos incluye 14 días cerrados consecutivos',()=>{
 const dates=spcManualRange('2026-10-08','2026-10-21','2026-10-22');
 assert.equal(SPC_MANUAL_MAX_DAYS,14);
 assert.equal(dates.length,14);
 assert.equal(dates[0],'2026-10-08');
 assert.equal(dates.at(-1),'2026-10-21');
});
test('rango SPC mayor de 14, invertido o con días abiertos se rechaza ANTES de red',()=>{
 assert.throws(()=>spcManualRange('2026-10-07','2026-10-21','2026-10-22'),/14 días/);
 assert.throws(()=>spcManualRange('2026-10-21','2026-10-20','2026-10-22'),/ordenadas/);
 assert.throws(()=>spcManualRange('2026-10-21','2026-10-22','2026-10-22'),/cerrados/);
 assert.throws(()=>spcManualRange('2026-10-22','2026-10-22','2026-10-22'),/cerrados/);
 assert.throws(()=>spcManualRange('2026-02-31','2026-02-31','2026-10-22'),/fechas válidas/);
});
test('rango SPC cuenta correctamente febrero bisiesto',()=>{
 assert.deepEqual(spcManualRange('2028-02-28','2028-03-01','2028-03-02'),
  ['2028-02-28','2028-02-29','2028-03-01']);
});
