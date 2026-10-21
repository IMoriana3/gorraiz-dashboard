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
    const CFG={kwp:100,inv:10000};
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
      ideDiario,contrasteRed,gridDiario,horasDia,contrasteTexto,contrastePdfTexto,idePeriodos,
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
// periodo son medida suya, no un reparto nuestro.
const horasP = (date, filas) => filas.map(([h, consumo, gen, periodo]) =>
  ({ts:new Date(`${date}T${String(h).padStart(2,'0')}:30:00`), consumo, gen, periodo}));

test('el reparto por periodo suma la medida de i-DE y deriva el autoconsumo del inversor', () => {
  const d=dashboard(),date='2026-10-05';
  d.setRaw({A:[{ts:new Date(date+'T10:30:00'),dia:60,pot:1000,acum:0}],
            B:[{ts:new Date(date+'T10:30:00'),dia:60,pot:1000,acum:0}],
            I:horasP(date,[[10,5,2,'P1'],[11,7,0,'P1'],[12,9,0,'P4'],[13,4,0,'Sin periodo']])});
  const rep=d.idePeriodos(date,date);
  close(rep.periodos.P1.importKWh,12);
  close(rep.periodos.P1.exportKWh,2);
  close(rep.periodos.P4.importKWh,9);
  close(rep.importKWh,25);
  close(rep.exportKWh,2);
  assert.equal(rep.dias,1);
  assert.equal(rep.horas,4);
  // Una fila sin periodo reconocible no se pierde ni se cuela en P6.
  close(rep.periodos['Sin periodo'].importKWh,4);
  assert.equal(rep.periodos.P6.horas,0);
  assert.ok(!rep.franjas.includes('P6'),'un periodo sin horas no se enseña');
  assert.ok(rep.franjas.includes('Sin periodo'));
});

test('el autoconsumo por periodo descuenta el vertido y no cuenta horas sin producción', () => {
  const d=dashboard(),date='2026-10-05';
  // Produccion horaria a partir de acumulados: 40 kWh por inversor a las 10h.
  const muestras=k=>[{ts:new Date(date+'T10:00:00'),dia:40,pot:0,acum:0},
                     {ts:new Date(date+'T10:50:00'),dia:40,pot:0,acum:40}];
  d.setRaw({A:muestras('A'),B:muestras('B'),
            I:horasP(date,[[10,0,15,'P1'],[14,3,0,'P4']])});
  const rep=d.idePeriodos(date,date);
  // 80 kWh producidos a las 10h menos 15 vertidos = 65 autoconsumidos.
  close(rep.periodos.P1.autoKWh,65);
  assert.equal(rep.periodos.P1.horasConProd,1);
  // A las 14h no hay muestras: no se inventa autoconsumo.
  assert.equal(rep.periodos.P4.autoKWh,0);
  assert.equal(rep.periodos.P4.horasConProd,0);
  assert.equal(rep.horasConProd,1);
  assert.equal(rep.horas,2);
});

test('el reparto respeta el rango pedido y desaparece sin ficheros de i-DE', () => {
  const d=dashboard();
  d.setRaw({A:[],B:[],I:[...horasP('2026-10-05',[[10,10,0,'P1']]),
                         ...horasP('2026-10-09',[[10,20,0,'P1']])]});
  close(d.idePeriodos('2026-10-05','2026-10-05').importKWh,10);
  close(d.idePeriodos('2026-10-01','2026-10-31').importKWh,30);
  assert.equal(d.idePeriodos('2026-10-20','2026-10-25'),null,'rango sin filas no devuelve reparto');
  d.setRaw({A:[],B:[],I:[]});
  assert.equal(d.idePeriodos('2026-10-01','2026-10-31'),null);
});
