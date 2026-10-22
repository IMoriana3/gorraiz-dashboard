import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker, {SolarmanQuota} from '../worker/index.js';

// Banco de pruebas SIN conexiones externas ni secretos reales.
const base={
  PANEL_KEY:'qa-panel-ficticio',ALLOWED_ORIGIN:'https://imoriana3.github.io',
  SOLARMAN_APPID:'ficticio',SOLARMAN_APPSECRET:'no-es-un-secreto',
  SOLARMAN_EMAIL:'qa@example.invalid',SOLARMAN_PASS:'prueba-sin-credenciales',
  SOLARMAN_ORGID:'10865841',SOLARMAN_BASE:'https://globalapi.solarmanpv.com'
};
const endpoint='https://gorraiz-dashboard.example.invalid';
const prod=(from='2026-10-19',to=from)=>new Request(endpoint+'/produccion',{
  method:'POST',headers:{Origin:base.ALLOWED_ORIGIN,'X-Panel-Key':base.PANEL_KEY,
    'content-type':'application/json'},body:JSON.stringify({desde:from,hasta:to})
});
const diagnostico=dia=>new Request(endpoint+'/solarman/diagnostico?k='+base.PANEL_KEY+
  '&dia='+dia,{headers:{Origin:base.ALLOWED_ORIGIN}});
function storage(){
 const memory=new Map();let queue=Promise.resolve();
 const tx={get:async k=>memory.get(k),put:async(k,v)=>{memory.set(k,v)}};
 return{memory, ...tx,
  // Emula transacciones serializables de SQLite DO, incluso con peticiones concurrentes.
  async transaction(fn){
    let done;const next=new Promise(resolve=>{done=resolve});
    const previous=queue;queue=next;
    await previous;try{return await fn(tx)}finally{done()}
  }
 };
}
function namespace(env,db){
 const quota=new SolarmanQuota({storage:db},env);
 return{idFromName(name){assert.equal(name,'gorraiz-solarman-global-v1');return name},
   get(){return{fetch:(url,init)=>quota.fetch(new Request(url,init))}}};
}
function provider(t,{fail=false,delay=0}={}){
 let count=0;const routes=[];
 const fake=t.mock.method(globalThis,'fetch',async (url,init)=>{
   count++;const pathname=new URL(url).pathname;routes.push(pathname);
   if(delay)await new Promise(r=>setTimeout(r,delay));
   if(fail)throw new Error('Simulación de fallo de red');
   const reply=obj=>new Response(JSON.stringify(obj),{status:200,headers:{'content-type':'application/json'}});
   if(pathname==='/account/v1.0/token')return reply({success:true,access_token:'qa-token'});
   if(pathname==='/station/v1.0/list')
     return reply({success:true,stationList:[{id:42001}],total:1});
   if(pathname==='/station/v1.0/device')
     return reply({success:true,deviceListItems:[{deviceSn:'INV-A',deviceId:1},{deviceSn:'INV-B',deviceId:2}]});
   if(pathname==='/device/v1.0/historical')
     return reply({success:true,paramDataList:[{collectTime:Math.floor(Date.parse('2026-10-19T12:00:00Z')/1000),
       dataList:[{key:'APo_t1',value:'21.3'},{key:'Et_ge0',value:'3021.2'},{key:'Etdy_ge1',value:'74.2'}]}]});
   if(pathname==='/account/v1.0/info')
     return reply({success:true,orgInfoList:[{companyId:10865841,companyName:'Amixalan'}]});
   throw new Error('Ruta externa inesperada: '+pathname);
 });
 return{routes,fake,get calls(){return count}};
}
test('sin binding global se deniega Solarman antes de contactar su API',async t=>{
 const api=provider(t);
 const r=await worker.fetch(prod(),base);
 assert.equal(r.status,503);
 assert.match((await r.json()).error,/SOLARMAN_QUOTA/);
 assert.equal(api.calls,0);
});
test('autenticación del panel se comprueba ANTES de abrir el cupo',async t=>{
 const api=provider(t),db=storage(),env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 const request=prod();request.headers.set('X-Panel-Key','incorrecta');
 const r=await worker.fetch(request,env);
 assert.equal(r.status,401);assert.equal(api.calls,0);assert.equal(db.memory.size,0);
});
test('rango inválido no consume ni reserva presupuesto central',async t=>{
 const api=provider(t),db=storage(),env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 const r=await worker.fetch(prod('2026-02-30'),env);
 assert.equal(r.status,400);assert.equal(api.calls,0);assert.equal(db.memory.size,0);
});
test('un lote/h global, con caché compartida por todos los clientes',async t=>{
 const api=provider(t),db=storage(),env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 const clock=t.mock.method(Date,'now',()=>1_000_000_000);
 const first=await worker.fetch(prod(),env);
 assert.equal(first.status,200,await first.clone().text());
 assert.equal(first.headers.get('X-Solarman-Cuota'),'origen');
 const sourceCalls=api.calls;
 assert.ok(sourceCalls>=3,'un lote comprende varias llamadas reales a Solarman');
 const cached=await worker.fetch(prod(),env);
 assert.equal(cached.status,200);assert.equal(cached.headers.get('X-Solarman-Cuota'),'cache-compartida');
 assert.equal(api.calls,sourceCalls);
 assert.deepEqual(await cached.json(),await first.json());
 const second=await worker.fetch(prod('2026-10-20'),env);
 assert.equal(second.status,429);
 assert.equal(second.headers.get('Retry-After'),'3600');
 assert.equal((await second.json()).retryAfterSeconds,3600);
 assert.equal(api.calls,sourceCalls);
 clock.mock.restore();
});
test('cambiar de pestaña o dispositivo no elude presupuesto persistente',async t=>{
 const api=provider(t),db=storage(),clock=t.mock.method(Date,'now',()=>2_000_000_000);
 const first={...base,SOLARMAN_QUOTA:namespace(base,db)};
 const second={...base,SOLARMAN_QUOTA:namespace(base,db)};
 assert.equal((await worker.fetch(prod(),first)).status,200);
 const count=api.calls;
 assert.equal((await worker.fetch(prod('2026-10-21'),second)).status,429);
 assert.equal(api.calls,count);
 clock.mock.restore();
});
test('tras 60 minutos completos se permite un lote nuevo',async t=>{
 const api=provider(t),db=storage();let now=3_000_000_000;
 const clock=t.mock.method(Date,'now',()=>now);
 const env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 assert.equal((await worker.fetch(prod(),env)).status,200);
 const previous=api.calls;
 now+=3_599_999;assert.equal((await worker.fetch(prod('2026-10-20'),env)).status,429);
 now++;assert.equal((await worker.fetch(prod('2026-10-20'),env)).status,200);
 assert.ok(api.calls>previous);
 clock.mock.restore();
});
test('un error de proveedor tampoco libera el cupo, y el segundo intento no llega a Solarman',async t=>{
 const api=provider(t,{fail:true}),db=storage(),env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 const first=await worker.fetch(prod(),env);
 assert.equal(first.status,502);
 const count=api.calls;
 const again=await worker.fetch(prod(),env);
 assert.equal(again.status,429);assert.equal(api.calls,count);
});
test('si falla el almacenamiento central, se bloquea el acceso por seguridad',async t=>{
 const api=provider(t),broken={transaction:async()=>{throw Error('DB indisponible')}};
 const env={...base,SOLARMAN_QUOTA:namespace(base,broken)};
 const response=await worker.fetch(prod(),env);
 assert.equal(response.status,503);assert.equal(api.calls,0);
});
test('diagnóstico Solarman usa el MISMO cupo del histórico',async t=>{
 const api=provider(t),db=storage(),env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 assert.equal((await worker.fetch(prod(),env)).status,200);
 const count=api.calls;
 const r=await worker.fetch(diagnostico('2026-10-19'),env);
 assert.equal(r.status,429);assert.equal(api.calls,count);
});
test('solicitudes simultáneas de dos clientes no duplican compras de datos',async t=>{
 const api=provider(t,{delay:8}),db=storage(),env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 const [a,b]=await Promise.all([worker.fetch(prod(),env),worker.fetch(prod(),env)]);
 assert.deepEqual([a.status,b.status].sort(),[200,429]);
 const before=api.calls;
 const follow=await worker.fetch(prod(),env);
 assert.equal(follow.status,200);assert.equal(follow.headers.get('X-Solarman-Cuota'),'cache-compartida');
 assert.equal(api.calls,before);
});

test('un único lote Solarman alimenta el histórico A/B del Informe y SCADA sin otras llamadas',async t=>{
 const api=provider(t),db=storage(),env={...base,SOLARMAN_QUOTA:namespace(base,db)};
 const result=await worker.fetch(prod(),env);
 assert.equal(result.status,200);
 const body=await result.json();
 assert.equal(body.meta.compartido.ok,true,JSON.stringify(body.meta));
 assert.equal(body.meta.compartido.guardadas,2);
 assert.ok(db.memory.has('energia:v1:A:2026-10-19'));
 assert.ok(db.memory.has('energia:v1:B:2026-10-19'));
 const attempts=api.calls;
 const request=new Request(endpoint+'/historico/datos',{
  method:'POST',headers:{Origin:base.ALLOWED_ORIGIN,'X-Panel-Key':base.PANEL_KEY,
   'content-type':'application/json'},
  body:JSON.stringify({desde:'2026-10-19',hasta:'2026-10-19'})
 });
 const historic=await worker.fetch(request,env);
 assert.equal(historic.status,200);
 const shared=await historic.json();
 assert.deepEqual(shared.fuentes.map(s=>s.tipo),['A','B']);
 assert.equal(shared.fuentes[0].rows[0].pot,21.3);
 assert.equal(api.calls,attempts,'la lectura del servidor nunca consulta Solarman');
});
