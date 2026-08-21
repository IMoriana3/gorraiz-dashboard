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
// no-store: sin esto, el navegador puede quedarse con una respuesta vieja y
// hacer creer que un cambio de configuración no ha surtido efecto.
const json=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,
  headers:{'content-type':'application/json;charset=utf-8','cache-control':'no-store',...h}});
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
const dUTC=s=>new Date(s+'T00:00:00Z');

function cors(env,req){
  const org=req.headers.get('Origin');
  // Sin cabecera Origin no es una llamada de navegador (curl, wrangler dev):
  // CORS no pinta nada ahí y la clave de panel sigue siendo obligatoria.
  if(!org)return{ok:true,h:{}};
  const permitidos=(env.ALLOWED_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
  const ok=permitidos.includes(org);
  return{ok:ok,h:{
    'Access-Control-Allow-Origin':ok?org:'null',
    'Access-Control-Allow-Headers':'content-type,x-panel-key',
    'Access-Control-Allow-Methods':'POST,GET,OPTIONS',
    'Access-Control-Max-Age':'86400',
    'Vary':'Origin',
  }};
}

// Con 123,84 kWp y ~142.000 kWh/año de producción, una media horaria de
// cientos de kWh no es plausible: casi seguro que los valores vienen en Wh.
// Se avisa en lugar de corregir a ciegas; el ajuste va por IDE_FACTOR.
function revisaUnidades(filas){
  if(!filas.length)return null;
  const total=filas.reduce((a,f)=>a+f.consumo,0),media=total/filas.length;
  return{totalKWh:Math.round(total),mediaHoraria:+media.toFixed(2),
    aviso:media>500?'La media horaria es de '+Math.round(media)+' kWh, desproporcionada para esta instalación: lo más probable es que el portal sirva Wh. Configura IDE_FACTOR=0.001 y repite.':null};
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

// Si el CUPS no es de la propia cuenta sino de un tercero que te ha
// autorizado (el caso normal cuando la instaladora consulta a su cliente),
// hay que mandar el NIF/CIF del titular en authorizedNif. Si el suministro es
// propio, el parámetro NO debe ir.
function autorizado(env){
  const n=(env.DATADIS_AUTHORIZED_NIF||'').trim();
  return n?{authorizedNif:n}:{};
}

async function datadisSuministro(env,tk){
  const q=new URLSearchParams(autorizado(env)).toString();
  const r=await pedir(DATADIS+'/api-private/api/get-supplies'+(q?'?'+q:''),{headers:{Authorization:'Bearer '+tk}});
  if(!r.ok)throw new Error('Datadis: no se pudo listar suministros (HTTP '+r.status+').');
  const lista=await r.json();
  if(!Array.isArray(lista)||!lista.length)throw new Error(env.DATADIS_AUTHORIZED_NIF
    ?('Datadis: no hay suministros autorizados para el NIF '+env.DATADIS_AUTHORIZED_NIF+'. ¿Ha aceptado el titular la autorización?')
    :'Datadis: la cuenta no tiene ningún suministro dado de alta. Si el CUPS es de un cliente, configura DATADIS_AUTHORIZED_NIF.');
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
    const q=new URLSearchParams(Object.assign({cups:sup.cups,distributorCode:sup.distributorCode,
      startDate:mes,endDate:mes,measurementType:'0',pointType:String(sup.pointType)},autorizado(env)));
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
    titular:env.DATADIS_AUTHORIZED_NIF||'propio',
    desde:desde,hasta:hasta,registros:filas.length,mesesConFallo:fallos}};
}

// ── i-DE (portal de clientes) ────────────────────────────────────────────
// Alternativa a Datadis cuando no se dispone de cuenta de organización: usa
// las mismas credenciales del área privada de i-DE. OJO: es una API interna
// del portal, no documentada ni soportada. Funciona, pero puede cambiar sin
// aviso; Datadis es la vía estable.
const IDE='https://www.i-de.es/consumidores/rest';
const IDE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IDE_CAB={'content-type':'application/json; charset=utf-8',
  'esVersionNueva':'1','idioma':'es','movilAPP':'si','tipoAPP':'ios',
  'Accept':'application/json, text/plain, */*','Accept-Language':'es-ES,es;q=0.9',
  'Origin':'https://www.i-de.es','Referer':'https://www.i-de.es/consumidores/web/guest/login',
  'User-Agent':IDE_UA};

// El fetch de Workers no gestiona cookies: hay que recogerlas del login y
// reenviarlas a mano en cada llamada posterior.
function galleta(r){
  const set=typeof r.headers.getSetCookie==='function'?r.headers.getSetCookie()
    :(r.headers.get('set-cookie')?[r.headers.get('set-cookie')]:[]);
  return set.map(c=>c.split(';')[0]).join('; ');
}
const ideCab=ck=>Object.assign({},IDE_CAB,ck?{cookie:ck}:{});

async function ideLogin(env){
  // Visita previa a la página de login para recoger cookies antes del POST: el
  // portal responde 503 a peticiones que llegan "en frío", sin haber pasado
  // por la web. Si esta visita falla, se intenta el login igualmente.
  let previa='';
  try{
    const w=await pedir('https://www.i-de.es/consumidores/web/guest/login',
      {headers:{'User-Agent':IDE_UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'es-ES,es;q=0.9'}},2);
    previa=galleta(w);
  }catch(e){}
  let r;
  try{
    r=await pedir(IDE+'/loginNew/login/',{method:'POST',headers:ideCab(previa),
      body:JSON.stringify([env.IDE_USER,env.IDE_PASS,'','Android 6.0','Móvil','Chrome 119.0.0.0','0','','s',''])});
  }catch(e){
    // pedir() reintenta los 5xx y acaba lanzando su error genérico, así que el
    // caso interesante hay que explicarlo aquí y no comprobando r.status.
    if(String(e.message).includes('503'))
      throw new Error('i-DE responde 503 al login tras varios intentos. Si el portal te funciona en el navegador, está rechazando la petición por venir de un servidor, y esta vía no sirve: hay que ir por Datadis.');
    throw e;
  }
  if(!r.ok)throw new Error('i-DE: el login devolvió HTTP '+r.status+'.');
  const j=await r.json().catch(()=>({}));
  if(String(j.success)!=='true')
    throw new Error('i-DE: login rechazado'+(j.message?(' ('+j.message+')'):'')+'. Revisa IDE_USER e IDE_PASS.');
  const ck=galleta(r)||previa;
  if(!ck)throw new Error('i-DE: el login no devolvió cookie de sesión.');
  return ck;
}

// El portal trabaja sobre "el contrato seleccionado", así que si la cuenta
// tiene varios hay que elegir el de Gorraiz antes de pedir consumos.
async function ideContratos(env,ck){
  const r=await pedir(IDE+'/cto/listaCtos/',{headers:ideCab(ck)});
  const j=await r.json().catch(()=>({}));
  const lista=Array.isArray(j)?j:(j.contratos||j.lista||[]);
  if(!lista.length)throw new Error('i-DE: la cuenta no devuelve ningún contrato.');
  return lista;
}
async function ideSelecciona(env,ck){
  const lista=await ideContratos(env,ck);
  let i=0;
  if(env.IDE_CUPS){
    const busca=env.IDE_CUPS.toUpperCase();
    // El nombre del campo del CUPS varía según versión del portal, así que se
    // busca por valor en lugar de fiarlo a una clave concreta.
    i=lista.findIndex(c=>Object.values(c).some(v=>String(v).toUpperCase().includes(busca)));
    if(i<0)throw new Error('i-DE: el CUPS '+env.IDE_CUPS+' no está entre los '+lista.length+' contratos de la cuenta.');
  }
  if(lista.length>1){
    const r=await pedir(IDE+'/cto/seleccion/'+i,{headers:ideCab(ck)});
    if(!r.ok)throw new Error('i-DE: no se pudo seleccionar el contrato (HTTP '+r.status+').');
  }
  return{indice:i,contrato:lista[i],total:lista.length};
}

// Cambios de hora: el último domingo de marzo tiene 23 horas y el de octubre
// 25. Sin esto, el reparto de valores por día se desplazaría a partir de ahí.
function ultimoDomingo(y,m){
  const d=new Date(Date.UTC(y,m,0));
  d.setUTCDate(d.getUTCDate()-d.getUTCDay());
  return d.getUTCDate();
}
function horasDelDia(y,m,d){
  if(m===3&&d===ultimoDomingo(y,3))return [0,1,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
  if(m===10&&d===ultimoDomingo(y,10))return [0,1,2,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
  return Array.from({length:24},(_,h)=>h);
}

async function ideConsumo(env,desde,hasta){
  const factor=+(env.IDE_FACTOR||1)||1;
  const ck=await ideLogin(env);
  const sel=await ideSelecciona(env,ck);
  const fmt=d=>pad(d.getUTCDate())+'-'+pad(d.getUTCMonth()+1)+'-'+d.getUTCFullYear();
  const filas=[],fallos=[];
  // Se pide mes a mes para no depender de cuánto rango acepta el portal de una
  // vez y para acotar el efecto de un tramo que venga mal.
  for(const mes of meses(desde,hasta)){
    const p=mes.split('/'),y=+p[0],m=+p[1];
    const ini=new Date(Date.UTC(y,m-1,1)),fin=new Date(Date.UTC(y,m,0));
    try{
      const r=await pedir(IDE+'/consumoNew/obtenerDatosConsumoDH/'+fmt(ini)+'/'+fmt(fin)+'/horas/USU/',{headers:ideCab(ck)});
      if(!r.ok){fallos.push(mes+': HTTP '+r.status);continue}
      const j=await r.json().catch(()=>null);
      const d0=Array.isArray(j)?j[0]:j;
      const vals=d0&&d0.valores;
      if(!Array.isArray(vals)||!vals.length){fallos.push(mes+': sin valores');continue}
      // fechaDesde manda sobre lo pedido: el portal puede recortar el rango.
      const fd=String(d0.fechaDesde||'').split('-');
      let dia=fd.length===3?+fd[0]:1,mm=fd.length===3?+fd[1]:m,yy=fd.length===3?+fd[2]:y;
      let i=0;
      while(i<vals.length){
        const horas=horasDelDia(yy,mm,dia);
        for(const h of horas){
          if(i>=vals.length)break;
          const v=vals[i++];
          let kwh=v&&typeof v==='object'?+v.valor:+v;
          if(isNaN(kwh))continue;
          kwh*=factor;
          const f=yy+'-'+pad(mm)+'-'+pad(dia);
          if(f<desde||f>hasta)continue;
          filas.push({ts:f+'T'+pad(h)+':00:00',consumo:kwh,gen:0,periodo:periodo(yy,mm,dia,h)});
        }
        const ultimo=new Date(Date.UTC(yy,mm,0)).getUTCDate();
        if(++dia>ultimo){dia=1;if(++mm>12){mm=1;yy++}}
      }
    }catch(e){fallos.push(mes+': '+e.message)}
  }
  filas.sort((a,b)=>a.ts<b.ts?-1:a.ts>b.ts?1:0);
  const u=revisaUnidades(filas);
  return{rows:filas,meta:Object.assign({fuente:'i-DE (portal)',contrato:sel.indice+1+' de '+sel.total,
    desde:desde,hasta:hasta,registros:filas.length,mesesConFallo:fallos,factor:factor},u||{})};
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
    const c=cors(env,req),h=c.h;
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:h});
    if(!c.ok)
      return json({error:'Origen no autorizado. Revisa ALLOWED_ORIGIN en el Worker.'},403,h);
    // Distinguir los dos casos ahorra mucho tiempo: si PANEL_KEY no llega, lo
    // habitual es haberla puesto en las variables de *compilación* (Settings →
    // Build) en lugar de en las de ejecución (Settings → Variables and Secrets).
    const url=new URL(req.url);
    const ruta=url.pathname.replace(/\/+$/,'');
    // Las rutas de diagnóstico admiten la clave por parámetro y método GET,
    // para poder abrirlas desde la barra del navegador. Solo ellas: /consumo y
    // /produccion siguen exigiendo la cabecera.
    const esDiag=ruta.endsWith('/diagnostico');
    const clave=req.headers.get('X-Panel-Key')||(esDiag?(url.searchParams.get('k')||''):'');

    if(!env.PANEL_KEY)
      return json({error:'El Worker no tiene PANEL_KEY configurada. Compruébalo en Settings → Variables and Secrets (las de ejecución, no las de Build).',
        pistas:{ALLOWED_ORIGIN:env.ALLOWED_ORIGIN||null,IDE_USER:!!env.IDE_USER,IDE_PASS:!!env.IDE_PASS,DATADIS_USER:!!env.DATADIS_USER}},401,h);
    if(clave.trim()!==String(env.PANEL_KEY).trim())
      return json({error:'La clave de panel no coincide con la PANEL_KEY del Worker.'},401,h);

    try{
      if(ruta==='/estado')return json({
        datadis:!!(env.DATADIS_USER&&env.DATADIS_PASS),
        datadisAutorizado:!!env.DATADIS_AUTHORIZED_NIF,
        ide:!!(env.IDE_USER&&env.IDE_PASS),
        solarman:!!(env.SOLARMAN_APPID&&env.SOLARMAN_APPSECRET&&env.SOLARMAN_EMAIL&&env.SOLARMAN_PASS),
      },200,h);

      const b=req.method==='POST'?await req.json().catch(()=>({}))
        :Object.fromEntries(url.searchParams);
      const desde=b.desde,hasta=b.hasta;
      if(ruta==='/consumo'||ruta==='/produccion'){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(desde||'')||!/^\d{4}-\d{2}-\d{2}$/.test(hasta||''))
          return json({error:'Faltan las fechas (desde/hasta en formato AAAA-MM-DD).'},400,h);
        if(desde>hasta)return json({error:'La fecha inicial es posterior a la final.'},400,h);
      }
      if(ruta==='/consumo'){
        // Datadis manda si está configurado (es la vía oficial y estable);
        // i-DE queda como alternativa cuando no hay cuenta de organización.
        const fuente=b.fuente||(env.DATADIS_USER?'datadis':(env.IDE_USER?'ide':''));
        if(fuente==='datadis'){
          if(!env.DATADIS_USER)return json({error:'Datadis no está configurado en el Worker.'},501,h);
          return json(await datadisConsumo(env,desde,hasta),200,h);
        }
        if(fuente==='ide'){
          if(!env.IDE_USER)return json({error:'i-DE no está configurado en el Worker.'},501,h);
          return json(await ideConsumo(env,desde,hasta),200,h);
        }
        return json({error:'No hay ninguna fuente de consumo configurada (ni Datadis ni i-DE).'},501,h);
      }
      if(ruta==='/ide/diagnostico'){
        if(!env.IDE_USER)return json({error:'i-DE no está configurado.'},501,h);
        const ck=await ideLogin(env);
        const contratos=await ideContratos(env,ck);
        const res={contratos:contratos};
        // Un día en crudo: es lo que permite ver de una vez el nombre de los
        // campos, la forma de 'valores' y la magnitud real de las cifras.
        if(b.dia&&/^\d{4}-\d{2}-\d{2}$/.test(b.dia)){
          await ideSelecciona(env,ck);
          const p=b.dia.split('-'),f=p[2]+'-'+p[1]+'-'+p[0];
          const r=await pedir(IDE+'/consumoNew/obtenerDatosConsumoDH/'+f+'/'+f+'/horas/USU/',{headers:ideCab(ck)});
          const j=await r.json().catch(()=>null);
          const d0=Array.isArray(j)?j[0]:j;
          res.dia={http:r.status,claves:d0?Object.keys(d0):null,fechaDesde:d0&&d0.fechaDesde,
            nValores:d0&&d0.valores?d0.valores.length:0,
            primeros:d0&&d0.valores?d0.valores.slice(0,5):null};
        }
        return json(res,200,h);
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
