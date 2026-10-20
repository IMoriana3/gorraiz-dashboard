// SPC Cloud: consultas de lectura. No contiene rutas de control de equipos.
// El cliente público del portal documenta estas llamadas, pero no es una API
// pública estable. El primer acceso real debe contrastarse con su pantalla/XLS.
export const SPC_BASE = 'https://spc.ksdatacloud.com';
export const SPC_FIELDS = Object.freeze([
  'saveTime', 'positiveActiveElec', 'reverseActiveElec', 'totalActivePower', 'currentRatio',
]);
export const SPC_LIMITS = Object.freeze({pageSize: 100, maxPages: 25, cacheDays: 31, maxRequests: 36});
const API = SPC_BASE + '/api';
const DAY_MS = 86400000;
const TOKEN_TTL_MS = 4 * 60000;
const MAX_JSON_CHARS = 4 * 1024 * 1024;
const sessions = new Map();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = o => !!o && typeof o === 'object' && !Array.isArray(o);
const enabled = v => v === true || String(v || '').toLowerCase() === 'true';

export class SpcError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'SpcError';
    this.code = code;
    this.status = status;
  }
}

// No se devuelve error.message de fetch, del proveedor ni de KV: puede contener
// la URL de autenticación, cuyos parámetros incluyen usuario y contraseña.
export function safeSpcError(error) {
  if (error instanceof SpcError && error.code !== 'SPC_SESSION_EXPIRED') {
    return {code: error.code, message: error.message, status: error.status};
  }
  return {code: 'SPC_ERROR', message: 'No se ha podido completar la consulta de SPC.', status: 502};
}

const fail = (code, message, status) => { throw new SpcError(code, message, status); };
const clock = options => {
  const d = new Date(options.now ? options.now() : Date.now());
  if (!Number.isFinite(+d)) fail('SPC_CLOCK', 'No se ha podido determinar la fecha de consulta.');
  return d;
};
const stamp = options => clock(options).toISOString();

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value;
}

export function validateSpcRange(desde, hasta, maxDays = 1) {
  if (!validDate(desde) || !validDate(hasta) || desde > hasta) {
    fail('SPC_RANGE', 'Indica un rango válido desde/hasta en formato AAAA-MM-DD.', 400);
  }
  const n = Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / DAY_MS) + 1;
  if (n > maxDays) fail('SPC_RANGE', 'SPC admite como máximo ' + maxDays + ' día(s) por consulta.', 400);
  return Array.from({length: n}, (_, i) => new Date(Date.parse(desde + 'T00:00:00Z') + i * DAY_MS).toISOString().slice(0, 10));
}

function identifier(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const s = String(value).trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(s) ? s : null;
}

function missing(env) {
  return ['SPC_USER', 'SPC_PASS', 'SPC_STATION_ID']
    .filter(k => typeof env[k] !== 'string' || !env[k].trim());
}

function settings(env, requireCredentials = true) {
  if (requireCredentials && missing(env).length) {
    fail('SPC_CONFIG', 'SPC no está configurado. Faltan: ' + missing(env).join(', ') + '.', 501);
  }
  const stationId = identifier(env.SPC_STATION_ID);
  if (!stationId) fail('SPC_CONFIG', 'Falta un SPC_STATION_ID válido en el Worker.', 501);
  const meterId = env.SPC_METER_ID ? identifier(env.SPC_METER_ID) : null;
  if (env.SPC_METER_ID && !meterId) fail('SPC_CONFIG', 'SPC_METER_ID no tiene un formato válido.', 501);
  const timezone = env.SPC_TIMEZONE || 'Europe/Madrid';
  try { new Intl.DateTimeFormat('sv-SE', {timeZone: timezone}).format(new Date()); }
  catch { fail('SPC_CONFIG', 'SPC_TIMEZONE no es una zona horaria válida.', 501); }
  return {stationId, meterId, timezone};
}

function localTime(date, timezone) {
  const parts = new Intl.DateTimeFormat('sv-SE', {timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}

function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normaliseSpcRow(row) {
  if (!object(row) || typeof row.saveTime !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(row.saveTime) ||
      !validDate(row.saveTime.slice(0, 10)) ||
      !SPC_FIELDS.slice(1).some(k => own(row, k))) {
    fail('SPC_SCHEMA', 'SPC devolvió una fila de histórico con formato no reconocido.');
  }
  const time = row.saveTime.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  const offset = row.saveTime.match(/[+-](\d{2}):?(\d{2})$/);
  if (+time[1] > 23 || +time[2] > 59 || +(time[3] || 0) > 59 ||
      (offset && (+offset[1] > 23 || +offset[2] > 59))) {
    fail('SPC_SCHEMA', 'SPC devolvió una marca de tiempo inválida en el histórico.');
  }
  // Se conserva la marca literal: no se ha verificado el huso del portal.
  // Tampoco se aplican multiplicadores CT ni se fabrican energías horarias.
  return Object.fromEntries(SPC_FIELDS.map(k => [k, k === 'saveTime' ? row[k] : finiteOrNull(row[k])]));
}

export function normaliseSpcDaily(payload, date) {
  const d = payload && payload.data;
  if (!object(d) || !['positiveElec', 'reverseElec', 'selfConsumption'].some(k => own(d, k))) {
    fail('SPC_SCHEMA', 'SPC no devolvió los campos esperados del resumen diario.');
  }
  return {date, importKWh: finiteOrNull(d.positiveElec), exportKWh: finiteOrNull(d.reverseElec),
    selfConsumptionKWh: finiteOrNull(d.selfConsumption)};
}

function pageData(payload) {
  const total = finiteOrNull(payload && payload.total);
  if (!object(payload) || !Array.isArray(payload.rows) || !Number.isSafeInteger(total) || total < 0) {
    fail('SPC_SCHEMA', 'SPC no devolvió una página con filas y un total válido.');
  }
  return {rows: payload.rows, total};
}

async function credentialsKey(user, pass) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user + '\0' + pass));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function createSpcClient(env, options = {}) {
  const cfg = settings(env);
  const fetcher = options.fetch || globalThis.fetch;
  const tokenStore = options.sessionCache || sessions;
  const user = env.SPC_USER.trim(), pass = env.SPC_PASS;
  const keyPromise = credentialsKey(user, pass);
  let renewed = false;
  let requestCount = 0;

  async function fetchJson(path, {method = 'GET', params, body, token, login = false} = {}) {
    // También cuentan los logins proactivos si el proveedor anuncia un token
    // con vida muy corta. Nunca se excede el presupuesto externo del Worker.
    if (requestCount >= SPC_LIMITS.maxRequests)
      fail('SPC_REQUEST_LIMIT', 'SPC necesita demasiadas consultas para completar el día. No se ha guardado un resultado truncado.');
    requestCount++;
    const url = new URL(API + path);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers = {Accept: 'application/json', language: 'en',
      client_time: localTime(clock(options), cfg.timezone)};
    if (login) headers.Authorization = 'Basic ' + btoa('kstar:kstarSecret'); // Cliente público del portal.
    else headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    let response, text;
    try {
      response = await fetcher(url.toString(), {method, headers, redirect: 'error',
        cache: 'no-store', signal: controller.signal,
        ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
      if (response.status === 401) fail('SPC_SESSION_EXPIRED', 'La sesión de SPC ha caducado.');
      if (response.status >= 300 && response.status < 400) {
        fail('SPC_REDIRECT', 'SPC intentó redirigir la consulta. Solo se permite el servicio HTTPS configurado.');
      }
      if (!response.ok) {
        fail('SPC_HTTP', 'SPC no está disponible por HTTPS (HTTP ' + response.status + ').',
          response.status >= 500 ? 503 : 502);
      }
      if (!/application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) {
        fail('SPC_NOT_JSON', 'SPC no devolvió JSON. Puede tratarse de una página de acceso o de error.');
      }
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_JSON_CHARS) fail('SPC_SIZE', 'La respuesta de SPC supera el tamaño admitido.');
      text = await response.text();
      if (text.length > MAX_JSON_CHARS) fail('SPC_SIZE', 'La respuesta de SPC supera el tamaño admitido.');
    } catch (error) {
      if (error instanceof SpcError) throw error;
      fail('SPC_NETWORK', 'No se ha podido contactar con SPC mediante HTTPS. No se ha usado HTTP.', 503);
    } finally { clearTimeout(timer); }
    let data;
    try { data = JSON.parse(text); }
    catch { fail('SPC_NOT_JSON', 'SPC devolvió una respuesta JSON ilegible.'); }
    if (!object(data)) fail('SPC_SCHEMA', 'SPC devolvió una respuesta con formato no reconocido.');
    const code = data.code === undefined || data.code === null ? null : String(data.code);
    if (code === '10031' || code === '10032' || code === '401') {
      fail('SPC_SESSION_EXPIRED', 'La sesión de SPC ha caducado.');
    }
    if ((code !== null && code !== '0' && code !== '200') || data.success === false || data.error) {
      fail('SPC_PROVIDER_ERROR', 'SPC devolvió un error de aplicación; no se han utilizado sus datos.');
    }
    return data;
  }

  async function getToken(force = false, previousToken = null) {
    const key = await keyPromise, now = +clock(options);
    const current = tokenStore.get(key);
    if (current && current.token && current.until > now &&
        (!force || current.token !== previousToken)) return current.token;
    if (current && current.pending) return current.pending;
    const entry = {};
    const pending = (async () => {
      let data;
      try {
        data = await fetchJson('/authentication/form', {method: 'POST', login: true,
          params: {username: user, password: pass, langType: 'en'}});
      } catch (error) {
        if (error instanceof SpcError && error.code === 'SPC_SESSION_EXPIRED') {
          fail('SPC_AUTH', 'SPC ha rechazado el acceso. Revisa SPC_USER y SPC_PASS en el Worker.');
        }
        throw error;
      }
      const t = data.token;
      if (!object(t) || typeof t.access_token !== 'string' || !t.access_token.trim() ||
          /[\r\n]/.test(t.access_token) || t.access_token.length > 16000) {
        fail('SPC_AUTH', 'SPC no devolvió una sesión válida. Revisa sus credenciales y el acceso al portal.');
      }
      const seconds = finiteOrNull(t.expires_in);
      const ttl = seconds === null ? TOKEN_TTL_MS : Math.min(TOKEN_TTL_MS, Math.max(0, seconds * 1000 - 15000));
      tokenStore.set(key, {token: t.access_token, until: +clock(options) + ttl});
      return t.access_token;
    })();
    entry.pending = pending;
    tokenStore.set(key, entry);
    // Límite de sesiones en memoria; nunca se persisten en KV ni se devuelven.
    while (tokenStore.size > 8) tokenStore.delete(tokenStore.keys().next().value);
    try { return await pending; }
    catch (error) { if (tokenStore.get(key) === entry) tokenStore.delete(key); throw error; }
  }

  async function request(path, init = {}) {
    let token = await getToken();
    try { return await fetchJson(path, {...init, token}); }
    catch (error) {
      if (!(error instanceof SpcError) || error.code !== 'SPC_SESSION_EXPIRED') throw error;
      if (renewed) fail('SPC_AUTH', 'SPC ha vuelto a rechazar la sesión después de renovarla una vez.');
      renewed = true;
      token = await getToken(true, token);
      try { return await fetchJson(path, {...init, token}); }
      catch (retryError) {
        if (retryError instanceof SpcError && retryError.code === 'SPC_SESSION_EXPIRED') {
          fail('SPC_AUTH', 'SPC ha vuelto a rechazar la sesión después de renovarla una vez.');
        }
        throw retryError;
      }
    }
  }

  async function discoverMeter() {
    const p = pageData(await request('/station/monitor/detail/meter/list', {method: 'POST', body: {
      pageNumber: 1, pageSize: 100, stationId: cfg.stationId, collectId: '', orderField: '', orderDirection: '',
    }}));
    if (p.total > 100 || p.rows.length !== p.total) {
      fail('SPC_METERS_INCOMPLETE', 'La lista de medidores de SPC está incompleta o supera los 100 equipos.');
    }
    if (!p.rows.length) fail('SPC_NO_METER', 'La estación SPC configurada no devuelve ningún medidor.');
    const ids = p.rows.map(row => {
      if (!object(row) || !identifier(row.deviceId) ||
          (own(row, 'stationId') && identifier(row.stationId) !== cfg.stationId)) {
        fail('SPC_METER_MEMBERSHIP', 'No se ha podido verificar que el medidor pertenezca a la estación configurada.');
      }
      return identifier(row.deviceId);
    });
    if (new Set(ids).size !== ids.length) fail('SPC_SCHEMA', 'SPC devolvió medidores duplicados.');
    if (cfg.meterId) {
      if (!ids.includes(cfg.meterId)) fail('SPC_METER_MEMBERSHIP', 'SPC_METER_ID no pertenece a la estación configurada.');
      return {meterId: cfg.meterId, meterCount: ids.length};
    }
    if (ids.length !== 1) fail('SPC_MULTIPLE_METERS', 'Hay varios medidores en la estación. Configura SPC_METER_ID para elegir uno.');
    return {meterId: ids[0], meterCount: ids.length};
  }

  async function history(meterId, date) {
    const rows = [], pageSignatures = new Set();
    let total = null;
    for (let page = 1; page <= SPC_LIMITS.maxPages; page++) {
      const p = pageData(await request('/meter/monitor/detail/history/data', {params: {
        deviceId: meterId, startTime: date, pageNumber: page, pageSize: SPC_LIMITS.pageSize,
      }}));
      if (total === null) total = p.total;
      if (total > SPC_LIMITS.maxPages * SPC_LIMITS.pageSize) {
        fail('SPC_PAGE_LIMIT', 'El histórico supera el límite de 25 páginas de 100 filas. No se ha guardado un resultado truncado.');
      }
      if (p.total !== total) fail('SPC_PAGINATION', 'El histórico cambió durante la lectura. Repite la consulta para obtener un conjunto coherente.');
      if (p.rows.length > SPC_LIMITS.pageSize || rows.length + p.rows.length > total ||
          (!p.rows.length && rows.length < total)) {
        fail('SPC_PAGINATION', 'SPC devolvió una paginación incompleta o incoherente.');
      }
      const normalised = p.rows.map(normaliseSpcRow);
      const signature = JSON.stringify(normalised);
      if (pageSignatures.has(signature)) fail('SPC_PAGINATION', 'SPC repitió una página del histórico. No se ha guardado como completa.');
      pageSignatures.add(signature);
      rows.push(...normalised);
      if (rows.length === total) return {rows, total, pages: page};
    }
    fail('SPC_PAGE_LIMIT', 'No se ha completado el histórico dentro de las 25 páginas admitidas.');
  }

  async function readDay(date) {
    validateSpcRange(date, date);
    const {meterId, meterCount} = await discoverMeter();
    const h = await history(meterId, date);
    const daily = normaliseSpcDaily(await request('/station/monitor/detail/self', {
      params: {stationId: cfg.stationId, startTime: date},
    }), date);
    const hasHistoryValues = h.rows.some(row => ['positiveActiveElec', 'reverseActiveElec', 'totalActivePower'].some(k => row[k] !== null));
    const hasHistoryEnergy = h.rows.some(row => row.positiveActiveElec !== null && row.reverseActiveElec !== null);
    const hasDailyValues = ['importKWh', 'exportKWh', 'selfConsumptionKWh'].some(k => daily[k] !== null);
    if (!hasHistoryValues && !hasDailyValues) fail('SPC_EMPTY', 'SPC no devolvió mediciones ni energía diaria válida para ese día.');
    const updated = stamp(options), closed = date < localTime(clock(options), cfg.timezone).slice(0, 10);
    return {rows: h.rows, daily: [daily], meta: {
      fuente: 'spc', stationId: cfg.stationId, meterId, desde: date, hasta: date,
      solicitado: {desde: date, hasta: date}, registros: h.rows.length,
      actualizado: updated, fetchedAt: updated, timezone: cfg.timezone, timezoneVerified: false,
      paginas: h.pages, totalDeclarado: h.total, sinHistorico: !h.rows.length,
      completo: closed && hasHistoryEnergy && daily.importKWh !== null && daily.exportKWh !== null && daily.importKWh >= 0 && daily.exportKWh >= 0,
      resumenDiarioCompleto: closed && daily.importKWh !== null && daily.exportKWh !== null && daily.importKWh >= 0 && daily.exportKWh >= 0,
      diaCerrado: closed, coberturaHorariaVerificada: false,
      dailyScope: 'station', historyScope: 'meter', medidoresEstacion: meterCount,
    }};
  }

  return {readDay};
}

const dataKey = (stationId, date) => 'spc:v1:' + stationId + ':' + date;
const statusKey = stationId => 'spc:v1:' + stationId + ':estado';
const isoOrNull = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;

async function readStatus(env, stationId) {
  if (!env.DATOS) return null;
  const d = await env.DATOS.get(statusKey(stationId), 'json');
  if (!object(d)) return null;
  // La forma se reconstruye: nunca se vuelca una respuesta del proveedor.
  return {lastAttempt: isoOrNull(d.lastAttempt), lastSuccess: isoOrNull(d.lastSuccess),
    lastError: object(d.lastError) && typeof d.lastError.code === 'string' && typeof d.lastError.message === 'string'
      ? {code: d.lastError.code.slice(0, 64), message: d.lastError.message.slice(0, 300)} : null,
    status: ['ok', 'partial', 'error'].includes(d.status) ? d.status : 'error',
    date: validDate(d.date) ? d.date : null, source: d.source === 'scheduled' ? 'scheduled' : 'manual',
    complete: d.complete === true};
}

async function writeStatus(env, stationId, date, payload, error, options) {
  if (!env.DATOS) return;
  let before = null;
  try { before = await readStatus(env, stationId); } catch { /* El último resultado válido no se toca. */ }
  const complete = !!(payload && payload.meta.completo);
  const safe = error ? safeSpcError(error) : null;
  const status = {lastAttempt: stamp(options),
    lastSuccess: complete ? stamp(options) : (before && before.lastSuccess) || null,
    lastError: safe ? {code: safe.code, message: safe.message} : null,
    status: error ? 'error' : (complete ? 'ok' : 'partial'), date,
    source: options.source === 'scheduled' ? 'scheduled' : 'manual', complete};
  await env.DATOS.put(statusKey(stationId), JSON.stringify(status));
}

async function saveGoodDay(env, payload) {
  if (!env.DATOS) return {persistido: false, avisoCache: 'El Worker no tiene almacén DATOS; esta descarga solo queda en el navegador.'};
  const key = dataKey(payload.meta.stationId, payload.meta.desde);
  const before = await env.DATOS.get(key, 'json');
  if (before && before.meta && before.meta.completo === true && !payload.meta.completo) {
    return {persistido: false, cacheConservada: true, avisoCache: 'Se conserva la última copia completa de este día.'};
  }
  const text = JSON.stringify(payload);
  if (text.length > MAX_JSON_CHARS) fail('SPC_CACHE_SIZE', 'Los datos SPC del día superan el tamaño admitido para el almacén.');
  await env.DATOS.put(key, text);
  return {persistido: true};
}

export async function spcIntercambio(env, desde, hasta, options = {}) {
  validateSpcRange(desde, hasta);
  let stationId = identifier(env.SPC_STATION_ID);
  try {
    const result = await createSpcClient(env, options).readDay(desde);
    stationId = result.meta.stationId;
    try { Object.assign(result.meta, await saveGoodDay(env, result)); }
    catch { result.meta.persistido = false; result.meta.avisoCache = 'La lectura es válida, pero no se ha podido guardar en DATOS.'; }
    try { await writeStatus(env, stationId, desde, result, null, options); }
    catch { result.meta.avisoEstado = 'No se ha podido guardar el estado de la última consulta SPC.'; }
    return result;
  } catch (error) {
    if (stationId) try { await writeStatus(env, stationId, desde, null, error, options); } catch { /* No ocultar el fallo original. */ }
    if (error instanceof SpcError) throw error;
    const safe = safeSpcError(error);
    throw new SpcError(safe.code, safe.message, safe.status);
  }
}

export async function spcDiagnostico(env, date, options = {}) {
  const data = await spcIntercambio(env, date, date, options);
  return {ok: true, complete: data.meta.completo, stationId: data.meta.stationId, meterId: data.meta.meterId,
    dia: date, registros: data.rows.length, campos: [...SPC_FIELDS], daily: data.daily,
    actualizado: data.meta.actualizado, sinHistorico: data.meta.sinHistorico,
    timezone: data.meta.timezone, timezoneVerified: false, persistido: data.meta.persistido,
    avisoCache: data.meta.avisoCache || null};
}

function validateCached(payload, stationId, date) {
  if (!object(payload) || !object(payload.meta) || payload.meta.fuente !== 'spc' ||
      payload.meta.stationId !== stationId || payload.meta.desde !== date || payload.meta.hasta !== date ||
      !identifier(payload.meta.meterId) || !Array.isArray(payload.rows) ||
      !Array.isArray(payload.daily) || payload.daily.length !== 1 || payload.daily[0].date !== date ||
      !isoOrNull(payload.meta.actualizado)) fail('SPC_CACHE_SCHEMA', 'El almacén SPC contiene un día con formato inválido.');
  const rows = payload.rows.map(normaliseSpcRow);
  const d = payload.daily[0];
  const daily = [{date, importKWh: finiteOrNull(d.importKWh), exportKWh: finiteOrNull(d.exportKWh),
    selfConsumptionKWh: finiteOrNull(d.selfConsumptionKWh)}];
  const m = payload.meta;
  // Solo metadatos propios, aunque una copia almacenada tenga campos extra.
  return {date, rows, daily, meta: {fuente: 'spc', stationId, meterId: identifier(m.meterId),
    desde: date, hasta: date, solicitado: {desde: date, hasta: date}, registros: rows.length,
    actualizado: m.actualizado, fetchedAt: isoOrNull(m.fetchedAt) || m.actualizado,
    timezone: typeof m.timezone === 'string' ? m.timezone : null, timezoneVerified: false,
    completo: m.completo === true, sinHistorico: !rows.length, diaCerrado: m.diaCerrado === true,
    resumenDiarioCompleto: m.resumenDiarioCompleto === true,
    paginas: Number.isSafeInteger(m.paginas) ? m.paginas : null,
    totalDeclarado: Number.isSafeInteger(m.totalDeclarado) ? m.totalDeclarado : null,
    coberturaHorariaVerificada: false, cache: true, persistido: true,
    dailyScope: 'station', historyScope: 'meter',
    medidoresEstacion: Number.isSafeInteger(m.medidoresEstacion) ? m.medidoresEstacion : null,
  }};
}

export async function spcDatos(env, desde, hasta, options = {}) {
  const days = validateSpcRange(desde, hasta, SPC_LIMITS.cacheDays);
  const cfg = settings(env, false);
  if (!env.DATOS) fail('SPC_NO_CACHE', 'No hay almacén DATOS configurado para consultar el histórico SPC.', 501);
  const fuentes = [], diasFaltan = [], diasErrores = [];
  for (const date of days) {
    try {
      const value = await env.DATOS.get(dataKey(cfg.stationId, date), 'json');
      if (!value) { diasFaltan.push(date); continue; }
      const source = validateCached(value, cfg.stationId, date);
      if (cfg.meterId && source.meta.meterId !== cfg.meterId) { diasFaltan.push(date); continue; }
      fuentes.push(source);
    } catch { diasErrores.push(date); }
  }
  const rows = fuentes.flatMap(f => f.rows), daily = fuentes.flatMap(f => f.daily);
  const updated = fuentes.map(f => f.meta.actualizado).sort().at(-1) || null;
  const meterIds = [...new Set(fuentes.map(f => f.meta.meterId))];
  return {rows, daily, fuentes, meta: {fuente: 'spc', stationId: cfg.stationId,
    meterId: meterIds.length === 1 ? meterIds[0] : cfg.meterId, meterIds,
    desde, hasta, solicitado: {desde, hasta}, registros: rows.length,
    actualizado: updated, fetchedAt: updated, cacheReadAt: stamp(options),
    timezone: cfg.timezone, timezoneVerified: false, cache: true,
    diasCache: fuentes.map(f => f.date), diasFaltan, diasErrores,
    sinHistorico: !rows.length,
    completo: fuentes.length === days.length && fuentes.every(f => f.meta.completo === true),
  }};
}

export async function spcEstado(env) {
  const faltan = missing(env);
  let config = null, last = null, configError = null;
  try { config = settings(env, false); }
  catch (error) { configError = safeSpcError(error).message; }
  if (config && env.DATOS) try { last = await readStatus(env, config.stationId); } catch { /* El resto del panel sigue funcionando. */ }
  // Configurado no equivale a autenticación comprobada: esa evidencia está en
  // spcUltima y en el resultado del diagnóstico, no en la presencia de secretos.
  return {spc: faltan.length === 0 && !!config, spcFaltan: faltan,
    spcSync: enabled(env.SPC_SYNC_ENABLED), spcConfigError: configError,
    spcUltima: last, spcLastAttempt: last ? last.lastAttempt : null,
    spcLastSuccess: last ? last.lastSuccess : null, spcError: last ? last.lastError : null};
}

export async function spcScheduled(env, options = {}) {
  if (!enabled(env.SPC_SYNC_ENABLED)) return {skipped: true, reason: 'disabled'};
  let stationId = identifier(env.SPC_STATION_ID), date = null;
  const opt = {...options, source: 'scheduled'};
  try {
    const cfg = settings(env);
    stationId = cfg.stationId;
    if (!env.DATOS) fail('SPC_NO_CACHE', 'La sincronización SPC requiere el almacén DATOS.', 501);
    const today = localTime(clock(options), cfg.timezone).slice(0, 10);
    date = new Date(Date.parse(today + 'T00:00:00Z') - DAY_MS).toISOString().slice(0, 10);
    const result = await spcIntercambio(env, date, date, opt);
    return {ok: true, date, complete: result.meta.completo, registros: result.rows.length,
      persistido: result.meta.persistido};
  } catch (error) {
    if (stationId && !date) try { await writeStatus(env, stationId, date, null, error, opt); } catch { /* Sin credenciales en los logs. */ }
    const safe = safeSpcError(error);
    return {ok: false, date, error: {code: safe.code, message: safe.message}};
  }
}
