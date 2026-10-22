import {availableDays,buildSeries,numeric} from './scada-data.mjs';
import {SCADA_POLL_MS,SCADA_QUOTA_KEY,SCADA_LOCK_NAME,quotaState,reserveAttempt} from './scada-quota.mjs';

const $=id=>document.getElementById(id);
const fmt=new Intl.NumberFormat('es-ES',{maximumFractionDigits:1});
const fmt2=new Intl.NumberFormat('es-ES',{maximumFractionDigits:2});
const paints={generation:'#48d18a',consumption:'#6ebcff',import:'#f27478',export:'#efc357',a:'#76d6cf',b:'#8bdb97'};
let stored=[],day='',range=1,charts={},pvBusy=false,autoTimer=null;
function madridToday(){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
}
function text(id,value){$(id).textContent=value}
function kw(v){return v===null||v===undefined?'—':fmt.format(v)+' kW'}
function kwh(v){return v===null||v===undefined?'—':fmt2.format(v)+' kWh'}
function hh(key){return key?key.slice(11,16):'—'}
function safeState(message){text('notice',message)}
function getDb(){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open('gorraiz_datos',1);
  r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('fuentes'))r.result.createObjectStore('fuentes',{keyPath:'id'})};
  r.onerror=()=>reject(r.error||new Error('No se pudo abrir IndexedDB'));
  r.onsuccess=()=>resolve(r.result);
 });
}
async function load(){
 const db=await getDb();
 return new Promise((resolve,reject)=>{
  const q=db.transaction('fuentes','readonly').objectStore('fuentes').getAll();
  q.onsuccess=()=>{db.close();resolve(q.result||[])};
  q.onerror=()=>{db.close();reject(q.error)};
 });
}
async function storePV(data,onDate){
 const entries=[];
 for(const type of ['A','B']){
  if(!Array.isArray(data[type])||!data[type].length)continue;
  const rows=data[type].map(x=>({ts:new Date(x.ts),pot:numeric(x.pot),
     acum:numeric(x.acum),dia:numeric(x.dia)})).filter(x=>Number.isFinite(+x.ts));
  if(!rows.length)continue;
  entries.push({id:type+'|SCADA Solarman '+onDate,tipo:type,nombre:'SCADA Solarman '+onDate,
    updatedAt:new Date().toISOString(),rows});
 }
 if(!entries.length)throw new Error('El Worker no devolvió muestras válidas de ninguno de los inversores.');
 const db=await getDb();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction('fuentes','readwrite'),os=tx.objectStore('fuentes');
  for(const entry of entries)os.put(entry);
  tx.oncomplete=()=>{db.close();resolve(entries.map(x=>x.tipo).join(' y '))};
  tx.onerror=()=>{db.close();reject(tx.error)};
 });
}
function chartStyle(){
 return {responsive:true,maintainAspectRatio:false,animation:false,normalized:true,
  interaction:{mode:'index',intersect:false},plugins:{legend:{display:true,position:'bottom',
   labels:{color:'#aec5cc',boxWidth:9,boxHeight:9,padding:14,font:{size:10}}},
   tooltip:{callbacks:{label:p=>p.parsed.y===null?p.dataset.label+': sin dato':p.dataset.label+': '+fmt.format(p.parsed.y)+' kW'}}},
  elements:{point:{radius:0,hitRadius:9},line:{borderWidth:1.8,tension:0.08,spanGaps:false}},
  scales:{x:{grid:{color:'#243b44'},ticks:{color:'#89a5af',autoSkip:true,maxTicksLimit:9,
     callback:function(i){const s=this.getLabelForValue(i);return s.length===16?
       (range===7?s.slice(8,10)+'/'+s.slice(5,7)+' '+s.slice(11):s.slice(11)) : s}}},
   y:{beginAtZero:true,title:{display:true,text:'kW',color:'#9ab5bb'},grid:{color:'#2c424b'},ticks:{color:'#99b1ba'}}}};
}
function makeSeries(label,values,color,dashed=false){
 return {label,data:values,borderColor:color,backgroundColor:color,pointBackgroundColor:color,
  borderDash:dashed?[5,4]:[],fill:false};
}
function paint(canvasId,series,labels){
 const element=$(canvasId);
 if(!element || element.closest('.scada-view[hidden]')){
   charts[canvasId]?.destroy();delete charts[canvasId];return;
 }
 if(typeof Chart==='undefined'){
  $('notice').textContent='Chart.js no está disponible: comprueba la conexión con el CDN antes de interpretar las gráficas.';
  return;
 }
 charts[canvasId]?.destroy();
 charts[canvasId]=new Chart($(canvasId),{type:'line',data:{labels,datasets:series},options:chartStyle()});
}
function notices(lines){
 const el=$('alarms');el.replaceChildren();
 if(!lines.length)lines=['Sin incidencias de datos identificadas en el periodo consultado. No se supervisan alarmas del inversor.'];
 for(const line of lines){
  const p=document.createElement('p');p.textContent='• '+line;el.append(p);
 }
}
function setDevice(dotId,labelId,last,source){
 const dot=$(dotId);dot.classList.toggle('off',!last);dot.classList.toggle('warn',!!last);
 text(labelId,last?fmt.format(last.value)+' kW · '+hh(last.key):source||'Sin muestra');
}
function bar(id,value,max){
 $(id).style.width=value!==null&&max>0?Math.max(0,Math.min(100,100*value/max))+'%':'0%';
}
const SCADA_VIEW_IDS=new Set(['general','planta','inversores','red','historicos','diagnostico']);
function navigateView(){
 const requested=location.hash.slice(1);
 const chosen=SCADA_VIEW_IDS.has(requested)?requested:'general';
 for(const panel of document.querySelectorAll('[data-view-panel]'))
   panel.hidden=panel.dataset.viewPanel!==chosen;
 for(const link of document.querySelectorAll('[data-view-link]')){
   const current=link.dataset.viewLink===chosen;
   link.classList.toggle('on',current);
   if(current)link.setAttribute('aria-current','page');
   else link.removeAttribute('aria-current');
 }
 if(day)repaint(); // reconstruye solo las gráficas visibles, nunca llama a API
 window.scrollTo({top:0,behavior:'auto'});
}
function updateDetailPanels(r,labels){
 const present=values=>values.filter(v=>v!==null).length;
 const solarCount=present(r.series.generation);
 const gridCount=present(r.series.import);
 const from=r.dates[0]||'—',to=r.dates.at(-1)||'—';
 const pvCurves=[
   makeSeries('Generación total',r.series.generation,paints.generation),
   makeSeries('Inversor A',r.series.a,paints.a,true),
   makeSeries('Inversor B',r.series.b,paints.b,true)];
 const gridCurves=[
   makeSeries('Importación · media estimada',r.series.import,paints.import),
   makeSeries('Exportación · media estimada',r.series.export,paints.export)];
 const commonCurves=[
   makeSeries('Generación',r.series.generation,paints.generation),
   makeSeries('Consumo calculado',r.series.consumption,paints.consumption,true),
   ...gridCurves];
 text('plantNow',kw(r.last.generation?.value));
 text('plantDay',kwh(r.summary.generation));
 text('plantPoints',String(solarCount));
 paint('plantChart',pvCurves,labels);
 text('invDetailA',r.last.a?kw(r.last.a.value)+' · '+hh(r.last.a.key):'Sin muestra de A');
 text('invDetailB',r.last.b?kw(r.last.b.value)+' · '+hh(r.last.b.key):'Sin muestra de B');
 text('invCoverageA',present(r.series.a)+' muestras válidas de A en la selección.');
 text('invCoverageB',present(r.series.b)+' muestras válidas de B en la selección.');
 paint('inverterAChart',[makeSeries('Inversor A',r.series.a,paints.a)],labels);
 paint('inverterBChart',[makeSeries('Inversor B',r.series.b,paints.b)],labels);
 text('redImpDay',kwh(r.summary.import));
 text('redExpDay',kwh(r.summary.export));
 text('redPoints',String(gridCount));
 const gridDay=r.gridState[to];
 const clockVerified=gridDay?.ready===true&&gridDay.meta?.timezoneVerified===true;
 text('redClock',clockVerified?'Zona horaria señalada como verificada':'Reloj SPC sin verificar con Solarman');
 paint('redDetailChart',gridCurves,labels);
 text('historyDates',from+' → '+to);
 text('historyCoverage','En '+r.keys.length+' intervalos posibles se observan '+solarCount+
   ' con generación simultánea, '+gridCount+' con medición derivada de KSTAR y '+
   r.common+' con consumo calculable. Los demás quedan vacíos; no equivalen a cero.');
 paint('historyChart',commonCurves,labels);
 text('diagPv',String(solarCount));
 text('diagGrid',String(gridCount));
 text('diagCons',String(r.common));
 text('diagClock',clockVerified?'Metadato SPC: huso horario verificado para '+to+'.':
   'Reloj del SPC sin contrastar frente a Solarman para '+to+
   '. El consumo horario no se confirma salvo cruce provisional explícito.');
 const warningLines=[...r.warnings];
 if(!r.gridState[to])warningLines.push('Sin jornada SPC con intervalos conciliados el '+to+'.');
 if(!solarCount)warningLines.push('No coinciden los dos inversores en ningún punto de este periodo.');
 if(!warningLines.length)warningLines.push('Sin incidencias de cobertura detectadas en el intervalo. No se supervisan alarmas de hardware.');
 const container=$('diagWarnings');
 container.replaceChildren();
 for(const warning of warningLines){
   const p=document.createElement('p');p.textContent=warning;container.appendChild(p);
 }
}

function repaint(){
 if(!day)return;
 const r=buildSeries(stored,{date:day,range,allowProvisional:$('provisional').checked});
 const labels=r.keys;
 paint('mainChart',[
  makeSeries('Generación FV · medida',r.series.generation,paints.generation),
  makeSeries('Consumo · derivado',r.series.consumption,paints.consumption,true),
  makeSeries('Importación · media estimada',r.series.import,paints.import),
  makeSeries('Exportación · media estimada',r.series.export,paints.export)],labels);
 paint('pvChart',[
  makeSeries('Generación',r.series.generation,paints.generation),
  makeSeries('Inversor A',r.series.a,paints.a,true),
  makeSeries('Inversor B',r.series.b,paints.b,true)],labels);
 paint('consChart',[makeSeries('Consumo calculado',r.series.consumption,paints.consumption)],labels);
 paint('gridChart',[makeSeries('Importación',r.series.import,paints.import),
  makeSeries('Exportación',r.series.export,paints.export)],labels);

 updateDetailPanels(r,labels);
 text('powerGen',kw(r.last.generation?.value));
 text('powerCons',kw(r.last.consumption?.value));
 text('powerImp',kw(r.last.import?.value));
 text('powerExp',kw(r.last.export?.value));
 text('powerSelf',kwh(r.summary.spcAutoconsumption));
 text('subGen',r.last.generation?'Último punto '+hh(r.last.generation.key)+' · Solarman':'Sin medidas A+B simultáneas');
 text('subCons',r.last.consumption?(r.provisional?'Estimación provisional · '+hh(r.last.consumption.key):
  'Cruce horario validado · '+hh(r.last.consumption.key)):'Pendiente de reloj SPC y ambos inversores');
 text('subImp',r.last.import?'Media intervalo · '+hh(r.last.import.key):'KSTAR sin intervalos conciliados');
 text('subExp',r.last.export?'Media intervalo · '+hh(r.last.export.key):'KSTAR sin intervalos conciliados');
 text('flowGen',kw(r.last.generation?.value));
 text('flowInv',kw(r.last.generation?.value));
 text('flowLoad',kw(r.last.consumption?.value));
 text('flowImp',kw(r.last.import?.value));
 text('flowExp',kw(r.last.export?.value));
 text('invA',r.last.a?kw(r.last.a.value)+' · '+hh(r.last.a.key):'Sin lectura');
 text('invB',r.last.b?kw(r.last.b.value)+' · '+hh(r.last.b.key):'Sin lectura');
 setDevice('dotA','invA',r.last.a);setDevice('dotB','invB',r.last.b);
 const spc=r.gridState[day];const isSpc=!!spc?.ready;
 $('dotSPC').classList.toggle('off',!isSpc);$('dotSPC').classList.toggle('warn',isSpc);
 text('spcState',isSpc?'Intervalos históricos':'Sin intervalo validado');
 $('dotBalance').classList.toggle('off',!r.common);$('dotBalance').classList.toggle('warn',!!r.common);
 text('balanceState',r.common?r.common+' pares de muestras':'Falta cruce horario');
 text('miniGen',r.last.generation?kw(r.last.generation.value):'Sin potencia');
 text('miniCons',r.last.consumption?(r.provisional?'Provisional':'Derivado'):'Sin correspondencia temporal');
 text('dailyGen',kwh(r.summary.generation));
 text('dailyCons',kwh(r.summary.consumption));
 text('dailyExp',kwh(r.summary.export));
 text('dailyImp',kwh(r.summary.import));
 const vmax=Math.max(0,...Object.values(r.summary).filter(x=>typeof x==='number'&&Number.isFinite(x)));
 bar('barGen',r.summary.generation,vmax);bar('barCons',r.summary.consumption,vmax);
 bar('barExp',r.summary.export,vmax);bar('barImp',r.summary.import,vmax);
 const maxDay=availableDays(stored).at(-1)||null;
 $('empty').style.display=r.keys.some((k,i)=>Object.values(r.series).some(a=>a[i]!==null))?'none':'block';
 const latest=[r.last.generation?.key,r.last.import?.key,r.last.export?.key].filter(Boolean).sort().at(-1);
 text('updated',latest?'Última muestra seleccionada: '+latest.replace('T',' '):'Sin muestras de potencia');
 const current=day===madridToday();
 $('state').innerHTML=current?'<i class="dot warn"></i> Histórico del día · no en directo':
   '<i class="dot off"></i> Histórico · '+(range===7?'7 días':day);
 notices([
  ...r.warnings,
  ...(current?['El día en curso está abierto: el balance es provisional.']:[]),
  ...(!stored.some(x=>x.tipo==='S')?['SPC sin histórico local; la consulta KSTAR exige un día cerrado.']:[]),
  ...(maxDay&&maxDay<day?['Última fecha con datos: '+maxDay]:[])
 ]);
 safeState('Datos locales · '+r.dates[0]+' → '+r.dates.at(-1)+
  ' · A+B '+r.series.generation.filter(x=>x!==null).length+
  ' muestras · SPC '+r.series.import.filter(x=>x!==null).length+
  ' intervalos · consumo '+r.common+' puntos'+
  (r.provisional?' · cruce provisional SIN validar':'')+'.');
}
async function reload({keepDay=true}={}){
 try{
  stored=await load();const ds=availableDays(stored),prev=keepDay?$('day').value:'';
  day=prev||ds.at(-1)||madridToday();$('day').value=day;
  if(ds.length){$('day').min=ds[0];$('day').max=madridToday()>ds.at(-1)?madridToday():ds.at(-1)}
  repaint();
 }catch(e){safeState('No se pudo cargar el almacén local: '+e.message)}
}
function apiCfg(){
 try{return JSON.parse(localStorage.getItem('gorraiz_api_cfg')||'{}')}catch{return{}}
}
const madridClock=new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'});
function quotaMessage() {
 const q=quotaState(localStorage);
 if(q.error)return 'Cupo horario no disponible: '+q.error;
 return q.allowed?'Solarman: se admite una actualización (máximo 1 intento por hora y navegador).':
   'Solarman: próxima actualización permitida a las '+madridClock.format(new Date(q.nextAt))+' (Madrid).';
}
function showQuota(){text('rateInfo',quotaMessage())}
async function reserveHourlyUpdate({auto=false}={}) {
 // Web Locks serializa la reserva entre las pestañas del mismo origen.
 // Si no hay exclusión segura, la descarga automática se deshabilita.
 if(typeof navigator!=='undefined' && navigator.locks?.request)
   return navigator.locks.request(SCADA_LOCK_NAME,{mode:'exclusive'},()=>reserveAttempt(localStorage));
 return auto
   ? {allowed:false,error:'Este navegador no ofrece bloqueo entre pestañas; actualización automática deshabilitada.'}
   : reserveAttempt(localStorage); // manual: límite local, sin garantía entre dos pestañas simultáneas
}
async function refreshPV({auto=false}={}){
 if(pvBusy || (auto&&document.hidden))return;
 const c=apiCfg();const selected=auto?madridToday():day;
 if(!c.url||!c.key){safeState('Configura primero la URL y clave del Worker de Solarman en el informe principal.');return}
 let url;
 try{url=new URL(c.url);if(url.protocol!=='https:'||url.username||url.password||
   url.search||url.hash)throw new Error('URL no permitida')}
 catch{safeState('La URL del Worker debe ser HTTPS y no incluir usuario, query ni fragmentos.');return}
 const btn=$('updatePV');pvBusy=true;btn.disabled=true;
 try{
  const quota=await reserveHourlyUpdate({auto});
  showQuota();
  if(!quota.allowed){
   safeState(quota.error?
    'Consulta bloqueada para conservar el cupo: '+quota.error:
    'Cupo Solarman: consulta bloqueada hasta las '+madridClock.format(new Date(quota.nextAt))+
    '. Las curvas siguen disponibles desde el almacenamiento local.');
   return;
  }
  safeState('Consulta horaria autorizada · Solarman '+selected+'. KSTAR no se consulta.');
  const response=await fetch(url.origin+url.pathname.replace(/\/$/,'')+'/produccion',{
   method:'POST',cache:'no-store',headers:{'content-type':'application/json','X-Panel-Key':c.key},
   body:JSON.stringify({desde:selected,hasta:selected})});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('Worker de Solarman respondió HTTP '+response.status);
  const types=await storePV(body,selected);
  await reload({keepDay:true});
  $('dotLink').classList.remove('off');$('dotLink').classList.add('warn');
  text('linkState','Consulta correcta · '+new Date().toLocaleTimeString('es-ES'));
  safeState('Solarman actualizado para '+types+' el '+selected+
   '. Gráficas regeneradas. KSTAR continúa histórico manual y no se ha consultado.');
 }catch(e){
  $('dotLink').classList.add('off');$('dotLink').classList.remove('warn');
  text('linkState','Error de actualización');
  safeState('Solarman: '+e.message+'. Se conservan los datos locales anteriores.');
 }finally{pvBusy=false;btn.disabled=false;showQuota()}
}
function setRange(n){
 range=n;$('one').setAttribute('aria-pressed',String(n===1));
 $('seven').setAttribute('aria-pressed',String(n===7));repaint();
}
$('one').addEventListener('click',()=>setRange(1));
$('seven').addEventListener('click',()=>setRange(7));
$('day').addEventListener('change',()=>{day=$('day').value;repaint()});
$('today').addEventListener('click',()=>{day=madridToday();$('day').value=day;repaint()});
$('reload').addEventListener('click',()=>reload());
$('provisional').addEventListener('change',repaint);
$('updatePV').addEventListener('click',()=>refreshPV());
$('auto').addEventListener('change',()=>{
 if(autoTimer)clearInterval(autoTimer);autoTimer=null;
 if($('auto').checked){
  if(!navigator.locks?.request){
   $('auto').checked=false;
   safeState('Automático no activado: este navegador no puede coordinar la cuota entre pestañas.');
   return;
  }
  safeState('Actualización automática FV cada 60 min, solo con la pestaña abierta y visible. '+
    'No hace ninguna consulta al activar ni abrir la pantalla; KSTAR permanece manual.');
  // No disparamos una consulta al marcar la casilla: el temporizador arranca ahora.
  autoTimer=setInterval(()=>refreshPV({auto:true}),SCADA_POLL_MS);
 } else {
  safeState('Actualización FV automática desactivada; las gráficas siguen usando datos locales.');
 }
});
window.addEventListener('storage',e=>{
 if(e.key==='gorraiz_api_cfg')text('linkState','Conexión modificada en otra pestaña');
 if(e.key===SCADA_QUOTA_KEY)showQuota();
});
showQuota();
setInterval(showQuota,60_000); // solo interfaz local, cero llamadas a la API
window.addEventListener('hashchange',navigateView);
navigateView();
await reload({keepDay:false});
