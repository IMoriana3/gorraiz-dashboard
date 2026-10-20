import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../worker/index.js';

const base={
  PANEL_KEY:'fictional-panel-key-123456789',
  ALLOWED_ORIGIN:'https://imoriana3.github.io',
  SOLARMAN_APPID:'fictional-app-id',
  SOLARMAN_APPSECRET:'fictional-app-secret',
  SOLARMAN_EMAIL:'valid@example.invalid',
  SOLARMAN_PASS:'original-not-hashed-password',
  SOLARMAN_ORGID:'10865841',
  SOLARMAN_BASE:'https://globalapi.solarmanpv.com',
};
const url='https://gorraiz-dashboard.example.workers.dev';
function prod(){
  return new Request(url+'/produccion',{method:'POST',
    headers:{'X-Panel-Key':base.PANEL_KEY,'Origin':'https://imoriana3.github.io',
      'Content-Type':'application/json'},
    body:JSON.stringify({desde:'2026-10-19',hasta:'2026-10-19'})});
}
function state(){
  return new Request(url+'/estado',{headers:{
    'X-Panel-Key':base.PANEL_KEY,'Origin':'https://imoriana3.github.io'}});
}
const hash=createHash('sha256').update(base.SOLARMAN_PASS).digest('hex');

for(const [tipo,override,campo,value] of [
  ['email',{},'email',base.SOLARMAN_EMAIL],
  ['username',{SOLARMAN_LOGIN_TYPE:'username',SOLARMAN_USERNAME:'BusinessUser42'},
    'username','BusinessUser42'],
  ['mobile',{SOLARMAN_LOGIN_TYPE:'mobile',SOLARMAN_MOBILE:'612345678',
    SOLARMAN_COUNTRY_CODE:'34'},'mobile','612345678'],
]){
  test('Solarman login '+tipo+' envía solo '+campo+' con contraseña SHA256 y ORGID',async t=>{
    const env={...base,...override};
    const outbound=t.mock.method(globalThis,'fetch',async(r,init)=>{
      const parsed=new URL(r);
      assert.equal(parsed.origin,env.SOLARMAN_BASE);
      assert.equal(parsed.pathname,'/account/v1.0/token');
      assert.equal(parsed.searchParams.get('appId'),env.SOLARMAN_APPID);
      const payload=JSON.parse(init.body);
      assert.equal(payload[campo],value);
      assert.equal(payload.appSecret,env.SOLARMAN_APPSECRET);
      assert.equal(payload.password,hash);
      assert.equal(payload.orgId,10865841);
      if(tipo==='mobile')assert.equal(payload.countryCode,'34');
      for(const other of ['email','username','mobile'].filter(x=>x!==campo))
        assert.equal(payload[other],undefined);
      // Simula proveedor que rechaza sin revelar credenciales.
      return new Response(JSON.stringify({success:false,msg:'auth failed'}),{
        status:200,headers:{'content-type':'application/json'}});
    });
    const r=await worker.fetch(prod(),env);
    assert.equal(r.status,502);
    const body=await r.json();
    assert.match(body.error,/login rechazado/);
    assert.match(body.error,new RegExp('identificador '+tipo));
    assert.match(body.error,/no prueba por sí solo/);
    assert.equal(outbound.mock.callCount(),1,'no probar centros ni identidades adicionales sin permiso');
    for(const secret of [env.SOLARMAN_PASS,env.SOLARMAN_APPSECRET,hash,env.SOLARMAN_EMAIL])
      assert.equal(body.error.includes(secret),false);
    const status=(await worker.fetch(state(),env));
    assert.equal(status.status,200);
    const st=await status.json();
    assert.equal(st.solarman,true);
    assert.equal(st.solarmanLoginType,tipo);
    assert.equal(st.solarmanLoginVariable,
      tipo==='email'?'SOLARMAN_EMAIL':tipo==='username'?'SOLARMAN_USERNAME':'SOLARMAN_MOBILE');
    assert.equal(st.solarmanLoginConfigurado,true);
    assert.equal(st.solarmanPasswordPareceHashPrevio,false);
  });
}
test('modo de cuenta Solarman inválido se rechaza sin contactar proveedor',async t=>{
  const external=t.mock.method(globalThis,'fetch',()=>{throw Error('should not reach network')});
  const response=await worker.fetch(prod(),{...base,SOLARMAN_LOGIN_TYPE:'both'});
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/SOLARMAN_LOGIN_TYPE debe ser/);
  assert.equal(external.mock.callCount(),0);
});
test('username ausente se identifica por variable, sin contactar proveedor',async t=>{
  const external=t.mock.method(globalThis,'fetch',()=>{throw Error('should not reach network')});
  const env={...base,SOLARMAN_LOGIN_TYPE:'username'};
  const response=await worker.fetch(prod(),env);
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/falta SOLARMAN_USERNAME/);
  assert.equal(external.mock.callCount(),0);
  const r=await worker.fetch(state(),env);
  assert.equal((await r.json()).solarman,false);
});
test('sin correo válido se propone seleccionar método username',async t=>{
  const external=t.mock.method(globalThis,'fetch',()=>{throw Error('should not reach network')});
  const env={...base,SOLARMAN_EMAIL:'logindesolarman'};
  const response=await worker.fetch(prod(),env);
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/no parece un correo electrónico/);
  assert.equal(external.mock.callCount(),0);
});
test('cuenta móvil requiere countryCode y no intenta login si falta',async t=>{
  const external=t.mock.method(globalThis,'fetch',()=>{throw Error('should not reach network')});
  const env={...base,SOLARMAN_LOGIN_TYPE:'mobile',SOLARMAN_MOBILE:'612345678'};
  const r=await worker.fetch(prod(),env);
  assert.equal(r.status,502);
  assert.match((await r.json()).error,/SOLARMAN_COUNTRY_CODE/);
  assert.equal(external.mock.callCount(),0);
});
test('estado señala si se pegó una contraseña que parece SHA256 anterior',async()=>{
  const env={...base,SOLARMAN_PASS:'a'.repeat(64)};
  const status=await worker.fetch(state(),env);
  assert.equal(status.status,200);
  const data=await status.json();
  assert.equal(data.solarmanPasswordPareceHashPrevio,true);
  assert.equal(JSON.stringify(data).includes(env.SOLARMAN_PASS),false);
});
