import test from 'node:test';
import assert from 'node:assert/strict';
import {writeHistory,readHistory,historyStatus,historyKey,normalizeHistoryItem} from '../worker/shared-history.js';
import worker,{SolarmanQuota} from '../worker/index.js';

const DAY='2026-10-19';
const ENV={SPC_STATION_ID:'2026032317114373',SPC_METER_ID:'210261430F3060020000661',
 PANEL_KEY:'clave-panel-qa',ALLOWED_ORIGIN:'https://imoriana3.github.io'};
function fakeStorage(){
 const memory=new Map();let lock=Promise.resolve();
 const inner={get:async k=>memory.get(k),put:async (k,v)=>{memory.set(k,v)},
   list:async ({prefix,limit})=>new Map([...memory.entries()].filter(([key])=>key.startsWith(prefix)).slice(0,limit))};
 return {...inner,memory,async transaction(fn){
   let end;const next=new Promise(ok=>{end=ok});
   const prev=lock;lock=next;await prev;
   try{return await fn(inner)}finally{end()}
 }};
}
const inv=(type='A',pot=20)=>({tipo:type,fecha:DAY,
 rows:[{ts:DAY+'T10:00:00',pot,dia:15,acum:100},
       {ts:DAY+'T10:05:00',pot:pot+2,dia:18,acum:103}]});
const spc=()=>({tipo:'S',fecha:DAY,payload:{
 rows:[{saveTime:DAY+' 10:00:00',positiveActiveElec:100,reverseActiveElec:2,
   totalActivePower:350,currentRatio:1},
 {saveTime:DAY+' 10:05:00',positiveActiveElec:101,reverseActiveElec:2.1,
   totalActivePower:360,currentRatio:1}],
 daily:[{date:DAY,importKWh:1,exportKWh:0.1,selfConsumptionKWh:22}],
 meta:{fuente:'spc',stationId:ENV.SPC_STATION_ID,meterId:ENV.SPC_METER_ID,
   desde:DAY,hasta:DAY,completo:true,diaCerrado:true,resumenDiarioCompleto:true,
   medidoresEstacion:1,actualizado:'2026-10-20T12:00:00Z',timezone:'Europe/Madrid',
   timezoneVerified:true,transport:'http',dailyScope:'station',historyScope:'meter'}}});
test('archivo compartido conserva A/B y SPC, con alcance del medidor validado',async()=>{
 const db=fakeStorage(),items=[inv(),inv('B',16),spc()];
 const saved=await writeHistory(db,items,ENV);
 assert.equal(saved.guardadas,3);
 const fetched=await readHistory(db,DAY,DAY);
 assert.equal(fetched.fuentes.length,3);
 assert.deepEqual(fetched.fuentes.map(v=>v.tipo),['A','B','S']);
 assert.equal(fetched.fuentes.find(f=>f.tipo==='S').payload.meta.timezoneVerified,false,
   'un metadato del cliente no certifica el reloj SPC');
 assert.equal(fetched.meta.proveedorConsultado,false);
 const status=await historyStatus(db);
 assert.equal(status.cobertura.A.dias,1);assert.equal(status.cobertura.S.dias,1);
});
test('múltiples escritores fusionan muestras del día sin perder históricas',async()=>{
 const db=fakeStorage();await writeHistory(db,[inv()],ENV);
 await writeHistory(db,[{tipo:'A',fecha:DAY,rows:[
   {ts:DAY+'T10:05:00',pot:24,dia:null,acum:105},
   {ts:DAY+'T10:10:00',pot:28,dia:21,acum:108}]}],ENV);
 const r=(await readHistory(db,DAY,DAY)).fuentes[0];
 assert.deepEqual(r.rows.map(v=>v.ts),[DAY+'T10:00:00',DAY+'T10:05:00',DAY+'T10:10:00']);
 assert.equal(r.rows[1].pot,24);assert.equal(r.rows[1].dia,18);
});
test('SPC completo nunca se sustituye por copia parcial',async()=>{
 const db=fakeStorage();await writeHistory(db,[spc()],ENV);
 const partial=spc();partial.payload.meta.completo=false;partial.payload.rows=partial.payload.rows.slice(0,1);
 await writeHistory(db,[partial],ENV);
 const r=(await readHistory(db,DAY,DAY)).fuentes[0];
 assert.equal(r.payload.meta.completo,true);assert.equal(r.payload.rows.length,2);
});
test('rechaza planta ajena y tipos/formato peligrosos',()=>{
 const wrong=spc();wrong.payload.meta.stationId='OTRA_ESTACION';
 assert.throws(()=>normalizeHistoryItem(wrong,ENV),/estación/);
 const wrongMeter=spc();wrongMeter.payload.meta.meterId='AJENO';
 assert.throws(()=>normalizeHistoryItem(wrongMeter,ENV),/identificador/);
 assert.throws(()=>normalizeHistoryItem({...inv(),tipo:'I'},ENV),/Tipo o fecha/);
 assert.throws(()=>normalizeHistoryItem({...inv(),rows:[{ts:DAY+'T10:00:00',pot:900}]},ENV),/Potencia/);
});
test('límite 31 días, no rellena huecos',async()=>{
 const db=fakeStorage();await writeHistory(db,[inv()],ENV);
 assert.equal((await readHistory(db,'2026-10-18','2026-10-20')).fuentes.length,1);
 await assert.rejects(readHistory(db,'2026-09-01',DAY),/31 días/);
});
test('publicación desde móvil e informe accede al mismo DO y nunca llama a proveedores',async t=>{
 const db=fakeStorage();const quota=new SolarmanQuota({storage:db},ENV);
 const env={...ENV,SOLARMAN_QUOTA:{idFromName:()=>1,get:()=>({fetch:(url,init)=>quota.fetch(new Request(url,init))})}};
 const external=t.mock.method(globalThis,'fetch',()=>{throw new Error('No se debe contactar proveedor')});
 const post=(path,body,key=ENV.PANEL_KEY)=>worker.fetch(new Request('https://gorraiz.example.workers.dev'+path,{
    method:'POST',headers:{Origin:ENV.ALLOWED_ORIGIN,'X-Panel-Key':key,'content-type':'application/json'},
    body:JSON.stringify(body)
 }),env);
 const upload=await post('/historico/guardar',{items:[inv(),inv('B',14),spc()]});
 assert.equal(upload.status,200,await upload.clone().text());
 const getFromScada=await post('/historico/datos',{desde:DAY,hasta:DAY});
 const body=await getFromScada.json();assert.equal(body.fuentes.length,3);
 const state=await worker.fetch(new Request('https://gorraiz.example.workers.dev/historico/estado',{
  headers:{Origin:ENV.ALLOWED_ORIGIN,'X-Panel-Key':ENV.PANEL_KEY}
 }),env);
 assert.equal(state.status,200);
 assert.equal((await state.json()).cobertura.S.dias,1);
 const unauthorized=await post('/historico/guardar',{items:[inv()]},'invalid');
 assert.equal(unauthorized.status,401);
 assert.equal(external.mock.callCount(),0);
 assert.equal(db.memory.has('solarman:ultima_reserva'),false,
   'leer/escribir datos centrales NO debe gastar cupo Solarman');
});
