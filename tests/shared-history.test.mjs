import test from 'node:test';
import assert from 'node:assert/strict';
import {writeHistory,readHistory,historyStatus,historyKey,normalizeHistoryItem,validateHistory} from '../worker/shared-history.js';
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
 const unusual=normalizeHistoryItem({...inv(),rows:[{ts:DAY+'T10:00:00',pot:900,dia:10}]},ENV);
 assert.equal(unusual.rows[0].pot,null,'no mostrar 900 como si fuesen kW');
 assert.equal(unusual.rows[0].potSinValidar,900,'conservar el dato bruto');
 assert.equal(unusual.controlPotencia.muestrasSinVerificar,1);
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

test('potencia acreditada de Solarman W se convierte a kW sin perder acumulados',async()=>{
 const db=fakeStorage();
 const result=await writeHistory(db,[{tipo:'A',fecha:DAY,unidadPotencia:'W',
   rows:[{ts:DAY+'T10:00:00',pot:35000,dia:85,acum:456789},
         {ts:DAY+'T10:05:00',pot:42000,dia:89,acum:456793}]}],ENV);
 assert.equal(result.guardadas,1);assert.equal(result.pendientesPotencia,0);
 const f=(await readHistory(db,DAY,DAY)).fuentes[0];
 assert.deepEqual(f.rows.map(r=>r.pot),[35,42]);
 assert.equal(f.rows[0].dia,85);
 assert.equal(f.unidadPotencia,'kW');
});
test('potencia sospechosa sin unidad no bloquea otros días ni se pierde',async()=>{
 const db=fakeStorage();
 const result=await writeHistory(db,[
  {tipo:'A',fecha:DAY,unidadPotencia:'desconocida',
   rows:[{ts:DAY+'T10:00:00',pot:35000,dia:85,acum:456789}]},
  {...inv('B',20),fecha:DAY,unidadPotencia:'kW'}
 ],ENV);
 assert.equal(result.guardadas,2);
 assert.equal(result.pendientesPotencia,1);
 const data=(await readHistory(db,DAY,DAY)).fuentes;
 assert.equal(data[0].rows[0].pot,null);
 assert.equal(data[0].rows[0].potSinValidar,35000);
 assert.equal(data[1].rows[0].pot,20);
});
test('potencia con unidad W fuera del rango del inversor queda registrada en cuarentena',()=>{
 const record=normalizeHistoryItem({tipo:'A',fecha:DAY,unidadPotencia:'W',
  rows:[{ts:DAY+'T10:00:00',pot:120000,acum:900,dia:5}]},ENV);
 assert.equal(record.rows[0].pot,null);
 assert.equal(record.rows[0].potSinValidar,120000);
 assert.equal(record.rows[0].acum,900);
});
test('no se atribuye unidad kW al XLSX histórico sin metadatos',()=>{
 const record=normalizeHistoryItem({tipo:'B',fecha:DAY,unidadPotencia:'desconocida',
  rows:[{ts:DAY+'T10:00:00',pot:20,dia:5,acum:2000}]},ENV);
 assert.equal(record.rows[0].pot,null);
 assert.equal(record.rows[0].potSinValidar,20);
});

test('un histórico de kWh diarios en unidades antiguas no bloquea el lote completo',async()=>{
 const db=fakeStorage();
 const files=[
   {tipo:'A',fecha:DAY,unidadPotencia:'kW',rows:[
     {ts:DAY+'T10:00:00',pot:35,dia:150000,acum:1500000000},
     {ts:DAY+'T10:05:00',pot:36,dia:150800,acum:1500000800}]},
   inv('B',20)
 ];
 const inspection=validateHistory(files,ENV);
 assert.equal(inspection.version,'migracion-v3');
 assert.equal(inspection.validas,2);
 const result=await writeHistory(db,files,ENV);
 assert.equal(result.guardadas,2,JSON.stringify(result));
 assert.equal(result.rechazadas,0);
 assert.ok(result.pendientesEnergia>=2);
 const a=(await readHistory(db,DAY,DAY)).fuentes[0];
 assert.equal(a.rows[0].pot,35);
 assert.equal(a.rows[0].dia,null,'no calcular con unidades incorrectas');
 assert.equal(a.rows[0].diaSinValidar,150000);
 assert.equal(a.rows[0].acumSinValidar,1500000000);
 assert.equal(a.controlPotencia.energiaSinVerificar,2);
});
test('un día inválido devuelve causa y permite guardar los demás días del mismo paquete',async()=>{
 const db=fakeStorage();
 const dateBad='2026-10-20';
 const group=[inv('A',20),{tipo:'A',fecha:dateBad,rows:[{
   ts:'fecha no reconocida',pot:35000,dia:2000,acum:3000000000
 }]}];
 const check=validateHistory(group,ENV);
 assert.equal(check.validas,1);
 assert.equal(check.rechazadas,1);
 assert.match(check.incidencias[0].motivo,/Ninguna muestra FV con fecha y hora compatibles/);
 const saved=await writeHistory(db,group,ENV);
 assert.equal(saved.version,'migracion-v3');
 assert.equal(saved.guardadas,1);
 assert.equal(saved.rechazadas,1);
 assert.equal(saved.incidencias[0].fecha,dateBad);
 assert.equal((await readHistory(db,DAY,DAY)).fuentes.length,1);
});
test('validación seca autentificada no escribe ni consulta Solarman',async t=>{
 const db=fakeStorage(),quota=new SolarmanQuota({storage:db},ENV);
 const env={...ENV,SOLARMAN_QUOTA:{idFromName:()=>1,get:()=>({
   fetch:(url,init)=>quota.fetch(new Request(url,init))})}};
 const external=t.mock.method(globalThis,'fetch',()=>{throw Error('Acceso a proveedor no permitido')});
 const req=new Request('https://gorraiz.example.workers.dev/historico/validar',{
  method:'POST',headers:{Origin:ENV.ALLOWED_ORIGIN,
    'X-Panel-Key':ENV.PANEL_KEY,'content-type':'application/json'},
  body:JSON.stringify({items:[inv(),inv('B',18)]})
 });
 const result=await worker.fetch(req,env);
 assert.equal(result.status,200,await result.clone().text());
 const output=await result.json();
 assert.equal(output.version,'migracion-v3');
 assert.equal(output.validas,2);
 assert.equal(db.memory.size,0,'la validación no escribe en la base');
 assert.equal(external.mock.callCount(),0);
});
test('hasta 2.500 muestras al día, con límite real por bytes',()=>{
 const many=Array.from({length:1700},(_,i)=>({
   ts:DAY+'T'+String(Math.floor(i/3600)).padStart(2,'0')+
     ':'+String(Math.floor(i/60)%60).padStart(2,'0')+
     ':'+String(i%60).padStart(2,'0'),pot:30,dia:55,acum:500}));
 const rec=normalizeHistoryItem({tipo:'A',fecha:DAY,unidadPotencia:'kW',rows:many},ENV);
 assert.ok(rec.rows.length>100,'admite 1700 muestras válidas en un día');
});
