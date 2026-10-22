// Archivo canónico de datos energéticos Gorraiz.
// Durable Object SQLite: una instancia, claves por origen y día, transacciones
// consistentes entre navegadores. Sin llamadas a Solarman ni al portal SPC.
// La aplicación solo ve copias normalizadas y limita el tamaño de cada lote.
export const HISTORY_PREFIX='energia:v1:';
export const HISTORY_MAX_DAYS=31;
export const HISTORY_MAX_ITEMS=93;
const MAX_SAMPLES=600; // por equipo y día (incluye repeticiones de captura)
const MAX_SPC=600;
const MAX_TEXT=1_800_000; // margen bajo el máximo de valores del DO
const types=new Set(['A','B','S']);
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:
  typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
const dateOK=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&
  Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
export const historyKey=(type,date)=>HISTORY_PREFIX+type+':'+date;
const utcMadrid = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',
  second:'2-digit',hourCycle:'h23'});
function localOfUTC(value){
 const date=new Date(value);
 if(!Number.isFinite(+date))return null;
 const p=Object.fromEntries(utcMadrid.formatToParts(date).map(x=>[x.type,x.value]));
 return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':'+p.second;
}
function normalizedTime(value){
 if(value instanceof Date)value=value.toISOString();
 if(typeof value!=='string')return null;
 const v=value.trim();
 if(/^\d{4}-\d{2}-\d{2}[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(v)){
   const norm=v.replace(' ','T');
   const d=norm.slice(0,10);
   if(!dateOK(d))return null;
   const h=Number(norm.slice(11,13)),m=Number(norm.slice(14,16)),sec=Number(norm.slice(17,19)||'0');
   return h<24&&m<60&&sec<60?norm:null;
 }
 if(/^\d{4}-\d{2}-\d{2}T\d\d:\d\d/.test(v)&&/(?:Z|[+-]\d\d:?\d\d)$/.test(v))
   return localOfUTC(v);
 return null;
}
const limited=v=>typeof v==='string'?v.slice(0,90):'';
function sanitizeInv(input,source){
 if(!Array.isArray(source.rows)||source.rows.length>MAX_SAMPLES||source.rows.length===0)
   throw new Error('El día FV no contiene una lista válida de hasta 600 muestras.');
 const date=input.fecha;
 const out=new Map();
 for(const row of source.rows){
   if(!row||typeof row!=='object')throw new Error('Muestra FV inválida.');
   const ts=normalizedTime(row.ts);
   if(!ts||ts.slice(0,10)!==date)throw new Error('Marca FV fuera del día de origen.');
   const pot=number(row.pot),acum=number(row.acum),dia=number(row.dia);
   if(pot!==null&&(pot<0||pot>65))throw new Error('Potencia inversor fuera de límites de plausibilidad.');
   if(acum!==null&&(acum<0||acum>1e9))throw new Error('Acumulado inversor inválido.');
   if(dia!==null&&(dia<0||dia>1000))throw new Error('Energía diaria inversor inválida.');
   if(pot===null&&acum===null&&dia===null)continue;
   out.set(ts,{ts,pot,acum,dia});
 }
 if(!out.size)throw new Error('Sin muestras FV útiles.');
 return {tipo:input.tipo,fecha:date,rows:[...out.values()].sort((a,b)=>a.ts.localeCompare(b.ts)),
   origen:'datos-compartidos',updatedAt:new Date().toISOString()};
}
const isoTime=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?
  new Date(v).toISOString():null;
function sanitizeSpc(input,source,env){
 const date=input.fecha,p=source.payload||source;
 const m=p?.meta,d=p?.daily;
 if(!m||m.fuente!=='spc'||m.stationId!==env.SPC_STATION_ID||
    m.desde!==date||m.hasta!==date||!m.meterId||!Array.isArray(p.rows)||
    !Array.isArray(d)||d.length!==1||d[0]?.date!==date||
    p.rows.length>MAX_SPC||m.medidoresEstacion!==null&&m.medidoresEstacion!==undefined&&m.medidoresEstacion!==1)
   throw new Error('Origen, estación o alcance de SPC no válidos.');
 if(env.SPC_METER_ID&&m.meterId!==env.SPC_METER_ID)
   throw new Error('El identificador del contador SPC no corresponde a Gorraiz.');
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(m.meterId))
   throw new Error('Identificador de contador SPC inválido.');
 const rows=[],dedup=new Map();
 for(const r of p.rows){
   if(!r||typeof r.saveTime!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d\d:\d\d/.test(r.saveTime)||
     r.saveTime.slice(0,10)!==date)throw new Error('Marca histórica SPC inválida.');
   const t=r.saveTime.slice(11).match(/^(\d\d):(\d\d)(?::(\d\d))?/);
   if(!t||+t[1]>23||+t[2]>59||+(t[3]||0)>59)throw new Error('Hora SPC no válida.');
   const row={saveTime:r.saveTime.slice(0,48)};
   for(const name of ['positiveActiveElec','reverseActiveElec','totalActivePower','currentRatio']){
     const val=number(r[name]);
     row[name]=val;
   }
   if(row.positiveActiveElec===null&&row.reverseActiveElec===null&&
     row.totalActivePower===null)continue;
   dedup.set(row.saveTime,row);
 }
 rows.push(...[...dedup.values()].sort((a,b)=>a.saveTime.localeCompare(b.saveTime)));
 const daily={date};
 for(const [field,max] of [['importKWh',1e6],['exportKWh',1e6],['selfConsumptionKWh',1e6]]){
   const val=number(d[0][field]);
   if(val!==null&&(val<0||val>max))throw new Error('Resumen SPC con valores fuera de rango.');
   daily[field]=val;
 }
 if(m.completo===true&&(!rows.length||daily.importKWh===null||daily.exportKWh===null))
   throw new Error('No se admite un día SPC completo sin contadores y resumen.');
 const updated=isoTime(m.actualizado)||isoTime(m.fetchedAt)||new Date().toISOString();
 return {tipo:'S',fecha:date,payload:{
   date,rows,daily:[daily],meta:{
     fuente:'spc',stationId:env.SPC_STATION_ID,meterId:m.meterId,desde:date,hasta:date,
     actualizado:updated,fetchedAt:updated,
     completo:m.completo===true,diaCerrado:m.diaCerrado===true,
     resumenDiarioCompleto:m.resumenDiarioCompleto===true,
     timezone:limited(m.timezone)||'Europe/Madrid',timezoneVerified:false,
     dailyScope:'station',historyScope:'meter',
     medidoresEstacion:1,transporteOrigen:m.transport==='http'?'http':'no-verificado',
     persistido:true,origen:'historico-compartido',registros:rows.length
   }}};
}
export function normalizeHistoryItem(input,env){
 if(!input||!types.has(input.tipo)||!dateOK(input.fecha))throw new Error('Tipo o fecha de la fuente inválidos.');
 const source=input.payload?input:{...input};
 const clean=input.tipo==='S'?sanitizeSpc(input,source,env):sanitizeInv(input,source);
 if(JSON.stringify(clean).length>MAX_TEXT)throw new Error('Día demasiado grande para el almacén central.');
 return clean;
}
function combine(old,received){
 if(!old)return received;
 if(received.tipo==='S'){
   const a=old.payload,b=received.payload;
   if(a?.meta?.completo===true&&b?.meta?.completo!==true)return old;
   if(a?.meta?.completo===true&&b?.meta?.completo===true&&
      (a.rows?.length||0)>(b.rows?.length||0))return old;
   return received;
 }
 const rows=new Map();
 for(const row of old.rows||[])rows.set(row.ts,row);
 for(const row of received.rows||[]){
   const prev=rows.get(row.ts);
   rows.set(row.ts,prev?{ts:row.ts,
     pot:row.pot??prev.pot,acum:row.acum??prev.acum,dia:row.dia??prev.dia}:row);
 }
 const merged={...received,rows:[...rows.values()].sort((a,b)=>a.ts.localeCompare(b.ts))};
 if(merged.rows.length>MAX_SAMPLES||JSON.stringify(merged).length>MAX_TEXT)
   throw new Error('El histórico del día excede el límite de tamaño.');
 return merged;
}
export async function writeHistory(storage,items,env){
 if(!Array.isArray(items)||items.length<1||items.length>HISTORY_MAX_ITEMS)
   throw new Error('Cantidad inválida de fuentes para almacenar.');
 const incoming=items.map(i=>normalizeHistoryItem(i,env));
 const seen=new Set();
 for(const item of incoming){
   const id=historyKey(item.tipo,item.fecha);
   if(seen.has(id))throw new Error('Lote con origen y día repetidos.');
   seen.add(id);
 }
 const results=[];
 for(const source of incoming){
   const key=historyKey(source.tipo,source.fecha);
   const result=await storage.transaction(async tx=>{
     const previous=await tx.get(key);
     const next=combine(previous,source);
     if(JSON.stringify(next).length>MAX_TEXT)
       throw new Error('Límite de almacenamiento diario superado.');
     if(JSON.stringify(next)!==JSON.stringify(previous))await tx.put(key,next);
     return{tipo:source.tipo,fecha:source.fecha,
       muestras:source.tipo==='S'?next.payload.rows.length:next.rows.length,
       completo:source.tipo==='S'?next.payload.meta.completo:true};
   });
   results.push(result);
 }
 return{ok:true,guardadas:results.length,fuentes:results};
}
export async function readHistory(storage,desde,hasta){
 if(!dateOK(desde)||!dateOK(hasta)||desde>hasta)throw new Error('Rango de fechas inválido.');
 const total=(Date.parse(hasta+'T00:00:00Z')-Date.parse(desde+'T00:00:00Z'))/864e5+1;
 if(total>HISTORY_MAX_DAYS)throw new Error('Solo se pueden leer hasta 31 días por consulta.');
 const fuentes=[];
 for(let epoch=Date.parse(desde+'T00:00:00Z');epoch<=Date.parse(hasta+'T00:00:00Z');epoch+=864e5){
   const date=new Date(epoch).toISOString().slice(0,10);
   for(const type of ['A','B','S']){
     const value=await storage.get(historyKey(type,date));
     if(value)fuentes.push(value);
   }
 }
 return{fuentes,meta:{desde,hasta,dias:total,guardadas:fuentes.length,fuente:'Gorraiz compartido',proveedorConsultado:false}};
}
export async function historyStatus(storage){
 const prefix=HISTORY_PREFIX;
 const records=await storage.list({prefix,limit:5000});
 const out={A:[],B:[],S:[]};
 for(const key of records.keys()){
   const m=key.slice(prefix.length).match(/^([ABS]):(\d{4}-\d{2}-\d{2})$/);
   if(m&&dateOK(m[2]))out[m[1]].push(m[2]);
 }
 for(const type of ['A','B','S'])out[type].sort();
 return{ok:true,dias:out,cobertura:Object.fromEntries(Object.entries(out).map(([k,v])=>[k,{
   dias:v.length,desde:v[0]||null,hasta:v.at(-1)||null
 }])),proveedorConsultado:false};
}
