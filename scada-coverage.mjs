import {invStamp,numeric} from './scada-data.mjs';
import {normalizeSourcePower} from './scada-units.mjs';

// Cobertura por fecha y atraso del SPC para SCADA Gorraiz.
// Puro: no lee credenciales, no accede al proveedor y no modifica los datos.
const dateOK=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&
  !Number.isNaN(Date.parse(v+'T00:00:00Z'))&&
  new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const dayOffset=(v,n)=>new Date(Date.parse(v+'T00:00:00Z')+n*864e5).toISOString().slice(0,10);
const diffDays=(a,b)=>Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/864e5);
export function spcBacklog(items,madridToday){
 const complete=[...new Set((items||[])
   .filter(x=>x.tipo==='S'&&dateOK(x.fecha)&&x.payload?.meta?.completo===true)
   .map(x=>x.fecha))].sort();
 const last=complete.at(-1)||null;
 const yesterday=dateOK(madridToday)?dayOffset(madridToday,-1):null;
 const next=last?dayOffset(last,1):null;
 const pending=!!next&&!!yesterday&&next<=yesterday;
 return {lastComplete:last,lastClosed:yesterday,
   firstPending:pending?next:null,
   pendingCount:pending?diffDays(next,yesterday)+1:0,
   storedDays:complete};
}
const populated=array=>array.filter(v=>v!==null&&v!==undefined).length;
function internalGaps(values){
 const valid=[];
 for(let i=0;i<values.length;i++)if(values[i]!==null&&values[i]!==undefined)valid.push(i);
 return valid.length>1 ? valid.at(-1)-valid[0]+1-valid.length:0;
}
export function dailyCoverage(result,items){
 const dates=result?.dates||[];
 const closed=new Set((items||[]).filter(x=>x.tipo==='S'&&x.payload?.meta?.completo===true).map(x=>x.fecha));
 return dates.map((date,index)=>{
   const start=index*288,end=start+288;
   const a=result.series.a.slice(start,end),b=result.series.b.slice(start,end);
   const gen=result.series.generation.slice(start,end),imp=result.series.import.slice(start,end);
   const paired=populated(gen),spc=populated(imp);
   const missing=!(items||[]).some(x=>x.tipo==='S'&&x.fecha===date);
   return {date,a:populated(a),b:populated(b),paired,spc,
     gapsInside:internalGaps(gen),
     status:missing?'sin-descarga':!closed.has(date)?'spc-parcial':
       spc===0?'spc-no-conciliado':'spc-con-intervalos',
     reason:result.gridState?.[date]?.reason||null};
 });
}


// Inventario del día directamente sobre las filas originales de IndexedDB.
// Es distinto de las curvas (que exigen potencia kW válida en intervalos de 5 min).
// Conserva el indicador potSinValidar de la migración sin tomarlo por potencia AC.
export function dailyPvInventory(items,date){
 const out={A:{raw:0,rawPower:0,validPower:0,unverified:0,energyOnly:0,sources:[]},
   B:{raw:0,rawPower:0,validPower:0,unverified:0,energyOnly:0,sources:[]}};
 if(!dateOK(date))return out;
 for(const type of ['A','B']){
   const keyed=new Map(),names=new Set();
   for(const source of (items||[]).filter(x=>x.tipo===type)){
     for(const row of Array.isArray(source.rows)?source.rows:[]){
       const stamp=invStamp(row.ts);
       if(stamp?.date!==date)continue;
       const instant=new Date(row.ts);
       if(!Number.isFinite(+instant))continue;
       const key=+instant,existing=keyed.get(key)||{
         powerPresent:false,powerValid:false,pending:false,hasEnergy:false
       };
       const raw=numeric(row.pot),suspect=numeric(row.potSinValidar);
       const normalized=normalizeSourcePower(source,row.pot).pot;
       existing.powerPresent||=raw!==null||suspect!==null;
       existing.powerValid||=normalized!==null;
       existing.pending||=(suspect!==null)||(raw!==null&&normalized===null);
       existing.hasEnergy||=numeric(row.dia)!==null||numeric(row.acum)!==null;
       keyed.set(key,existing);
       names.add(String(source.nombre||source.origen||source.tipo).slice(0,100));
     }
   }
   out[type].raw=keyed.size;
   for(const row of keyed.values()){
     if(row.powerPresent)out[type].rawPower++;
     if(row.powerValid)out[type].validPower++;
     if(row.pending&&!row.powerValid)out[type].unverified++;
     if(!row.powerPresent&&row.hasEnergy)out[type].energyOnly++;
   }
   out[type].sources=[...names].sort().slice(0,8);
 }
 return out;
}

export function pvDayDiagnosis(items,result,date){
 const inv=dailyPvInventory(items,date);
 const a=inv.A,b=inv.B;
 const slots=(result?.dates||[]).indexOf(date);
 const start=slots>=0?slots*288:0;
 const valid=(key)=>slots<0?0:(result.series[key]||[])
   .slice(start,start+288).filter(v=>v!==null&&v!==undefined).length;
 const plotted={A:valid('a'),B:valid('b'),joint:valid('generation')};
 const raw=a.raw+b.raw,unverified=a.unverified+b.unverified;
 let kind='complete',message='';
 if(plotted.A===0||plotted.B===0){
   if(!raw){
     kind='not-downloaded';
     message='No constan filas originales FV de A ni B para '+date+
       ' en la copia local recuperada. Se puede consultar únicamente Solarman de ese día cuando el cupo horario esté disponible.';
   }else if(unverified){
     kind='unverified';
     message='Existen '+raw+' filas FV originales en '+date+', pero '+unverified+
       ' potencias están pendientes de validar. No vuelvas a descargar sin revisar primero unidades y marcas horarias.';
   }else if(a.raw===0||b.raw===0){
     kind='partial-source';
     message='Solo aparece histórico original de '+(a.raw===0?'B':'A')+
       ' para '+date+'. Falta el otro inversor para obtener generación conjunta.';
   }else {
     kind='no-valid-power';
     message='Hay '+raw+' filas FV originales para '+date+
       ', pero no resultan medidas válidas simultáneas en la curva. Revisar potencias y marcas horarias antes de consultar Solarman.';
   }
 }
 return {date,inventory:inv,plotted,kind,message};
}

// Auditoría de los huecos FV reales, exclusivamente sobre el histórico local.
// Se reproduce la misma asignación a casillas de cinco minutos que scada-data.
// Distingue "sin fila en el archivo" de "hay fila pero potencia invalidada".
// No permite deducir si una ausencia se originó en el datalogger, la nube de
// Solarman o una respuesta incompleta del Worker: eso requiere telemetría externa.
const pvSlot=(stamp)=>{
 if(!stamp)return null;
 const step=Math.round((stamp.minute+stamp.second/60)/5);
 return step>=0&&step<288?step:null;
};
const pvClock=step=>String(Math.floor(step/12)).padStart(2,'0')+':'+
  String((step%12)*5).padStart(2,'0');
const gapTitles={
 'sin-A-ni-B':'No hay fila de A ni B',
 'sin-A':'A sin fila; B con potencia válida',
 'sin-B':'B sin fila; A con potencia válida',
 'A-invalidado':'A tiene fila sin potencia válida',
 'B-invalidado':'B tiene fila sin potencia válida',
 'ambos-invalidados':'Ambos tienen filas sin potencia válida',
 'A-no-valido-y-B-ausente':'A sin potencia válida y B sin fila',
 'B-no-valido-y-A-ausente':'B sin potencia válida y A sin fila',
 'mixto-sin-potencia':'No hay potencia válida conjunta',
};
function inverterSlotInventory(items,date,type){
 const slots=new Map();
 for(const src of (items||[]).filter(x=>x.tipo===type)){
  for(const row of Array.isArray(src.rows)?src.rows:[]){
   const stamp=invStamp(row.ts);
   if(stamp?.date!==date)continue;
   const position=pvSlot(stamp);
   if(position===null)continue;
   const cell=slots.get(position)||{rows:0,valid:false,invalid:false,
     energyOnly:false,timestamps:new Set()};
   cell.rows++;
   const val=normalizeSourcePower(src,row.pot).pot;
   const raw=numeric(row.pot),unverified=numeric(row.potSinValidar);
   if(val!==null)cell.valid=true;
   if(unverified!==null||(raw!==null&&val===null))cell.invalid=true;
   if(raw===null&&unverified===null&&(numeric(row.dia)!==null||numeric(row.acum)!==null))
    cell.energyOnly=true;
   cell.timestamps.add(pvClock(Math.floor((stamp.minute)/5))+
     ':'+String(stamp.second).padStart(2,'0'));
   slots.set(position,cell);
  }
 }
 return slots;
}
export function solarGapAudit(items,date){
 const a=inverterSlotInventory(items,date,'A');
 const b=inverterSlotInventory(items,date,'B');
 const joint=[];
 const allValid=new Set([...a.keys(),...b.keys()]);
 for(const t of allValid)if(a.get(t)?.valid&&b.get(t)?.valid)joint.push(t);
 joint.sort((x,y)=>x-y);
 const range=joint.length>=2?{first:joint[0],last:joint.at(-1)}:null;
 const totals={bothMissing:0,onlyA:0,onlyB:0,invalid:0,
   possibleOffset:0,withinWindow:0};
 const issues=[],reasons={};
 if(range){
  for(let t=range.first;t<=range.last;t++){
   const ca=a.get(t),cb=b.get(t);
   if(ca?.valid&&cb?.valid)continue;
   let category;
   if(ca?.valid){
    if(cb?.invalid||cb?.energyOnly)category='B-invalidado';
    else category='sin-B';
    totals.onlyA++;
   }else if(cb?.valid){
    if(ca?.invalid||ca?.energyOnly)category='A-invalidado';
    else category='sin-A';
    totals.onlyB++;
   }else if(!ca&&!cb){
    category='sin-A-ni-B';totals.bothMissing++;
   }else if(ca&&cb){
    category='ambos-invalidados';
   }else if(ca&&!cb){
    category='A-no-valido-y-B-ausente';
   }else if(cb&&!ca){
    category='B-no-valido-y-A-ausente';
   }else category='mixto-sin-potencia';
   if(ca?.invalid||cb?.invalid||ca?.energyOnly||cb?.energyOnly)totals.invalid++;
   const neighbor=Boolean(
     (ca?.valid&&!cb?.valid&&(b.get(t-1)?.valid||b.get(t+1)?.valid))||
     (cb?.valid&&!ca?.valid&&(a.get(t-1)?.valid||a.get(t+1)?.valid))
   );
   if(neighbor)totals.possibleOffset++;
   reasons[category]=(reasons[category]||0)+1;
   issues.push({time:pvClock(t),reason:category,
     description:gapTitles[category],
     a:ca?.valid?'Válido':ca?.invalid?'Potencia pendiente':
       ca?.energyOnly?'Solo energía':ca?'Sin potencia':'Sin fila',
     b:cb?.valid?'Válido':cb?.invalid?'Potencia pendiente':
       cb?.energyOnly?'Solo energía':cb?'Sin potencia':'Sin fila',
     possibleOffset:neighbor});
  }
  totals.withinWindow=range.last-range.first+1;
 }
 const countValid=map=>[...map.values()].filter(x=>x.valid).length;
 const countOriginal=map=>map.size;
 return {
  date,first:range?pvClock(range.first):null,last:range?pvClock(range.last):null,
  validA:countValid(a),validB:countValid(b),originalSlotsA:countOriginal(a),
  originalSlotsB:countOriginal(b),joint:joint.length,totals,reasons,issues,
  interpretation: !range?
    'No hay dos puntos FV conjuntos para definir una ventana diurna; primero revisar la cobertura de A y B.':
    !issues.length?
      'No hay huecos entre las primeras y últimas muestras simultáneas. Las horas nocturnas no cuentan.':
      'Estos son huecos de la curva construida, no prueba de caídas del datalogger. '+
      'Los casos con «Sin fila» requieren consultar la fuente original o la respuesta API para determinar si la nube los proporcionó. '+
      '«Posible desfase» indica lectura válida del otro inversor en la casilla adyacente, sin certificar la causa.'
 };
}
export function solarGapCsv(report){
 const head='fecha;hora;causa;inversor_A;inversor_B;posible_desfase_5min';
 const clean=text=>String(text||'').replaceAll(';',',').replaceAll('\n',' ');
 return '\ufeff'+head+'\r\n'+report.issues.map(x=>[
  report.date,x.time,clean(x.description),clean(x.a),clean(x.b),
  x.possibleOffset?'POSIBLE':'NO'].join(';')).join('\r\n')+
  (report.issues.length?'\r\n':'');
}
