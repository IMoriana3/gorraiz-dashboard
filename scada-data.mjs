// Gorraiz SCADA: funciones puras, sin acceso a Workers ni credenciales.
// La generación Solarman (APo_t1) es potencia AC; los kW de red de KSTAR
// se ESTIMAN por delta de contadores kWh / tiempo, nunca con totalActivePower
// (unidad, relación CT y signo todavía no validados).
export const STEP_MINUTES = 5;
const MAX_INV_KW = 65; // filtro de plausibilidad para cada G50KT de 50 kW AC
const MAX_GRID_KW = 500; // filtro de datos anómalos, no límite eléctrico contratado
const madrid = new Intl.DateTimeFormat('en-GB', {
  timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
});
const pad=n=>String(n).padStart(2,'0');
export const numeric = v =>
  typeof v==='number' && Number.isFinite(v) ? v :
  typeof v==='string' && v.trim()!=='' && Number.isFinite(Number(v)) ? Number(v) : null;
const dateOK = d => typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  !Number.isNaN(Date.parse(d+'T00:00:00Z')) &&
  new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;

function zoneParts(d) {
  const parts=Object.fromEntries(madrid.formatToParts(d).map(p=>[p.type,p.value]));
  return {date:parts.year+'-'+parts.month+'-'+parts.day,
    minute:Number(parts.hour)*60+Number(parts.minute),second:Number(parts.second)};
}
export function invStamp(value) {
  const d=value instanceof Date?value:new Date(value);
  return Number.isFinite(+d)?zoneParts(d):null;
}
export function spcStamp(value) {
  if(typeof value!=='string')return null;
  const m=value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d\d):(\d\d)(?::(\d\d))?/);
  if(!m||!dateOK(m[1])||+m[2]>23||+m[3]>59||+(m[4]||0)>59)return null;
  // Las filas sin offset conservan el reloj literal SPC, no se afirma
  // que sea Europe/Madrid. Con offset explícito sí se convierte.
  if(/(?:Z|[+-]\d\d:?\d\d)$/.test(value)){
    const d=new Date(value);
    return Number.isFinite(+d)?zoneParts(d):null;
  }
  return {date:m[1],minute:+m[2]*60+(+m[3]),second:+(m[4]||0)};
}
function slot(stamp) {
  if(!stamp)return null;
  const i=Math.round((stamp.minute+stamp.second/60)/STEP_MINUTES);
  return i>=0&&i<288?stamp.date+'T'+pad(Math.floor(i/12))+':'+pad((i%12)*5):null;
}
const daysBack = (day,n) => new Date(Date.parse(day+'T00:00:00Z')-n*86400000).toISOString().slice(0,10);
export function daysFor(end,range=1){
  if(!dateOK(end))return [];
  const size=range===7?7:1;
  return Array.from({length:size},(_,i)=>daysBack(end,size-i-1));
}
const valueAt = (obj,key) => obj&&obj[key]!==undefined?numeric(obj[key]):null;

function inverterMap(items,type,days){
  const allowed=new Set(days), map=new Map(), dayEnergy=new Map();
  // Los registros anteriores de Solarman y un refresco de SCADA pueden
  // coexistir. El más reciente debe ganar incluso si IndexedDB ordena ids
  // de manera distinta: NO fiarse del orden alfabético de objectStore.getAll().
  const oldest=Date.parse(days[0]+'T00:00:00Z')-86400000;
  const newest=Date.parse(days.at(-1)+'T00:00:00Z')+2*86400000;
  for(const source of items.filter(x=>x.tipo===type)){
    const priority=Number.isFinite(Date.parse(source.updatedAt))?Date.parse(source.updatedAt):0;
    for(const row of Array.isArray(source.rows)?source.rows:[]){
      const timestamp=row.ts instanceof Date?+row.ts:+new Date(row.ts);
      if(!Number.isFinite(timestamp)||timestamp<oldest||timestamp>newest)continue;
      const stamp=invStamp(row.ts);
      if(!stamp||!allowed.has(stamp.date))continue;
      const n=numeric(row.pot),daily=numeric(row.dia);
      const oldDaily=dayEnergy.get(stamp.date);
      if(daily!==null&&daily>=0&&daily<=1000&&
         (!oldDaily||priority>oldDaily.priority||priority===oldDaily.priority&&daily>oldDaily.value)){
        dayEnergy.set(stamp.date,{value:daily,priority});
      }
      if(n===null||n<0||n>MAX_INV_KW)continue;
      const key=slot(stamp),old=map.get(key);
      if(key&&(!old||priority>=old.priority))map.set(key,{kw:n,stamp,priority});
    }
  }
  return {map,dayEnergy};
}

function reconcile(rows,daily){
  if(rows.length<2)return false;
  const first=rows[0].row,last=rows.at(-1).row;
  for(const [key,totalKey] of [['positiveActiveElec','importKWh'],['reverseActiveElec','exportKWh']]){
    const actual=valueAt(daily,totalKey),a=valueAt(first,key),b=valueAt(last,key);
    if(actual===null||a===null||b===null||actual<0||b<a)return false;
    const delta=b-a;
    // El desfase de primera/última muestra admite hasta un intervalo sin medir;
    // para valores pequeños, tolerancia absoluta de 1 kWh.
    if(Math.abs(delta-actual)>Math.max(1,actual*0.02))return false;
  }
  return true;
}
export function gridIntervals(source){
  const meta=source?.meta||source?.payload?.meta||{};
  const date=source?.fecha||source?.date||source?.payload?.date;
  const p=source?.payload||source;
  const d=Array.isArray(p?.daily)?p.daily.find(x=>x.date===date):null;
  const out={date,meta,daily:d,intervals:[],ready:false,reason:null};
  if(!dateOK(date)||meta.medidoresEstacion!==undefined&&meta.medidoresEstacion!==null&&meta.medidoresEstacion!==1){
    out.reason='Identidad de medidor no verificada';return out;
  }
  if(meta.completo!==true || !d){
    out.reason='No consta un día cerrado y completo de KSTAR';return out;
  }
  const rows=(Array.isArray(p.rows)?p.rows:[])
    .map(row=>({row,stamp:spcStamp(row.saveTime)}))
    .filter(x=>x.stamp?.date===date)
    .sort((a,b)=>a.stamp.minute*60+a.stamp.second-b.stamp.minute*60-b.stamp.second);
  if(!reconcile(rows,d)){out.reason='Acumulados SPC sin conciliación con resumen diario';return out}
  let prev=rows[0],accepted=0;
  for(let i=1;i<rows.length;i++){
    const cur=rows[i];
    const dt=((cur.stamp.minute-prev.stamp.minute)*60+cur.stamp.second-prev.stamp.second)/3600;
    // Nunca rellenar los huecos ni cruzar una discontinuidad >10 min.
    if(dt<2/60||dt>10/60){prev=cur;continue}
    const a=valueAt(prev.row,'positiveActiveElec'),b=valueAt(cur.row,'positiveActiveElec');
    const c=valueAt(prev.row,'reverseActiveElec'),e=valueAt(cur.row,'reverseActiveElec');
    prev=cur;
    if([a,b,c,e].some(x=>x===null))continue;
    const importKW=(b-a)/dt,exportKW=(e-c)/dt;
    if(!Number.isFinite(importKW)||!Number.isFinite(exportKW)||importKW< -0.01||exportKW< -0.01||
       importKW>MAX_GRID_KW||exportKW>MAX_GRID_KW)continue;
    const key=slot(cur.stamp);
    if(!key)continue;
    out.intervals.push({key,importKW:Math.max(0,importKW),exportKW:Math.max(0,exportKW),
      estimated:true,clockVerified:meta.timezoneVerified===true});
    accepted++;
  }
  out.ready=accepted>0;
  if(!out.ready)out.reason='Sin intervalos KSTAR válidos de 2–10 minutos';
  return out;
}
function latestSource(items,day){
  const matching=items.filter(x=>x.tipo==='S'&&x.fecha===day&&x.payload);
  return matching.sort((a,b)=>
    Date.parse(a.payload?.meta?.fetchedAt||a.payload?.meta?.actualizado||0) -
    Date.parse(b.payload?.meta?.fetchedAt||b.payload?.meta?.actualizado||0)).at(-1)||null;
}
export function availableDays(items){
  const keys=new Set();
  for(const s of items||[]){
    if(s.tipo==='S'&&dateOK(s.fecha))keys.add(s.fecha);
    if((s.tipo==='A'||s.tipo==='B')&&Array.isArray(s.rows)){
      for(const r of s.rows){const st=invStamp(r.ts);if(st)keys.add(st.date)}
    }
  }
  return [...keys].sort();
}
export function buildSeries(items,{date,range=1,allowProvisional=false}={}){
  const dates=daysFor(date,range), keys=[];
  for(const day of dates)for(let n=0;n<288;n++)keys.push(day+'T'+pad(Math.floor(n/12))+':'+pad(n%12*5));
  const A=inverterMap(items,'A',dates),B=inverterMap(items,'B',dates);
  const grid=new Map(),gridState={};
  for(const day of dates){
    const source=latestSource(items,day);
    if(!source)continue;
    const state=gridIntervals(source);gridState[day]=state;
    if(state.ready)for(const g of state.intervals)grid.set(g.key,g);
  }
  const series={generation:[],a:[],b:[],import:[],export:[],consumption:[]};
  let common=0,provisional=false;
  for(const key of keys){
    const a=A.map.get(key)?.kw??null,b=B.map.get(key)?.kw??null,g=grid.get(key);
    const prod=a!==null&&b!==null?a+b:null;
    let consumption=null;
    if(prod!==null&&g&&(g.clockVerified||allowProvisional)){
      const computed=prod+g.importKW-g.exportKW;
      if(computed>=-0.2){consumption=Math.max(0,computed);common++;if(!g.clockVerified)provisional=true}
    }
    series.a.push(a);series.b.push(b);series.generation.push(prod);
    series.import.push(g?g.importKW:null);series.export.push(g?g.exportKW:null);
    series.consumption.push(consumption);
  }
  const reportDay=dates.at(-1);
  const summary=gridState[reportDay]?.daily||null;
  const aDay=A.dayEnergy.get(reportDay)?.value??null,bDay=B.dayEnergy.get(reportDay)?.value??null;
  const productionDay=aDay!==null&&bDay!==null?aDay+bDay:null;
  const imp=summary?valueAt(summary,'importKWh'):null,exp=summary?valueAt(summary,'exportKWh'):null;
  const consumptionDay=productionDay!==null&&imp!==null&&exp!==null&&productionDay>=exp
    ?productionDay+imp-exp:null;
  const last = values => {
    for(let i=values.length-1;i>=0;i--)if(values[i]!==null)return {value:values[i],key:keys[i]};
    return null;
  };
  return {dates,keys,series,last:{
    generation:last(series.generation),a:last(series.a),b:last(series.b),
    import:last(series.import),export:last(series.export),consumption:last(series.consumption)
  },summary:{generation:productionDay,import:imp,export:exp,consumption:consumptionDay,
    spcAutoconsumption:summary?valueAt(summary,'selfConsumptionKWh'):null},
    gridState,common,provisional,
    warnings:[
      ...(!keys.some(k=>A.map.has(k)&&B.map.has(k))?['Sin puntos simultáneos de ambos inversores']:[]),
      ...(dates.some(d=>gridState[d]?.reason)?['SPC: '+dates.filter(d=>gridState[d]?.reason).map(d=>d+' '+gridState[d].reason).join('; ')]:[]),
      ...(dates.some(d=>gridState[d]?.ready&&gridState[d].meta.timezoneVerified!==true)?
        ['Reloj SPC sin validar frente a Solarman. La importación/exportación son medias por intervalo, no valores instantáneos.']:[]),
      ...(!common?['Consumo horario sin muestra temporalmente conciliada; no se rellena con valores inventados.']:[]),
      ...(provisional?['Consumo estimado provisional: superposición horaria SPC–Solarman sin verificar.']:[])
    ]};
}
