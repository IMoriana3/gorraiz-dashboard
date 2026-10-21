import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the actual inline processing functions with the production energy
// module. No browser, network, private invoices or production account is used.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const energy = readFileSync(new URL('../energia.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Dashboard section missing: ${start}`);
  return html.slice(a, b);
}
function dashboard() {
  const local=new Map(),session=new Map();
  const store=m=>({getItem:k=>m.has(k)?m.get(k):null,
    setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)});
  const context = vm.createContext({Intl, Date, URL, localStorage:store(local), sessionStorage:store(session)});
  vm.runInContext(energy, context, {filename: 'energia.js'});
  const source = `
    const CFG={kwp:100,inv:10000,vertidoDesde:'2026-10-01'};
    let PRECIOS=null,PRECIO_FUTURO=false,METEO=null,RAW={A:[],B:[],I:[]};
    function guardaFuentes(){}
    ${section('function fn(x,d=0)', '// ── Parse Excel date ──')}
    ${section('function fdmy(d)', 'function esc(t)')}
    ${section('// ═══ SPC: FUENTES DIARIAS', '// ═══ PRECIOS PRIVADOS:')}
    ${section('function filt(arr,d,h)', '// ── Meteo ──')}
    ${section('function calculaInforme(desde,hasta){', 'async function generate(){')}
    ${section('const FRANJAS=', 'function deltaStr(')}
    pintaSpc=()=>{};
    spcHoy=()=> '2026-10-20';
    globalThis.api={
      procProd,procCons,calcKPIs,calcEvol,calcAnalysis,calculaInforme,calcCompPeriod,
      ponFuenteSpc,incorporaSpc,getSpcDaily,getSpcRows,bloquesSpc,fn,kstarCfg,kstarCall,
      ideDiario,contrasteRed,gridDiario,horasDia,contrasteTexto,contrastePdfTexto,idePeriodos,idePeriodosNota,
      contrasteFactura,contrasteFacturaTexto,contrasteFacturaPdfTexto,diasEntre,ideHorario,
      vertidoExcluido,vertidoExcluidoTexto,cortaVertido,fiabilidadTexto,ratioTexto,rangoDias,
      setFetch(fn){globalThis.fetch=fn},
      setKstarAccess(url,key){localStorage.setItem(KSTAR_URL_KEY,url);localStorage.setItem(KSTAR_CLAVE_KEY,key)},
      setKstarAccessSesion(url,key){localStorage.setItem(KSTAR_URL_KEY,url);sessionStorage.setItem(KSTAR_SESSION_KEY,key)},
      setRaw(value){RAW=value},
      setGrid(rows){SPC_FUENTES=[];rows.forEach(d=>ponFuenteSpc(d.date,{rows:[],daily:[d],meta:d.meta||{}}))},
      setPricing(value,forward=false){PRECIOS=value?GorraizEnergia.validatePricingConfig(value):null;PRECIO_FUTURO=forward}
    };
  `;
  vm.runInContext(source, context, {filename: 'dashboard-inline.js'});
  return context.api;
}

const reading = (date, dia) => ({ts:new Date(date+'T12:00:00'), dia, pot:1000, acum:dia});
const grid = (date, importKWh=150, exportKWh=100) => ({date,importKWh,exportKWh,
  meta:{completo:true,resumenDiarioCompleto:true,units:'kWh'}});
const fakePrices = {version:1,currency:'EUR',method:'invoice-average',label:'FICTICIO QA',periods:[{
  from:'2026-10-01',to:'2026-10-18',importKWh:100,energyEUR:25,ie:.05,vat:.21,source:'FICTICIO'
}]};
const production = (d,date='2026-10-18',a=200,b=200) => d.procProd([reading(date,a)],[reading(date,b)]);
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-9, `${a} != ${b}`);

test('dashboard supplies explicit inverter presence without replacing a missing inverter with zero', () => {
  const d=dashboard(),p=production(d);
  assert.equal(p.daily[0].hasA,true);assert.equal(p.daily[0].hasB,true);assert.equal(p.daily[0].total,400);
  const one=d.procProd([reading('2026-10-18',0)],[]).daily[0];
  assert.equal(one.A,0);assert.equal(one.hasA,true);assert.equal(one.hasB,false);assert.equal(one.total,null);
  d.setGrid([grid('2026-10-18')]);
  const r=d.calcKPIs({daily:[one],hourly:[]},d.procCons([]),{from:one.date,to:one.date});
  assert.equal(r.tC,null);assert.equal(r.energia.coverage.completeDays,0);
});

test('dashboard wires daily SPC export into self-consumption and does not require an i-DE file', () => {
  const d=dashboard();d.setGrid([grid('2026-10-18')]);
  const r=d.calcKPIs(production(d),d.procCons([]),{from:'2026-10-18',to:'2026-10-18'});
  assert.equal(r.tPV,300);assert.equal(r.tC,450);assert.equal(r.tR,150);assert.equal(r.tExport,100);
  assert.equal(r.cons.daily[0].total,450);assert.equal(r.cons.daily[0].export,100);
  assert.equal(r.tAF,null);assert.equal(r.tCash,null);assert.equal(d.fn(r.tAF),'—');
  assert.equal(r.energia.coverage.completeDays,1);assert.equal(r.energia.coverage.pricedDays,0);
});

test('dashboard, evolution and investment reference use IE without mixing in IVA', () => {
  const d=dashboard();d.setGrid([grid('2026-10-18')]);d.setPricing(fakePrices);
  const p=production(d),r=d.calcKPIs(p,d.procCons([]),{from:'2026-10-18',to:'2026-10-18'});
  close(r.tAE,75);close(r.tAF,78.75);close(r.tCash,95.2875);
  assert.equal(d.fn(31.5*1.21,2),'38,12');
  close(d.calcEvol(p.daily,r.energia).ahorroM[0].acum,r.tAF);
  close(d.calcAnalysis(p.hourly,[],r.energia).pb.ahAcum,r.tAF);
  assert.equal(d.calcAnalysis(p.hourly,[],r.energia).pb.canP,false);
});

test('missing SPC leaves balances, savings and charts unknown even when a price exists', () => {
  const d=dashboard();d.setPricing(fakePrices);
  const p=production(d),r=d.calcKPIs(p,d.procCons([]),{from:'2026-10-17',to:'2026-10-19'});
  assert.equal(r.energia.coverage.expectedDays,3);assert.equal(r.energia.coverage.completeDays,0);
  for(const key of ['tPV','tC','tR','tExport','tAF','tCash'])assert.equal(r[key],null,key);
  assert.equal(r.cons.daily[1].total,null);
  assert.equal(d.calcEvol(p.daily,r.energia).ahorroM[0].acum,null);
  assert.equal(d.calcAnalysis(p.hourly,[],r.energia).pb.pct,null);
});

test('selected report, full-history pages and comparison keep their separate calendar coverage', () => {
  const d=dashboard(),raw={A:[reading('2026-10-17',100),reading('2026-10-19',200)],
    B:[reading('2026-10-17',100),reading('2026-10-19',200)],I:[]};
  d.setRaw(raw);
  const report=d.calculaInforme('2026-10-19','2026-10-19');
  assert.equal(report.energia.coverage.expectedDays,1);
  assert.equal(report.historico.energia.coverage.expectedDays,3);
  assert.equal(report.evol.energia.coverage.expectedDays,3);
  assert.equal(report.analysis.energia.coverage.expectedDays,3);
  const cmp=d.calcCompPeriod(raw.A,raw.B,[], '2026-10-16','2026-10-19');
  assert.equal(cmp.energia.coverage.expectedDays,4);assert.equal(cmp.tAF,null);assert.equal(cmp.franja.P1,null);
});

test('KSTAR operativo ignora el legado horario i-DE/Datadis y no valora un día abierto', () => {
  const d=dashboard(),date='2026-10-20';d.setPricing(fakePrices,true);d.setGrid([grid(date)]);
  const cons=d.procCons([{ts:new Date(date+'T12:00:00'),consumo:8,periodo:'P2'}]);
  assert.equal(cons.hourly.length,0,'ninguna curva i-DE se presenta como medida KSTAR');
  const r=d.calcKPIs(production(d,date),cons,{from:date,to:date});
  assert.equal(r.energia.coverage.completeDays,0);assert.equal(r.tAF,null);
  assert.ok(r.hpCons.LV.every(v=>v===null));
});

test('future-price permission is explicit in dashboard wiring and preserves measured zero', () => {
  const d=dashboard(),date='2026-10-19';d.setGrid([grid(date,5,0)]);d.setPricing(fakePrices);
  const p=production(d,date,0,0),opts={from:date,to:date};
  const missing=d.calcKPIs(p,d.procCons([]),opts);
  assert.equal(missing.tPV,0);assert.equal(missing.tC,5);assert.equal(missing.tExport,0);assert.equal(missing.tAF,null);
  d.setPricing(fakePrices,true);
  const valued=d.calcKPIs(p,d.procCons([]),opts);
  assert.equal(valued.tAF,0);assert.equal(valued.energia.coverage.forwardEstimatedDays,1);
});

test('SPC replaces a complete day atomically, retaining source and literal timestamps', () => {
  const d=dashboard(),date='2026-10-18';
  const p=(time,value)=>({rows:[{saveTime:time,totalActivePower:value}],daily:[grid(date)],
    meta:{completo:true,stationId:'fake-station',meterId:'fake-meter',fetchedAt:'2026-10-19T12:00:00Z'}});
  d.ponFuenteSpc(date,p('18/10/2026 12:00:00',1));
  d.ponFuenteSpc(date,p('18/10/2026 13:00:00',2));
  assert.equal(d.getSpcRows().length,1);assert.equal(d.getSpcRows()[0].saveTime,'18/10/2026 13:00:00');
  assert.equal(d.getSpcDaily()[0].meta.meterId,'fake-meter');
  assert.equal(d.incorporaSpc({rows:[],daily:[],meta:{}},{desde:date,hasta:date}),0);
  assert.equal(d.getSpcRows()[0].totalActivePower,2);
  const partial=p('18/10/2026 14:00:00',3);partial.meta.completo=false;partial.meta.fetchedAt='2026-10-19T14:00:00Z';
  assert.equal(d.ponFuenteSpc(date,partial),false);assert.equal(d.getSpcRows()[0].totalActivePower,2);
  const stale=p('18/10/2026 11:00:00',0);stale.meta.fetchedAt='2026-10-19T11:00:00Z';
  assert.equal(d.ponFuenteSpc(date,stale,true),false);assert.equal(d.getSpcRows()[0].totalActivePower,2);
});

test('SPC chunking covers more than 400 days and limits cache requests to 31 days', () => {
  const d=dashboard(),all=d.bloquesSpc('2025-01-01','2026-04-01',1);
  assert.equal(all.length,456);assert.equal(all[all.length-1].hasta,'2026-04-01');
  const cache=d.bloquesSpc('2026-01-01','2026-02-01',31);
  assert.equal(cache.length,2);assert.equal(cache[0].hasta,'2026-01-31');assert.equal(cache[1].desde,'2026-02-01');
});


test('KSTAR externo es la fuente real del informe: un dia cerrado, usuario solo en Worker', async () => {
  const d=dashboard(),day='2026-10-19',key='fictional-temporary-key-1234567890123';
  const url='https://gorraiz-kstar-prueba.example.workers.dev';
  d.setKstarAccess(url,key);
  const payload={rows:[{saveTime:'2026-10-19 12:00:00',positiveActiveElec:147000,
    reverseActiveElec:2140.5901}],daily:[{date:day,importKWh:658.92,exportKWh:0,selfConsumptionKWh:74}],
    meta:{fuente:'spc',stationId:'2026032317114373',meterId:'210261430F3060020000661',
      dailyScope:'station',historyScope:'meter',completo:true,fetchedAt:'2026-10-20T13:00:00Z'}};
  let called=0;
  d.setFetch(async (req,init)=>{
    called++;
    assert.equal(req,url+'/spc/intercambio');
    assert.equal(init.method,'POST');
    assert.equal(init.headers['X-KSTAR-Test-Key'],key);
    assert.equal(init.headers['content-type'],'application/json');
    assert.deepEqual(JSON.parse(init.body),{desde:day,hasta:day});
    assert.equal(JSON.stringify(init).includes('fictional-password'),false);
    return {ok:true,json:async()=>payload};
  });
  const data=await d.kstarCall(day,day);
  assert.equal(data.daily[0].importKWh,658.92);
  assert.equal(data.daily[0].exportKWh,0);
  assert.equal(d.incorporaSpc(data,{desde:day,hasta:day}),1);
  assert.equal(d.getSpcDaily()[0].importKWh,658.92);
  const r=d.calcKPIs(production(d,day,30,44),d.procCons([]),{from:day,to:day});
  assert.equal(r.tC,732.92);
  assert.equal(r.tPV,74);
  assert.equal(r.tExport,0);
  assert.equal(called,1);
});
test('KSTAR rechaza estacion o medidor ajenos, fechas abiertas y respuestas incompletas', async () => {
  const d=dashboard(),day='2026-10-19';
  d.setKstarAccess('https://test.workers.dev','fictional-temporary-key-1234567890123');
  let requests=0;
  const valid={rows:[],daily:[{date:day,importKWh:2,exportKWh:0}],meta:{
    fuente:'spc',stationId:'2026032317114373',meterId:'210261430F3060020000661',
    dailyScope:'station',historyScope:'meter',completo:true}};
  d.setFetch(async()=>{requests++;return{ok:true,json:async()=>({...valid,meta:{...valid.meta,meterId:'WRONG'}})}});
  await assert.rejects(d.kstarCall(day,day),/contador/);
  assert.equal(requests,1);
  await assert.rejects(d.kstarCall('2026-10-20','2026-10-20'),/cerrado/);
  assert.equal(requests,1);
  d.setFetch(async()=>{requests++;return{ok:true,json:async()=>({...valid,daily:[]})}});
  await assert.rejects(d.kstarCall(day,day),/formato/);
  assert.equal(requests,2);
});

// ── Contraste i-DE ↔ KSTAR ────────────────────────────────────────────────
// i-DE y KSTAR miden la misma energía de red por vías distintas. Estas pruebas
// fijan que se comparan solo días completos y que una diferencia real se avisa.
const horas = (date, kWh, n = 24) => Array.from({length:n},
  (_, h) => ({ts:new Date(`${date}T${String(h).padStart(2,'0')}:30:00`), consumo:kWh/n, gen:0, periodo:'P2'}));

test('i-DE se agrega por día y un día al que le faltan horas no se da por completo', () => {
  const d=dashboard();
  d.setRaw({A:[],B:[],I:[...horas('2026-10-05',240),...horas('2026-10-06',120,20)]});
  const dias=d.ideDiario();
  assert.equal(dias.length,2);
  close(dias[0].importKWh,240);
  assert.equal(dias[0].horas,24);assert.equal(dias[0].completo,true);
  assert.equal(dias[1].horas,20);assert.equal(dias[1].completo,false,'20 horas no cubren el día');
});

test('el día del cambio de hora de octubre tiene 25 horas y se completa con ellas', () => {
  const d=dashboard();
  assert.equal(d.horasDia('2026-10-25'),25);
  assert.equal(d.horasDia('2026-03-29'),23);
  assert.equal(d.horasDia('2026-10-20'),24);
  d.setRaw({A:[],B:[],I:horas('2026-10-25',250,24)});
  assert.equal(d.ideDiario()[0].completo,false,'24 horas no cubren un día de 25');
});

test('contraste avisa de la discrepancia real y calla ante el ruido de redondeo', () => {
  const d=dashboard();
  d.setGrid([grid('2026-10-05',240,0),grid('2026-10-06',100,0),grid('2026-10-07',1000,0)]);
  d.setRaw({A:[],B:[],I:[...horas('2026-10-05',240.3),...horas('2026-10-06',120),...horas('2026-10-07',1004)]});
  const c=d.contrasteRed();
  assert.equal(c.filas.length,3);
  assert.equal(c.discrepantes.length,1,'solo el 6 difiere de verdad');
  assert.equal(c.discrepantes[0].date,'2026-10-06');
  close(c.discrepantes[0].dif,20);
  // 0,3 kWh sobre 240 no llega al umbral absoluto; 4 kWh sobre 1.000 no llega
  // al relativo. Ninguno de los dos se avisa.
  assert.deepEqual([...c.filas.filter(f=>f.discrepa).map(f=>f.date)],['2026-10-06']);
});

test('contraste separa los días que solo tiene una de las dos fuentes', () => {
  const d=dashboard();
  d.setGrid([grid('2026-10-05',240,0)]);
  d.setRaw({A:[],B:[],I:[...horas('2026-10-05',240),...horas('2026-10-08',200)]});
  const c=d.contrasteRed();
  assert.deepEqual([...c.soloIde],['2026-10-08']);
  assert.deepEqual([...c.soloSpc],[]);
  assert.equal(c.filas.length,1);
});

test('la medida que factura manda en el balance y KSTAR cubre lo que i-DE no trae', () => {
  const d=dashboard(),dia='2026-10-05',otro='2026-10-06';
  d.setGrid([grid(dia,240,0),grid(otro,100,0)]);
  d.setRaw({A:[],B:[],I:horas(dia,260)});
  const red=d.gridDiario();
  assert.equal(red.length,2);
  close(red[0].importKWh,260);
  assert.equal(red[0].meta.contador,'i-DE');
  assert.equal(red[1].importKWh,100);
  assert.equal(red[1].meta.contador,'KSTAR');
  // meta.fuente no se toca: kstarCall la usa para validar la respuesta.
  assert.equal(red[1].meta.fuente,'spc');
});

test('un día incompleto de i-DE no desplaza la medida de KSTAR en el balance', () => {
  const d=dashboard(),dia='2026-10-05';
  d.setGrid([grid(dia,240,0)]);
  d.setRaw({A:[],B:[],I:horas(dia,99,10)});
  const red=d.gridDiario();
  assert.equal(red.length,1);
  assert.equal(red[0].importKWh,240,'manda KSTAR mientras i-DE no cubra el día');
  assert.equal(red[0].meta.contador,'KSTAR');
  assert.equal(d.contrasteRed().filas.length,0,'un día incompleto no se contrasta');
});

test('sin ficheros de i-DE el balance y el contraste se comportan como antes', () => {
  const d=dashboard(),dia='2026-10-18';
  d.setGrid([grid(dia)]);
  const r=d.calcKPIs(production(d,dia),d.procCons([]),{from:dia,to:dia});
  assert.equal(r.tR,150);assert.equal(r.energia.coverage.completeDays,1);
  const c=d.contrasteRed();
  assert.equal(c.filas.length,0);assert.equal(c.discrepantes.length,0);
});

test('el aviso de discrepancia nombra el día y las dos medidas', () => {
  const d=dashboard();
  d.setGrid([grid('2026-10-05',240,0),grid('2026-10-06',100,0)]);
  d.setRaw({A:[],B:[],I:[...horas('2026-10-05',240),...horas('2026-10-06',120)]});
  const txt=d.contrasteTexto(d.contrasteRed());
  assert.match(txt,/2 día\(s\) medidos por los dos, 1 cuadran/);
  assert.match(txt,/1 con discrepancia/);
  assert.match(txt,/06\/10\/2026/);
  assert.match(txt,/i-DE 120,0 \/ KSTAR 100,0 kWh/);
  assert.match(txt,/\+20,0/);
  assert.ok(!txt.includes('05/10/2026'),'el día que cuadra no se nombra');
});

test('sin discrepancias lo dice, y sin ficheros de i-DE no dice nada', () => {
  const d=dashboard();
  d.setGrid([grid('2026-10-05',240,0)]);
  assert.equal(d.contrasteTexto(d.contrasteRed()),'','sin i-DE no se habla de contraste');
  d.setRaw({A:[],B:[],I:horas('2026-10-05',240)});
  assert.match(d.contrasteTexto(d.contrasteRed()),/1 día\(s\) medidos por los dos, 1 cuadran\. Sin discrepancias\./);
});

test('con i-DE pero sin ningún día de KSTAR en común se explica, no se calla', () => {
  const d=dashboard();
  d.setGrid([grid('2026-10-09',240,0)]);
  d.setRaw({A:[],B:[],I:horas('2026-10-05',240)});
  const txt=d.contrasteTexto(d.contrasteRed());
  assert.match(txt,/aún no hay ningún día medido por los dos/);
  assert.match(txt,/1 día\(s\) solo de i-DE/);
  assert.match(txt,/1 día\(s\) solo de KSTAR/);
});

test('el PDF avisa del mayor desvío y no dice nada cuando los dos cuadran', () => {
  const d=dashboard();
  d.setGrid([grid('2026-10-05',240,0),grid('2026-10-06',100,0),grid('2026-10-07',300,0)]);
  d.setRaw({A:[],B:[],I:[...horas('2026-10-05',240),...horas('2026-10-06',120),...horas('2026-10-07',340)]});
  const txt=d.contrastePdfTexto();
  assert.match(txt,/ATENCIÓN: i-DE y KSTAR no cuadran en 2 día\(s\)/);
  assert.match(txt,/el mayor desvío es el 07\/10\/2026, 40,0 kWh/,'se nombra el desvío mayor, no el primero');
  d.setRaw({A:[],B:[],I:[...horas('2026-10-05',240),...horas('2026-10-06',100),...horas('2026-10-07',300)]});
  assert.equal(d.contrastePdfTexto(),'');
});

test('la clave de KSTAR se conserva en el equipo y la antigua de sesión se sigue leyendo', () => {
  const clave='clave-de-prueba-de-veinticuatro';
  const guardada=dashboard();
  guardada.setKstarAccess('https://ejemplo.workers.dev',clave);
  assert.equal(guardada.kstarCfg().key,clave,'la clave guardada en el equipo se lee');

  // Una sesión abierta con la clave antigua no debe perderla al actualizar.
  const vieja=dashboard();
  vieja.setKstarAccessSesion('https://ejemplo.workers.dev',clave);
  assert.equal(vieja.kstarCfg().key,clave,'se sigue leyendo la clave de sesión anterior');

  // Cada dashboard del arnés parte de almacenes vacíos: sin clave, no hay clave.
  assert.equal(dashboard().kstarCfg().key,'');
});

// ── Reparto P1–P6 desde i-DE ──────────────────────────────────────────────
// i-DE trae el periodo tarifario de cada hora: la importación y el vertido por
// periodo son medida suya. El autoconsumo del día también es medido; lo que se
// reparte es su distribución entre periodos. Por eso la tabla y los recuadros
// del informe tienen que dar exactamente lo mismo.
const horasP = (date, filas) => filas.map(([h, consumo, gen, periodo]) =>
  ({ts:new Date(`${date}T${String(h).padStart(2,'0')}:30:00`), consumo, gen, periodo}));
// Produccion repartida en muestras horarias, con acumulado creciente.
const muestrasDia = (date, horas, kWhPorHora) => {
  const out=[{ts:new Date(`${date}T${String(horas[0]).padStart(2,'0')}:00:00`),dia:kWhPorHora*horas.length,pot:0,acum:0}];
  horas.forEach((h,i)=>out.push({ts:new Date(`${date}T${String(h).padStart(2,'0')}:55:00`),
    dia:kWhPorHora*horas.length,pot:0,acum:kWhPorHora*(i+1)}));
  return out;
};
// Balance tal y como lo ve el informe, para pasarselo al reparto.
const balanceDe = (d, from, to) => d.calcKPIs(d.procProd(RAW_A, RAW_B), d.procCons([]), {from, to}).balance;
let RAW_A=[], RAW_B=[];
function escena(d, {date, horasSol, kWhHora, idefilas, importDia, exportDia}) {
  RAW_A=muestrasDia(date,horasSol,kWhHora); RAW_B=muestrasDia(date,horasSol,kWhHora);
  d.setRaw({A:RAW_A,B:RAW_B,I:horasP(date,idefilas)});
  d.setGrid([grid(date,importDia,exportDia)]);
  return d.calcKPIs(d.procProd(RAW_A,RAW_B),d.procCons([]),{from:date,to:date});
}

test('la tabla por periodo y los recuadros del informe dan lo mismo', () => {
  const d=dashboard(),date='2026-10-05';
  const r=escena(d,{date,horasSol:[10,11,12],kWhHora:20,
    idefilas:[[10,5,0,'P4'],[11,7,0,'P4'],[12,9,0,'P5'],[23,4,0,'P6']],
    importDia:25,exportDia:6});
  const rep=d.idePeriodos(date,date,r.balance);
  // Importacion, vertido y autoconsumo: las tres columnas cuadran con su KPI.
  close(rep.importKWh,r.tR);
  close(rep.exportKWh,r.tExport);
  close(rep.autoKWh,r.tPV);
  // Y el autoconsumo es el MEDIDO del balance: 120 producidos - 6 vertidos.
  close(r.tPV,114);
  close(rep.autoKWh,114);
  assert.equal(rep.diasBalance,1);
});

test('el autoconsumo se reparte en proporción a la producción de cada hora', () => {
  const d=dashboard(),date='2026-10-05';
  // Produccion solo a las 10, 11 y 12; el consumo de las 23 no lleva FV.
  const r=escena(d,{date,horasSol:[10,11,12],kWhHora:20,
    idefilas:[[10,0,0,'P4'],[11,0,0,'P4'],[12,0,0,'P5'],[23,4,0,'P6']],
    importDia:4,exportDia:0});
  const rep=d.idePeriodos(date,date,r.balance);
  // 120 kWh medidos: dos horas en P4 y una en P5, a partes iguales.
  close(rep.autoKWh,120);
  close(rep.periodos.P4.autoKWh,80);
  close(rep.periodos.P5.autoKWh,40);
  close(rep.periodos.P6.autoKWh,0,'sin sol no hay autoconsumo que repartir');
  close(rep.periodos.P6.importKWh,4,'pero su importación sí se cuenta');
});

test('solo entran los días que el balance da por completos', () => {
  const d=dashboard();
  RAW_A=muestrasDia('2026-10-05',[10,11],30); RAW_B=muestrasDia('2026-10-05',[10,11],30);
  // El 06 tiene fichero de i-DE pero ni produccion ni medida de red: no es un
  // dia completo, asi que no debe colarse en la tabla.
  d.setRaw({A:RAW_A,B:RAW_B,I:[...horasP('2026-10-05',[[10,5,0,'P4']]),
                               ...horasP('2026-10-06',[[10,99,0,'P4']])]});
  d.setGrid([grid('2026-10-05',5,0)]);
  const r=d.calcKPIs(d.procProd(RAW_A,RAW_B),d.procCons([]),{from:'2026-10-05',to:'2026-10-06'});
  const rep=d.idePeriodos('2026-10-05','2026-10-06',r.balance);
  assert.equal(rep.diasBalance,1);
  close(rep.importKWh,5,'los 99 kWh del día incompleto quedan fuera');
  close(rep.importKWh,r.tR);
});

test('sin balance, sin días completos o sin ficheros no hay reparto', () => {
  const d=dashboard();
  d.setRaw({A:[],B:[],I:horasP('2026-10-05',[[10,5,0,'P4']])});
  assert.equal(d.idePeriodos('2026-10-05','2026-10-05',null),null,'sin balance, nada');
  assert.equal(d.idePeriodos('2026-10-05','2026-10-05',[]),null,'sin días completos, tampoco');
  d.setRaw({A:[],B:[],I:[]});
  assert.equal(d.idePeriodos('2026-10-05','2026-10-05',[{date:'2026-10-05',complete:true}]),null);
});

test('P1-P6 salen siempre con cero, y «Sin periodo» solo si ha caído algo', () => {
  const d=dashboard(),date='2026-10-05';
  const r=escena(d,{date,horasSol:[10],kWhHora:30,
    idefilas:[[10,5,0,'P4'],[23,4,0,'Sin periodo']],importDia:9,exportDia:0});
  const rep=d.idePeriodos(date,date,r.balance);
  // Un periodo que desaparece de la tabla se lee como «no existe»; con cero se
  // lee como «no hubo», que es lo que pasó.
  for(const p of ['P1','P2','P3','P4','P5','P6'])
    assert.ok(rep.franjas.includes(p),p+' tiene que salir aunque no tenga horas');
  assert.equal(rep.periodos.P1.horas,0);
  close(rep.periodos.P1.importKWh,0);
  assert.ok(rep.franjas.includes('Sin periodo'),'lo que no tiene periodo no se cuela en P6');
  close(rep.periodos['Sin periodo'].importKWh,4);
  // Los totales no cambian por enseñar franjas vacías.
  close(rep.importKWh,r.tR);
  // Y sin nada fuera de periodo, esa fila no aparece.
  const r2=escena(d,{date,horasSol:[10],kWhHora:30,
    idefilas:[[10,5,0,'P4']],importDia:5,exportDia:0});
  assert.ok(!d.idePeriodos(date,date,r2.balance).franjas.includes('Sin periodo'));
});

// ── Ahorro por periodo tarifario ──────────────────────────────────────────
const preciosPeriodo = (from,to,precios,source) => ({version:1,currency:'EUR',
  method:'invoice-average',label:'FICTICIO QA',periods:[{from,to,importKWh:100,energyEUR:25,
    ie:.05,vat:.21,source,pricesByPeriod:precios}]});

test('el ahorro por periodo usa el precio de ese periodo y nombra la factura', () => {
  const d=dashboard(),date='2026-10-05';
  d.setPricing(preciosPeriodo('2026-10-01','2026-10-31',
    {P1:.25,P2:.20,P3:.20,P4:.15,P5:.15,P6:.15},'Factura ficticia octubre'));
  const r=escena(d,{date,horasSol:[10],kWhHora:80,
    idefilas:[[10,0,0,'P1']],importDia:0,exportDia:0});
  const rep=d.idePeriodos(date,date,r.balance);
  close(rep.periodos.P1.autoKWh,160);        // 80 kWh por inversor
  close(rep.periodos.P1.ahorroEUR,40);       // 160 x 0,25
  close(rep.ahorroEUR,40);
  assert.equal(rep.fuentes.length,1);
  assert.match(rep.fuentes[0],/Factura ficticia octubre \(2026-10-01 a 2026-10-31\)/);
});

test('sin precios por periodo el reparto sigue dando kWh, pero el ahorro queda nulo', () => {
  const d=dashboard(),date='2026-10-05';
  d.setPricing(fakePrices,true);   // media mensual, sin desglose por periodo
  const r=escena(d,{date,horasSol:[10],kWhHora:40,
    idefilas:[[10,1,0,'P1']],importDia:1,exportDia:0});
  const rep=d.idePeriodos(date,date,r.balance);
  close(rep.periodos.P1.importKWh,1);
  assert.equal(rep.ahorroEUR,null,'un cero sería afirmar un ahorro que no se ha calculado');
  assert.equal(rep.autoValoradoKWh,0);
  assert.equal(rep.fuentes.length,0);
  assert.match(d.idePeriodosNota(rep),/Sin precios por periodo cargados/);
});

test('la nota dice sobre cuántos días de balance se ha hecho el reparto', () => {
  const d=dashboard(),date='2026-10-05';
  const r=escena(d,{date,horasSol:[10,11],kWhHora:25,
    idefilas:[[10,2,0,'P4'],[11,3,0,'P4'],[23,5,0,'P6']],importDia:10,exportDia:0});
  const nota=d.idePeriodosNota(d.idePeriodos(date,date,r.balance));
  assert.match(nota,/sobre los mismos 1 día\(s\) completos que los recuadros/);
  assert.match(nota,/las dos cifras cuadran/);
  assert.ok(!/le faltan/.test(nota));
});

// ── Contraste factura ↔ medida ────────────────────────────────────────────
// La factura y la curva horaria de i-DE salen del mismo contador: tienen que
// cuadrar. Es el contraste que cierra el circulo contra lo que se paga.
const facturaDe = (from,to,importKWh,source) => ({version:1,currency:'EUR',
  method:'invoice-average',label:'FICTICIO QA',
  periods:[{from,to,importKWh,energyEUR:importKWh*0.2,ie:.05,vat:.21,source}]});
// Dias completos de red: produccion de los dos inversores + medida i-DE.
function mesDeRed(d, desde, dias, kWhDia) {
  const fechas=Array.from({length:dias},(_,i)=>{
    const t=new Date(desde+'T12:00:00Z');t.setUTCDate(t.getUTCDate()+i);
    return t.toISOString().slice(0,10);
  });
  d.setRaw({A:[],B:[],I:fechas.flatMap(f=>horasP(f,[[12,kWhDia,0,'P4']]).concat(
    Array.from({length:23},(_,h)=>({ts:new Date(`${f}T${String(h<12?h:h+1).padStart(2,'0')}:30:00`),
      consumo:0,gen:0,periodo:'P4'}))))});
  return fechas;
}

test('un mes cubierto por entero se compara con su factura y se avisa del desvío', () => {
  const d=dashboard();
  mesDeRed(d,'2026-09-01',30,100);            // 30 dias x 100 kWh = 3.000 medidos
  d.setPricing(facturaDe('2026-09-01','2026-09-30',3000,'Factura septiembre'));
  let c=d.contrasteFactura();
  assert.equal(c.filas.length,1);
  assert.equal(c.filas[0].completo,true);
  close(c.filas[0].medida,3000);
  assert.equal(c.discrepantes.length,0,'cuadrando no se avisa');
  assert.match(d.contrasteFacturaTexto(c),/1 periodo\(s\) cubiertos por entero, 1 cuadran/);
  assert.equal(d.contrasteFacturaPdfTexto(),'');

  // Misma medida contra una factura de 3.500: faltan 500 kWh, un 14%.
  d.setPricing(facturaDe('2026-09-01','2026-09-30',3500,'Factura septiembre'));
  c=d.contrasteFactura();
  assert.equal(c.discrepantes.length,1);
  close(c.discrepantes[0].dif,-500);
  // El separador de millares depende del ICU del entorno: en el navegador sale
  // «3.500,0» y en el vm de las pruebas «3500,0». La aserción no lo exige.
  assert.match(d.contrasteFacturaTexto(c),/facturado 3\.?500,0 kWh, medido 3\.?000,0/);
  assert.match(d.contrasteFacturaPdfTexto(),/ATENCIÓN/);
  assert.match(d.contrasteFacturaPdfTexto(),/500,0 kWh/);
});

test('un mes a medio cubrir no se declara discrepante: faltan días, no kWh', () => {
  const d=dashboard();
  mesDeRed(d,'2026-09-01',10,100);            // solo 10 de los 30 dias
  d.setPricing(facturaDe('2026-09-01','2026-09-30',3000,'Factura septiembre'));
  const c=d.contrasteFactura();
  assert.equal(c.filas[0].cubiertos,10);
  assert.equal(c.filas[0].esperados,30);
  assert.equal(c.filas[0].completo,false);
  assert.equal(c.discrepantes.length,0,'un mes incompleto siempre sale corto; no es un desvío');
  assert.equal(c.parciales.length,1);
  assert.match(d.contrasteFacturaTexto(c),/ningún periodo de factura está cubierto por entero/);
});

test('el redondeo de la factura no dispara la alarma', () => {
  const d=dashboard();
  mesDeRed(d,'2026-09-01',30,100);
  // 5 kWh de diferencia sobre 3.000: pasa el relativo pero no el absoluto.
  d.setPricing(facturaDe('2026-09-01','2026-09-30',3005,'Factura septiembre'));
  assert.equal(d.contrasteFactura().discrepantes.length,0);
  // 20 kWh ya pasa los dos umbrales (0,67% > 1%? no) -> sigue sin avisar.
  d.setPricing(facturaDe('2026-09-01','2026-09-30',3020,'Factura septiembre'));
  assert.equal(d.contrasteFactura().discrepantes.length,0,'0,66% no llega al umbral relativo');
  // 100 kWh: 3,3% y 100 kWh, los dos umbrales superados.
  d.setPricing(facturaDe('2026-09-01','2026-09-30',3100,'Factura septiembre'));
  assert.equal(d.contrasteFactura().discrepantes.length,1);
});

test('sin precios o sin datos de red no hay contraste que hacer', () => {
  const d=dashboard();
  assert.equal(d.contrasteFactura(),null,'sin precios, nada');
  d.setPricing(facturaDe('2026-09-01','2026-09-30',3000,'Factura septiembre'));
  assert.equal(d.contrasteFactura(),null,'sin datos de red, tampoco');
  assert.equal(d.contrasteFacturaTexto(null),'');
});

test('diasEntre cuenta ambos extremos y rechaza fechas no válidas', () => {
  const d=dashboard();
  assert.equal(d.diasEntre('2026-09-01','2026-09-30'),30);
  assert.equal(d.diasEntre('2026-10-01','2026-10-31'),31);
  assert.equal(d.diasEntre('2026-09-01','2026-09-01'),1);
  assert.equal(d.diasEntre('2026-02-01','2026-02-28'),28);
  assert.equal(d.diasEntre('mal','2026-09-30'),0);
});

// ── Perfil horario de importación desde i-DE ──────────────────────────────
test('el perfil horario separa laborables, sábado y domingo', () => {
  const d=dashboard();
  // 2026-10-05 es lunes; el 10 sábado y el 11 domingo.
  d.setRaw({A:[],B:[],I:[
    ...horasP('2026-10-05',[[10,30,0,'P4'],[11,40,0,'P4']]),
    ...horasP('2026-10-10',[[10,10,0,'P6']]),
    ...horasP('2026-10-11',[[10,6,0,'P6']])]});
  const p=d.ideHorario('2026-10-01','2026-10-31');
  close(p.LV[10],30);close(p.LV[11],40);
  close(p.S[10],10);
  close(p.D[10],6);
  assert.equal(p.LV[3],null,'una hora sin dato no se convierte en cero');
  // La media mezcla los tres tipos de día: (30+10+6)/3 a las 10h.
  close(p.media[10],46/3);
});

test('el perfil horario respeta el rango y desaparece sin ficheros', () => {
  const d=dashboard();
  d.setRaw({A:[],B:[],I:[...horasP('2026-10-05',[[10,30,0,'P4']]),
                         ...horasP('2026-11-02',[[10,90,0,'P4']])]});
  close(d.ideHorario('2026-10-01','2026-10-31').LV[10],30);
  close(d.ideHorario('2026-11-01','2026-11-30').LV[10],90);
  // Promedia los dos lunes cuando el rango los abarca.
  close(d.ideHorario('2026-10-01','2026-11-30').LV[10],60);
  assert.equal(d.ideHorario('2026-12-01','2026-12-31'),null);
  d.setRaw({A:[],B:[],I:[]});
  assert.equal(d.ideHorario('2026-10-01','2026-10-31'),null);
});

test('con ficheros de i-DE el perfil horario del informe deja de venir vacío', () => {
  const d=dashboard(),date='2026-10-05';
  d.setGrid([grid(date,240,0)]);
  d.setRaw({A:[],B:[],I:horasP(date,[[10,20,0,'P4'],[11,25,0,'P4']])});
  const r=d.calcKPIs(production(d,date),d.procCons([]),{from:date,to:date});
  // Antes todas las horas salían null y la gráfica quedaba en blanco.
  assert.ok(r.hpCons.LV.some(v=>Number.isFinite(v)),'el perfil ya trae datos');
  close(r.hpCons.LV[10],20);close(r.hpCons.LV[11],25);
  // Y procCons sigue sin presentar su curva como medida del contador KSTAR.
  assert.equal(d.procCons([{ts:new Date(date+'T12:00:00'),consumo:8,periodo:'P2'}]).hourly.length,0);
});

// ── Vertido anterior a la fecha de corte ──────────────────────────────────
// Por decisión de la propiedad no se contabiliza el vertido previo al arreglo
// del antivertido. Se aplica en gridDiario, que es de donde beben el balance,
// las gráficas, la tabla por periodo y el anexo.
test('el vertido anterior al corte sale del balance y el posterior se mantiene', () => {
  const d=dashboard();
  d.setGrid([grid('2026-09-20',100,40),grid('2026-10-02',100,30)]);
  const red=d.gridDiario();
  const porFecha=Object.fromEntries(red.map(r=>[r.date,r]));
  assert.equal(porFecha['2026-09-20'].exportKWh,0,'septiembre queda a cero');
  assert.equal(porFecha['2026-09-20'].meta.vertidoExcluidoKWh,40,'pero queda constancia de cuánto');
  assert.equal(porFecha['2026-10-02'].exportKWh,30,'octubre se mantiene intacto');
  assert.equal(porFecha['2026-10-02'].meta.vertidoExcluidoKWh,undefined);
});

test('al quitar el vertido, el autoconsumo del balance sube por esa misma energía', () => {
  const d=dashboard(),date='2026-09-20';
  d.setGrid([grid(date,100,40)]);
  const r=d.calcKPIs(production(d,date),d.procCons([]),{from:date,to:date});
  // 400 kWh producidos. Con el vertido contado serían 360 de autoconsumo.
  assert.equal(r.tPV,400,'todo se declara autoconsumido');
  assert.equal(r.tExport,0);
  assert.equal(r.tC,500,'y el consumo sube en esos 40 kWh: 100 de red + 400');
});

test('el informe dice cuánto vertido ha dejado fuera, para poder cuadrarlo con i-DE', () => {
  const d=dashboard();
  d.setGrid([grid('2026-09-20',100,40),grid('2026-09-21',100,12),grid('2026-10-02',100,30)]);
  close(d.vertidoExcluido('2026-09-01','2026-10-31'),52);
  close(d.vertidoExcluido('2026-10-01','2026-10-31'),0);
  const t=d.vertidoExcluidoTexto('2026-09-01','2026-10-31');
  assert.match(t,/El vertido anterior al 01\/10\/2026/);
  assert.match(t,/52,0 kWh en este periodo/);
  assert.match(t,/fallo del antivertido ya corregido/);
  // Y dice en qué lado del total están esos kWh, que es lo que se preguntaba
  // al leer «vertido a red» en los recuadros.
  assert.match(t,/NO se contabiliza: la cifra de vertido de este informe no lo incluye/);
  // Sin nada que excluir, ni se menciona.
  assert.equal(d.vertidoExcluidoTexto('2026-10-01','2026-10-31'),'');
});

test('cortaVertido respeta un día sin fecha de corte y uno sin vertido medido', () => {
  const d=dashboard();
  // Un día posterior al corte pasa tal cual, con su objeto intacto.
  const dia={date:'2026-10-05',importKWh:10,exportKWh:5,meta:{contador:'i-DE'}};
  assert.equal(d.cortaVertido(dia),dia);
  // Uno anterior sin vertido numérico no inventa un excluido falso.
  const sin={date:'2026-09-05',importKWh:10,exportKWh:null,meta:{}};
  assert.equal(d.cortaVertido(sin).exportKWh,0);
  assert.equal(d.cortaVertido(sin).meta.vertidoExcluidoKWh,0);
});

// ── Resumen de fiabilidad ─────────────────────────────────────────────────
// Lo que permite a quien recibe el informe juzgar sus cifras: sobre cuántos
// días se han calculado y si los contadores y la factura cuadran.
test('el resumen de fiabilidad reúne cobertura y los dos contrastes', () => {
  const d=dashboard(),date='2026-10-05';
  d.setGrid([grid(date,240,0)]);
  d.setRaw({A:[],B:[],I:horasP(date,[[10,240,0,'P4']])});
  const r=d.calcKPIs(production(d,date),d.procCons([]),{from:date,to:date});
  const t=d.fiabilidadTexto(date,date,r.energia);
  assert.match(t,/^Fiabilidad de los datos:/);
  assert.match(t,/cobertura 1 de 1 día\(s\) con balance completo, 0 con precio/);
  assert.match(t,/i-DE ↔ KSTAR sin días comparables/,'un día de i-DE incompleto no se compara');
  assert.match(t,/factura sin precios cargados/);
});

test('con precios y contrastes cuadrando, el resumen lo dice', () => {
  const d=dashboard();
  mesDeRed(d,'2026-11-01',30,100);
  d.setPricing(facturaDe('2026-11-01','2026-11-30',3000,'Factura noviembre'));
  const t=d.fiabilidadTexto('2026-11-01','2026-11-30',
    {coverage:{completeDays:30,expectedDays:30,pricedDays:30}});
  assert.match(t,/cobertura 30 de 30/);
  assert.match(t,/factura 1 periodo\(s\) de este rango cubiertos, todos cuadran/);
});

test('el resumen avisa de la discrepancia y del vertido apartado', () => {
  const d=dashboard();
  mesDeRed(d,'2026-11-01',30,100);
  d.setPricing(facturaDe('2026-11-01','2026-11-30',3400,'Factura noviembre'));
  const t=d.fiabilidadTexto('2026-11-01','2026-11-30',
    {coverage:{completeDays:30,expectedDays:30,pricedDays:30}});
  assert.match(t,/factura 1 periodo\(s\) de este rango cubiertos, 1 con discrepancia/);

  // Un vertido anterior al corte aparece en el resumen con sus kWh.
  const e=dashboard();
  e.setGrid([grid('2026-09-20',100,40)]);
  const t2=e.fiabilidadTexto('2026-09-01','2026-09-30',{coverage:{completeDays:1,expectedDays:30,pricedDays:0}});
  assert.match(t2,/vertido no contabilizado 40,0 kWh/);
});

// ── El vertido entra en las gráficas que lo ignoraban ──────────────────────
test('el perfil horario de vertido separa tipos de día y no cuenta el anterior al corte', () => {
  const d=dashboard();
  // 2026-10-05 es lunes; el 10 sábado y el 11 domingo. El 2026-09-28 también es
  // lunes, pero cae antes de CFG.vertidoDesde (2026-10-01).
  d.setRaw({A:[],B:[],I:[
    ...horasP('2026-10-05',[[13,5,20,'P4']]),
    ...horasP('2026-10-10',[[13,2,30,'P6']]),
    ...horasP('2026-10-11',[[13,1,40,'P6']]),
    ...horasP('2026-09-28',[[13,5,99,'P4']])]});
  const p=d.ideHorario('2026-09-01','2026-10-31');
  close(p.vS[13],30);close(p.vD[13],40);
  // Los dos lunes promedian, pero el de septiembre aporta cero, no 99: (20+0)/2.
  close(p.vLV[13],10);
  // La importación de ese mismo día sí cuenta entera: el corte es solo del vertido.
  close(p.LV[13],5);
  assert.equal(p.vLV[3],null,'una hora sin dato sigue siendo hueco, no cero');
});

test('la media por día de semana arrastra el vertido ya recortado del balance', () => {
  const d=dashboard(),date='2026-10-05';          // lunes → índice 0
  d.setGrid([grid(date,150,60)]);
  const r=d.calcKPIs(production(d,date),d.procCons([]),{from:date,to:date});
  close(r.weekly[0].export,60);
  close(r.weekly[0].red,150);
  assert.equal(r.weekly[1].export,null,'un día de la semana sin datos no se rellena con cero');
  // Y el vertido excluido no reaparece por esta vía.
  const anterior='2026-09-28';                     // también lunes, antes del corte
  d.setGrid([grid(anterior,150,60)]);
  const r2=d.calcKPIs(production(d,anterior),d.procCons([]),{from:anterior,to:anterior});
  close(r2.weekly[0].export,0);
});

test('el donut reparte toda la energía, con el vertido como tercera porción', () => {
  const d=dashboard(),date='2026-10-05';
  d.setGrid([grid(date,150,60)]);
  const r=d.calcKPIs(production(d,date),d.procCons([]),{from:date,to:date});
  // production() da 400 kWh; 60 se vierten, así que 340 son autoconsumo.
  close(r.tExport,60);close(r.tPV,340);close(r.tR,150);
  // El total del donut ya no es el consumo: es consumo + vertido.
  close(r.tPV+r.tR+r.tExport,r.tC+r.tExport);
});

test('la fiabilidad de portada no saca discrepancias de fuera del periodo elegido', () => {
  const d=dashboard();
  // Dos facturas: noviembre cuadra, diciembre no. Las dos cubiertas por entero.
  // Se evita octubre a propósito: su día de 25 h deja el mes sin cubrir.
  mesDeRed(d,'2026-11-01',61,100);
  d.setPricing({version:1,currency:'EUR',method:'invoice-average',label:'FICTICIO QA',periods:[
    {from:'2026-11-01',to:'2026-11-30',importKWh:3000,energyEUR:750,ie:.05,vat:.21,source:'Factura noviembre'},
    {from:'2026-12-01',to:'2026-12-31',importKWh:3400,energyEUR:850,ie:.05,vat:.21,source:'Factura diciembre'}]});
  const cob={coverage:{completeDays:30,expectedDays:30,pricedDays:30}};
  // Mirando solo noviembre, la discrepancia de diciembre no se asoma.
  const nov=d.fiabilidadTexto('2026-11-01','2026-11-30',cob);
  assert.match(nov,/factura 1 periodo\(s\) de este rango cubiertos, todos cuadran/);
  assert.ok(!/con discrepancia/.test(nov),'una discrepancia de otro mes no sale en portada');
  // Mirando diciembre, sí.
  assert.match(d.fiabilidadTexto('2026-12-01','2026-12-31',cob),
    /factura 1 periodo\(s\) de este rango cubiertos, 1 con discrepancia/);
  // Y el contraste completo del anexo las sigue viendo las dos.
  assert.equal(d.contrasteFactura().completos.length,2);
  assert.equal(d.contrasteFactura().discrepantes.length,1);
});

test('el mapa de calor recorre el calendario y deja en gris lo que no tiene muestra', () => {
  const d=dashboard();
  // Producción el 1 y el 5 de julio: entre medias no hay muestra.
  const prodH=[
    {date:'2026-07-01',h:12,total:30},
    {date:'2026-07-05',h:12,total:30}];
  const an=d.calcAnalysis(prodH,[],
    {totals:{savingsWithIEEUR:100},coverage:{pricedDays:2},monthly:[],daily:[]},null,null);
  // Antes el eje tenía 2 columnas y el 1 de julio salía pegado al 5.
  assert.deepStrictEqual([...an.heatDates],
    ['2026-07-01','2026-07-02','2026-07-03','2026-07-04','2026-07-05']);
  // Los días del hueco no traen dato: se pintan en gris, no como cero.
  for(const hueco of ['2026-07-02','2026-07-03','2026-07-04'])
    assert.equal(an.heatData[hueco],undefined,hueco+' no puede inventarse un cero');
  assert.equal(an.heatData['2026-07-01'][12],30);
  assert.equal(an.hayHeat,true);
  // Y una hora sin muestra dentro de un día con datos tampoco es cero.
  assert.equal(an.heatData['2026-07-01'][13],undefined);
});

test('el ratio de ahorro dice sobre cuántos días y qué fechas se calcula', () => {
  const d=dashboard();
  const an=d.calcAnalysis([],[],{totals:{savingsWithIEEUR:10784},coverage:{pricedDays:292},monthly:[],
    daily:[{date:'2025-12-16',priced:true},{date:'2026-03-02',priced:false},{date:'2026-10-20',priced:true}]},null,null);
  assert.equal(an.pb.desde,'2025-12-16');
  assert.equal(an.pb.hasta,'2026-10-20');
  assert.equal(an.pb.dias,292);
  // Sin anualizar: el texto dice «acumulado» y nombra los días y el rango.
  const t=d.ratioTexto(an.pb);
  assert.match(t,/acumulado en 292 día\(s\) valorados/);
  assert.match(t,/16\/12\/2025 → 20\/10\/2026/);
  assert.equal(d.ratioTexto({pct:null}),'—');
});
