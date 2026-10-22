// Sinóptico de energía (kWh) separado del sinóptico de potencia (kW).
// No se integran curvas de kW para fabricar energía: exclusivamente las
// energías diarias declaradas por Solarman y SPC. No llama a proveedores.
// Al escoger siete días, un balance físico usa SOLO días en los que existen
// simultáneamente FV A+B y SPC cerrado/conciliado. Los totales parciales de FV
// se presentan por separado y nunca se combinan con una red de menos días.
import {buildSeries,daysFor,invStamp,numeric} from './scada-data.mjs';

const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const close=(a,b)=>Math.abs(a-b)<=0.2;
function latestInverterAccumulator(items,type,until){
 let last=null;
 const limit=Date.parse(until+'T23:59:59Z')+2*86400000;
 for(const source of items||[]){
   if(source?.tipo!==type||!Array.isArray(source.rows))continue;
   for(const row of source.rows){
     const stamp=invStamp(row.ts);
     if(!stamp||stamp.date>until)continue;
     const value=numeric(row.acum),time=+new Date(row.ts);
     if(!valid(value)||value>1e9||!Number.isFinite(time)||time>limit)continue;
     const next={date:stamp.date,time,value};
     if(!last||next.time>last.time)last=next;
   }
 }
 return last;
}
function accumulatedGeneration(items,endDate){
 const a=latestInverterAccumulator(items,'A',endDate);
 const b=latestInverterAccumulator(items,'B',endDate);
 // Un acumulado sin muestra del otro inversor en una hora próxima no forma
 // una instantánea común. No se publica una falsa producción de por vida.
 if(!a||!b||a.date!==b.date||Math.abs(a.time-b.time)>30*60000)
   return {kwh:null,day:null,status:'Sin acumulados A+B comparables en la misma jornada (tolerancia 30 min)'};
 return {kwh:a.value+b.value,day:a.date,
   status:'Últimos acumulados de ambos inversores · no equivale a producción verificada por contador de red',
   a:a.value,b:b.value};
}
const plus=(a,b)=>(a||0)+b;
export function energySynoptic(items,{date,range=1,today}={}){
 const days=daysFor(date,range);
 if(!days.length)throw new Error('El sinóptico de energía requiere una fecha válida.');
 const rows=[],issues=[];
 const period={generation:0,generationDays:0,spcImport:0,spcExport:0,
   gridDays:0,openDays:0,balancedDays:0,balancedGeneration:0,
   balancedImport:0,balancedExport:0,balancedLoad:0,
   balancedSelf:0,spcDeclaredSelf:0,declaredSelfDays:0};
 for(const d of days){
   const r=buildSeries(items,{date:d,range:1,allowProvisional:false});
   const pv=r.summary.generation,imp=r.summary.import,exp=r.summary.export;
   const completeSPC=r.gridState[d]?.ready===true&&r.gridState[d].meta?.completo===true;
   const closed=!today||d<today;
   const pvOK=valid(pv),gridOK=completeSPC&&closed&&valid(imp)&&valid(exp);
   if(!closed)period.openDays++;
   if(pvOK){period.generation+=pv;period.generationDays++}
   if(gridOK){period.spcImport+=imp;period.spcExport+=exp;period.gridDays++}
   const load=pvOK&&gridOK?pv+imp-exp:null;
   const self=pvOK&&gridOK?pv-exp:null;
   const canBalance=valid(load)&&valid(self)&&
     (load>=0||close(load,0))&&(self>=0||close(self,0));
   if(canBalance){
     const safeLoad=Math.max(0,load),safeSelf=Math.max(0,self);
     period.balancedDays++;
     period.balancedGeneration+=pv;
     period.balancedImport+=imp;
     period.balancedExport+=exp;
     period.balancedLoad+=safeLoad;
     period.balancedSelf+=safeSelf;
     const declared=r.summary.spcAutoconsumption;
     if(valid(declared)){period.spcDeclaredSelf+=declared;period.declaredSelfDays++}
   }else if(pvOK&&gridOK)issues.push(d+
     ': el balance diario es negativo o la exportación supera la producción FV; excluido');
   rows.push({date:d,closed,pv:pvOK?pv:null,
     import:gridOK?imp:null,export:gridOK?exp:null,
     hasSPC:gridOK,comparable:canBalance,
     load:canBalance?Math.max(0,load):null,
     self:canBalance?Math.max(0,self):null,
     issue:issues.at(-1)?.startsWith(d+':')?issues.at(-1):null});
 }
 const n=days.length,comp=period.balancedDays;
 const aligned=comp>0?{
   generation:period.balancedGeneration,
   import:period.balancedImport,
   export:period.balancedExport,
   load:period.balancedLoad,
   self:period.balancedSelf,
   spcDeclaredSelf:period.declaredSelfDays===comp?period.spcDeclaredSelf:null
 }:{generation:null,import:null,export:null,load:null,self:null,spcDeclaredSelf:null};
 return {
   from:days[0],to:days.at(-1),days:n,rows,issues,
   generatedInPeriod:period.generationDays>0?period.generation:null,
   generatedDays:period.generationDays,gridDays:period.gridDays,
   comparableDays:comp,excludedDayCount:issues.length,
   openDays:period.openDays,matched:aligned,
   productionAccumulated:accumulatedGeneration(items,days.at(-1)),
   label:n===1?'Día '+days[0]:'Periodo '+days[0]+' → '+days.at(-1),
   explanation:comp?
     'Balance de '+comp+'/'+n+' día(s) con FV A+B y SPC cerrado/conciliado. '+
     (period.generationDays!==comp?
       'La producción de toda la selección se muestra aparte y NO se mezcla con red de menos días. ':'')+
     'El consumo y la energía FV autoconsumida son calculados, no medidos de forma independiente. '+
     'Los relojes y el perímetro del contador siguen pendientes de contraste.':
     'No hay ningún día con FV A+B y SPC cerrado/conciliado compatible. Se muestran únicamente las energías de origen disponibles, sin inventar un balance.'
 };
}
