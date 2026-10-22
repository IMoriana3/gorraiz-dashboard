import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotAt,defaultSnapshotIndex,latestSnapshotIndex,
 snapshotSourceTimes,snapshotStatus,pointDateTime} from '../scada-snapshot.mjs';

const date='2026-10-21';
function fixture(){
 const keys=Array.from({length:288},(_,i)=>date+'T'+
   String(Math.floor(i/12)).padStart(2,'0')+':'+String((i%12)*5).padStart(2,'0'));
 const source={keys,dates:[date],series:{
  a:Array(288).fill(null),b:Array(288).fill(null),
  generation:Array(288).fill(null),consumption:Array(288).fill(null),
  import:Array(288).fill(null),export:Array(288).fill(null)
 },gridState:{[date]:{meta:{timezoneVerified:false}}}};
 // FV ends at 19:25; SPC ends at 23:55.
 const common=19*12+5,spcLast=23*12+11;
 source.series.a[common]=0;source.series.b[common]=0;
 source.series.generation[common]=0;
 source.series.import[common]=35.9;
 source.series.export[common]=0;
 source.series.consumption[common]=35.9;
 source.series.import[spcLast]=11.8;
 source.series.export[spcLast]=0;
 return{source,common,spcLast};
}
test('instantánea por defecto NO mezcla consumo de 19:25 con importación SPC de 23:55',()=>{
 const {source,common,spcLast}=fixture();
 assert.equal(defaultSnapshotIndex(source),common);
 assert.equal(latestSnapshotIndex(source,'spc'),spcLast);
 const selected=snapshotAt(source,defaultSnapshotIndex(source));
 assert.equal(selected.key,date+'T19:25');
 assert.equal(selected.generation,0,'potencia cero FV válida, no falta de lectura');
 assert.equal(selected.consumption,35.9);
 assert.equal(selected.import,35.9);
 assert.equal(selected.export,0);
 assert.equal(selected.status,'paired');
 assert.equal(selected.clockVerified,false);
 const latest=snapshotSourceTimes(source);
 assert.equal(latest.pv,date+'T19:25');
 assert.equal(latest.spc,date+'T23:55');
 assert.equal(latest.matched,date+'T19:25');
});
test('opción Último SPC muestra red 23:55 sin inventar FV y consumo',()=>{
 const {source,spcLast}=fixture();
 const p=snapshotAt(source,spcLast);
 assert.equal(p.key,date+'T23:55');
 assert.equal(p.import,11.8);
 assert.equal(p.export,0);
 assert.equal(p.generation,null);
 assert.equal(p.consumption,null);
 assert.equal(p.hasSPC,true);
 assert.equal(p.hasFV,false);
 assert.equal(p.status,'spc-only');
 assert.match(snapshotStatus(p,{provisional:true}),/NO puede estimarse/);
});
test('en ausencia de pareja FV/SPC se selecciona última SPC, sin fingir coincidencia',()=>{
 const {source,common,spcLast}=fixture();
 for(const kind of ['a','b','generation','consumption'])
   source.series[kind][common]=null;
 assert.equal(latestSnapshotIndex(source,'matched'),-1);
 assert.equal(defaultSnapshotIndex(source),spcLast);
 assert.equal(snapshotAt(source,spcLast).status,'spc-only');
});
test('sin consumo provisional se mantiene una casilla común pero no se inventa carga',()=>{
 const {source,common}=fixture();
 source.series.consumption[common]=null;
 assert.equal(defaultSnapshotIndex(source),common);
 const p=snapshotAt(source,common);
 assert.equal(p.hasFV,true);assert.equal(p.hasSPC,true);
 assert.equal(p.consumption,null);
 assert.match(snapshotStatus(p,{provisional:false}),/desactivado/);
});
test('controles nunca indexan fuera del periodo ni convierten null en cero',()=>{
 const {source}=fixture();
 assert.equal(snapshotAt(source,-1),null);
 assert.equal(snapshotAt(source,288),null);
 assert.equal(snapshotAt(source,10).import,null);
 assert.equal(snapshotAt(source,10).generation,null);
 assert.equal(snapshotAt(source,10).consumption,null);
 assert.equal(snapshotAt(source,10).status,'empty');
});
test('hora local y fecha visibles en rangos multidiarios, sin formatear datos corruptos',()=>{
 assert.equal(pointDateTime('2026-10-21T19:25'),'21/10 19:25');
 assert.equal(pointDateTime('2026-10-21T23:55'),'21/10 23:55');
 assert.equal(pointDateTime('bad'),'—');
 const {source,common}=fixture();
 const old=source.keys.slice(),empty=Array(288).fill(null);
 source.keys=Array.from({length:288},(_,i)=>'2026-10-20T'+
  String(Math.floor(i/12)).padStart(2,'0')+':'+String((i%12)*5).padStart(2,'0')).concat(old);
 for(const key of Object.keys(source.series))
  source.series[key]=empty.concat(source.series[key]);
 assert.equal(defaultSnapshotIndex(source),common+288);
 assert.equal(snapshotAt(source,common+288).date,'2026-10-21');
});
