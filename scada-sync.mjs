import {normalizeSourcePower} from './scada-units.mjs';

// Acceso a archivo común para el SCADA (mismo Durable Object que Informe).
// Lectura/guardado NO consulta Solarman ni el proveedor KSTAR; SPC solo se
// consulta desde downloadSpcDay(), siempre tras un clic explícito.
const $=id=>document.getElementById(id);
const notify=msg=>{const el=$('sharedState');if(el)el.textContent=msg};
const today=()=>{
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',
  year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
 return p.year+'-'+p.month+'-'+p.day;
};
function settings(){
 let c;
 try{c=JSON.parse(localStorage.getItem('gorraiz_api_cfg')||'{}')}catch{}
 if(!c?.url||!c?.key)throw Error('Falta la configuración del Worker principal (Informe).');
 const u=new URL(c.url);
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)
   throw Error('URL de Worker compartido no autorizada.');
 return{url:u.origin+u.pathname.replace(/\/$/,''),key:c.key};
}
async function central(path,body){
 const c=settings();
 const r=await fetch(c.url+path,{method:body?'POST':'GET',cache:'no-store',
  headers:{'content-type':'application/json','X-Panel-Key':c.key},
  body:body?JSON.stringify(body):undefined});
 const value=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(value.error||'Respuesta central HTTP '+r.status);
 return value;
}
function buckets(keys){
 const ds=[...new Set(keys)].sort(),out=[];
 for(let i=0;i<ds.length;){
  const start=ds[i],limit=new Date(Date.parse(start+'T00:00:00Z')+30*864e5).toISOString().slice(0,10);
  let j=i;while(j+1<ds.length&&ds[j+1]<=limit)j++;
  out.push({desde:start,hasta:ds[j]});i=j+1;
 }
 return out;
}
function openDB(){
 return new Promise((ok,fail)=>{
  const r=indexedDB.open('gorraiz_datos',1);
  r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('fuentes'))
    r.result.createObjectStore('fuentes',{keyPath:'id'})};
  r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);
 });
}
async function readLocal(){
 const db=await openDB();
 return new Promise((resolve,reject)=>{
  const r=db.transaction('fuentes','readonly').objectStore('fuentes').getAll();
  r.onsuccess=()=>{db.close();resolve(r.result||[])};
  r.onerror=()=>{db.close();reject(r.error)};
 });
}
async function writeLocal(sources){
 const db=await openDB();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction('fuentes','readwrite'),st=tx.objectStore('fuentes');
  for(const f of sources){
   if(f.tipo==='A'||f.tipo==='B'){
    const rows=(f.rows||[]).map(x=>({...x,ts:new Date(x.ts)})).filter(x=>Number.isFinite(+x.ts));
    if(rows.length)st.put({id:f.tipo+'|Compartido '+f.fecha,
      tipo:f.tipo,nombre:'Compartido '+f.fecha,updatedAt:f.updatedAt,rows});
   }else if(f.tipo==='S'&&f.payload){
    const id='S|'+f.fecha;
    const q=st.get(id);
    q.onsuccess=()=>{
     const current=q.result?.payload,next=f.payload;
     const a=Date.parse(current?.meta?.fetchedAt||current?.meta?.actualizado||0);
     const b=Date.parse(next.meta?.fetchedAt||next.meta?.actualizado||0);
     if(current?.meta?.completo===true&&(next.meta?.completo!==true||a>b))return;
     st.put({id,tipo:'S',fecha:f.fecha,payload:next});
    };
   }
  }
  tx.oncomplete=()=>{db.close();resolve()};
  tx.onerror=()=>{db.close();reject(tx.error)};
 });
}
let busy=false;
export async function pullShared({all=false,date=null}={}){
 if(busy)return false;
 let cfg;
 try{cfg=settings()}catch{notify('Worker central no configurado; se mantienen los datos locales.');return false}
 busy=true;const button=$('pullHistory');if(button)button.disabled=true;
 try{
  const state=await central('/historico/estado');
  const dates=[...new Set([...(state.dias?.A||[]),...(state.dias?.B||[]),...(state.dias?.S||[])])].sort();
  if(!dates.length){notify('Archivo central vacío: «Compartir copia local» incorporará los datos de este equipo.');return false}
  const latest=dates.at(-1);
  const cutoff=new Date(Date.parse(latest+'T00:00:00Z')-44*864e5).toISOString().slice(0,10);
  let saved=0;
  for(const block of buckets(dates.filter(d=>all||d>=cutoff||d===date))){
   const r=await central('/historico/datos',block);
   await writeLocal(r.fuentes||[]);
   saved+=(r.fuentes||[]).length;
  }
  notify('Histórico central: '+saved+' días/equipos recuperados sin consulta a proveedores. Cobertura: A '+
    (state.cobertura?.A?.dias||0)+' días, B '+(state.cobertura?.B?.dias||0)+
    ', SPC '+(state.cobertura?.S?.dias||0)+'.');
  return saved>0;
 }catch(e){notify('Archivo central no disponible: '+e.message+'. Datos locales conservados.');return false}
 finally{busy=false;if(button)button.disabled=false}
}
function madridDay(v){
 const d=new Date(v);
 if(!Number.isFinite(+d))return null;
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',
  year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).map(x=>[x.type,x.value]));
 return p.year+'-'+p.month+'-'+p.day;
}
export async function pushShared(){
 if(busy)return;
 busy=true;const btn=$('pushHistory');if(btn)btn.disabled=true;
 let uploaded=0,unverified=0;
 const failures=[];
 async function pushBlock(items){
  try{
   const inspection=await central('/historico/validar',{items});
   if(inspection.version!=='migracion-v3')
     throw Error('Worker central desactualizado: el migrador v3 no está desplegado.');
   const rejected=new Set((inspection.incidencias||[]).map(x=>x.tipo+'|'+x.fecha));
   for(const reason of inspection.incidencias||[])
     failures.push(reason.tipo+' '+reason.fecha+': '+reason.motivo);
   const acceptable=items.filter(x=>!rejected.has(x.tipo+'|'+x.fecha));
   if(acceptable.length){
     const res=await central('/historico/guardar',{items:acceptable});
     if(res.version!=='migracion-v3')
       throw Error('Versión inesperada del archivo común; no continuar.');
     uploaded+=res.guardadas||0;
     unverified+=res.pendientesPotencia||0;
     for(const reason of res.incidencias||[])
       failures.push(reason.tipo+' '+reason.fecha+': '+reason.motivo);
   }
   notify('Migración v3: '+uploaded+' guardados, '+failures.length+
     ' rechazados, '+unverified+' potencias pendientes. '+
     (failures.length?'Primero: '+failures[0]+'. ':'')+'Sin consultar proveedores.');
  }catch(e){
   if(items.length>1&&
      !/PANEL_KEY|clave de panel|SOLARMAN_QUOTA|coordinador central|credencial|desactualizado|Versión inesperada/i.test(e.message)){
     const mid=Math.floor(items.length/2);
     await pushBlock(items.slice(0,mid));
     await pushBlock(items.slice(mid));
     return;
   }
   if(items.length>1)throw e;
   failures.push(items[0].tipo+' '+items[0].fecha+': '+e.message);
  }
 }
 try{
  const data=await readLocal(),group=new Map();
  for(const f of data){
   if(f.tipo==='S'&&f.fecha&&f.payload?.meta?.fuente==='spc'){
    group.set('S|'+f.fecha,{tipo:'S',fecha:f.fecha,payload:f.payload});continue;
   }
   if(!['A','B'].includes(f.tipo)||!Array.isArray(f.rows))continue;
   for(const row of f.rows){
    const date=madridDay(row.ts);
    if(!date)continue;
    const key=f.tipo+'|'+date;
    if(!group.has(key))group.set(key,{tipo:f.tipo,fecha:date,unidadPotencia:'kW',rows:new Map()});
    const stamp=row.ts instanceof Date?row.ts.toISOString():String(row.ts);
    const power=normalizeSourcePower(f,row.pot);
    const previous=group.get(key).rows.get(stamp);
    const measurement={ts:stamp,pot:power.pot,acum:row.acum??null,dia:row.dia??null};
    const unverifiedRaw=power.potSinValidar??row.potSinValidar??null;
    if(unverifiedRaw!==null&&power.pot===null)measurement.potSinValidar=unverifiedRaw;
    group.get(key).rows.set(stamp,previous?{
      ...previous,...measurement,
      pot:measurement.pot??previous.pot??null,
      acum:measurement.acum??previous.acum??null,
      dia:measurement.dia??previous.dia??null
    }:measurement);
   }
  }
  const items=[...group.values()].map(v=>v.rows instanceof Map?
    {...v,rows:[...v.rows.values()]}:v);
  if(!items.length){notify('No hay lecturas FV/SPC locales que subir.');return}
  items.sort((a,b)=>a.fecha.localeCompare(b.fecha));
  for(let i=0;i<items.length;i+=12)await pushBlock(items.slice(i,i+12));
  notify('Migración v3 finalizada: '+uploaded+'/'+items.length+' conjuntos guardados, '+
    failures.length+' rechazados y '+unverified+' potencias pendientes. '+
    (failures.length?'Primera incidencia: '+failures[0]+'. ':'')+
    'No se ha consultado Solarman ni SPC.');
 }catch(e){
  notify('Migración interrumpida por error general tras '+uploaded+
    ' conjuntos: '+e.message+'. Puedes reintentar; no se ha borrado nada.');
 }finally{busy=false;if(btn)btn.disabled=false}
}

export async function downloadSpcDay(date){
 if(busy)return false;
 if(!date||date>=today()){notify('SPC solo admite un día cerrado anterior a hoy (Madrid).');return false}
 // Si el día SPC ya está completo en IndexedDB no hacer otra solicitud HTTP.
 const local=await readLocal().catch(()=>[]);
 if(local.some(x=>x.tipo==='S'&&x.fecha===date&&x.payload?.meta?.completo===true)){
   notify('SPC '+date+': día cerrado ya guardado. No se ha vuelto a consultar a KSTAR.');
   return false;
 }
 const url=localStorage.getItem('gorraiz_kstar_url_v1')||'';
 const key=localStorage.getItem('gorraiz_kstar_clave_v1')||
   sessionStorage.getItem('gorraiz_kstar_key_sesion_v1')||'';
 let endpoint,headers;
 try{
  if(url){
   const worker=new URL(url);
   if(worker.protocol!=='https:'||!worker.hostname.endsWith('.workers.dev')||worker.username||
      worker.password||worker.search||worker.hash||worker.pathname!=='/'||key.length<24)
      throw Error('Worker KSTAR aislado o su clave no son válidos.');
   endpoint=worker.origin+'/spc/intercambio';
   headers={'content-type':'application/json','X-KSTAR-Test-Key':key};
  }else{
   // Mismo proveedor desde el Worker central cuando este tenga SPC activado.
   // No consulta jamás la ruta /produccion.
   const main=settings();
   endpoint=main.url+'/spc/intercambio';
   headers={'content-type':'application/json','X-Panel-Key':main.key};
  }
 }catch(e){
  notify('No se pudo preparar KSTAR: '+e.message+
    '. Configura su Worker aislado o el Worker central con SPC de solo lectura.');
  return false;
 }
 busy=true;const btn=$('fetchSPC');if(btn)btn.disabled=true;
 try{
  const response=await fetch(endpoint,{
   method:'POST',cache:'no-store',headers,
   body:JSON.stringify({desde:date,hasta:date})});
  const p=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(p.error||('Respuesta SPC HTTP '+response.status));
  if(p?.meta?.fuente!=='spc'||p.meta.stationId!=='2026032317114373'||
    p.meta.meterId!=='210261430F3060020000661'||p.daily?.[0]?.date!==date||
    !Array.isArray(p.rows))throw Error('SPC devolvió una identidad o formato incorrectos.');
  await writeLocal([{tipo:'S',fecha:date,payload:p}]);
  try{
   const saved=await central('/historico/guardar',{items:[{tipo:'S',fecha:date,payload:p}]});
   if(saved.guardadas!==1)throw Error(saved.incidencias?.[0]?.motivo||'El archivo central no confirmó el día');
   notify('SPC '+date+': '+p.rows.length+' muestras descargadas · día guardado en archivo compartido. Solarman no consultado.');
  }catch(e){notify('SPC '+date+' guardado localmente, pero no se pudo copiar al servidor: '+e.message)}
  return true;
 }catch(e){notify('No se pudo descargar SPC: '+e.message+'. Sin borrar histórico previo.');return false}
 finally{busy=false;if(btn)btn.disabled=false}
}
