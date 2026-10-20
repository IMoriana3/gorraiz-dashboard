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
