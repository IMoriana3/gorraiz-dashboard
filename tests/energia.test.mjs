import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../energia.js';
const {validatePricingConfig, buildDailyBalance, valueBalance} = globalThis.GorraizEnergia;
const config = {version: 1, currency: 'EUR', method: 'invoice-average', periods: [
  {from:'2026-05-01', to:'2026-05-31', importKWh:1000, energyEUR:200, ie:0.05, vat:0.21, source:'Ejemplo ficticio'}
]};
const production = date => ({date, total:100, A:60, B:40, hasA:true, hasB:true});
const grid = (date, exportKWh=30) => ({date,importKWh:50,exportKWh});
const balance = (p, g, options={}) => buildDailyBalance(p,g,{today:'2026-06-02',...options});
const close = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-9, `${actual} != ${expected}`);

test('conservación energética: FV exportada no cuenta como autoconsumo ni demanda', () => {
  const [r] = balance([production('2026-05-03')],[grid('2026-05-03')]);
  assert.equal(r.selfConsumptionKWh,70); assert.equal(r.loadKWh,120);
  assert.equal(r.generatedKWh+r.importKWh,r.loadKWh+r.exportKWh);
});
test('cero medido es válido; energía ausente no se convierte en cero', () => {
  const p=production('2026-05-03');
  assert.equal(balance([p],[grid(p.date,0)])[0].complete,true);
  for(const value of [null,undefined,'',NaN,'0',-1]) {
    const r=balance([p],[{...grid(p.date),exportKWh:value}])[0];
    assert.equal(r.complete,false); assert.equal(r.selfConsumptionKWh,null);
  }
});
test('requiere ambos inversores y un día cerrado', () => {
  const p=production('2026-06-02');
  assert.equal(balance([p],[grid(p.date)])[0].reason,'open-day');
  p.date='2026-06-01';p.hasB=false;
  assert.equal(balance([p],[grid(p.date)])[0].reason,'missing-production');
});
test('no recorta una exportación mayor que la generación para ocultar incoherencias', () => {
  const p=production('2026-05-03');
  const r=balance([p],[grid(p.date,101)])[0];
  assert.equal(r.reason,'export-exceeds-production');assert.equal(r.loadKWh,null);
});
test('huecos de calendario se incluyen en cobertura y no suman como ceros', () => {
  const p=[production('2026-05-01'),production('2026-05-03')];
  const b=balance(p,p.map(r=>grid(r.date)));
  assert.equal(b.length,3);assert.equal(b[1].reason,'missing-production');
  const r=valueBalance(b,config);
  assert.equal(r.coverage.completeDays,2);assert.equal(r.coverage.expectedDays,3);
  assert.equal(r.totals.selfConsumptionKWh,140);assert.equal(r.coverage.partial,true);
});
test('fecha y duplicados incorrectos fallan explícitamente', () => {
  assert.throws(()=>balance([production('2026-02-30')],[]),/Fecha/);
  assert.throws(()=>balance([production('2026-05-01'),production('2026-05-01')],[]),/duplicado/);
});
test('balance no depende del cambio horario: días civiles de 23 o 25 horas', () => {
  const p=[production('2026-03-28'),production('2026-03-30')];
  const b=balance(p,[],{today:'2026-11-01'});
  assert.deepEqual(b.map(r=>r.date),['2026-03-28','2026-03-29','2026-03-30']);
  const c=balance([production('2026-10-24'),production('2026-10-26')],[],{today:'2026-11-01'});
  assert.equal(c.length,3);
});
test('valora solo autoconsumo, mantiene IE e IVA separados y no presume ingresos de venta', () => {
  const r=valueBalance(balance([production('2026-05-03')],[grid('2026-05-03')]),config);
  close(r.totals.energySavingsEUR,14);close(r.totals.savingsWithIEEUR,14.7);
  close(r.totals.cashSavingsWithVATEUR,17.787);close(r.totals.gridEnergyEUR,10);
  assert.equal(r.totals.exportRevenueEUR,null);
});
test('fuera de la factura no hay precio por defecto; el opt-in futuro queda marcado', () => {
  const b=balance([production('2026-06-01')],[grid('2026-06-01')]);
  const r=valueBalance(b,config);assert.equal(r.totals.energySavingsEUR,null);
  assert.equal(r.coverage.missingPriceDays,1);
  const e=valueBalance(b,config,{allowForwardEstimate:true});
  close(e.totals.energySavingsEUR,14);assert.equal(e.coverage.forwardEstimatedDays,1);
  assert.equal(valueBalance(balance([production('2026-04-30')],[grid('2026-04-30')]),config,
    {allowForwardEstimate:true}).totals.energySavingsEUR,null);
});
test('sin datos o sin configuración devuelve null; todo exportado da ahorro cero real', () => {
  assert.equal(valueBalance([],config).totals.energySavingsEUR,null);
  const b=balance([production('2026-05-03')],[grid('2026-05-03',100)]);
  assert.equal(valueBalance(b,null).totals.energySavingsEUR,null);
  assert.equal(valueBalance(b,config).totals.energySavingsEUR,0);
});
test('validación de precios no acepta solapes, fechas inexistentes ni importación cero', () => {
  assert.throws(()=>validatePricingConfig({...config,periods:[...config.periods,...config.periods]}),/solapados/);
  for(const patch of [{to:'2026-05-32'},{importKWh:0},{energyEUR:NaN},{vat:21},{ie:null}])
    assert.throws(()=>validatePricingConfig({...config,periods:[{...config.periods[0],...patch}]}));
});
test('no confunde base facturada con costes fijos ni precio precomputado manipulado', () => {
  const c=validatePricingConfig({...config,periods:[{...config.periods[0],price:500,totalInvoiceEUR:900,fixedEUR:700}]});
  assert.equal(c.periods[0].price,0.2);assert.equal(c.periods[0].fixedEUR,undefined);
});
test('agregación mensual conserva precisión y el mismo ámbito en todas las sumas', () => {
  const p=[production('2026-05-30'),production('2026-05-31'),production('2026-06-01')];
  const r=valueBalance(balance(p,p.map(d=>grid(d.date))),config);
  assert.equal(r.monthly.length,2);close(r.totals.energySavingsEUR,28);
  assert.equal(r.totals.pricedDays,2);assert.equal(r.totals.completeDays,3);
  assert.equal(r.totals.pricedSelfKWh,140);assert.equal(r.totals.selfConsumptionKWh,210);
});

test('ceros medidos en todos los flujos conservan un balance válido y ahorro cero', () => {
  const p={...production('2026-05-03'),total:0,A:0,B:0};
  const b=balance([p],[{date:p.date,importKWh:0,exportKWh:0}]);
  const r=valueBalance(b,config);
  assert.equal(b[0].complete,true);
  for(const key of ['generatedKWh','importKWh','exportKWh','selfConsumptionKWh','loadKWh',
    'energySavingsEUR','gridEnergyEUR','cashSavingsWithVATEUR']) assert.equal(r.totals[key],0,key);
  assert.equal(r.coverage.pricedDays,1);assert.equal(r.totals.exportRevenueEUR,null);
});

test('valores ausentes o no numéricos en producción e importación impiden valorar el día', () => {
  for(const value of [null,undefined,'',NaN,Infinity,'0',-1]) {
    for(const field of ['production','import']) {
      const p=production('2026-05-03'),g=grid(p.date);
      if(field==='production') p.total=value; else g.importKWh=value;
      const b=balance([p],[g]),r=valueBalance(b,config);
      assert.equal(b[0].complete,false,field+' '+String(value));
      assert.equal(r.totals.energySavingsEUR,null);
      assert.equal(r.coverage.missingEnergyDays,1);
    }
  }
});

test('un día parcial en caché SPC sigue incompleto aunque su fecha ya haya terminado', () => {
  const p=production('2026-05-03');
  for(const meta of [{completo:false},{diaCerrado:false},{completo:true,diaCerrado:false}]) {
    const b=balance([p],[{...grid(p.date),meta}]);
    assert.equal(b[0].complete,false,JSON.stringify(meta));
    assert.equal(valueBalance(b,config).totals.energySavingsEUR,null);
  }
  assert.equal(balance([p],[{...grid(p.date),meta:{completo:true,diaCerrado:true}}])[0].complete,true);
});

test('toda unidad explícita incompatible con kWh impide mezclar potencia y energía', () => {
  const p=production('2026-05-03');
  for(const units of ['Wh','MWh','kW','W','kVARh']) {
    const b=balance([p],[{...grid(p.date),meta:{units}}]);
    assert.equal(b[0].complete,false,units);
    assert.equal(b[0].reason,'unexpected-units');
    assert.equal(valueBalance(b,config).totals.energySavingsEUR,null);
  }
  assert.equal(balance([p],[{...grid(p.date),meta:{units:'kWh'}}])[0].complete,true);
});

test('sin fechas FV el SPC observado cuenta como cobertura incompleta, no desaparece', () => {
  const b=balance([],[grid('2026-05-03')]);
  assert.equal(b.length,1);assert.equal(b[0].date,'2026-05-03');
  assert.equal(b[0].reason,'missing-production');
  const r=valueBalance(b,config);
  assert.equal(r.coverage.expectedDays,1);assert.equal(r.coverage.missingEnergyDays,1);
  assert.equal(r.totals.energySavingsEUR,null);
});

test('el rango implícito cubre ambas fuentes y el explícito conserva sus límites', () => {
  const p=[production('2026-05-02')],g=[grid('2026-05-01'),grid('2026-05-02'),grid('2026-05-03')];
  const b=balance(p,g);
  assert.deepEqual(b.map(r=>r.date),['2026-05-01','2026-05-02','2026-05-03']);
  assert.deepEqual(b.map(r=>r.complete),[false,true,false]);
  assert.equal(balance(p,g,{from:'2026-05-02',to:'2026-05-02'}).length,1);
});

test('límites inclusivos y cambios de IE/IVA se aplican por factura sin mezclar tipos', () => {
  const c={...config,periods:[
    {from:'2026-06-01',to:'2026-06-30',importKWh:1000,energyEUR:400,ie:0.10,vat:0.10,source:'Otro ejemplo ficticio'},
    ...config.periods
  ]};
  const p=[production('2026-05-31'),production('2026-06-01')];
  const r=valueBalance(balance(p,p.map(d=>grid(d.date))),c);
  assert.equal(r.daily[0].price,0.2);assert.equal(r.daily[1].price,0.4);
  close(r.totals.energySavingsEUR,42);close(r.totals.savingsWithIEEUR,45.5);
  close(r.totals.cashSavingsWithVATEUR,51.667);
  assert.equal(r.coverage.forwardEstimatedDays,0);assert.equal(r.coverage.pricedDays,2);
  const first=valueBalance(balance([production('2026-05-01')],[grid('2026-05-01')]),config);
  assert.equal(first.coverage.pricedDays,1);
});

test('el permiso de estimación futura no rellena huecos entre facturas', () => {
  const c={...config,periods:[
    {...config.periods[0],to:'2026-05-10'},
    {...config.periods[0],from:'2026-05-20'}
  ]};
  const p=production('2026-05-15');
  const r=valueBalance(balance([p],[grid(p.date)]),c,{allowForwardEstimate:true});
  assert.equal(r.totals.energySavingsEUR,null);assert.equal(r.coverage.missingPriceDays,1);
  assert.equal(r.coverage.forwardEstimatedDays,0);
});

test('término de energía e impuestos realmente nulos se distinguen de campos ausentes', () => {
  const c={...config,periods:[{...config.periods[0],energyEUR:0,ie:0,vat:0}]};
  const p=production('2026-05-03'),r=valueBalance(balance([p],[grid(p.date)]),c);
  assert.equal(r.totals.energySavingsEUR,0);assert.equal(r.totals.cashSavingsWithVATEUR,0);
  assert.equal(r.coverage.pricedDays,1);
  for(const patch of [{energyEUR:null},{energyEUR:'200'},{ie:undefined},{vat:NaN},{importKWh:Infinity}])
    assert.throws(()=>validatePricingConfig({...config,periods:[{...config.periods[0],...patch}]}));
});

test('fechas civiles inválidas y duplicados SPC se rechazan sin alterar el calendario', () => {
  const p=production('2026-05-03');
  assert.throws(()=>balance([p],[grid(p.date),grid(p.date)]),/duplicado/);
  assert.throws(()=>balance([production('2026-02-29')],[]),/Fecha/);
  assert.equal(balance([production('2028-02-29')],[],{today:'2028-03-01'})[0].date,'2028-02-29');
  assert.throws(()=>balance([p],[],{from:'2026-05-03',to:'2026-05-02'}),/Rango/);
  assert.throws(()=>balance([p],[],{today:'2026-06-31'}),/Fecha/);
});

// ── Precios por periodo tarifario (opcionales) ────────────────────────────
const conPeriodos = extra => ({...config, periods:[{...config.periods[0], ...extra}]});
const seis = {P1:.21,P2:.18,P3:.18,P4:.15,P5:.15,P6:.15};

test('los precios por periodo son opcionales, y si se declaran van los seis', () => {
  assert.equal(validatePricingConfig(config).periods[0].pricesByPeriod,null,
    'sin declararlos, no se inventa ninguno');

  const ok = validatePricingConfig(conPeriodos({pricesByPeriod:seis}));
  assert.equal(ok.periods[0].pricesByPeriod.P1,.21);
  assert.equal(ok.periods[0].pricesByPeriod.P6,.15);

  // Con cinco, el que falta valoraría su energía a cero sin avisar.
  const cinco = {...seis}; delete cinco.P5;
  assert.throws(()=>validatePricingConfig(conPeriodos({pricesByPeriod:cinco})),/P5/);
});

test('un precio por periodo no positivo, desconocido o mal tipado se rechaza', () => {
  assert.throws(()=>validatePricingConfig(conPeriodos({pricesByPeriod:{...seis,P3:0}})),/P3/);
  assert.throws(()=>validatePricingConfig(conPeriodos({pricesByPeriod:{...seis,P3:-1}})),/P3/);
  assert.throws(()=>validatePricingConfig(conPeriodos({pricesByPeriod:{...seis,P7:.1}})),/P7/);
  assert.throws(()=>validatePricingConfig(conPeriodos({pricesByPeriod:[1,2,3,4,5,6]})),/P1-P6/);
  assert.throws(()=>validatePricingConfig(conPeriodos({pricesByPeriod:{...seis,P2:'0,18'}})),/P2/);
});

test('periodAt localiza la factura de cada día y respeta la extrapolación', () => {
  const {periodAt} = globalThis.GorraizEnergia;
  const cfg = validatePricingConfig(conPeriodos({pricesByPeriod:seis}));
  assert.equal(periodAt(cfg,'2026-05-15').pricesByPeriod.P1,.21);
  assert.equal(periodAt(cfg,'2026-04-30'),null,'antes de la primera factura no hay precio');
  assert.equal(periodAt(cfg,'2026-06-10'),null,'después de la última, tampoco sin permiso');
  assert.equal(periodAt(cfg,'2026-06-10',true).forwardEstimate,true);
});
