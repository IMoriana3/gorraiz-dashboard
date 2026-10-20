// Analisis horario preliminar de acumulados del medidor KSTAR SPC01.
// Se usa SOLO para presentar kWh estimados por periodo P1-P6, sin euros.
// No modifica el balance diario del SPC ni asigna precios indexados.
import {periodo} from './worker/periodos.js';

const VALID_DATE=/^\d{4}-\d{2}-\d{2}$/;
const STAMP=/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/;
const MAX_STEP_S=420; // huecos mayores de 7 min NO se interpolan
const PERIODS=Object.freeze(['P1','P2','P3','P4','P5','P6']);
const valid=k=>typeof k==='number'&&Number.isFinite(k)&&k>=0;
const dateOk=s=>{
  if(typeof s!=='string'||!VALID_DATE.test(s))return false;
  const t=new Date(s+'T12:00:00Z');
  return Number.isFinite(+t)&&t.toISOString().slice(0,10)===s;
};
function ultimoDomingo(y,month) {
  const last=new Date(Date.UTC(y,month,0));
  return last.getUTCDate()-last.getUTCDay();
}
function cambioHorario(date) {
  const y=Number(date.slice(0,4)),m=Number(date.slice(5,7)),d=Number(date.slice(8,10));
  return (m===3||m===10)&&d===ultimoDomingo(y,m);
}
function parseStamp(value,date) {
  const m=typeof value==='string'?value.match(STAMP):null;
  if(!m||m[1]!==date)return null;
  const y=+date.slice(0,4),mo=+date.slice(5,7),d=+date.slice(8,10),
    hh=+m[2],mm=+m[3],ss=+m[4];
  if(hh>23||mm>59||ss>59)return null;
  const stamp=Date.UTC(y,mo-1,d,hh,mm,ss);
  const a=new Date(stamp);
  if(a.getUTCFullYear()!==y||a.getUTCMonth()!==mo-1||a.getUTCDate()!==d)return null;
  return stamp;
}
function porPeriodoVacio(){
  return Object.fromEntries(PERIODS.map(p=>[p,{importKWh:0,exportKWh:0,minutos:0}]));
}
function redondea(v){return Math.round(v*1e6)/1e6;}
function analizarDia(rows,day) {
  if(!day||!dateOk(day.date))throw Error('Fecha diaria SPC no válida.');
  const date=day.date,p=porPeriodoVacio();
  const invalid=()=>({date,calidad:'sin-intervalos',motivo:'Sin registros válidos suficientes.',
    estimado:true,registros:0,intervalos:0,huecos:0,minutosCubiertos:0,
    diferenciaImportKWh:null,diferenciaExportKWh:null,
    totalImportCalculado:null,totalExportCalculado:null,periodos:p});
  if(!Array.isArray(rows)||rows.length<2)return invalid();
  if(cambioHorario(date))return {...invalid(),calidad:'cambio-horario',motivo:'Cambio de hora: zona horaria del histórico sin verificar.'};
  const parsed=rows.filter(x=>x&&typeof x.saveTime==='string'&&x.saveTime.slice(0,10)===date)
    .map(x=>({t:parseStamp(x.saveTime,date),pos:x.positiveActiveElec,rev:x.reverseActiveElec}))
    .filter(x=>x.t!==null&&valid(x.pos)&&valid(x.rev)).sort((a,b)=>a.t-b.t);
  if(parsed.length<2)return invalid();
  const start=parsed[0],end=parsed.at(-1),millis=1000;
  let duplicados=0,gaps=0,resets=0,intervalos=0,minutosCubiertos=0;
  let importTotal=0,exportTotal=0;
  for(let i=1;i<parsed.length;i++){
    const a=parsed[i-1],b=parsed[i],dt=(b.t-a.t)/millis;
    if(dt<=0){duplicados++;continue}
    const inDelta=b.pos-a.pos,exDelta=b.rev-a.rev;
    if(inDelta<0||exDelta<0){resets++;continue}
    if(dt>MAX_STEP_S){gaps++;continue}
    intervalos++;minutosCubiertos+=dt/60;importTotal+=inDelta;exportTotal+=exDelta;
    let cursor=a.t;
    while(cursor<b.t){
      const hourStart=Math.floor(cursor/3600000)*3600000;
      const until=Math.min(b.t,hourStart+3600000);
      const fraction=(until-cursor)/(b.t-a.t);
      const local=new Date(cursor),pp=periodo(local.getUTCFullYear(),local.getUTCMonth()+1,
        local.getUTCDate(),local.getUTCHours());
      p[pp].importKWh+=inDelta*fraction;
      p[pp].exportKWh+=exDelta*fraction;
      p[pp].minutos+=(until-cursor)/60000;
      cursor=until;
    }
  }
  const positiveDelta=end.pos-start.pos,negativeDelta=end.rev-start.rev;
  const validCounters=positiveDelta>=0&&negativeDelta>=0;
  const expectedImport=day.importKWh,expectedExport=day.exportKWh;
  const importOk=valid(expectedImport)&&validCounters&&
    Math.abs(positiveDelta-expectedImport)<=Math.max(0.5,expectedImport*0.005);
  const exportOk=valid(expectedExport)&&validCounters&&
    Math.abs(negativeDelta-expectedExport)<=Math.max(0.2,expectedExport*0.01);
  const coverageOk=minutosCubiertos>=1380&&
    start.t-Date.parse(date+'T00:00:00Z')<=600000&&
    Date.parse(date+'T23:59:59Z')-end.t<=600000&&
    gaps===0&&resets===0&&duplicados===0;
  const calidad=coverageOk&&importOk&&exportOk?'compatible':'provisional-incompleto';
  const reason=calidad==='compatible'
    ? 'Lecturas concordantes con resumen SPC, sin comprobar zona horaria contractual.'
    : 'Hay intervalos sin cubrir, acumulados incoherentes o diferencias con el resumen SPC.';
  for(const rec of Object.values(p)){
    rec.importKWh=redondea(rec.importKWh);
    rec.exportKWh=redondea(rec.exportKWh);
    rec.minutos=redondea(rec.minutos);
  }
  return {date,calidad,motivo:reason,estimado:true,
    registros:parsed.length,intervalos,huecos:gaps,reinicios:resets,duplicados,
    minutosCubiertos:redondea(minutosCubiertos),
    diferenciaImportKWh:validCounters?redondea(positiveDelta):null,
    diferenciaExportKWh:validCounters?redondea(negativeDelta):null,
    totalImportCalculado:redondea(importTotal),totalExportCalculado:redondea(exportTotal),
    periodos:p};
}
function agruparDias(fuentes,desde,hasta){
  const rows=[],p=porPeriodoVacio(),rechazados=[];
  for(const f of fuentes||[]){
    if(!f||typeof f.date!=='string'||(desde&&f.date<desde)||(hasta&&f.date>hasta))continue;
    const day=(f.daily||[]).find(d=>d?.date===f.date);
    if(!day||f.meta?.completo!==true){rechazados.push({date:f.date,razon:'Sin cierre SPC completo'});continue}
    const x=analizarDia(f.rows,day);rows.push(x);
    if(x.calidad!=='compatible'){rechazados.push({date:x.date,razon:x.motivo});continue}
    for(const pp of PERIODS){
      p[pp].importKWh+=x.periodos[pp].importKWh;
      p[pp].exportKWh+=x.periodos[pp].exportKWh;
      p[pp].minutos+=x.periodos[pp].minutos;
    }
  }
  for(const v of Object.values(p)){
    v.importKWh=redondea(v.importKWh);v.exportKWh=redondea(v.exportKWh);v.minutos=redondea(v.minutos);
  }
  return {periodos:p,diasCompatibles:rows.filter(r=>r.calidad==='compatible').length,
    diasRevisados:rows.length,rechazados,estimado:true,
    nota:'kWh por periodo aproximados según acumulados SPC y horario CNMC. No se aplican precios indexados ni se certifica el huso del portal.'};
}
const Horario=Object.freeze({analizarDia,agruparDias,PERIODS});
globalThis.GorraizSpcHorario=Horario;
export {analizarDia,agruparDias,PERIODS};
