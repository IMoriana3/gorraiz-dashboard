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
