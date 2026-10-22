import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const slice=(from,to)=>{
 const a=html.indexOf(from),b=html.indexOf(to,a+from.length);
 assert.ok(a>=0&&b>a,'No existe el bloque '+from);
 return html.slice(a,b);
};
function context({quota=false,range=false}={}){
 const calls=[],saved=[],tables={
  aDesde:{value:range?'2026-09-01':'2026-10-21'},aHasta:{value:'2026-10-21'},
  spcDiaManual:{value:'2026-10-21',dataset:{},addEventListener(){}},
  spcHastaManual:{value:'2026-10-21',dataset:{},addEventListener(){}},
  stAuto:{textContent:''},spcAccion:{textContent:''},
  btnAuto:{disabled:false,textContent:'Descargar Solarman'},
  btnSpcSolo:{disabled:false,textContent:'Descargar SPC'},
  btnSpc:{disabled:false,textContent:'Reconsultar SPC'}
 };
 let spcCalls=0,centralWrites=0;
 const testCtx=vm.createContext({
  Date,Number,Math,Promise,Error,Array,JSON,
  $:id=>tables[id],spcFecha:date=>typeof date==='string'&&
    /^\d{4}-\d{2}-\d{2}$/.test(date)?date:'',
  spcHoy:()=> '2026-10-22',
  spcSumaDias:(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*864e5).toISOString().slice(0,10),
  SPC_FUENTES:[],
  API_ESTADO:{solarman:true,spc:true},
  estadoApi:async()=>{},pintaSpc:()=>{},chk:()=>{},fdmy:s=>s,fn:n=>String(n),
  kstarCfg:()=>({url:'https://qa-spc.workers.dev',key:'x'.repeat(30)}),
  spcTieneDatos:()=>true,
  incorporaSpc:()=>1,
  guardar:()=>{},
  guardaDiaSpcCentral:async()=>{centralWrites++;return true},
  kstarCall:async(desde,hasta)=>{spcCalls++;
    assert.equal(desde,hasta,'el backend SPC solo recibe un día');
    return{
    rows:[{saveTime:desde+' 10:00:00'}],
    daily:[{date:desde,importKWh:100,exportKWh:0}],
    meta:{fuente:'spc',stationId:'2026032317114373',
      meterId:'210261430F3060020000661',completo:true,
      actualizado:'2026-10-22T10:00:00Z'}
  }},
  KSTAR_STATION:'2026032317114373',KSTAR_METER:'210261430F3060020000661',
  guardando:null,
  ponFuenteProd:(type,name,rows,unit)=>saved.push({type,name,rows,unit}),
  apiCall:async(route,data)=>{
    calls.push(route);
    if(quota&&route==='/produccion')throw Error('Cupo Solarman agotado: 60 minutos');
    if(route==='/produccion')return{
      A:[{ts:'2026-10-21T08:05:00Z',pot:21.2,acum:2000,dia:20}],
      B:[{ts:'2026-10-21T08:05:00Z',pot:19.1,acum:3000,dia:18}]
    };
    throw Error('Ruta externa inesperada '+route);
  }
 });
 vm.runInContext('let SPC_OCUPADO=false;let SPC_PRUEBA=null;'+
  slice('async function descargarSoloSpc(){','// ═══ CONTRASTE')+
  slice('async function traerDatos(){','(function initAuto(){'),testCtx);
 return {testCtx,calls,saved,tables,get spcCalls(){return spcCalls},
   get centralWrites(){return centralWrites}};
}
test('Informe descarga SOLO Solarman con cupo y guarda ambos inversores',async()=>{
 const t=context();
 await vm.runInContext('traerDatos()',t.testCtx);
 assert.deepEqual(t.calls,['/produccion']);
 assert.equal(t.saved.length,2);
 assert.ok(t.saved.every(s=>s.unit==='kW'));
 assert.equal(t.spcCalls,0);
 assert.equal(t.centralWrites,0);
 assert.match(t.tables.stAuto.textContent,/SPC no se ha consultado/);
});
test('Informe descarga SOLO SPC para el día elegido, sin consultar Solarman',async()=>{
 const t=context();
 await vm.runInContext('descargarSoloSpc()',t.testCtx);
 assert.equal(t.spcCalls,1);
 assert.equal(t.centralWrites,1);
 assert.deepEqual(t.calls,[]);
 assert.match(t.tables.spcAccion.textContent,/No se ha consultado Solarman/);
});
test('Cupo Solarman bloqueado no hace consulta SPC ni borra datos',async()=>{
 const t=context({quota:true});
 await vm.runInContext('traerDatos()',t.testCtx);
 assert.deepEqual(t.calls,['/produccion']);
 assert.equal(t.spcCalls,0);
 assert.equal(t.saved.length,0);
 assert.match(t.tables.stAuto.textContent,/Cuota Solarman agotada/);
});
test('Rango de Solarman mayor de 10 días no consume llamadas',async()=>{
 const t=context({range:true});
 await vm.runInContext('traerDatos()',t.testCtx);
 assert.equal(t.calls.length,0);
 assert.match(t.tables.stAuto.textContent,/máximo 10 días/);
});
test('SPC completo ya guardado se reutiliza sin repetir HTTP',async()=>{
 const t=context();
 t.testCtx.SPC_FUENTES.push({date:'2026-10-21',meta:{completo:true}});
 await vm.runInContext('descargarSoloSpc()',t.testCtx);
 assert.equal(t.spcCalls,0);
 assert.equal(t.centralWrites,0);
 assert.match(t.tables.spcAccion.textContent,/ya guardado/);
});

test('Informe: rango SPC de 3 días omite completo, guarda otros y no llama Solarman',async()=>{
 const t=context();
 t.tables.spcDiaManual.value='2026-10-19';
 t.tables.spcHastaManual.value='2026-10-21';
 t.testCtx.SPC_FUENTES.push({date:'2026-10-20',meta:{completo:true}});
 await vm.runInContext('descargarSoloSpc()',t.testCtx);
 assert.equal(t.spcCalls,2);
 assert.equal(t.centralWrites,2);
 assert.deepEqual(t.calls,[]);
 assert.match(t.tables.spcAccion.textContent,/2 días completos nuevos/);
 assert.match(t.tables.spcAccion.textContent,/1 ya guardados/);
 assert.match(t.tables.spcAccion.textContent,/No se ha consultado Solarman/);
});
test('Informe: rango SPC de 14 días permite 14 solicitudes secuenciales',async()=>{
 const t=context();
 t.tables.spcDiaManual.value='2026-10-08';
 t.tables.spcHastaManual.value='2026-10-21';
 await vm.runInContext('descargarSoloSpc()',t.testCtx);
 assert.equal(t.spcCalls,14);
 assert.equal(t.centralWrites,14);
 assert.deepEqual(t.calls,[]);
 assert.match(t.tables.spcAccion.textContent,/14 días completos nuevos/);
});
test('Informe: 15 días SPC no dispara ninguna petición a proveedores ni escritura',async()=>{
 const t=context();
 t.tables.spcDiaManual.value='2026-10-07';
 t.tables.spcHastaManual.value='2026-10-21';
 await vm.runInContext('descargarSoloSpc()',t.testCtx);
 assert.equal(t.spcCalls,0);
 assert.equal(t.centralWrites,0);
 assert.deepEqual(t.calls,[]);
 assert.match(t.tables.spcAccion.textContent,/máximo 14 días/);
});
test('Informe: día SPC en curso se rechaza antes de consultar API',async()=>{
 const t=context();
 t.tables.spcDiaManual.value='2026-10-21';
 t.tables.spcHastaManual.value='2026-10-22';
 await vm.runInContext('descargarSoloSpc()',t.testCtx);
 assert.equal(t.spcCalls,0);
 assert.match(t.tables.spcAccion.textContent,/anterior a hoy/);
});
test('Informe: un día SPC con error no detiene los siguientes',async()=>{
 const t=context();
 t.tables.spcDiaManual.value='2026-10-19';
 t.tables.spcHastaManual.value='2026-10-21';
 const original=t.testCtx.kstarCall;
 t.testCtx.kstarCall=async(desde,hasta)=>{
  if(desde==='2026-10-20')throw Error('KSTAR no disponible 20/10');
  return original(desde,hasta);
 };
 await vm.runInContext('descargarSoloSpc()',t.testCtx);
 assert.equal(t.spcCalls,2);
 assert.equal(t.centralWrites,2);
 assert.match(t.tables.spcAccion.textContent,/1 errores/);
 assert.match(t.tables.spcAccion.textContent,/2026-10-20/);
 assert.match(t.tables.spcAccion.textContent,/2 días completos nuevos/);
});
