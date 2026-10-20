import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/kstar-prueba.js';

const SECRET = 'only-for-tests-test-key-1234567890123456';
const DAY = '2026-10-19';
const ENV = {
  KSTAR_TEST_KEY: SECRET,
  SPC_USER: 'user@example.invalid',
  SPC_PASS: 'test-password-not-real',
  SPC_STATION_ID: 'STATION_TEST',
  SPC_TIMEZONE: 'Europe/Madrid',
  SPC_TRANSPORT: 'http',
  SPC_HTTP_RISK_ACK: 'I_ACCEPT_UNENCRYPTED_CREDENTIALS',
};
function request(key=SECRET, day=DAY) {
  return new Request('https://kstar-test.example.invalid/comprobar',{
    method:'POST',headers:{'content-type':'application/json','X-KSTAR-Test-Key':key},
    body:JSON.stringify({dia:day}),
  });
}
const json=(obj)=>new Response(JSON.stringify(obj),{headers:{'content-type':'application/json'}});
test('página de prueba no incluye credenciales y no permite caché',async()=>{
  const r=await worker.fetch(new Request('https://kstar-test.example.invalid/'),ENV);
  assert.equal(r.status,200);
  assert.equal(r.headers.get('cache-control'),'no-store');
  const body=await r.text();
  assert.match(body,/KSTAR SPC01/);
  assert.equal(body.includes(ENV.SPC_USER),false);
  assert.equal(body.includes(ENV.SPC_PASS),false);
  assert.match(body,/HTTP sin cifrar/);
});
test('sin clave o sin doble autorización NO consulta al proveedor',async t=>{
  const upstream=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Forbidden network')});
  assert.equal((await worker.fetch(request('not-correct'),ENV)).status,401);
  assert.equal((await worker.fetch(request(),{...ENV,SPC_HTTP_RISK_ACK:'no'})).status,501);
  assert.equal((await worker.fetch(request(),{...ENV,KSTAR_TEST_KEY:'weak'})).status,503);
  assert.equal((await worker.fetch(request(SECRET,'2030-01-01'),ENV)).status,400);
  assert.equal(upstream.mock.callCount(),0);
});
test('consulta protegida da importación y exportación, sin token ni contraseña',async t=>{
  const upstream=t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url);
    assert.equal(u.protocol,'http:');
    assert.equal(u.hostname,'spc.ksdatacloud.com');
    if(u.pathname==='/api/authentication/form'){
      assert.equal(u.searchParams.get('username'),ENV.SPC_USER);
      assert.equal(u.searchParams.get('password'),ENV.SPC_PASS);
      return json({token:{access_token:'fictional-token-123',expires_in:3600}});
    }
    assert.match(init.headers.Authorization,/^Bearer fictional-token-123$/);
    if(u.pathname==='/api/station/monitor/detail/meter/list')
      return json({code:200,rows:[{deviceId:'M_TEST',stationId:ENV.SPC_STATION_ID}],total:1});
    if(u.pathname==='/api/meter/monitor/detail/history/data')
      return json({code:200,rows:[{saveTime:'2026-10-19 12:00:00',positiveActiveElec:10,reverseActiveElec:2}],total:1});
    if(u.pathname==='/api/station/monitor/detail/self')
      return json({code:200,data:{positiveElec:273,reverseElec:41.8,selfConsumption:115.2}});
    throw Error('Unexpected route');
  });
  const r=await worker.fetch(request(),ENV);
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.ok,true);
  assert.equal(body.importKWh,273);
  assert.equal(body.exportKWh,41.8);
  assert.equal(body.complete,true);
  assert.equal(body.meterId,'M_TEST');
  const txt=JSON.stringify(body);
  assert.equal(txt.includes(ENV.SPC_USER),false);
  assert.equal(txt.includes(ENV.SPC_PASS),false);
  assert.equal(txt.includes('fictional-token-123'),false);
  assert.equal(upstream.mock.callCount(),4);
});


test('sondeo sin usuario, contraseña ni token, muestra solo GET/POST y código de red', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = new URL(url);
    assert.equal(u.protocol, 'http:');
    assert.equal(u.hostname, 'spc.ksdatacloud.com');
    assert.equal(u.search, '');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, undefined);
    assert.ok(['GET','POST'].includes(init.method));
    assert.ok(['/', '/api/station/monitor/detail/self', '/api/authentication/form'].includes(u.pathname));
    const status = u.pathname === '/' ? 200
      : u.pathname.includes('authentication') ? 400 : 401;
    return new Response('', {status});
  });
  const r = await worker.fetch(new Request('https://kstar-test.example.invalid/sondeo', {
    method:'POST', headers:{'X-KSTAR-Test-Key':SECRET},
  }),ENV);
  assert.equal(r.status,200);
  const body = await r.json();
  assert.equal(body.sinCredencialesKstar,true);
  assert.deepEqual(body.resultados.map(x=>x.http),[200,401,400]);
  assert.equal(upstream.mock.callCount(),3);
  for(const forbidden of [ENV.SPC_USER,ENV.SPC_PASS,'Authorization','Bearer']) {
    assert.equal(JSON.stringify(body).includes(forbidden),false);
  }
});

test('sondeo sin clave no contacta KSTAR', async t => {
  const upstream=t.mock.method(globalThis,'fetch',async()=>{throw Error('No debe consultar upstream')});
  const r=await worker.fetch(new Request('https://kstar-test.example.invalid/sondeo',{
    method:'POST',headers:{'X-KSTAR-Test-Key':'contraseña-incorrecta'},
  }),ENV);
  assert.equal(r.status,401);
  assert.equal(upstream.mock.callCount(),0);
});

test('error de transporte identifica etapa del login sin divulgar la URL ni credenciales', async t => {
  const upstream=t.mock.method(globalThis,'fetch',async(url)=>{
    throw Error('Secret leaked in low-level error ' + url);
  });
  const r=await worker.fetch(request(),ENV);
  assert.equal(r.status,503);
  const body=await r.json();
  assert.equal(body.code,'SPC_NETWORK');
  assert.equal(body.etapa,'autenticacion');
  assert.equal(body.detalleRed,'fallo_de_transporte');
  assert.equal(upstream.mock.callCount(),1);
  for(const forbidden of [ENV.SPC_USER, ENV.SPC_PASS, 'username=', 'password=', 'http://']) {
    assert.equal(JSON.stringify(body).includes(forbidden),false);
  }
});

test('si falla el histórico indica etapa y no expone el token KSTAR', async t => {
  const upstream=t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url);
    assert.equal(init.redirect,'manual');
    if(u.pathname==='/api/authentication/form')
      return json({token:{access_token:'fictional-secret-token',expires_in:3600}});
    if(u.pathname==='/api/station/monitor/detail/meter/list')
      return json({code:200,rows:[{deviceId:'M_TEST',stationId:ENV.SPC_STATION_ID}],total:1});
    if(u.pathname==='/api/meter/monitor/detail/history/data')
      throw Error('Blocked https?token=fictional-secret-token');
    throw Error('Unexpected request');
  });
  const response=await worker.fetch(request(),ENV);
  assert.equal(response.status,503);
  const body=await response.json();
  assert.equal(body.code,'SPC_NETWORK');
  assert.equal(body.etapa,'historico_medidor');
  assert.equal(body.detalleRed,'fallo_de_transporte');
  assert.equal(JSON.stringify(body).includes('fictional-secret-token'),false);
  assert.equal(upstream.mock.callCount(),3);
});

test('redirige manualmente y no filtra location del login',async t=>{
  const upstream=t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(init.redirect,'manual');
    return new Response(null,{status:302,headers:{location:'https://other.invalid?password='+ENV.SPC_PASS}});
  });
  const r=await worker.fetch(request(),ENV);
  assert.equal(r.status,502);
  const body=await r.json();
  assert.equal(body.code,'SPC_REDIRECT');
  assert.equal(body.etapa,'autenticacion');
  assert.equal(JSON.stringify(body).includes(ENV.SPC_PASS),false);
  assert.equal(upstream.mock.callCount(),1);
});


test('ante error KSTAR en resumen diario conserva la muestra segura del histórico, sin inventar kWh diarios', async t => {
  const upstream=t.mock.method(globalThis,'fetch',async(url,init)=>{
    const p=new URL(url);
    if(p.pathname==='/api/authentication/form')
      return json({token:{access_token:'fictional-private-token',expires_in:3600}});
    if(p.pathname==='/api/station/monitor/detail/meter/list')
      return json({code:200,rows:[{deviceId:'M_TEST',stationId:ENV.SPC_STATION_ID}],total:1});
    if(p.pathname==='/api/meter/monitor/detail/history/data')
      return json({code:200,total:2,rows:[
        {saveTime:'2026-10-19 00:00:00',positiveActiveElec:15,reverseActiveElec:4},
        {saveTime:'2026-10-19 23:30:00',positiveActiveElec:19,reverseActiveElec:6},
      ]});
    if(p.pathname==='/api/station/monitor/detail/self')
      return json({code:40027,success:false,msg:'provider response with fictional-private-token and '+ENV.SPC_PASS, data:null});
    throw Error('Unexpected request');
  });
  const r=await worker.fetch(request(),ENV);
  assert.equal(r.status,502);
  const body=await r.json();
  assert.equal(body.ok,false);
  assert.equal(body.code,'SPC_PROVIDER_ERROR');
  assert.equal(body.etapa,'resumen_diario');
  assert.equal(body.proveedor.codigo,'40027');
  assert.equal(body.proveedor.success,false);
  assert.equal(body.proveedor.tipoDatos,'sin_datos');
  assert.equal(body.historico.registros,2);
  assert.equal(body.historico.medidor,'M_TEST');
  assert.equal(body.historico.primeraFila.positivaSinValidar,15);
  assert.equal(body.historico.ultimaFila.inversaSinValidar,6);
  assert.equal(body.importKWh,undefined);
  assert.equal(body.exportKWh,undefined);
  assert.equal(upstream.mock.callCount(),4);
  const literal=JSON.stringify(body);
  assert.equal(literal.includes(ENV.SPC_USER),false);
  assert.equal(literal.includes(ENV.SPC_PASS),false);
  assert.equal(literal.includes('fictional-private-token'),false);
  assert.equal(literal.includes('provider response'),false);
});

test('sin histórico, código no numérico no se devuelve y se conservan nulos',async t=>{
  const upstream=t.mock.method(globalThis,'fetch',async url=>{
    const p=new URL(url);
    if(p.pathname==='/api/authentication/form')
      return json({token:{access_token:'fictional-token',expires_in:3600}});
    if(p.pathname==='/api/station/monitor/detail/meter/list')
      return json({code:200,rows:[{deviceId:'M_TEST',stationId:ENV.SPC_STATION_ID}],total:1});
    if(p.pathname==='/api/meter/monitor/detail/history/data')
      return json({code:200,rows:[],total:0});
    if(p.pathname==='/api/station/monitor/detail/self')
      return json({code:'private-station-id-do-not-disclose',error:true,data:[]});
    throw Error('unexpected');
  });
  const r=await worker.fetch(request(),ENV);
  assert.equal(r.status,502);
  const body=await r.json();
  assert.equal(body.code,'SPC_PROVIDER_ERROR');
  assert.equal(body.proveedor.codigo,null);
  assert.equal(body.proveedor.tipoDatos,'lista');
  assert.equal(body.historico.registros,0);
  assert.equal(body.historico.primeraFila,null);
  assert.equal(body.historico.ultimaFila,null);
  assert.equal(JSON.stringify(body).includes('private-station-id-do-not-disclose'),false);
  assert.equal(upstream.mock.callCount(),4);
});


test('KSTAR primer dia real simulado: respuesta 000000, entrada 658.92 y salida 0', async t => {
  const fetcher=t.mock.method(globalThis,'fetch',async url=>{
    const p=new URL(url).pathname;
    if(p==='/api/authentication/form')
      return json({token:{access_token:'fictitious-regression-token',expires_in:3600}});
    if(p==='/api/station/monitor/detail/meter/list')
      return json({code:200,rows:[{deviceId:'M_TEST',stationId:ENV.SPC_STATION_ID}],total:1});
    if(p==='/api/meter/monitor/detail/history/data')
      return json({code:200,rows:[
        {saveTime:'2026-10-19 23:56:34',positiveActiveElec:147636.2969,reverseActiveElec:2140.5901},
        {saveTime:'2026-10-19 00:02:03',positiveActiveElec:146977.375,reverseActiveElec:2140.5901},
      ],total:2});
    if(p==='/api/station/monitor/detail/self')
      return json({code:'000000',success:true,data:{
        positiveElec:658.92,reverseElec:0,selfConsumption:74}});
    throw Error('Unexpected path');
  });
  const resp=await worker.fetch(request(),ENV);
  assert.equal(resp.status,200);
  const d=await resp.json();
  assert.equal(d.ok,true);
  assert.equal(d.importKWh,658.92);
  assert.equal(d.exportKWh,0);
  assert.equal(d.selfConsumptionKWh,74);
  assert.equal(d.proveedor.codigo,'000000');
  assert.equal(d.complete,true);
  assert.equal(d.historico.registros,2);
  assert.equal(fetcher.mock.callCount(),4);
  for(const secret of [ENV.SPC_USER,ENV.SPC_PASS,'fictitious-regression-token'])
    assert.equal(JSON.stringify(d).includes(secret),false);
});

