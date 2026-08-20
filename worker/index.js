// ═══════════════════════════════════════════════════════════════════════════
// Gorraiz Dashboard — proxy de datos (Cloudflare Worker)
//
// El dashboard es una página estática: desde el navegador NO se puede llamar
// ni a Datadis ni a Solarman (no mandan cabeceras CORS y exigen credenciales
// que quedarían a la vista en el HTML). Este Worker es la pieza mínima que
// guarda las credenciales y hace esas llamadas por su cuenta.
//
// Devuelve los datos ya normalizados con la MISMA forma que produce la carga
// de ficheros .xlsx, para que el resto del informe no se entere del cambio.
// ═══════════════════════════════════════════════════════════════════════════
import {periodo} from './periodos.js';

const DATADIS='https://datadis.es';
const SOLARMAN='https://globalapi.solarmanpv.com';

// ── utilidades ───────────────────────────────────────────────────────────
const json=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json;charset=utf-8',...h}});
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
const dUTC=s=>new Date(s+'T00:00:00Z');

function cors(env,req){
  const org=req.headers.get('Origin')||'';
  const permitidos=(env.ALLOWED_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
  // Sin ALLOWED_ORIGIN configurado no se abre a cualquiera: se deniega.
  const ok=permitidos.includes(org);
  return{
    'Access-Control-Allow-Origin':ok?org:'null',
    'Access-Control-Allow-Headers':'content-type,x-panel-key',
    'Access-Control-Allow-Methods':'POST,GET,OPTIONS',
    'Access-Control-Max-Age':'86400',
    'Vary':'Origin',
  };
}

// Reintento con espera creciente: Datadis va lento y corta si se le aprieta.
async function pedir(url,opt={},intentos=3){
  let ultimo;
  for(let i=0;i<intentos;i++){
    try{
      const r=await fetch(url,opt);
      if(r.status===429||r.status>=500){ultimo=new Error('HTTP '+r.status+' en '+new URL(url).pathname)}
      else return r;
    }catch(e){ultimo=e}
    await new Promise(s=>setTimeout(s,1000*Math.pow(2,i)));
  }
  throw ultimo;
}

// ── DATADIS ──────────────────────────────────────────────────────────────
// Autenticación: NIF + contraseña de la cuenta de datadis.es. Devuelve el JWT
// en texto plano, no en JSON.
async function datadisToken(env){
  const body=new URLSearchParams({username:env.DATADIS_USER,password:env.DATADIS_PASS});
  const r=await pedir(DATADIS+'/nikola-auth/tokens/login',{method:'POST',body,
    headers:{'content-type':'application/x-www-form-urlencoded'}});
  if(!r.ok)throw new Error('Datadis: login rechazado (HTTP '+r.status+'). Revisa DATADIS_USER (NIF) y DATADIS_PASS.');
  const t=(await r.text()).trim();
  if(!t||t.length<20)throw new Error('Datadis: el login no devolvió token.');
  return t;
}

async function datadisSuministro(env,tk){
  const r=await pedir(DATADIS+'/api-private/api/get-supplies',{headers:{Authorization:'Bearer '+tk}});
  if(!r.ok)throw new Error('Datadis: no se pudo listar suministros (HTTP '+r.status+').');
  const lista=await r.json();
  if(!Array.isArray(lista)||!lista.length)throw new Error('Datadis: la cuenta no tiene ningún suministro dado de alta.');
  const cups=env.DATADIS_CUPS;
  const s=cups?lista.find(x=>String(x.cups||'').toUpperCase().startsWith(cups.toUpperCase())):lista[0];
  if(!s)throw new Error('Datadis: el CUPS '+cups+' no está en esta cuenta. Disponibles: '+lista.map(x=>x.cups).join(', '));
  return s;
}

// Datadis pide el rango en meses (AAAA/MM) y sirve como mucho un mes por
// llamada: aquí está justo el motivo por el que el histórico llegaba partido.
function meses(desde,hasta){
  const out=[],d=dUTC(desde),f=dUTC(hasta);
  let y=d.getUTCFullYear(),m=d.getUTCMonth()+1;
  while(y<f.getUTCFullYear()||(y===f.getUTCFullYear()&&m<=f.getUTCMonth()+1)){
    out.push(y+'/'+pad(m));
    if(++m>12){m=1;y++}
  }
  return out;
}

async function datadisConsumo(env,desde,hasta){
  const tk=await datadisToken(env);
  const sup=await datadisSuministro(env,tk);
  const filas=[],fallos=[];
  for(const mes of meses(desde,hasta)){
    const q=new URLSearchParams({cups:sup.cups,distributorCode:sup.distributorCode,
      startDate:mes,endDate:mes,measurementType:'0',pointType:String(sup.pointType)});
    try{
      const r=await pedir(DATADIS+'/api-private/api/get-consumption-data?'+q,{headers:{Authorization:'Bearer '+tk}});
      if(!r.ok){fallos.push(mes+': HTTP '+r.status);continue}
      const datos=await r.json();
      if(!Array.isArray(datos))continue;
      for(const f of datos){
        // date 'AAAA/MM/DD' + time '01:00'..'24:00' (hora FINAL del tramo),
        // así que '01:00' es el tramo 00:00-01:00 -> índice horario 0.
        const p=String(f.date).split(/[\/\-]/).map(Number),y=p[0],m=p[1],d=p[2];
        let h=parseInt(String(f.time).slice(0,2),10)-1;
        if(!(y&&m&&d)||isNaN(h))continue;
        if(h<0)h=0;
        if(h>23)h=23;
        const dia=y+'-'+pad(m)+'-'+pad(d);
        if(dia<desde||dia>hasta)continue;
        filas.push({ts:dia+'T'+pad(h)+':00:00',consumo:+f.consumptionKWh||0,
          gen:+f.surplusEnergyKWh||0,periodo:periodo(y,m,d,h)});
      }
    }catch(e){fallos.push(mes+': '+e.message)}
  }
  filas.sort((a,b)=>a.ts<b.ts?-1:a.ts>b.ts?1:0);
  return{rows:filas,meta:{cups:sup.cups,distribuidora:sup.distributorCode,
    desde:desde,hasta:hasta,registros:filas.length,mesesConFallo:fallos}};
}

// ── SOLARMAN ─────────────────────────────────────────────────────────────
// Requiere appId/appSecret (se piden a customerservice@solarmanpv.com).
async function sha256(txt){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function smPost(env,ruta,cuerpo,tk){
  const r=await pedir(SOLARMAN+ruta,{method:'POST',
    headers:Object.assign({'content-type':'application/json'},tk?{Authorization:'Bearer '+tk}:{}),
    body:JSON.stringify(cuerpo)});
  const j=await r.json().catch(()=>({}));
  if(j.success===false)throw new Error('Solarman '+ruta+': '+(j.msg||j.code||'error'));
  return j;
}
async function smToken(env){
  const r=await pedir(SOLARMAN+'/account/v1.0/token?appId='+encodeURIComponent(env.SOLARMAN_APPID)+'&language=en',
    {method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({appSecret:env.SOLARMAN_APPSECRET,email:env.SOLARMAN_EMAIL,
       password:await sha256(env.SOLARMAN_PASS)})});
  const j=await r.json();
  if(!j.access_token)throw new Error('Solarman: login rechazado ('+(j.msg||j.error||'sin token')+').');
  return j.access_token;
}
async function smInversores(env,tk){
  let sid=env.SOLARMAN_STATION_ID;
  if(!sid){
    const l=await smPost(env,'/station/v1.0/list',{page:1,size:20},tk);
    if(!l.stationList||!l.stationList.length)throw new Error('Solarman: la cuenta no tiene plantas.');
    sid=l.stationList[0].id;
  }
  const d=await smPost(env,'/station/v1.0/device?language=en',{stationId:+sid,deviceType:'INVERTER'},tk);
  const inv=(d.deviceListItems||[]).map(x=>({sn:x.deviceSn,id:x.deviceId}));
  if(!inv.length)throw new Error('Solarman: la planta '+sid+' no declara inversores.');
  return{stationId:sid,inv:inv};
}
// Los nombres de los campos varían entre firmwares, así que se busca por
// nombre igual que la carga de .xlsx busca por cabecera de columna.
function smValor(lista,claves){
  for(const it of lista||[]){
    const n=((it.name||'')+' '+(it.key||'')).toLowerCase();
    if(claves.some(k=>n.includes(k)))return +it.value||0;
  }
  return 0;
}
async function smHistorico(env,tk,sn,desde,hasta){
  const out=[];
  for(let d=dUTC(desde);d<=dUTC(hasta);d=new Date(d.getTime()+864e5)){
    const dia=ymd(d);
    // timeType 1 = por tramos dentro del día; el rango debe ser un solo día.
    const j=await smPost(env,'/device/v1.0/historical?language=en',
      {deviceSn:sn,startTime:dia,endTime:dia,timeType:1},tk);
    for(const fr of j.paramDataList||[]){
      const l=fr.dataList||[];
      if(!fr.collectTime)continue;
      out.push({ts:new Date(+fr.collectTime*1000).toISOString(),
        pot:smValor(l,['total ac output power','apo_t','active power']),
        acum:smValor(l,['cumulative production','total production','et_ge0']),
        dia:smValor(l,['daily production','etdy_ge','et_use1'])});
    }
  }
  return out;
}
async function solarmanProduccion(env,desde,hasta){
  const tk=await smToken(env);
  const r=await smInversores(env,tk);
  const res={meta:{stationId:r.stationId,inversores:r.inv.map(i=>i.sn)}};
  for(let i=0;i<r.inv.length&&i<2;i++){
    res[i===0?'A':'B']=await smHistorico(env,tk,r.inv[i].sn,desde,hasta);
  }
  return res;
}
// Sin credenciales no se pueden comprobar los nombres reales de los campos:
// esto devuelve un tramo en crudo para poder mapearlos con certeza el 1er día.
async function solarmanDiagnostico(env,dia){
  const tk=await smToken(env);
  const r=await smInversores(env,tk);
  const j=await smPost(env,'/device/v1.0/historical?language=en',
    {deviceSn:r.inv[0].sn,startTime:dia,endTime:dia,timeType:1},tk);
  const fr=(j.paramDataList||[])[0]||{};
  return{deviceSn:r.inv[0].sn,collectTime:fr.collectTime,
    campos:(fr.dataList||[]).map(x=>({key:x.key,name:x.name,value:x.value}))};
}

// ── enrutado ─────────────────────────────────────────────────────────────
export default{
  async fetch(req,env){
    const h=cors(env,req);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:h});
    if(h['Access-Control-Allow-Origin']==='null')
      return json({error:'Origen no autorizado. Revisa ALLOWED_ORIGIN en el Worker.'},403,h);
    if((req.headers.get('X-Panel-Key')||'')!==(env.PANEL_KEY||' '))
      return json({error:'Clave de panel incorrecta.'},401,h);

    const ruta=new URL(req.url).pathname.replace(/\/+$/,'');
    try{
      if(ruta==='/estado')return json({
        datadis:!!(env.DATADIS_USER&&env.DATADIS_PASS),
        solarman:!!(env.SOLARMAN_APPID&&env.SOLARMAN_APPSECRET&&env.SOLARMAN_EMAIL&&env.SOLARMAN_PASS),
      },200,h);

      const b=req.method==='POST'?await req.json().catch(()=>({})):{};
      const desde=b.desde,hasta=b.hasta;
      if(ruta==='/consumo'||ruta==='/produccion'){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(desde||'')||!/^\d{4}-\d{2}-\d{2}$/.test(hasta||''))
          return json({error:'Faltan las fechas (desde/hasta en formato AAAA-MM-DD).'},400,h);
        if(desde>hasta)return json({error:'La fecha inicial es posterior a la final.'},400,h);
      }
      if(ruta==='/consumo'){
        if(!env.DATADIS_USER)return json({error:'Datadis no está configurado en el Worker.'},501,h);
        return json(await datadisConsumo(env,desde,hasta),200,h);
      }
      if(ruta==='/produccion'){
        if(!env.SOLARMAN_APPID)return json({error:'Solarman aún no está configurado: faltan appId y appSecret.'},501,h);
        return json(await solarmanProduccion(env,desde,hasta),200,h);
      }
      if(ruta==='/solarman/diagnostico'){
        if(!env.SOLARMAN_APPID)return json({error:'Solarman aún no está configurado.'},501,h);
        return json(await solarmanDiagnostico(env,b.dia||ymd(new Date(Date.now()-864e5))),200,h);
      }
      return json({error:'Ruta desconocida.'},404,h);
    }catch(e){
      return json({error:e.message||String(e)},502,h);
    }
  }
};
