// Instantánea histórica de Gorraiz. Todas las potencias del sinóptico y
// tarjetas se leen de LA MISMA casilla de 5 minutos, nunca del último punto
// independiente de cada proveedor. El campo de SPC es media por intervalo
// y el de Solarman es muestra instantánea: "misma casilla" no certifica reloj.
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const data=(r,k)=>Array.isArray(r?.series?.[k])?r.series[k]:[];
const length=r=>Array.isArray(r?.keys)?r.keys.length:0;
const at=(values,i)=>finite(values[i])?values[i]:null;
const latest=(r,predicate)=>{
 for(let i=length(r)-1;i>=0;i--)if(predicate(i))return i;
 return -1;
};
export function latestSnapshotIndex(r,kind='matched'){
 const g=data(r,'generation'),imp=data(r,'import'),exp=data(r,'export'),
   con=data(r,'consumption');
 const hasSolar=i=>finite(g[i]);
 const hasSpc=i=>finite(imp[i])&&finite(exp[i]);
 if(kind==='spc')return latest(r,hasSpc);
 if(kind==='pv')return latest(r,hasSolar);
 if(kind==='estimated')return latest(r,i=>finite(con[i])&&hasSolar(i)&&hasSpc(i));
 if(kind==='matched')return latest(r,i=>hasSolar(i)&&hasSpc(i));
 throw new Error('Tipo de instantánea desconocido');
}
export function defaultSnapshotIndex(r){
 const matchedLoad=latestSnapshotIndex(r,'estimated');
 if(matchedLoad!==-1)return matchedLoad;
 const matched=latestSnapshotIndex(r,'matched');
 if(matched!==-1)return matched;
 const grid=latestSnapshotIndex(r,'spc');
 if(grid!==-1)return grid;
 return latestSnapshotIndex(r,'pv');
}
export function snapshotAt(r,index){
 if(!Number.isInteger(index)||index<0||index>=length(r))return null;
 const key=r.keys[index];
 const fv=at(data(r,'generation'),index),imp=at(data(r,'import'),index),
   exp=at(data(r,'export'),index),load=at(data(r,'consumption'),index);
 const a=at(data(r,'a'),index),b=at(data(r,'b'),index);
 const hasFV=fv!==null,hasSPC=imp!==null&&exp!==null,hasLoad=load!==null;
 return{index,key,date:key.slice(0,10),time:key.slice(11,16),
   generation:fv,import:imp,export:exp,consumption:load,a,b,
   hasFV,hasSPC,hasLoad,
   status:hasFV&&hasSPC?'paired':hasFV?'pv-only':hasSPC?'spc-only':'empty',
   // El reloj SPC no se valida por compartir una etiqueta nominal.
   clockVerified:r.gridState?.[key.slice(0,10)]?.meta?.timezoneVerified===true
 };
}
export function snapshotSourceTimes(r){
 const pv=latestSnapshotIndex(r,'pv'),spc=latestSnapshotIndex(r,'spc'),
   matched=latestSnapshotIndex(r,'matched');
 return {pv:pv<0?null:r.keys[pv],spc:spc<0?null:r.keys[spc],
   matched:matched<0?null:r.keys[matched]};
}
export function snapshotStatus(point,{provisional=false}={}){
 if(!point)return 'No hay muestras de FV ni SPC para la selección.';
 if(!point.hasFV&&!point.hasSPC)
   return 'Sin lecturas válidas de FV ni SPC para esta casilla. No se rellena con cero.';
 if(!point.hasFV)
   return 'SPC disponible; falta generación FV de los dos inversores en esta casilla. El consumo NO puede estimarse suponiendo FV = 0.';
 if(!point.hasSPC)
   return 'FV disponible; falta un intervalo SPC válido en esta casilla. Consumo no calculable.';
 if(!point.hasLoad)
   return !provisional?
     'Las fuentes coinciden en la casilla, pero se ha desactivado la estimación de consumo.' :
     'FV y SPC comparten casilla nominal, pero el consumo estimado no supera el control de plausibilidad.';
 return point.clockVerified?
   'Muestras FV y SPC en la misma casilla; se debe verificar también el alcance eléctrico del medidor.':
   'Muestras de FV y SPC en la misma casilla nominal. Consumo ESTIMADO, reloj SPC SIN VALIDAR.';
}
export function pointDateTime(key){
 if(typeof key!=='string'||!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(key))return '—';
 return key.slice(8,10)+'/'+key.slice(5,7)+' '+key.slice(11,16);
}
