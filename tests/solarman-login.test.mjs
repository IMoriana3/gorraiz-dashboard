import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import realWorker, {SolarmanQuota} from '../worker/index.js';

// En las pruebas se inyecta un namespace DO de memoria, sin credenciales ni
// contacto con Cloudflare. La entrada pública SIEMPRE usa el coordinador.
const worker={
  async fetch(req,env){
    const memory=new Map();
    const storage={
      async get(k){return memory.get(k)},
      async put(k,v){memory.set(k,v)},
      async transaction(fn){return fn(storage)}
    };
    const quota=new SolarmanQuota({storage},env);
    const namespace={
      idFromName(name){assert.equal(name,'gorraiz-solarman-global-v1');return name},
      get(){return{fetch(url,init){return quota.fetch(new Request(url,init))}}}
    };
    return realWorker.fetch(req,{...env,SOLARMAN_QUOTA:namespace});
  }
};

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
    let intentos=0;
    const outbound=t.mock.method(globalThis,'fetch',async(r,init)=>{
      intentos++;
      const parsed=new URL(r);
      assert.equal(parsed.origin,env.SOLARMAN_BASE);
      assert.equal(parsed.pathname,'/account/v1.0/token');
      assert.equal(parsed.searchParams.get('appId'),env.SOLARMAN_APPID);
      const payload=JSON.parse(init.body);
      assert.equal(payload[campo],value);
      assert.equal(payload.appSecret,env.SOLARMAN_APPSECRET);
      assert.equal(payload.password,hash);
      // El primer intento reproduce el login personal de agosto;
      // solo tras el rechazo se intenta el token de organización.
      assert.equal(payload.orgId,intentos===1?undefined:10865841);
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
    assert.match(body.error,/han fallado los dos modos de login/);
    assert.match(body.error,new RegExp('identificador '+tipo));
    assert.match(body.error,/no prueba por sí solo/);
    assert.equal(outbound.mock.callCount(),2,'solo personal y organización configurada; ninguna identidad adicional');
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


function simulaProveedor(t,{
  personalValido=true,orgValido=true,plantasPersonales=false,
  orgInfo=[{companyId:10865841,companyName:'Amixalan'}],
  listaPersonalError=false,
}={}){
  const tokens=[],rutas=[];
  const reply=j=>new Response(JSON.stringify(j),{status:200,headers:{'content-type':'application/json'}});
  const mock=t.mock.method(globalThis,'fetch',async(u,init)=>{
    const path=new URL(u).pathname;
    rutas.push(path);
    const req=JSON.parse(init.body);
    if(path==='/account/v1.0/token'){
      tokens.push(req);
      const conOrg=req.orgId!==undefined;
      if(conOrg&&!orgValido||!conOrg&&!personalValido)
        return reply({success:false,msg:conOrg?'appId or api is locked':'auth failed'});
      return reply({success:true,access_token:conOrg?'org-token':'personal-token'});
    }
    const token=init.headers.Authorization;
    if(path==='/station/v1.0/list'){
      if(token==='Bearer personal-token'&&listaPersonalError)
        return reply({success:false,msg:'access denied'});
      const tienePlantas=token==='Bearer org-token'||plantasPersonales;
      return reply({success:true,stationList:tienePlantas?[{id:42001}]:[],total:tienePlantas?1:0});
    }
    if(path==='/account/v1.0/info')
      return reply({success:true,orgInfoList:orgInfo});
    if(path==='/station/v1.0/device')
      return reply({success:true,deviceListItems:[
        {deviceSn:'KSTAR-G50-500004',deviceId:4},{deviceSn:'KSTAR-G50-500002',deviceId:2}]});
    if(path==='/device/v1.0/historical')
      return reply({success:true,paramDataList:[{
        collectTime:Math.floor(Date.parse('2026-10-19T12:00:00Z')/1000),
        dataList:[{key:'APo_t1',value:'31.5'},
          {key:'Et_ge0',value:'21372.1'},{key:'Etdy_ge1',value:'100.1'}]}]});
    throw new Error('Petición SOLARMAN no prevista: '+path);
  });
  return{tokens,rutas,mock};
}

test('regresión agosto: token personal sin orgId descubre Amixalan aun existiendo SOLARMAN_ORGID',async t=>{
  const env={...base};
  const api=simulaProveedor(t);
  const response=await worker.fetch(prod(),env);
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null,10865841]);
  assert.deepEqual(api.rutas.slice(0,4),[
    '/account/v1.0/token','/station/v1.0/list',
    '/account/v1.0/info','/account/v1.0/token']);
  assert.equal(api.tokens[0].email,env.SOLARMAN_EMAIL);
  assert.equal(api.tokens[0].password,hash);
  assert.equal(data.meta.organizacion.id,10865841);
  assert.equal(data.meta.organizacion.nombre,'Amixalan');
  assert.equal(data.meta.organizacion.automatico,false);
  assert.equal(data.A.length,1);
  assert.equal(data.B.length,1);
  assert.equal(data.A[0].pot,31.5);
  assert.equal(data.A[0].acum,21372.1);
});

test('sin orgId configurado conserva autodetección exacta de la PR #21',async t=>{
  const api=simulaProveedor(t);
  const env={...base,SOLARMAN_ORGID:undefined};
  const response=await worker.fetch(prod(),env);
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null,10865841]);
  assert.equal(data.meta.organizacion.nombre,'Amixalan');
  assert.equal(data.meta.organizacion.automatico,true);
  assert.equal(data.A.length,1);
});

test('cuenta Business que rechaza token personal acepta el de organización configurada',async t=>{
  const api=simulaProveedor(t,{personalValido:false});
  const response=await worker.fetch(prod(),base);
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null,10865841]);
  assert.equal(api.rutas.includes('/account/v1.0/info'),false);
  assert.equal(data.meta.organizacion.id,'10865841');
  assert.equal(data.meta.organizacion.automatico,false);
  assert.equal(data.A.length,1);
});

test('token personal válido con plantas accesibles no realiza login organizativo extra',async t=>{
  const api=simulaProveedor(t,{plantasPersonales:true});
  const response=await worker.fetch(prod(),base);
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null]);
  assert.equal(data.meta.organizacion,null);
  assert.equal(data.B.length,1);
});

test('si el token personal ve cero plantas pero su cuenta tiene otra organización se detiene',async t=>{
  const api=simulaProveedor(t,{
    orgInfo:[{companyId:999999,companyName:'Otra organización'}],
  });
  const response=await worker.fetch(prod(),base);
  assert.equal(response.status,502);
  const body=await response.json();
  assert.match(body.error,/SOLARMAN_ORGID no coincide/);
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null]);
});

test('rollback sin SOLARMAN_ORGID: fallback real Amixalan tras login personal rechazado',async t=>{
  const api=simulaProveedor(t,{personalValido:false});
  const env={...base,SOLARMAN_ORGID:undefined};
  const response=await worker.fetch(prod(),env);
  assert.equal(response.status,200,await response.clone().text());
  const data=await response.json();
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null,10865841]);
  assert.equal(data.meta.organizacion.id,'10865841');
  assert.equal(data.meta.organizacion.nombre,'Amixalan (Gorraiz)');
  assert.equal(data.meta.organizacion.automatico,true);
  assert.equal(data.A.length,1);
  assert.equal(data.B.length,1);

  const estado=await worker.fetch(state(),env);
  const st=await estado.json();
  assert.equal(st.solarman,true);
  assert.equal(st.solarmanOrgId,null);
  assert.equal(st.solarmanOrgIdEfectivo,'10865841');
  assert.equal(st.solarmanOrgIdOrigen,'respaldo-gorraiz');
});

test('sin ORGID y con rechazo real en ambos modos: diagnóstico distinto sin revelar secretos',async t=>{
  const api=simulaProveedor(t,{personalValido:false,orgValido:false});
  const env={...base,SOLARMAN_ORGID:undefined};
  const response=await worker.fetch(prod(),env);
  assert.equal(response.status,502);
  const result=await response.json();
  assert.match(result.error,/han fallado los dos modos de login/);
  assert.match(result.error,/Personal:/);
  assert.match(result.error,/Organización:/);
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null,10865841]);
  for(const secret of [env.SOLARMAN_PASS,env.SOLARMAN_APPSECRET,hash,env.SOLARMAN_EMAIL])
    assert.equal(result.error.includes(secret),false);
});

test('ORGID configurado tiene prioridad sobre respaldo fijo de Gorraiz',async t=>{
  const api=simulaProveedor(t,{personalValido:false});
  const env={...base,SOLARMAN_ORGID:'12345678'};
  const response=await worker.fetch(prod(),env);
  assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null,12345678]);
  const result=await response.json();
  assert.equal(result.meta.organizacion.id,'12345678');
  assert.equal(result.meta.organizacion.automatico,false);
  const estado=await worker.fetch(state(),env);
  const st=await estado.json();
  assert.equal(st.solarmanOrgIdEfectivo,'12345678');
  assert.equal(st.solarmanOrgIdOrigen,'configurado');
});

test('token personal válido sin permiso para listar plantas cambia a organización configurada',async t=>{
  const api=simulaProveedor(t,{listaPersonalError:true});
  const response=await worker.fetch(prod(),base);
  assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(api.tokens.map(x=>x.orgId??null),[null,10865841]);
});
