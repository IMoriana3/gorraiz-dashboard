/* Balance diario y valoración aproximada por factura. Sin red ni persistencia.
 * Los costes fijos, el precio de venta y el reparto horario no se infieren.
 * Script clásico para GitHub Pages; también utilizable en pruebas con Node.
 */
(function (root) {
  'use strict';
  const energyKeys = ['generatedKWh', 'importKWh', 'exportKWh', 'selfConsumptionKWh', 'loadKWh'];
  const moneyKeys = ['energySavingsEUR', 'savingsWithIEEUR', 'cashSavingsWithVATEUR',
    'gridEnergyEUR', 'gridWithIEEUR', 'gridWithVATEUR'];
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const nonNegative = v => finite(v) && v >= 0;
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T12:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  function addDay(value) {
    const d = new Date(value + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  function todayMadrid() {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Madrid',
      year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date());
    const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
    return p.year + '-' + p.month + '-' + p.day;
  }
  function requireNumber(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!finite(value) || value < min || value > max) throw new Error(name + ': número no válido.');
    return value;
  }
  // Precio por periodo tarifario, opcional. Si se declara, tienen que estar los
  // seis: con cinco, el que faltara valoraría su energía a cero sin avisar, que
  // es peor que no valorar nada. El precio medio de la factura se sigue
  // exigiendo aparte, porque es el que valora el balance diario.
  function validatePeriodPrices(input, index) {
    if (input == null) return null;
    if (typeof input !== 'object' || Array.isArray(input))
      throw new Error('pricesByPeriod del periodo ' + index + ' debe ser un objeto P1-P6.');
    const keys = Object.keys(input);
    const expected = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
    for (const k of keys) {
      if (!expected.includes(k)) throw new Error('Periodo tarifario desconocido: ' + k + '.');
    }
    for (const k of expected) {
      if (!finite(input[k]) || input[k] <= 0)
        throw new Error('Falta un precio positivo para ' + k + ' en el periodo ' + index + '. Deben estar los seis.');
    }
    return Object.freeze(Object.fromEntries(expected.map(k => [k, input[k]])));
  }
  function validatePricingConfig(input) {
    if (!input || input.version !== 1 || input.currency !== 'EUR' || input.method !== 'invoice-average')
      throw new Error('Usa una configuración de precios medios de factura, versión 1 y moneda EUR.');
    if (!Array.isArray(input.periods) || !input.periods.length || input.periods.length > 120)
      throw new Error('La configuración debe contener entre 1 y 120 periodos de factura.');
    const periods = input.periods.map((p, i) => {
      if (!p || !validDate(p.from) || !validDate(p.to) || p.from > p.to)
        throw new Error('Fechas no válidas en el periodo ' + (i + 1) + '.');
      const importKWh = requireNumber(p.importKWh, 'kWh importados', Number.MIN_VALUE);
      const energyEUR = requireNumber(p.energyEUR, 'Término de energía');
      const ie = requireNumber(p.ie, 'IE (fracción)', 0, 1);
      const vat = requireNumber(p.vat, 'IVA (fracción)', 0, 1);
      const price = energyEUR / importKWh;
      if (!Number.isFinite(price)) throw new Error('El precio medio no es finito.');
      return {from: p.from, to: p.to, importKWh, energyEUR, ie, vat, price,
        pricesByPeriod: validatePeriodPrices(p.pricesByPeriod, i + 1),
        source: typeof p.source === 'string' ? p.source.slice(0, 200) : 'Factura'};
    }).sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < periods.length; i++) {
      if (periods[i].from <= periods[i - 1].to) throw new Error('Hay periodos de factura solapados.');
    }
    return {version: 1, currency: 'EUR', method: 'invoice-average',
      label: typeof input.label === 'string' ? input.label.slice(0, 160) : 'Precios medios de factura',
      periods,
      notes: Array.isArray(input.notes) ? input.notes.filter(v => typeof v === 'string').slice(0, 12).map(v => v.slice(0, 600)) : []};
  }
  function uniqueDates(rows, name) {
    const map = new Map();
    for (const row of rows || []) {
      if (!row || !validDate(row.date)) throw new Error('Fecha no válida en ' + name + '.');
      if (map.has(row.date)) throw new Error('Día duplicado en ' + name + ': ' + row.date + '.');
      map.set(row.date, row);
    }
    return map;
  }
  function buildDailyBalance(production, grid, options = {}) {
    const pMap = uniqueDates(production, 'producción');
    const gMap = uniqueDates(grid, 'SPC');
    const dates = [...new Set([...pMap.keys(), ...gMap.keys()])].sort();
    const from = options.from || dates[0];
    const to = options.to || dates[dates.length - 1];
    if (!from && !to) return [];
    if (!validDate(from) || !validDate(to) || from > to) throw new Error('Rango del balance no válido.');
    const today = options.today || todayMadrid();
    if (!validDate(today)) throw new Error('Fecha de cierre no válida.');
    const out = [];
    for (let date = from; date <= to; date = addDay(date)) {
      if (out.length >= 4000) throw new Error('El balance admite hasta 4.000 días por consulta.');
      const p = pMap.get(date), g = gMap.get(date);
      const generatedKWh = p && nonNegative(p.total) ? p.total : null;
      const importKWh = g && nonNegative(g.importKWh) ? g.importKWh : null;
      const exportKWh = g && nonNegative(g.exportKWh) ? g.exportKWh : null;
      let reason = null;
      if (date >= today) reason = date === today ? 'open-day' : 'future-day';
      else if (!p || p.hasA !== true || p.hasB !== true || generatedKWh === null) reason = 'missing-production';
      else if (importKWh === null || exportKWh === null) reason = 'missing-grid-energy';
      else if (g.meta && (g.meta.diaCerrado === false ||
          (g.meta.completo === false && g.meta.resumenDiarioCompleto !== true))) reason = 'partial-grid-energy';
      else if (g.meta && g.meta.units != null && g.meta.units !== 'kWh') reason = 'unexpected-units';
      else if (exportKWh - generatedKWh > 1e-7) reason = 'export-exceeds-production';
      const complete = reason === null;
      const selfConsumptionKWh = complete ? Math.max(0, generatedKWh - exportKWh) : null;
      const loadKWh = complete ? importKWh + selfConsumptionKWh : null;
      out.push({date, generatedKWh, importKWh, exportKWh, selfConsumptionKWh, loadKWh,
        complete, reason, meta: g && g.meta ? {...g.meta} : {}});
    }
    return out;
  }
  function periodAt(config, date, allowForwardEstimate) {
    if (!config) return null;
    const found = config.periods.find(p => p.from <= date && date <= p.to);
    if (found) return {...found, forwardEstimate: false};
    const last = config.periods[config.periods.length - 1];
    if (allowForwardEstimate === true && last && date > last.to) return {...last, forwardEstimate: true};
    return null;
  }
  function knownSum(rows, key) {
    const values = rows.map(r => r[key]).filter(finite);
    return values.length ? values.reduce((sum, v) => sum + v, 0) : null;
  }
  function aggregate(rows) {
    const complete = rows.filter(r => r.complete);
    const priced = rows.filter(r => r.priced);
    const values = {};
    for (const key of energyKeys) values[key] = knownSum(complete, key);
    for (const key of moneyKeys) values[key] = knownSum(priced, key);
    const pricedSelfKWh = knownSum(priced, 'selfConsumptionKWh');
    const pricedImportKWh = knownSum(priced, 'importKWh');
    const price = pricedSelfKWh > 0 ? values.energySavingsEUR / pricedSelfKWh
      : pricedImportKWh > 0 ? values.gridEnergyEUR / pricedImportKWh
        : priced.length ? priced.reduce((s, r) => s + r.price, 0) / priced.length : null;
    return {...values, price, pricedSelfKWh, pricedImportKWh,
      // No se conoce el contrato de excedentes. Un cero sería una afirmación falsa.
      exportRevenueEUR: null,
      expectedDays: rows.length, completeDays: complete.length, pricedDays: priced.length,
      forwardEstimatedDays: priced.filter(r => r.forwardEstimate).length,
      partial: complete.length !== rows.length || priced.length !== rows.length};
  }
  function valueBalance(balance, inputConfig, options = {}) {
    const config = inputConfig ? validatePricingConfig(inputConfig) : null;
    const daily = balance.map(row => {
      const p = periodAt(config, row.date, options.allowForwardEstimate);
      const priced = row.complete && !!p;
      const energySavingsEUR = priced ? row.selfConsumptionKWh * p.price : null;
      const gridEnergyEUR = priced ? row.importKWh * p.price : null;
      return {...row, priced, price: p ? p.price : null,
        priceSource: p ? p.source + ' (' + p.from + ' → ' + p.to + ')' : null,
        forwardEstimate: !!(p && p.forwardEstimate), energySavingsEUR,
        savingsWithIEEUR: priced ? energySavingsEUR * (1 + p.ie) : null,
        cashSavingsWithVATEUR: priced ? energySavingsEUR * (1 + p.ie) * (1 + p.vat) : null,
        gridEnergyEUR,
        gridWithIEEUR: priced ? gridEnergyEUR * (1 + p.ie) : null,
        gridWithVATEUR: priced ? gridEnergyEUR * (1 + p.ie) * (1 + p.vat) : null};
    });
    const months = new Map();
    for (const row of daily) {
      const month = row.date.slice(0, 7);
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(row);
    }
    const totals = aggregate(daily);
    const coverage = {expectedDays: daily.length, completeDays: totals.completeDays,
      pricedDays: totals.pricedDays, missingEnergyDays: daily.length - totals.completeDays,
      missingPriceDays: totals.completeDays - totals.pricedDays,
      forwardEstimatedDays: totals.forwardEstimatedDays, partial: totals.partial};
    return {daily, monthly: [...months].sort(([a], [b]) => a.localeCompare(b))
      .map(([month, rows]) => ({month, ...aggregate(rows)})), totals, coverage};
  }
  // periodAt se expone para poder valorar la energía por periodo tarifario con
  // la factura que cubre cada día, sin duplicar aquí la búsqueda.
  root.GorraizEnergia = Object.freeze({validatePricingConfig, buildDailyBalance, valueBalance,
    validDate, periodAt});
})(globalThis);
