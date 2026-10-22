// Archivo canónico de datos energéticos Gorraiz.
// Durable Object SQLite: una instancia, claves por origen y día, transacciones
// consistentes entre navegadores. Sin llamadas a Solarman ni al portal SPC.
// La aplicación solo ve copias normalizadas y limita el tamaño de cada lote.
export const HISTORY_PREFIX='energia:v1:';
export const HISTORY_MAX_DAYS=31;
export const HISTORY_MAX_ITEMS=93;
const MAX_SAMPLES=2500; // submuestreo o 30 s: máximo condicionado al tamaño 1,8 MB
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
   throw new Error('Muestras FV ausentes o más de 2.500 en un día; conservar local y revisar el formato.');
 const date=input.fecha,out=new Map();
 let units=source.unidadPotencia??source.potUnit??null;
 if(!['W','kW','desconocida',null].includes(units))units='desconocida';
 const rejected={fecha:0,potencia:0,energia:0,acumulado:0};
 for(const row of source.rows){
   if(!row||typeof row!=='object'){rejected.fecha++;continue}
   const ts=normalizedTime(row.ts);
   if(!ts||ts.slice(0,10)!==date){rejected.fecha++;continue}
   const rawPot=number(row.pot),rawDia=number(row.dia),rawAcum=number(row.acum);
   const dia=rawDia!==null&&rawDia>=0&&rawDia<=1000?rawDia:null;
   const acum=rawAcum!==null&&rawAcum>=0&&rawAcum<=1e9?rawAcum:null;
   let pot=units==='W'?(rawPot===null?null:rawPot/1000):
     units==='desconocida'?null:rawPot;
   if(pot!==null&&(pot<0||pot>65))pot=null;
   const anomalousPot=number(row.potSinValidar)??(pot===null?rawPot:null);
   const anomalousDia=number(row.diaSinValidar)??(dia===null?rawDia:null);
   const anomalousAcum=number(row.acumSinValidar)??(acum===null?rawAcum:null);
   // Nunca se descarta un día completo por un valor de energía sospechoso.
   // Los originales se conservan para un contraste posterior, sin mostrarlos
   // en cálculos SCADA ni inferir automáticamente su unidad.
   const clean={ts,pot,acum,dia};
   if(pot===null&&anomalousPot!==null){clean.potSinValidar=anomalousPot;rejected.potencia++}
   if(dia===null&&anomalousDia!==null){clean.diaSinValidar=anomalousDia;rejected.energia++}
   if(acum===null&&anomalousAcum!==null){clean.acumSinValidar=anomalousAcum;rejected.acumulado++}
   if(pot===null&&acum===null&&dia===null&&
      !('potSinValidar'in clean)&&!('diaSinValidar'in clean)&&!('acumSinValidar'in clean))continue;
   out.set(ts,clean);
 }
 if(!out.size)throw new Error('Ninguna muestra FV con fecha y hora compatibles con '+date+
   '; registros descartados por fecha: '+rejected.fecha);
 const rows=[...out.values()].sort((a,b)=>a.ts.localeCompare(b.ts));
 return {tipo:input.tipo,fecha:date,rows,origen:'datos-compartidos',
   unidadPotencia:'kW',controlPotencia:{
     unidadRecibida:units||'no-declarada',
     muestrasSinVerificar:rows.filter(r=>r.pot===null&&r.potSinValidar!==undefined).length,
     energiaSinVerificar:rows.filter(r=>r.dia===null&&r.diaSinValidar!==undefined).length,
     acumuladosSinVerificar:rows.filter(r=>r.acum===null&&r.acumSinValidar!==undefined).length,
     marcasFueraDeDia:rejected.fecha
   },updatedAt:new Date().toISOString()};
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
     pot:row.pot??prev.pot,acum:row.acum??prev.acum,dia:row.dia??prev.dia,
     ...(row.potSinValidar!==undefined||prev.potSinValidar!==undefined?
       {potSinValidar:row.potSinValidar??prev.potSinValidar}:{}),
     ...(row.diaSinValidar!==undefined||prev.diaSinValidar!==undefined?
       {diaSinValidar:row.diaSinValidar??prev.diaSinValidar}:{}),
     ...(row.acumSinValidar!==undefined||prev.acumSinValidar!==undefined?
       {acumSinValidar:row.acumSinValidar??prev.acumSinValidar}:{})}:row);
 }
 const all=[...rows.values()].sort((a,b)=>a.ts.localeCompare(b.ts));
 const merged={...received,rows:all,
   controlPotencia:{...received.controlPotencia,
     muestrasSinVerificar:all.filter(r=>r.pot===null&&r.potSinValidar!==undefined).length,
     energiaSinVerificar:all.filter(r=>r.dia===null&&r.diaSinValidar!==undefined).length,
     acumuladosSinVerificar:all.filter(r=>r.acum===null&&r.acumSinValidar!==undefined).length}};
 if(merged.rows.length>MAX_SAMPLES||JSON.stringify(merged).length>MAX_TEXT)
   throw new Error('El histórico del día excede el límite de tamaño.');
 return merged;
}
function historyIssue(source,error){
 return {tipo:types.has(source?.tipo)?source.tipo:'?',
   fecha:dateOK(source?.fecha)?source.fecha:'fecha-invalida',
   motivo:String(error?.message||'No se ha podido validar el objeto').slice(0,220)};
}
// Validación seca. No toca el almacén ni llama a proveedores. Permite
// comprobar los datos originales ANTES de iniciar cientos de escrituras.
export function validateHistory(items,env){
 if(!Array.isArray(items)||!items.length||items.length>HISTORY_MAX_ITEMS)
   throw new Error('La validación admite entre 1 y 93 fuentes');
 const issues=[],accepted=[];
 for(const source of items){
   try{const clean=normalizeHistoryItem(source,env);
     accepted.push({tipo:clean.tipo,fecha:clean.fecha,filas:clean.tipo==='S'?
       clean.payload.rows.length:clean.rows.length,
       potenciaSinValidar:clean.controlPotencia?.muestrasSinVerificar||0,
       energiaSinValidar:clean.controlPotencia?.energiaSinVerificar||0});
   }catch(e){issues.push(historyIssue(source,e))}
 }
 return {version:'migracion-v3',ok:issues.length===0,
   validas:accepted.length,rechazadas:issues.length,aceptadas:accepted,
   incidencias:issues.slice(0,30),consultaProveedor:false};
}
export async function writeHistory(storage,items,env){
 if(!Array.isArray(items)||items.length<1||items.length>HISTORY_MAX_ITEMS)
   throw new Error('Cantidad inválida de fuentes para almacenar.');
 const results=[],issues=[];
 const seen=new Set();
 for(const source of items){
   try{
     const item=normalizeHistoryItem(source,env);
     const key=historyKey(item.tipo,item.fecha);
     if(seen.has(key))throw new Error('Origen y fecha repetidos en el mismo lote');
     seen.add(key);
     const result=await storage.transaction(async tx=>{
       const previous=await tx.get(key);
       const next=combine(previous,item);
       if(JSON.stringify(next).length>MAX_TEXT)
         throw new Error('Límite de almacenamiento diario superado (1,8 MB).');
       if(JSON.stringify(next)!==JSON.stringify(previous))await tx.put(key,next);
       return {tipo:item.tipo,fecha:item.fecha,
         muestras:item.tipo==='S'?next.payload.rows.length:next.rows.length,
         completo:item.tipo==='S'?next.payload.meta.completo:true,
         pendientesPotencia:item.tipo==='S'?0:(next.controlPotencia?.muestrasSinVerificar||0),
         pendientesEnergia:item.tipo==='S'?0:(next.controlPotencia?.energiaSinVerificar||0)};
     });
     results.push(result);
   }catch(e){issues.push(historyIssue(source,e))}
 }
 return {version:'migracion-v3',ok:issues.length===0,
   guardadas:results.length,rechazadas:issues.length,
   incidencias:issues.slice(0,30),fuentes:results,
   pendientesPotencia:results.reduce((n,r)=>n+(r.pendientesPotencia||0),0),
   pendientesEnergia:results.reduce((n,r)=>n+(r.pendientesEnergia||0),0),
   consultaProveedor:false};
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
 return{ok:true,version:'migracion-v3',dias:out,cobertura:Object.fromEntries(Object.entries(out).map(([k,v])=>[k,{
   dias:v.length,desde:v[0]||null,hasta:v.at(-1)||null
 }])),proveedorConsultado:false};
}
