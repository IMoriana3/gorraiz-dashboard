import test from 'node:test';
import assert from 'node:assert/strict';
import {signedExportKW,signedExportSeries} from '../scada-grid-sign.mjs';

test('el sentido de potencia de red es importación positiva / exportación negativa',()=>{
 assert.equal(signedExportKW(18.42),-18.42);
 assert.equal(signedExportKW(0),0);
 assert.equal(signedExportKW(null),null);
 assert.equal(signedExportKW(undefined),null);
 assert.equal(signedExportKW(NaN),null);
 assert.equal(signedExportKW(Infinity),null);
});
test('la gráfica invierte solo la exportación, nunca los contadores ni el array original',()=>{
 const original=[0,12.5,null,3.25,0];
 const copy=original.slice();
 const plotted=signedExportSeries(original);
 assert.deepEqual(plotted,[0,-12.5,null,-3.25,0]);
 assert.deepEqual(original,copy);
 assert.equal(50+20-12.5,50+20+plotted[1],
   'no restar dos veces el flujo exportado negativo');
});
