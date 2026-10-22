import {signedExportKW} from './scada-grid-sign.mjs';

// Contraste FV / red de Gorraiz. Cálculo puro, sin credenciales ni proveedores.
// Potencia FV: muestra AC instantánea de Solarman (A + B).
// Intercambio: media sobre el intervalo de KSTAR a partir de dos acumulados.
// El ajuste de tiempo SOLO desplaza gráficas en memoria: no valida el reloj,
// no modifica IndexedDB y no convierte una inferencia en potencia medida.
export const STEP_CONTRAST_MIN=5;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const formatHour=h=>String(h).padStart(2,'0')+':00';
const average=(sum,count)=>count?sum/count:null;

export function contrastDay(series,{offsetMinutes=0}={}){
 if(!series?.dates||series.dates.length!==1||
    !Array.isArray(series.keys)||series.keys.length!==288)
   throw new Error('El contraste requiere un único día con 288 casillas de cinco minutos.');
 if(!Number.isInteger(offsetMinutes)||offsetMinutes%STEP_CONTRAST_MIN!==0||
    Math.abs(offsetMinutes)>180)
   throw new Error('El desfase SPC debe ser de -180 a +180 minutos, en pasos de 5.');
 const day=series.dates[0],shift=offsetMinutes/5;
 const readings={generation:[],import:[],export:[],netGrid:[],load:[]};
 const fields={solarmanPoints:0,spcPoints:0,simultaneous:0,
   nonnegativeLoad:0,negativeLoad:0,minimumLoad:null,offsetMinutes,
   spcClockVerified:series.gridState?.[day]?.meta?.timezoneVerified===true};
 const hourly=Array.from({length:24},(_,hour)=>({hour:formatHour(hour),
   generation:null,import:null,export:null,load:null,
   solarCount:0,spcCount:0,comparedCount:0,negativeCount:0,
   _g:0,_i:0,_e:0,_l:0,_lCount:0}));
 const old=series.series||{};
 const pv=old.generation||[],imp=old.import||[],exp=old.export||[];
 for(let i=0;i<288;i++){
   const shifted=i-shift;
   const power=finite(pv[i])?pv[i]:null;
   // SPC +5 min: una lectura etiquetada 09:55 se representa a las 10:00;
   // por tanto, para la casilla 10:00 se lee la casilla original 09:55.
   const importKW=shifted>=0&&shifted<288&&finite(imp[shifted])?
     imp[shifted]:null;
   const exportKW=shifted>=0&&shifted<288&&finite(exp[shifted])?
     exp[shifted]:null;
   const net=importKW!==null&&exportKW!==null?importKW-exportKW:null;
   let load=null;
   const h=hourly[Math.floor(i/12)];
   if(power!==null){fields.solarmanPoints++;h.solarCount++;h._g+=power}
   if(net!==null){fields.spcPoints++;h.spcCount++;h._i+=importKW;h._e+=exportKW}
   if(power!==null&&net!==null){
     fields.simultaneous++;h.comparedCount++;
     const inferred=power+net;
     if(fields.minimumLoad===null||inferred<fields.minimumLoad)
       fields.minimumLoad=inferred;
     if(inferred< -0.2){fields.negativeLoad++;h.negativeCount++}
     else {load=Math.max(0,inferred);fields.nonnegativeLoad++;h._l+=load;h._lCount++}
   }
   readings.generation.push(power);
   readings.import.push(importKW);
   readings.export.push(exportKW);
   readings.netGrid.push(net);
   readings.load.push(load);
 }
 for(const h of hourly){
   h.generation=average(h._g,h.solarCount);
   h.import=average(h._i,h.spcCount);
   h.export=average(h._e,h.spcCount);
   h.load=average(h._l,h._lCount);
   delete h._g;delete h._i;delete h._e;delete h._l;delete h._lCount;
 }
 const totals=series.summary||{};
 const gen=finite(totals.generation)&&totals.generation>=0?totals.generation:null;
 const importKWh=finite(totals.import)&&totals.import>=0?totals.import:null;
 const exportKWh=finite(totals.export)&&totals.export>=0?totals.export:null;
 const reportedSelf=finite(totals.spcAutoconsumption)&&totals.spcAutoconsumption>=0?
   totals.spcAutoconsumption:null;
 const completeDaily=gen!==null&&importKWh!==null&&exportKWh!==null &&
   series.gridState?.[day]?.meta?.completo===true;
 const derivedConsumption=completeDaily?gen+importKWh-exportKWh:null;
 const solarUsed=completeDaily&&gen>=exportKWh?gen-exportKWh:null;
 const selfDiff=solarUsed!==null&&reportedSelf!==null?reportedSelf-solarUsed:null;
 return {day,keys:series.keys.slice(),offsetMinutes,readings,hourly,fields,
   daily:{generation:gen,import:importKWh,export:exportKWh,
     inferredConsumption:completeDaily&&derivedConsumption>=0?derivedConsumption:null,
     inferredSelfConsumed:solarUsed,spcReportedSelf:reportedSelf,
     selfConsumptionDifference:selfDiff,complete:completeDaily}};
}
export function contrastCsv(data,{showLoad=false}={}){
 const rows=[
  'fecha_hora_Madrid;FV_AC_kW_muestra;importacion_SPC_kW_media;exportacion_SPC_kW_signo_negativo;consumo_estimado_kW_no_validado;desfase_aplicado_SPC_min;relojes_certificados',
 ];
 const asNumber=v=>finite(v)?v.toFixed(3):'';
 for(let i=0;i<data.keys.length;i++){
  rows.push([data.keys[i],
   asNumber(data.readings.generation[i]),asNumber(data.readings.import[i]),
   asNumber(signedExportKW(data.readings.export[i])),
   showLoad?asNumber(data.readings.load[i]):'',
   String(data.offsetMinutes),'NO'].join(';'));
 }
 return '\ufeff'+rows.join('\r\n')+'\r\n';
}
