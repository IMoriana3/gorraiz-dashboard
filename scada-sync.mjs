import {normalizeSourcePower} from './scada-units.mjs';
import {spcManualRange} from './scada-spc-range.mjs';

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

// Una acción manual de intervalo cerrado de 1–14 días. El servidor KSTAR
// mantiene su contrato seguro: /spc/intercambio recibe día único.
export async function downloadSpcRange(desde,hasta){
 let dates;
 try{dates=spcManualRange(desde,hasta,today())}
 catch(e){notify('Rango SPC no válido: '+e.message);return null}
 if(busy){notify('Hay una operación de sincronización en curso. No se inicia otra descarga SPC.');return null}
 busy=true;
 const mainButton=$('fetchSPC'),pendingButton=$('fetchPendingSPC');
 if(mainButton)mainButton.disabled=true;
 if(pendingButton)pendingButton.disabled=true;
 const result={desde,hasta,total:dates.length,downloaded:0,partial:0,skipped:0,
   central:0,localOnly:0,errors:[],stopped:false};
 const summary=()=>{
   return 'SPC '+desde+(desde===hasta?'':' → '+hasta)+
    ': '+result.downloaded+' días completos descargados, '+
    result.partial+' parciales, '+result.skipped+' ya guardados, '+
    result.central+' en base central, '+result.localOnly+' solo locales, '+
    result.errors.length+' errores. Solarman no consultado.';
 };
 try{
   const local=await readLocal();
   const complete=new Set(local.filter(x=>x.tipo==='S'&&x.fecha&&
     x.payload?.meta?.completo===true).map(x=>x.fecha));
   let endpoint,headers;
   // Antes de contactar al portal, resolver la conexión una sola vez.
   const remaining=dates.filter(d=>!complete.has(d));
   if(remaining.length){
     const url=localStorage.getItem('gorraiz_kstar_url_v1')||'';
     const key=localStorage.getItem('gorraiz_kstar_clave_v1')||
       sessionStorage.getItem('gorraiz_kstar_key_sesion_v1')||'';
     if(url){
       const worker=new URL(url);
       if(worker.protocol!=='https:'||!worker.hostname.endsWith('.workers.dev')||
         worker.username||worker.password||worker.search||worker.hash||
         worker.pathname!=='/'||key.length<24)
         throw Error('El Worker KSTAR aislado o su clave no son válidos.');
       endpoint=worker.origin+'/spc/intercambio';
       headers={'content-type':'application/json','X-KSTAR-Test-Key':key};
     }else{
       const cfg=settings();
       endpoint=cfg.url+'/spc/intercambio';
       headers={'content-type':'application/json','X-Panel-Key':cfg.key};
     }
   }
   for(let i=0;i<dates.length;i++){
     const date=dates[i];
     if(complete.has(date)){
       result.skipped++;
     }else{
       notify('SPC '+(i+1)+'/'+dates.length+
         ': consultando KSTAR del '+date+'; un único día por solicitud…');
       try{
         const response=await fetch(endpoint,{method:'POST',cache:'no-store',headers,
           body:JSON.stringify({desde:date,hasta:date})});
         const p=await response.json().catch(()=>({}));
         if(!response.ok){
           const error=new Error(p.error||('KSTAR SPC HTTP '+response.status));
           error.status=response.status;
           throw error;
         }
         if(p?.meta?.fuente!=='spc'||
           p.meta.stationId!=='2026032317114373'||
           p.meta.meterId!=='210261430F3060020000661'||
           p.daily?.length!==1||p.daily[0]?.date!==date||
           !Array.isArray(p.rows)||
           (p.meta.desde&&p.meta.desde!==date)||
           (p.meta.hasta&&p.meta.hasta!==date))
           throw Error('SPC devolvió estación, contador, día o estructura inesperados.');
         // Primero guardar la copia local; un fallo central nunca la borra.
         await writeLocal([{tipo:'S',fecha:date,payload:p}]);
         const closed=p.meta.completo===true;
         if(closed)result.downloaded++;
         else result.partial++;
         try{
           const saved=await central('/historico/guardar',{items:[
             {tipo:'S',fecha:date,payload:p}]});
           if(saved.guardadas!==1)
             throw Error(saved.incidencias?.[0]?.motivo||
               'La base central no confirmó el día SPC.');
           result.central++;
         }catch(error){
           result.localOnly++;
           result.errors.push(date+': copia local conservada; falta base central: '+error.message);
         }
       }catch(e){
         result.errors.push(date+': '+e.message);
         // No repetir autenticaciones inválidas ni insistir frente a 429.
         if([401,403,429].includes(e.status)){
           result.stopped=true;
           break;
         }
       }
     }
     notify('SPC '+(i+1)+'/'+dates.length+' · '+summary()+
       (result.errors.length?' Última incidencia: '+result.errors.at(-1):''));
   }
   notify('Descarga SPC por rango finalizada · '+summary()+
     (result.stopped?' Detenida para no insistir ante el rechazo del Worker.':'')+
     (result.localOnly?' Usa «Compartir copia local» para reintentar la base central.':'')+
     (result.errors.length?' Incidencias: '+
       result.errors.slice(0,2).join(' | ')+
       (result.errors.length>2?' y '+(result.errors.length-2)+' más':'')+'.':''));
 }catch(e){
   result.errors.push('Error previo a la descarga: '+e.message);
   notify('SPC '+desde+' → '+hasta+': '+e.message+
     '. No se ha consultado Solarman. Se mantiene el histórico existente.');
 }finally{
   busy=false;
   if(mainButton)mainButton.disabled=false;
   if(pendingButton)pendingButton.disabled=false;
 }
 return result;
}
export async function downloadSpcDay(date){
 const r=await downloadSpcRange(date,date);
 return Boolean(r&&(r.downloaded+r.partial)>0);
}
