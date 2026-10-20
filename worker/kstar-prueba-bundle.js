// GENERADO AUTOMÁTICAMENTE: SOLO PRUEBA AISLADA DE KSTAR SPC.
// No copiar credenciales a este fichero. Regenerar: node worker/construir.mjs

// SPC Cloud: consultas de lectura. No contiene rutas de control de equipos.
// El cliente público del portal documenta estas llamadas, pero no es una API
// pública estable. El primer acceso real debe contrastarse con su pantalla/XLS.
const SPC_BASE = 'https://spc.ksdatacloud.com';
const SPC_HTTP_BASE = 'http://spc.ksdatacloud.com';
// Sin cambio automático a HTTP cuando HTTPS falla: solo activación deliberada.
const SPC_FIELDS = Object.freeze([
  'saveTime', 'positiveActiveElec', 'reverseActiveElec', 'totalActivePower', 'currentRatio',
]);
const SPC_LIMITS = Object.freeze({pageSize: 100, maxPages: 25, cacheDays: 31, maxRequests: 36});
// La URL efectiva se selecciona por configuración al abrir el cliente.
const DAY_MS = 86400000;
const TOKEN_TTL_MS = 4 * 60000;
const MAX_JSON_CHARS = 4 * 1024 * 1024;
const sessions = new Map();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = o => !!o && typeof o === 'object' && !Array.isArray(o);
const enabled = v => v === true || String(v || '').toLowerCase() === 'true';

class SpcError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'SpcError';
    this.code = code;
    this.status = status;
  }
}

// No se devuelve error.message de fetch, del proveedor ni de KV: puede contener
// la URL de autenticación, cuyos parámetros incluyen usuario y contraseña.
function safeSpcError(error) {
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

function validateSpcRange(desde, hasta, maxDays = 1) {
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
  const transport = env.SPC_TRANSPORT === undefined ? 'https' : String(env.SPC_TRANSPORT).trim().toLowerCase();
  if (transport !== 'https' && transport !== 'http')
    fail('SPC_CONFIG', 'SPC_TRANSPORT debe ser https o http.', 501);
  if (transport === 'http' && env.SPC_HTTP_RISK_ACK !== 'I_ACCEPT_UNENCRYPTED_CREDENTIALS')
    fail('SPC_HTTP_LOCKED', 'HTTP sin cifrar está bloqueado. Hay que aceptar expresamente el riesgo de exponer las credenciales y la sesión.', 403);
  return {stationId, meterId, timezone, transport};
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

function normaliseSpcRow(row) {
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

function normaliseSpcDaily(payload, date) {
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

function createSpcClient(env, options = {}) {
  const cfg = settings(env);
  const api = (cfg.transport === 'http' ? SPC_HTTP_BASE : SPC_BASE) + '/api';
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
    const url = new URL(api + path);
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
        fail('SPC_REDIRECT', 'SPC intentó redirigir la consulta fuera del origen fijo autorizado.');
      }
      if (!response.ok) {
        fail('SPC_HTTP', 'SPC no está disponible por ' + (cfg.transport === 'http' ? 'HTTP sin cifrar' : 'HTTPS') + ' (HTTP ' + response.status + ').',
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
      fail('SPC_NETWORK', cfg.transport === 'http'
        ? 'No se ha podido contactar con SPC por HTTP sin cifrar (modo experimental).'
        : 'No se ha podido contactar con SPC mediante HTTPS. No se ha usado HTTP.', 503);
    } finally { clearTimeout(timer); }
    let data;
    try { data = JSON.parse(text); }
    catch { fail('SPC_NOT_JSON', 'SPC devolvió una respuesta JSON ilegible.'); }
    if (!object(data)) fail('SPC_SCHEMA', 'SPC devolvió una respuesta con formato no reconocido.');
    const code = data.code === undefined || data.code === null ? null : String(data.code);
    if (code === '10031' || code === '10032' || code === '401') {
      fail('SPC_SESSION_EXPIRED', 'La sesión de SPC ha caducado.');
    }
    // El código "000000" con success:true está confirmado como éxito en KSTAR.
    // No normalizar a número: otros códigos con ceros iniciales son errores.
    const goodCode = code === null || ['0', '200', '000000'].includes(code);
    if (!goodCode || data.success === false || data.error) {
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
    // El comprobador independiente puede conocer la cobertura y las
    // primeras/últimas lecturas aunque el resumen de estación falle.
    // No altera el resultado, no persiste datos ni cambia el flujo normal.
    if (typeof options.onHistory === 'function') {
      try { options.onHistory({meterId, meterCount, rows: h.rows, totalDeclarado: h.total, paginas: h.pages}); }
      catch { /* El diagnóstico opcional no debe invalidar una lectura real. */ }
    }
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
      transport: cfg.transport, unencryptedTransport: cfg.transport === 'http',
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

async function spcIntercambio(env, desde, hasta, options = {}) {
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

async function spcDiagnostico(env, date, options = {}) {
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
    transport: m.transport === 'http' ? 'http' : 'https',
    unencryptedTransport: m.unencryptedTransport === true,
    completo: m.completo === true, sinHistorico: !rows.length, diaCerrado: m.diaCerrado === true,
    resumenDiarioCompleto: m.resumenDiarioCompleto === true,
    paginas: Number.isSafeInteger(m.paginas) ? m.paginas : null,
    totalDeclarado: Number.isSafeInteger(m.totalDeclarado) ? m.totalDeclarado : null,
    coberturaHorariaVerificada: false, cache: true, persistido: true,
    dailyScope: 'station', historyScope: 'meter',
    medidoresEstacion: Number.isSafeInteger(m.medidoresEstacion) ? m.medidoresEstacion : null,
  }};
}

async function spcDatos(env, desde, hasta, options = {}) {
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

async function spcEstado(env) {
  const faltan = missing(env);
  let config = null, last = null, configError = null;
  try { config = settings(env, false); }
  catch (error) { configError = safeSpcError(error).message; }
  if (config && env.DATOS) try { last = await readStatus(env, config.stationId); } catch { /* El resto del panel sigue funcionando. */ }
  // Configurado no equivale a autenticación comprobada: esa evidencia está en
  // spcUltima y en el resultado del diagnóstico, no en la presencia de secretos.
  return {spc: faltan.length === 0 && !!config, spcFaltan: faltan,
    spcTransport: config ? config.transport : 'https',
    spcUnencryptedTransport: !!(config && config.transport === 'http'),
    spcSync: enabled(env.SPC_SYNC_ENABLED), spcConfigError: configError,
    spcUltima: last, spcLastAttempt: last ? last.lastAttempt : null,
    spcLastSuccess: last ? last.lastSuccess : null, spcError: last ? last.lastError : null};
}

async function spcScheduled(env, options = {}) {
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

// Prueba aislada de lectura SPC. No contiene credenciales ni rutas de control.
// Para copiar este Worker en Cloudflare, usar kstar-prueba-bundle.js generado.

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const HTML = [
  '<!doctype html>',
  '<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Gorraiz · KSTAR · Diagnóstico</title>',
  '<style>body{font:16px system-ui, sans-serif;max-width:640px;margin:5vh auto;padding:0 20px;background:#f5f7f6;color:#18372f}',
  'main{background:white;border:1px solid #d4ded9;border-radius:14px;padding:24px}h1{font-size:24px;margin:0 0 12px}',
  'p{line-height:1.5}label{display:block;font-weight:600;margin:18px 0 7px}',
  'input,button{box-sizing:border-box;font:inherit;padding:12px;border-radius:8px}',
  'input{border:1px solid #8ba89a;width:100%}button{margin-top:20px;border:0;background:#1d6050;color:#fff;cursor:pointer}',
  'button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#ecf2ef;padding:12px;border-radius:8px;min-height:50px}',
  '.risk{background:#fff3da;border-left:4px solid #b97c0d;padding:12px}</style></head><body><main>',
  '<h1>KSTAR SPC01 · Prueba de lectura</h1>',
  '<p>Worker independiente de Gorraiz. Consulta un solo día cerrado y no modifica la instalación.</p>',
  '<p class="risk"><strong>HTTP sin cifrar hacia KSTAR.</strong> El usuario, contraseña y token pueden ser interceptados entre Cloudflare y KSTAR. Solo usar cuenta temporal de solo lectura; no la cuenta principal de control.</p>',
  '<form id="form"><label for="key">Clave de prueba del Worker (NO la contraseña KSTAR)</label>',
  '<input id="key" type="password" autocomplete="off" minlength="24" required>',
  '<label for="day">Día cerrado para consultar</label><input id="day" type="date" required>',
  '<button id="probe" type="button">Comprobar red sin credenciales KSTAR</button>',
  '<button id="go" type="submit">Comprobar lectura KSTAR</button></form>',
  '<h2>Resultado</h2><pre id="result">Sin consulta realizada.</pre>',
  '<p>La comprobación de red no utiliza SPC_USER, SPC_PASS ni ningún token. Los resultados no se guardan ni se envían a GitHub.</p>',
  '</main><script>',
  'document.getElementById("form").addEventListener("submit", async function(e){',
  'e.preventDefault();const out=document.getElementById("result");const b=document.getElementById("go");',
  'b.disabled=true;out.textContent="Consultando KSTAR...";',
  'try{const response=await fetch("/comprobar",{method:"POST",headers:{"content-type":"application/json","X-KSTAR-Test-Key":document.getElementById("key").value},',
  'body:JSON.stringify({dia:document.getElementById("day").value})});',
  'const data=await response.json();out.textContent=JSON.stringify(data,null,2);}',
  'catch(e){out.textContent="No se pudo completar la consulta al Worker de pruebas.";}finally{b.disabled=false;}',
  '});',
  'document.getElementById("probe").addEventListener("click",async function(){',
  'const key=document.getElementById("key").value;const out=document.getElementById("result");const btn=document.getElementById("probe");',
  'if(key.length<24){out.textContent="Introduce la clave de prueba del Worker (no la contraseña KSTAR).";return;}',
  'btn.disabled=true;out.textContent="Comprobando conectividad sin credenciales KSTAR...";',
  'try{const r=await fetch("/sondeo",{method:"POST",headers:{"X-KSTAR-Test-Key":key}});',
  'const body=await r.json();out.textContent=JSON.stringify(body,null,2);}',
  'catch{out.textContent="No se pudo completar el sondeo del Worker.";}finally{btn.disabled=false;}',
  '});</script></body></html>',
].join('\n');

// La ruta de intercambio es la única que permite CORS desde el dashboard.
// No usamos comodines, cookies ni credenciales del proveedor en el navegador.
const DASHBOARD_ORIGIN = 'https://imoriana3.github.io';
function corsHeaders(req) {
  const origin = req.headers.get('Origin');
  return origin === DASHBOARD_ORIGIN ? {
    'access-control-allow-origin': DASHBOARD_ORIGIN,
    'access-control-allow-headers': 'content-type, X-KSTAR-Test-Key',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  } : {};
}
function output(data, status = 200, req = null) {
  return new Response(JSON.stringify(data), {status, headers: {
    ...HEADERS, 'content-type': 'application/json; charset=utf-8',
    ...(req ? corsHeaders(req) : {}),
  }});
}
async function equalSecret(candidate, actual) {
  if (typeof actual !== 'string' || actual.length < 24 || typeof candidate !== 'string') return false;
  const enc = new TextEncoder();
  const [a,b] = await Promise.all([candidate, actual].map(s => crypto.subtle.digest('SHA-256',enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < x.length; i++) mismatch |= x[i] ^ y[i];
  return mismatch === 0;
}
function validPastDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s+'T12:00:00Z');
  if (!Number.isFinite(+d) || d.toISOString().slice(0,10) !== s) return false;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(i => [i.type, i.value]));
  return s < p.year+'-'+p.month+'-'+p.day;
}


const DIAGNOSTIC_PATHS = Object.freeze({
  '/api/authentication/form': 'autenticacion',
  '/api/station/monitor/detail/meter/list': 'lista_medidores',
  '/api/meter/monitor/detail/history/data': 'historico_medidor',
  '/api/station/monitor/detail/self': 'resumen_diario',
});
function stageOf(url) {
  try { return DIAGNOSTIC_PATHS[new URL(url).pathname] || 'otra_ruta'; }
  catch { return 'no_identificada'; }
}

// Sonda sin secreto de KSTAR. No se siguen redirecciones y no se consultan
// cuerpos: solo código HTTP o tipo genérico de fallo, nunca URL privadas.
async function probeOnce(name, pathname, method = 'GET') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('http://spc.ksdatacloud.com' + pathname, {
      method,
      headers: {Accept: 'application/json'},
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    return {prueba: name, metodo: method, http: response.status,
      contenido: (response.headers.get('content-type') || '').split(';')[0] || null};
  } catch (error) {
    const kind = controller.signal.aborted || error?.name === 'AbortError' ? 'tiempo_agotado' : 'fallo_de_transporte';
    return {prueba: name, metodo: method, error: kind};
  } finally { clearTimeout(timeout); }
}
async function probeNetwork() {
  const checks = [
    ['portal', '/', 'GET'],
    ['api_sin_sesion', '/api/station/monitor/detail/self', 'GET'],
    ['login_post_sin_credenciales', '/api/authentication/form', 'POST'],
  ];
  const resultados = [];
  for (const [name,path,method] of checks) resultados.push(await probeOnce(name,path,method));
  return {ok: true, sinCredencialesKstar: true, resultados};
}


function safeHistoryInfo(raw) {
  if (!raw || !Array.isArray(raw.rows)) return null;
  const rows = raw.rows;
  const muestra = row => row ? {
    fechaHoraLiteral: typeof row.saveTime === 'string' ? row.saveTime.slice(0,48) : null,
    positivaSinValidar: typeof row.positiveActiveElec === 'number' ? row.positiveActiveElec : null,
    inversaSinValidar: typeof row.reverseActiveElec === 'number' ? row.reverseActiveElec : null,
  } : null;
  return {
    medidor: typeof raw.meterId === 'string' ? raw.meterId.slice(0,100) : null,
    medidoresEnEstacion: Number.isSafeInteger(raw.meterCount) ? raw.meterCount : null,
    registros: rows.length,
    totalDeclarado: Number.isSafeInteger(raw.totalDeclarado) ? raw.totalDeclarado : null,
    paginas: Number.isSafeInteger(raw.paginas) ? raw.paginas : null,
    primeraFila: muestra(rows[0]),
    ultimaFila: muestra(rows[rows.length-1]),
    aviso: 'Lecturas crudas del medidor; orden, unidades, acumulados y cobertura diaria sin validar. NO equivalen a kWh diarios.',
  };
}
function safeProviderInfo(response, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const val = payload.code === undefined || payload.code === null ? '' : String(payload.code);
  const codigo = /^\d{1,10}$/.test(val) ? val : null;
  const data = payload.data;
  const tipoDatos = data === null || data === undefined ? 'sin_datos'
    : Array.isArray(data) ? 'lista'
      : typeof data === 'object' ? 'objeto' : 'otro';
  return {http: response.status, codigo,
    success: typeof payload.success === 'boolean' ? payload.success : null,
    errorPresente: payload.error !== undefined && payload.error !== null && payload.error !== false,
    tipoDatos};
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/')
      return new Response(HTML, {headers: {...HEADERS, 'content-type': 'text/html; charset=utf-8'}});
    const exchange = path === '/spc/intercambio';
    const origin = req.headers.get('Origin');
    if (exchange && origin && origin !== DASHBOARD_ORIGIN)
      return output({error: 'Origen no autorizado.'}, 403);
    if (exchange && req.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: {...HEADERS, ...corsHeaders(req)}});
    }
    if (path !== '/comprobar' && path !== '/sondeo' && !exchange)
      return output({error: 'Ruta no disponible.'}, 404);
    if (req.method !== 'POST')
      return output({error: 'Se requiere POST.'}, 405, exchange ? req : null);
    if (!env.KSTAR_TEST_KEY || String(env.KSTAR_TEST_KEY).length < 24)
      return output({error: 'Configura KSTAR_TEST_KEY como secreto de al menos 24 caracteres.'}, 503);
    if (!await equalSecret(req.headers.get('X-KSTAR-Test-Key'), env.KSTAR_TEST_KEY))
      return output({error: 'Clave de prueba incorrecta.'}, 401, exchange ? req : null);
    if (path === '/sondeo') return output(await probeNetwork());
    if (env.SPC_TRANSPORT !== 'http' || env.SPC_HTTP_RISK_ACK !== 'I_ACCEPT_UNENCRYPTED_CREDENTIALS')
      return output({error: 'La prueba HTTP no está habilitada. Revisa ambas variables de aceptación.'}, 501, exchange ? req : null);
    if (!env.SPC_USER || !env.SPC_PASS || !env.SPC_STATION_ID)
      return output({error: 'Faltan SPC_USER, SPC_PASS o SPC_STATION_ID en el Worker.'}, 501, exchange ? req : null);
    let text;
    try { text = await req.text(); }
    catch { return output({error: 'Cuerpo de consulta no disponible.'}, 400); }
    if (text.length > 200) return output({error: 'Consulta demasiado larga.'}, 413);
    let body;
    try { body = JSON.parse(text); }
    catch { return output({error: 'Formato de consulta incorrecto.'}, 400); }
    const dia = exchange
      ? (body?.desde === body?.hasta ? body.desde : '')
      : body?.dia;
    if (!validPastDate(dia))
      return output({error: 'Selecciona un único día cerrado válido.'}, 400, exchange ? req : null);
    // Solo la ruta aislada comparte registros normalizados con el dashboard.
    // Evitamos escribir KV aquí; no tenemos programación automática ni control.
    if (exchange) {
      try {
        const r = await spcIntercambio({...env, DATOS: undefined}, dia, dia, {sessionCache: new Map()});
        if (r.meta?.stationId !== env.SPC_STATION_ID || r.daily?.[0]?.date !== dia)
          return output({error: 'La estación o el día KSTAR no coinciden.'}, 502, req);
        return output({rows: r.rows, daily: r.daily, meta: {
          ...r.meta, persistido: false, origen: 'kstar-worker-aislado',
        }}, 200, req);
      } catch (error) {
        const safe = safeSpcError(error);
        return output({code: safe.code, error: safe.message}, safe.status, req);
      }
    }
    let etapa = 'preparacion', detalleRed = null, proveedor = null, historico = null;
    // En la prueba aislada usamos redirección manual: nunca seguir un 302
    // con la contraseña o el Bearer a otro destino. No registrar URLs ni headers.
    const fetchDiagnostic = async (url, init) => {
      etapa = stageOf(url);
      try {
        const response = await fetch(url, {...init, redirect: 'manual'});
        if (etapa === 'resumen_diario') {
          // Nunca se publican mensajes crudos ni respuestas completas del
          // proveedor: podrían contener datos identificables o tokens.
          try {
            const len = Number(response.headers.get('content-length') || 0);
            if (len < 20000 && /application\/json/i.test(response.headers.get('content-type') || '')) {
              const raw = await response.clone().text();
              if (raw.length <= 20000) proveedor = safeProviderInfo(response, JSON.parse(raw));
            }
          } catch { /* No interferir con la respuesta original. */ }
        }
        return response;
      }
      catch (error) {
        detalleRed = init.signal?.aborted || error?.name === 'AbortError'
          ? 'tiempo_agotado' : 'fallo_de_transporte';
        throw error;
      }
    };
    try {
      // Sesión efímera por solicitud para no retener tokens KSTAR en el Worker de ensayo.
      const r = await spcDiagnostico(env, body.dia, {
        fetch: fetchDiagnostic, sessionCache: new Map(),
        onHistory: raw => { historico = safeHistoryInfo(raw); },
      });
      // Solo campos y kWh; nunca se envían el token, el login ni el histórico crudo.
      return output({ok: true, dia: r.dia, stationId: r.stationId,
        meterId: r.meterId, registros: r.registros,
        importKWh: r.daily?.[0]?.importKWh ?? null, exportKWh: r.daily?.[0]?.exportKWh ?? null,
        selfConsumptionKWh: r.daily?.[0]?.selfConsumptionKWh ?? null,
        complete: r.complete === true,
        ...(historico ? {historico} : {}),
        ...(proveedor ? {proveedor} : {}),
        nota: r.complete ? 'Compara estos datos con el portal KSTAR.' : 'Lecturas parciales. No utilizarlas como cierre validado.'});
    } catch (error) {
      const safe = safeSpcError(error);
      return output({ok: false, code: safe.code, error: safe.message,
        etapa, ...(detalleRed ? {detalleRed} : {}),
        ...(proveedor ? {proveedor} : {}),
        ...(historico ? {historico} : {})}, safe.status);
    }
  },
};
