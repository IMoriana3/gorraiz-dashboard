import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('todo el JavaScript inline del dashboard es sintacticamente valido',()=>{
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const inline=scripts.map(x=>x[1]).filter(x=>x.trim());
  assert.equal(inline.length,1,'Se espera un único script inline de dashboard');
  assert.doesNotThrow(()=>new vm.Script(inline[0],{filename:'gorraiz/index.html'}));
});
test('UI KSTAR contiene conexión aislada y previene mostrar i-DE como fuente actual',()=>{
  for(const id of ['cfgKstar','spcPeriodosKwh','spcAccion','btnSpc',
    'aDesde','aHasta','btnAuto','zSpc','zPrecios'])
    assert.match(html,new RegExp('id="'+id+'"'),id);
  assert.match(html,/spc-horario\.js/);
  assert.match(html,/KSTAR_ONLY=true/);
  assert.match(html,/kstarCall\(bl\[i\]\.desde,bl\[i\]\.hasta\)/);
  assert.match(html,/!KSTAR_ONLY&&est\.datadis/);
  // La clave de KSTAR se guarda en este equipo, como la del Worker principal,
  // y se sigue leyendo la antigua de sesión para no perderla a media sesión.
  assert.match(html,/localStorage\.setItem\(KSTAR_CLAVE_KEY,clave\)/);
  assert.match(html,/localStorage\.getItem\(KSTAR_CLAVE_KEY\)\|\|sessionStorage\.getItem\(KSTAR_SESSION_KEY\)/);
  assert.match(html,/if\(KSTAR_ONLY\)return \{hourly:\[\],daily:\[\]\}/);
  assert.match(html,/spcPeriodos=detalle/);
});
test('las graficas entran en el PDF compuestas sobre blanco, no sobre el negro del JPEG',()=>{
  // JPEG no guarda transparencia y el navegador compone lo transparente sobre
  // negro. Los lienzos de Chart.js no pintan fondo, asi que codificarlos
  // directamente metia cada grafica del informe en un recuadro negro.
  assert.match(html,/function pdfLienzoBlanco\(cv\)/);
  const fn=html.match(/function pdfLienzoBlanco\(cv\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn,/fillStyle='#ffffff'/);
  assert.match(fn,/fillRect\(0,0,off\.width,off\.height\)/);
  assert.ok(fn.indexOf('fillRect')<fn.indexOf('drawImage'),
    'hay que pintar el blanco antes de volcar el lienzo encima');
  assert.match(html,/doc\.addImage\(pdfLienzoBlanco\(cv\),'JPEG'/);
  // Nadie mas puede codificar un lienzo en JPEG sin pasar por ahi.
  assert.equal((html.match(/toDataURL\('image\/jpeg'/g)||[]).length,1,
    'el unico toDataURL JPEG debe ser el de pdfLienzoBlanco');
  // El mapa de calor si pinta su propio fondo oscuro y se queda en PNG.
  assert.match(html,/doc\.addImage\(cv\.toDataURL\('image\/png'\),'PNG'/);
});
test('las cuatro graficas que ignoraban el vertido ya lo pintan',()=>{
  // Media por dia de semana: en pila aparte, porque importacion + autoconsumo
  // ES el consumo y meter el vertido dentro rompe esa lectura.
  assert.match(html,/\{label:'Vertido',data:R\.weekly\.map\(w=>w\.export\),backgroundColor:'#5c95cf',stack:'v'\}/);
  assert.match(html,/\{label:'Autoconsumo',data:R\.weekly\.map\(w=>w\.pv\),backgroundColor:'#d4a039',stack:'a'\}/);
  // Perfil horario: cada serie de red con su pareja de vertido, en discontinuo.
  for(const s of ['vLV','vS','vD'])
    assert.match(html,new RegExp("data:R\\.hpCons\\."+s+",borderColor:'#[0-9a-f]{6}',borderDash:\\[4,2\\]"),s);
  // Donut de tres porciones.
  assert.match(html,/labels:\['Autoconsumo','Importación','Vertido'\]/);
  assert.match(html,/data:\[R\.tPV,R\.tR,R\.tExport\]/);
  // Perfil de dia laborable de la pagina del historico.
  assert.match(html,/data:an\.perfil\.map\(p=>p\.vert\)/);
  // El nombre «Cobertura FV» se reserva para el recuadro del porcentaje: el
  // donut ya no suma el consumo, asi que no puede llamarse igual.
  assert.match(html,/<h4>Reparto de energía<\/h4>/);
  assert.equal((html.match(/'Cobertura FV'/g)||[]).length,1,
    'solo el KPI del porcentaje conserva el nombre');
  // El corte del vertido tiene un unico juez, compartido por balance y perfil.
  assert.match(html,/function vertidoCuenta\(date\)/);
  assert.match(html,/if\(vertidoCuenta\(d\.date\)\)return d;/);
  assert.match(html,/vertidoCuenta\(spcFecha\(dk\(r\.ts\)\)\)\?Math\.max\(0,r\.gen\):0/);
});

test('Informe y SCADA escriben FV/SPC en la misma base central sin forzar proveedor',()=>{
  for(const id of ['zCompartido','btnCentroLeer','btnCentroSubir','centroEstado'])
    assert.match(html,new RegExp('id="'+id+'"'),id);
  for(const method of ['bajaHistoricoCompartido','subeHistoricoLocal','guardaDiaSpcCentral'])
    assert.match(html,new RegExp('async function '+method+'\\('),method);
  assert.match(html,/historico\/estado/);
  assert.match(html,/historico\/datos/);
  assert.match(html,/historico\/guardar/);
  assert.match(html,/if\(separado\)await guardaDiaSpcCentral\(bl\[i\]\.desde,p\)/);
  assert.match(html,/await guardaDiaSpcCentral\(dia,p\)/);
  assert.match(html,/\.then\(\(\)=>bajaHistoricoCompartido\(\)\)/);
  // Recuperar meses recientes no debe eliminar meses centrales ya importados.
  assert.match(html,/const antes=PROD_FUENTES\[tipo\]\.find/);
  assert.match(html,/const unidos=new Map/);
});

test('guardar fuentes no borra entradas nuevas escritas desde otra pestaña',()=>{
  const start=html.indexOf('function guardaFuentes(){');
  const end=html.indexOf('async function cargaFuentes(){',start);
  assert.ok(start>=0&&end>start);
  const code=html.slice(start,end);
  assert.doesNotMatch(code,/st\.clear\(\)/,'guardar una fuente no debe vaciar IndexedDB');
  assert.match(code,/st\.get\(source\.id\)/,'debe conciliar contra el registro más nuevo');
  assert.match(code,/mezclaFuenteLocal\(request\.result,source\)/);
  // Olvidar todo sigue siendo una acción explícita separada.
  assert.match(html,/async function olvidaTodo\(\)\{[\s\S]*?objectStore\(DB_STORE\)\.clear\(\)/);
});
test('la conciliación IndexedDB mantiene puntos FV recién descargados por SCADA',()=>{
  const start=html.indexOf('function mezclaFuenteLocal(');
  const end=html.indexOf('function guardaFuentes(){',start);
  assert.ok(start>=0&&end>start);
  const merge=vm.runInNewContext(html.slice(start,end)+'\nmezclaFuenteLocal',{Date,Map});
  const yesterday='2026-10-20';
  const old={
    id:'A|Compartido '+yesterday,tipo:'A',nombre:'Compartido '+yesterday,
    updatedAt:'2026-10-22T12:00:00Z',
    rows:[{ts:new Date(yesterday+'T08:00:00Z'),pot:22,dia:15,acum:100},
          {ts:new Date(yesterday+'T08:05:00Z'),pot:25,dia:20,acum:105}]
  };
  const stale={
    id:old.id,tipo:'A',nombre:old.nombre,
    rows:[{ts:new Date(yesterday+'T08:00:00Z'),pot:11,dia:null,acum:null},
          {ts:new Date(yesterday+'T07:55:00Z'),pot:19,dia:11,acum:90}]
  };
  const result=merge(old,stale);
  assert.equal(result.rows.length,3,'conservar muestras antiguas y nuevas');
  const byTime=t=>result.rows.find(r=>+new Date(r.ts)===+new Date(yesterday+'T'+t+'Z'));
  assert.equal(byTime('08:00:00').pot,22,'la fuente SCADA más reciente manda');
  assert.equal(byTime('08:05:00').pot,25,'no perder la muestra nueva');
  assert.equal(byTime('07:55:00').pot,19,'añadir tramo anterior disponible');
  const newer={...stale,updatedAt:'2026-10-22T13:00:00Z'};
  const corrected=merge(old,newer);
  assert.equal(corrected.rows.find(r=>+new Date(r.ts)===+new Date(yesterday+'T08:00:00Z')).pot,11);
  assert.equal(corrected.rows.find(r=>+new Date(r.ts)===+new Date(yesterday+'T08:00:00Z')).dia,15,
    'los valores nulos de una fuente no borran acumulados válidos');
});
test('SPC completo más reciente nunca se sobrescribe con día parcial ni versión vieja',()=>{
  const start=html.indexOf('function mezclaFuenteLocal('),end=html.indexOf('function guardaFuentes(){',start);
  const merge=vm.runInNewContext(html.slice(start,end)+'\nmezclaFuenteLocal',{Date,Map});
  const existing={tipo:'S',fecha:'2026-10-20',payload:{
    rows:[{saveTime:'2026-10-20 10:00:00'}],
    meta:{completo:true,fetchedAt:'2026-10-22T10:00:00Z'}}};
  const partial={tipo:'S',fecha:'2026-10-20',payload:{
    rows:[],meta:{completo:false,fetchedAt:'2026-10-22T11:00:00Z'}}};
  assert.strictEqual(merge(existing,partial),existing);
  const old={...partial,payload:{rows:[],meta:{completo:true,fetchedAt:'2026-10-21T11:00:00Z'}}};
  assert.strictEqual(merge(existing,old),existing);
});

test('el Informe convierte W antiguas por procedencia sin inventar unidad de XLSX',()=>{
 const start=html.indexOf('function unidadPotenciaLocal(');
 const end=html.indexOf('async function guardaDiaSpcCentral(',start);
 assert.ok(start>=0&&end>start);
 const elements={unidadXlsxLegacy:{value:'desconocida'}};
 const context=vm.createContext({
   Date,Map,Number,Promise,
   $:id=>elements[id],spcFecha:()=>true,dk:()=> '2026-10-19',
   apiCfg:()=>({url:'https://qa.invalid',key:'fictional'}),
   SPC_FUENTES:[],PROD_FUENTES:{A:[],B:[]},
   fn:x=>String(x),centroMensaje:()=>{},
   HIST_CENTRO_OCUPADO:false,apiCall:async()=>({guardadas:1})
 });
 const funcs=html.slice(start,end);
 vm.runInContext(funcs,context);
 const ask=text=>vm.runInContext(text,context);
 assert.equal(ask("unidadPotenciaLocal({nombre:'Solarman 2026-10-19'})"),'W');
 assert.equal(ask("unidadPotenciaLocal({nombre:'Solarman 2026-10-19',unidadPotencia:'kW'})"),'kW');
 assert.equal(ask("unidadPotenciaLocal({nombre:'Ficheros'})"),'desconocida');
 const source="{nombre:'Solarman 2026-10-19',rows:[{ts:new Date('2026-10-19T08:05:00Z'),pot:35000,dia:150,acum:35000}]}";
 const normalized=ask("fuenteDiaNormalizada('A',"+source+", "+source+".rows[0])");
 assert.equal(normalized.row.pot,35);
 elements.unidadXlsxLegacy.value='W';
 assert.equal(ask("unidadPotenciaLocal({nombre:'Ficheros'})"),'W');
 elements.unidadXlsxLegacy.value='desconocida';
 assert.equal(ask("unidadPotenciaLocal({nombre:'Ficheros'})"),'desconocida');
});
test('si un solo día falla el resto de la migración continúa y se conserva local',async()=>{
 const start=html.indexOf('function unidadPotenciaLocal(');
 const end=html.indexOf('async function guardaDiaSpcCentral(',start);
 assert.ok(start>=0&&end>start);
 const elements={
  btnCentroSubir:{disabled:false},btnCentroDiagnostico:{disabled:false},
  unidadXlsxLegacy:{value:'desconocida'},
  centroInformeMigracion:{textContent:''},centroDetalles:{open:false}
 };
 const messages=[],sent=[];
 const dateArray=Array.from({length:597},(_,i)=>new Date(Date.parse('2025-03-04T00:00:00Z')+i*864e5).toISOString().slice(0,10));
 const context=vm.createContext({
   Date,Map,Number,Promise,
   $:id=>elements[id],spcFecha:()=>true,
   dk:d=>d.toISOString().slice(0,10),
   apiCfg:()=>({url:'https://qa.invalid',key:'fictional'}),
   SPC_FUENTES:[],PROD_FUENTES:{
     A:[{nombre:'Solarman 2026',rows:dateArray.map(d=>({
       ts:new Date(d+'T10:00:00Z'),pot:35000,dia:150,acum:35000}))}],
     B:[]
   },
   centroMensaje:msg=>messages.push(msg),HIST_CENTRO_OCUPADO:false,
   apiCall:async(route,body)=>{
     if(route==='/historico/validar'){
       const rejected=body.items.filter(s=>s.fecha==='2026-01-10');
       return {version:'migracion-v3',
         validas:body.items.length-rejected.length,
         rechazadas:rejected.length,
         incidencias:rejected.map(s=>({tipo:s.tipo,fecha:s.fecha,
           motivo:'Hora incompatible'}))};
     }
     assert.equal(route,'/historico/guardar');
     sent.push(...body.items);
     return{version:'migracion-v3',guardadas:body.items.length,
       rechazadas:0,pendientesPotencia:0,pendientesEnergia:0,incidencias:[]}
   }
 });
 vm.runInContext(html.slice(start,end),context);
 await vm.runInContext('subeHistoricoLocal()',context);
 assert.equal(sent.length,596,'guardar 596/597 sin detenerse en el primer lote');
 assert.equal(sent[0].rows[0].pot,35,'las W se guardan como kW');
 assert.match(messages.at(-1),/596\/597/);
 assert.match(messages.at(-1),/1 rechazados/);
 assert.match(elements.centroInformeMigracion.textContent,/2026-01-10: Hora incompatible/);
 assert.equal(elements.centroDetalles.open,true);
 assert.equal(elements.btnCentroSubir.disabled,false,'el botón queda habilitado tras migrar');
});

test('si el servidor rechaza todos los días, el diagnóstico explica el 0/N sin escribir nada',async()=>{
 const a=html.indexOf('function unidadPotenciaLocal(');
 const b=html.indexOf('async function guardaDiaSpcCentral(',a);
 assert.ok(a>=0&&b>a);
 const days=['2026-10-19','2026-10-20','2026-10-21'];
 const elements={btnCentroSubir:{disabled:false},btnCentroDiagnostico:{disabled:false},
   unidadXlsxLegacy:{value:'desconocida'},
   centroInformeMigracion:{textContent:''},centroDetalles:{open:false}};
 let writes=0;const notices=[];
 const context=vm.createContext({Date,Map,Number,Promise,
   $:id=>elements[id],spcFecha:()=>true,dk:d=>d.toISOString().slice(0,10),
   apiCfg:()=>({url:'https://qa.invalid',key:'ficticia'}),
   PROD_FUENTES:{A:[{nombre:'Solarman 2026',rows:days.map(d=>({
     ts:new Date(d+'T10:00:00Z'),pot:34000,dia:100,acum:1000}))}],B:[]},
   SPC_FUENTES:[],HIST_CENTRO_OCUPADO:false,
   centroMensaje:m=>notices.push(m),
   apiCall:async(path,body)=>{
     if(path==='/historico/validar')return {
       version:'migracion-v3',validas:0,rechazadas:body.items.length,
       incidencias:body.items.map(item=>({tipo:item.tipo,fecha:item.fecha,
         motivo:'Marca FV incompatible: revisar hora sin alterar originales'}))};
     writes++;
     return{version:'migracion-v3',guardadas:0,rechazadas:body.items.length}
   }});
 vm.runInContext(html.slice(a,b),context);
 await vm.runInContext('diagnosticarMigracion()',context);
 assert.equal(writes,0,'el diagnóstico nunca escribe');
 assert.match(notices.at(-1),/0\/3 fuentes compatibles/);
 await vm.runInContext('subeHistoricoLocal()',context);
 assert.equal(writes,0,'no debe subir objetos que la validación acaba de rechazar');
 assert.match(notices.at(-1),/0\/3 conjuntos guardados/);
 assert.match(notices.at(-1),/3 rechazados/);
 assert.match(elements.centroInformeMigracion.textContent,/Marca FV incompatible/);
 assert.equal(elements.centroDetalles.open,true);
});
