// ═══════════════════════════════════════════════════════════════════════════
// GENERADO AUTOMÁTICAMENTE — no editar a mano.
// Es index.js + periodos.js + spc.js, para pegarlo en el editor web
// de Cloudflare cuando no se puede usar wrangler desde el equipo.
// Para regenerarlo tras cambiar cualquiera de ellos: node construir.mjs
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// Periodos tarifarios P1–P6 (3.0TD / 6.1TD, peninsular)
//
// Datadis NO devuelve el periodo tarifario en los datos de consumo: el
// fichero de i-DE sí lo traía, así que hay que calcularlo aquí para que
// el reparto del ahorro por periodo siga saliendo igual.
//
// Calendario de la Circular 3/2020 de la CNMC (mismo para 3.0TD y 6.1TD):
//   · Sábados, domingos y festivos nacionales: P6 las 24 h.
//   · Días laborables, horas 0–8: P6.
//   · Días laborables, resto de horas, según temporada del mes:
//        alta        (ene feb jul dic) → punta P1 / llano P2
//        media-alta  (mar nov)         → punta P2 / llano P3
//        media       (jun ago sep)     → punta P3 / llano P4
//        baja        (abr may oct)     → punta P4 / llano P5
//     punta = 9–14 y 18–22 · llano = 8–9, 14–18 y 22–24
// ═══════════════════════════════════════════════════════════════════

// Temporada por mes (1–12) → [periodo punta, periodo llano]
const TEMPORADA = {
  1:[1,2], 2:[1,2], 12:[1,2], 7:[1,2],        // alta
  3:[2,3], 11:[2,3],                          // media-alta
  6:[3,4], 8:[3,4], 9:[3,4],                  // media
  4:[4,5], 5:[4,5], 10:[4,5],                 // baja
};

// OJO con la zona horaria: el Worker corre en UTC, pero Datadis entrega fecha y
// hora ya en hora peninsular. Por eso aquí NUNCA se construye una fecha local:
// se trabaja con los componentes (año, mes, día, hora) tal cual vienen, y el día
// de la semana se saca en UTC, que para una fecha sin hora es estable.
function diaSemana(y,m,d){return new Date(Date.UTC(y,m-1,d)).getUTCDay()}

// Domingo de Pascua (algoritmo de Meeus/Jones/Butcher) → Viernes Santo = -2 días
function pascua(y){
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
        f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,
        i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
        mes=Math.floor((h+l-7*m+114)/31),dia=((h+l-7*m+114)%31)+1;
  return new Date(Date.UTC(y,mes-1,dia));
}

// Festivos nacionales no sustituibles. Los autonómicos y locales NO cuentan
// para el calendario tarifario, solo estos.
const FIJOS=['01-01','01-06','05-01','08-15','10-12','11-01','12-06','12-08','12-25'];
const cacheFest={};
function festivos(y){
  if(cacheFest[y])return cacheFest[y];
  const s=new Set(FIJOS);
  const vs=new Date(pascua(y).getTime()-2*864e5);              // Viernes Santo
  s.add(String(vs.getUTCMonth()+1).padStart(2,'0')+'-'+String(vs.getUTCDate()).padStart(2,'0'));
  return cacheFest[y]=s;
}

// (año, mes 1-12, día, hora 0-23) en hora peninsular → 'P1'...'P6'
function periodo(y,mes,dia,h){
  const dow=diaSemana(y,mes,dia);
  const md=String(mes).padStart(2,'0')+'-'+String(dia).padStart(2,'0');
  if(dow===0||dow===6||festivos(y).has(md))return 'P6';
  if(h<8)return 'P6';
  const [punta,llano]=TEMPORADA[mes];
  const esPunta=(h>=9&&h<14)||(h>=18&&h<22);
  return 'P'+(esPunta?punta:llano);
}

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

// Archivo canónico de datos energéticos Gorraiz.
// Durable Object SQLite: una instancia, claves por origen y día, transacciones
// consistentes entre navegadores. Sin llamadas a Solarman ni al portal SPC.
// La aplicación solo ve copias normalizadas y limita el tamaño de cada lote.
const HISTORY_PREFIX='energia:v1:';
const HISTORY_MAX_DAYS=31;
const HISTORY_MAX_ITEMS=93;
const MAX_SAMPLES=2500; // submuestreo o 30 s: máximo condicionado al tamaño 1,8 MB
const MAX_SPC=600;
const MAX_TEXT=1_800_000; // margen bajo el máximo de valores del DO
const types=new Set(['A','B','S']);
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:
  typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
const dateOK=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&
  Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const historyKey=(type,date)=>HISTORY_PREFIX+type+':'+date;
const utcMadrid = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',
  second:'2-digit',hourCycle:'h23'});
function localOfUTC(value){
 const date=new Date(value);
 if(!Number.isFinite(+date))return null;
 const p=Object.fromEntries(utcMadrid.formatToParts(date).map(x=>[x.type,x.value]));
 return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':'+p.second;
}
function normalizedTime(value){
 if(value instanceof Date)value=value.toISOString();
 if(typeof value!=='string')return null;
 const v=value.trim();
 if(/^\d{4}-\d{2}-\d{2}[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(v)){
   const norm=v.replace(' ','T');
   const d=norm.slice(0,10);
   if(!dateOK(d))return null;
   const h=Number(norm.slice(11,13)),m=Number(norm.slice(14,16)),sec=Number(norm.slice(17,19)||'0');
   return h<24&&m<60&&sec<60?norm:null;
 }
 if(/^\d{4}-\d{2}-\d{2}T\d\d:\d\d/.test(v)&&/(?:Z|[+-]\d\d:?\d\d)$/.test(v))
   return localOfUTC(v);
 return null;
}
const limited=v=>typeof v==='string'?v.slice(0,90):'';
function sanitizeInv(input,source){
 if(!Array.isArray(source.rows)||source.rows.length>MAX_SAMPLES||source.rows.length===0)
   throw new Error('Muestras FV ausentes o más de 2.500 en un día; conservar local y revisar el formato.');
 const date=input.fecha,out=new Map();
 let units=source.unidadPotencia??source.potUnit??null;
 if(!['W','kW','desconocida',null].includes(units))units='desconocida';
 const rejected={fecha:0,potencia:0,energia:0,acumulado:0};
 for(const row of source.rows){
   if(!row||typeof row!=='object'){rejected.fecha++;continue}
   const ts=normalizedTime(row.ts);
   if(!ts||ts.slice(0,10)!==date){rejected.fecha++;continue}
   const rawPot=number(row.pot),rawDia=number(row.dia),rawAcum=number(row.acum);
   const dia=rawDia!==null&&rawDia>=0&&rawDia<=1000?rawDia:null;
   const acum=rawAcum!==null&&rawAcum>=0&&rawAcum<=1e9?rawAcum:null;
   let pot=units==='W'?(rawPot===null?null:rawPot/1000):
     units==='desconocida'?null:rawPot;
   if(pot!==null&&(pot<0||pot>65))pot=null;
   const anomalousPot=number(row.potSinValidar)??(pot===null?rawPot:null);
   const anomalousDia=number(row.diaSinValidar)??(dia===null?rawDia:null);
   const anomalousAcum=number(row.acumSinValidar)??(acum===null?rawAcum:null);
   // Nunca se descarta un día completo por un valor de energía sospechoso.
   // Los originales se conservan para un contraste posterior, sin mostrarlos
   // en cálculos SCADA ni inferir automáticamente su unidad.
   const clean={ts,pot,acum,dia};
   if(pot===null&&anomalousPot!==null){clean.potSinValidar=anomalousPot;rejected.potencia++}
   if(dia===null&&anomalousDia!==null){clean.diaSinValidar=anomalousDia;rejected.energia++}
   if(acum===null&&anomalousAcum!==null){clean.acumSinValidar=anomalousAcum;rejected.acumulado++}
   if(pot===null&&acum===null&&dia===null&&
      !('potSinValidar'in clean)&&!('diaSinValidar'in clean)&&!('acumSinValidar'in clean))continue;
   out.set(ts,clean);
 }
 if(!out.size)throw new Error('Ninguna muestra FV con fecha y hora compatibles con '+date+
   '; registros descartados por fecha: '+rejected.fecha);
 const rows=[...out.values()].sort((a,b)=>a.ts.localeCompare(b.ts));
 return {tipo:input.tipo,fecha:date,rows,origen:'datos-compartidos',
   unidadPotencia:'kW',controlPotencia:{
     unidadRecibida:units||'no-declarada',
     muestrasSinVerificar:rows.filter(r=>r.pot===null&&r.potSinValidar!==undefined).length,
     energiaSinVerificar:rows.filter(r=>r.dia===null&&r.diaSinValidar!==undefined).length,
     acumuladosSinVerificar:rows.filter(r=>r.acum===null&&r.acumSinValidar!==undefined).length,
     marcasFueraDeDia:rejected.fecha
   },updatedAt:new Date().toISOString()};
}

const isoTime=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?
  new Date(v).toISOString():null;
function sanitizeSpc(input,source,env){
 const date=input.fecha,p=source.payload||source;
 const m=p?.meta,d=p?.daily;
 if(!m||m.fuente!=='spc'||m.stationId!==env.SPC_STATION_ID||
    m.desde!==date||m.hasta!==date||!m.meterId||!Array.isArray(p.rows)||
    !Array.isArray(d)||d.length!==1||d[0]?.date!==date||
    p.rows.length>MAX_SPC||m.medidoresEstacion!==null&&m.medidoresEstacion!==undefined&&m.medidoresEstacion!==1)
   throw new Error('Origen, estación o alcance de SPC no válidos.');
 if(env.SPC_METER_ID&&m.meterId!==env.SPC_METER_ID)
   throw new Error('El identificador del contador SPC no corresponde a Gorraiz.');
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(m.meterId))
   throw new Error('Identificador de contador SPC inválido.');
 const rows=[],dedup=new Map();
 for(const r of p.rows){
   if(!r||typeof r.saveTime!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d\d:\d\d/.test(r.saveTime)||
     r.saveTime.slice(0,10)!==date)throw new Error('Marca histórica SPC inválida.');
   const t=r.saveTime.slice(11).match(/^(\d\d):(\d\d)(?::(\d\d))?/);
   if(!t||+t[1]>23||+t[2]>59||+(t[3]||0)>59)throw new Error('Hora SPC no válida.');
   const row={saveTime:r.saveTime.slice(0,48)};
   for(const name of ['positiveActiveElec','reverseActiveElec','totalActivePower','currentRatio']){
     const val=number(r[name]);
     row[name]=val;
   }
   if(row.positiveActiveElec===null&&row.reverseActiveElec===null&&
     row.totalActivePower===null)continue;
   dedup.set(row.saveTime,row);
 }
 rows.push(...[...dedup.values()].sort((a,b)=>a.saveTime.localeCompare(b.saveTime)));
 const daily={date};
 for(const [field,max] of [['importKWh',1e6],['exportKWh',1e6],['selfConsumptionKWh',1e6]]){
   const val=number(d[0][field]);
   if(val!==null&&(val<0||val>max))throw new Error('Resumen SPC con valores fuera de rango.');
   daily[field]=val;
 }
 if(m.completo===true&&(!rows.length||daily.importKWh===null||daily.exportKWh===null))
   throw new Error('No se admite un día SPC completo sin contadores y resumen.');
 const updated=isoTime(m.actualizado)||isoTime(m.fetchedAt)||new Date().toISOString();
 return {tipo:'S',fecha:date,payload:{
   date,rows,daily:[daily],meta:{
     fuente:'spc',stationId:env.SPC_STATION_ID,meterId:m.meterId,desde:date,hasta:date,
     actualizado:updated,fetchedAt:updated,
     completo:m.completo===true,diaCerrado:m.diaCerrado===true,
     resumenDiarioCompleto:m.resumenDiarioCompleto===true,
     timezone:limited(m.timezone)||'Europe/Madrid',timezoneVerified:false,
     dailyScope:'station',historyScope:'meter',
     medidoresEstacion:1,transporteOrigen:m.transport==='http'?'http':'no-verificado',
     persistido:true,origen:'historico-compartido',registros:rows.length
   }}};
}
function normalizeHistoryItem(input,env){
 if(!input||!types.has(input.tipo)||!dateOK(input.fecha))throw new Error('Tipo o fecha de la fuente inválidos.');
 const source=input.payload?input:{...input};
 const clean=input.tipo==='S'?sanitizeSpc(input,source,env):sanitizeInv(input,source);
 if(JSON.stringify(clean).length>MAX_TEXT)throw new Error('Día demasiado grande para el almacén central.');
 return clean;
}
function combine(old,received){
 if(!old)return received;
 if(received.tipo==='S'){
   const a=old.payload,b=received.payload;
   if(a?.meta?.completo===true&&b?.meta?.completo!==true)return old;
   if(a?.meta?.completo===true&&b?.meta?.completo===true&&
      (a.rows?.length||0)>(b.rows?.length||0))return old;
   return received;
 }
 const rows=new Map();
 for(const row of old.rows||[])rows.set(row.ts,row);
 for(const row of received.rows||[]){
   const prev=rows.get(row.ts);
   rows.set(row.ts,prev?{ts:row.ts,
     pot:row.pot??prev.pot,acum:row.acum??prev.acum,dia:row.dia??prev.dia,
     ...(row.potSinValidar!==undefined||prev.potSinValidar!==undefined?
       {potSinValidar:row.potSinValidar??prev.potSinValidar}:{}),
     ...(row.diaSinValidar!==undefined||prev.diaSinValidar!==undefined?
       {diaSinValidar:row.diaSinValidar??prev.diaSinValidar}:{}),
     ...(row.acumSinValidar!==undefined||prev.acumSinValidar!==undefined?
       {acumSinValidar:row.acumSinValidar??prev.acumSinValidar}:{})}:row);
 }
 const all=[...rows.values()].sort((a,b)=>a.ts.localeCompare(b.ts));
 const merged={...received,rows:all,
   controlPotencia:{...received.controlPotencia,
     muestrasSinVerificar:all.filter(r=>r.pot===null&&r.potSinValidar!==undefined).length,
     energiaSinVerificar:all.filter(r=>r.dia===null&&r.diaSinValidar!==undefined).length,
     acumuladosSinVerificar:all.filter(r=>r.acum===null&&r.acumSinValidar!==undefined).length}};
 if(merged.rows.length>MAX_SAMPLES||JSON.stringify(merged).length>MAX_TEXT)
   throw new Error('El histórico del día excede el límite de tamaño.');
 return merged;
}
function historyIssue(source,error){
 return {tipo:types.has(source?.tipo)?source.tipo:'?',
   fecha:dateOK(source?.fecha)?source.fecha:'fecha-invalida',
   motivo:String(error?.message||'No se ha podido validar el objeto').slice(0,220)};
}
// Validación seca. No toca el almacén ni llama a proveedores. Permite
// comprobar los datos originales ANTES de iniciar cientos de escrituras.
function validateHistory(items,env){
 if(!Array.isArray(items)||!items.length||items.length>HISTORY_MAX_ITEMS)
   throw new Error('La validación admite entre 1 y 93 fuentes');
 const issues=[],accepted=[];
 for(const source of items){
   try{const clean=normalizeHistoryItem(source,env);
     accepted.push({tipo:clean.tipo,fecha:clean.fecha,filas:clean.tipo==='S'?
       clean.payload.rows.length:clean.rows.length,
       potenciaSinValidar:clean.controlPotencia?.muestrasSinVerificar||0,
       energiaSinValidar:clean.controlPotencia?.energiaSinVerificar||0});
   }catch(e){issues.push(historyIssue(source,e))}
 }
 return {version:'migracion-v3',ok:issues.length===0,
   validas:accepted.length,rechazadas:issues.length,aceptadas:accepted,
   incidencias:issues.slice(0,30),consultaProveedor:false};
}
async function writeHistory(storage,items,env){
 if(!Array.isArray(items)||items.length<1||items.length>HISTORY_MAX_ITEMS)
   throw new Error('Cantidad inválida de fuentes para almacenar.');
 const results=[],issues=[];
 const seen=new Set();
 for(const source of items){
   try{
     const item=normalizeHistoryItem(source,env);
     const key=historyKey(item.tipo,item.fecha);
     if(seen.has(key))throw new Error('Origen y fecha repetidos en el mismo lote');
     seen.add(key);
     const result=await storage.transaction(async tx=>{
       const previous=await tx.get(key);
       const next=combine(previous,item);
       if(JSON.stringify(next).length>MAX_TEXT)
         throw new Error('Límite de almacenamiento diario superado (1,8 MB).');
       if(JSON.stringify(next)!==JSON.stringify(previous))await tx.put(key,next);
       return {tipo:item.tipo,fecha:item.fecha,
         muestras:item.tipo==='S'?next.payload.rows.length:next.rows.length,
         completo:item.tipo==='S'?next.payload.meta.completo:true,
         pendientesPotencia:item.tipo==='S'?0:(next.controlPotencia?.muestrasSinVerificar||0),
         pendientesEnergia:item.tipo==='S'?0:(next.controlPotencia?.energiaSinVerificar||0)};
     });
     results.push(result);
   }catch(e){issues.push(historyIssue(source,e))}
 }
 return {version:'migracion-v3',ok:issues.length===0,
   guardadas:results.length,rechazadas:issues.length,
   incidencias:issues.slice(0,30),fuentes:results,
   pendientesPotencia:results.reduce((n,r)=>n+(r.pendientesPotencia||0),0),
   pendientesEnergia:results.reduce((n,r)=>n+(r.pendientesEnergia||0),0),
   consultaProveedor:false};
}

async function readHistory(storage,desde,hasta){
 if(!dateOK(desde)||!dateOK(hasta)||desde>hasta)throw new Error('Rango de fechas inválido.');
 const total=(Date.parse(hasta+'T00:00:00Z')-Date.parse(desde+'T00:00:00Z'))/864e5+1;
 if(total>HISTORY_MAX_DAYS)throw new Error('Solo se pueden leer hasta 31 días por consulta.');
 const fuentes=[];
 for(let epoch=Date.parse(desde+'T00:00:00Z');epoch<=Date.parse(hasta+'T00:00:00Z');epoch+=864e5){
   const date=new Date(epoch).toISOString().slice(0,10);
   for(const type of ['A','B','S']){
     const value=await storage.get(historyKey(type,date));
     if(value)fuentes.push(value);
   }
 }
 return{fuentes,meta:{desde,hasta,dias:total,guardadas:fuentes.length,fuente:'Gorraiz compartido',proveedorConsultado:false}};
}
async function historyStatus(storage){
 const prefix=HISTORY_PREFIX;
 const records=await storage.list({prefix,limit:5000});
 const out={A:[],B:[],S:[]};
 for(const key of records.keys()){
   const m=key.slice(prefix.length).match(/^([ABS]):(\d{4}-\d{2}-\d{2})$/);
   if(m&&dateOK(m[2]))out[m[1]].push(m[2]);
 }
 for(const type of ['A','B','S'])out[type].sort();
 return{ok:true,version:'migracion-v3',dias:out,cobertura:Object.fromEntries(Object.entries(out).map(([k,v])=>[k,{
   dias:v.length,desde:v[0]||null,hasta:v.at(-1)||null
 }])),proveedorConsultado:false};
}

// ═══════════════════════════════════════════════════════════════════════════
// Gorraiz Dashboard — proxy de datos (Cloudflare Worker)
//
// El dashboard es una página estática: desde el navegador NO se puede llamar
// ni a Datadis ni a Solarman (no mandan cabeceras CORS y exigen credenciales
// que quedarían a la vista en el HTML). Este Worker es la pieza mínima que
// guarda las credenciales y hace esas llamadas por su cuenta.
//
// Devuelve los datos ya normalizados con la MISMA forma que produce la carga
// de ficheros .xlsx, para que el resto del informe no se entere del cambio.
// ═══════════════════════════════════════════════════════════════════════════



const DATADIS='https://datadis.es';
// Solarman tiene varios centros de datos y el appId solo vale en el suyo:
// llamar al que no toca devuelve "appId or api is locked", que suena a
// problema de permisos y en realidad es de dominio. Se prueban por orden.
// ID de organización real de Gorraiz (Amixalan), comprobado en la PR #21.
// No es secreto ni credencial: el propio histórico de GitHub lo documenta.
// Sirve solo de respaldo si un rollback/despliegue pierde SOLARMAN_ORGID.
const GORRAIZ_ORGID='10865841';
const SOLARMAN_BASES=['https://globalapi.solarmanpv.com','https://api.solarmanpv.com'];

// ── utilidades ───────────────────────────────────────────────────────────
// no-store: sin esto, el navegador puede quedarse con una respuesta vieja y
// hacer creer que un cambio de configuración no ha surtido efecto.
const json=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,
  headers:{'content-type':'application/json;charset=utf-8','cache-control':'no-store',...h}});
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
const dUTC=s=>new Date(s+'T00:00:00Z');

function cors(env,req){
  const org=req.headers.get('Origin');
  // Sin cabecera Origin no es una llamada de navegador (curl, wrangler dev):
  // CORS no pinta nada ahí y la clave de panel sigue siendo obligatoria.
  if(!org)return{ok:true,h:{}};
  const permitidos=(env.ALLOWED_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
  const ok=permitidos.includes(org);
  return{ok:ok,h:{
    'Access-Control-Allow-Origin':ok?org:'null',
    'Access-Control-Allow-Headers':'content-type,x-panel-key',
    'Access-Control-Allow-Methods':'POST,GET,OPTIONS',
    'Access-Control-Max-Age':'86400',
    'Vary':'Origin',
  }};
}

// Con 123,84 kWp y ~142.000 kWh/año de producción, una media horaria de
// cientos de kWh no es plausible: casi seguro que los valores vienen en Wh.
// Se avisa en lugar de corregir a ciegas; el ajuste va por IDE_FACTOR.
function revisaUnidades(filas){
  if(!filas.length)return null;
  const total=filas.reduce((a,f)=>a+f.consumo,0),media=total/filas.length;
  return{totalKWh:Math.round(total),mediaHoraria:+media.toFixed(2),
    aviso:media>500?'La media horaria es de '+Math.round(media)+' kWh, desproporcionada para esta instalación: lo más probable es que el portal sirva Wh. Configura IDE_FACTOR=0.001 y repite.':null};
}

// Al pegar credenciales en el panel es fácil arrastrar un espacio, y el error
// que provoca no se parece en nada a su causa: Solarman, por ejemplo, responde
// "appId or api is locked", que suena a permisos. Se recortan siempre. Una
// credencial con espacios al principio o al final a propósito no existe, y si
// existiera el fallo sería visible (login rechazado), no silencioso.
const cred=v=>typeof v==='string'?v.trim():v;

// Huella de una credencial: lo justo para cotejarla sin revelarla. Un valor a
// medias o con espacios produce errores que no se parecen a su causa.
function huella(v){
  if(!v)return null;
  const n=v.length;
  return{longitud:n,empieza:v.slice(0,2),acaba:v.slice(-2),limpio:v===v.trim()};
}

// Reintento con espera creciente: Datadis va lento y corta si se le aprieta.
async function pedir(url,opt={},intentos=3){
  let ultimo;
  for(let i=0;i<intentos;i++){
    try{
      const r=await fetch(url,opt);
      if(r.status===429||r.status>=500){ultimo=new Error('HTTP '+r.status+' en '+new URL(url).pathname)}
      else return r;
    }catch(e){ultimo=e}
    await new Promise(s=>setTimeout(s,1000*Math.pow(2,i)));
  }
  throw ultimo;
}

// ── DATADIS ──────────────────────────────────────────────────────────────
// Autenticación: NIF + contraseña de la cuenta de datadis.es. Devuelve el JWT
// en texto plano, no en JSON.
async function datadisToken(env){
  const body=new URLSearchParams({username:cred(env.DATADIS_USER),password:cred(env.DATADIS_PASS)});
  const r=await pedir(DATADIS+'/nikola-auth/tokens/login',{method:'POST',body,
    headers:{'content-type':'application/x-www-form-urlencoded'}});
  if(!r.ok)throw new Error('Datadis: login rechazado (HTTP '+r.status+'). Revisa DATADIS_USER (NIF) y DATADIS_PASS.');
  const t=(await r.text()).trim();
  if(!t||t.length<20)throw new Error('Datadis: el login no devolvió token.');
  return t;
}

// Si el CUPS no es de la propia cuenta sino de un tercero que te ha
// autorizado (el caso normal cuando la instaladora consulta a su cliente),
// hay que mandar el NIF/CIF del titular en authorizedNif. Si el suministro es
// propio, el parámetro NO debe ir.
function autorizado(env){
  const n=(env.DATADIS_AUTHORIZED_NIF||'').trim();
  return n?{authorizedNif:n}:{};
}

async function datadisSuministro(env,tk){
  const q=new URLSearchParams(autorizado(env)).toString();
  const r=await pedir(DATADIS+'/api-private/api/get-supplies'+(q?'?'+q:''),{headers:{Authorization:'Bearer '+tk}});
  if(!r.ok)throw new Error('Datadis: no se pudo listar suministros (HTTP '+r.status+').');
  const lista=await r.json();
  if(!Array.isArray(lista)||!lista.length)throw new Error(env.DATADIS_AUTHORIZED_NIF
    ?('Datadis: no hay suministros autorizados para el NIF '+env.DATADIS_AUTHORIZED_NIF+'. ¿Ha aceptado el titular la autorización?')
    :'Datadis: la cuenta no tiene ningún suministro dado de alta. Si el CUPS es de un cliente, configura DATADIS_AUTHORIZED_NIF.');
  const cups=cred(env.DATADIS_CUPS);
  const s=cups?lista.find(x=>String(x.cups||'').toUpperCase().startsWith(cups.toUpperCase())):lista[0];
  if(!s)throw new Error('Datadis: el CUPS '+cups+' no está en esta cuenta. Disponibles: '+lista.map(x=>x.cups).join(', '));
  return s;
}

// Datadis pide el rango en meses (AAAA/MM) y sirve como mucho un mes por
// llamada: aquí está justo el motivo por el que el histórico llegaba partido.
function meses(desde,hasta){
  const out=[],d=dUTC(desde),f=dUTC(hasta);
  let y=d.getUTCFullYear(),m=d.getUTCMonth()+1;
  while(y<f.getUTCFullYear()||(y===f.getUTCFullYear()&&m<=f.getUTCMonth()+1)){
    out.push(y+'/'+pad(m));
    if(++m>12){m=1;y++}
  }
  return out;
}

async function datadisConsumo(env,desde,hasta){
  const tk=await datadisToken(env);
  const sup=await datadisSuministro(env,tk);
  const filas=[],fallos=[];
  for(const mes of meses(desde,hasta)){
    const q=new URLSearchParams(Object.assign({cups:sup.cups,distributorCode:sup.distributorCode,
      startDate:mes,endDate:mes,measurementType:'0',pointType:String(sup.pointType)},autorizado(env)));
    try{
      const r=await pedir(DATADIS+'/api-private/api/get-consumption-data?'+q,{headers:{Authorization:'Bearer '+tk}});
      if(!r.ok){fallos.push(mes+': HTTP '+r.status);continue}
      const datos=await r.json();
      if(!Array.isArray(datos))continue;
      for(const f of datos){
        // date 'AAAA/MM/DD' + time '01:00'..'24:00' (hora FINAL del tramo),
        // así que '01:00' es el tramo 00:00-01:00 -> índice horario 0.
        const p=String(f.date).split(/[\/\-]/).map(Number),y=p[0],m=p[1],d=p[2];
        let h=parseInt(String(f.time).slice(0,2),10)-1;
        if(!(y&&m&&d)||isNaN(h))continue;
        if(h<0)h=0;
        if(h>23)h=23;
        const dia=y+'-'+pad(m)+'-'+pad(d);
        if(dia<desde||dia>hasta)continue;
        filas.push({ts:dia+'T'+pad(h)+':00:00',consumo:+f.consumptionKWh||0,
          gen:+f.surplusEnergyKWh||0,periodo:periodo(y,m,d,h)});
      }
    }catch(e){fallos.push(mes+': '+e.message)}
  }
  filas.sort((a,b)=>a.ts<b.ts?-1:a.ts>b.ts?1:0);
  return{rows:filas,meta:{cups:sup.cups,distribuidora:sup.distributorCode,
    titular:env.DATADIS_AUTHORIZED_NIF||'propio',
    desde:desde,hasta:hasta,registros:filas.length,mesesConFallo:fallos}};
}

// ── i-DE (portal de clientes) ────────────────────────────────────────────
// Alternativa a Datadis cuando no se dispone de cuenta de organización: usa
// las mismas credenciales del área privada de i-DE. OJO: es una API interna
// del portal, no documentada ni soportada. Funciona, pero puede cambiar sin
// aviso; Datadis es la vía estable.
const IDE='https://www.i-de.es/consumidores/rest';
const IDE_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IDE_CAB={'content-type':'application/json; charset=utf-8',
  'esVersionNueva':'1','idioma':'es','movilAPP':'si','tipoAPP':'ios',
  'Accept':'application/json, text/plain, */*','Accept-Language':'es-ES,es;q=0.9',
  'Origin':'https://www.i-de.es','Referer':'https://www.i-de.es/consumidores/web/guest/login',
  'User-Agent':IDE_UA};

// El fetch de Workers no gestiona cookies: hay que recogerlas del login y
// reenviarlas a mano en cada llamada posterior.
function galleta(r){
  const set=typeof r.headers.getSetCookie==='function'?r.headers.getSetCookie()
    :(r.headers.get('set-cookie')?[r.headers.get('set-cookie')]:[]);
  return set.map(c=>c.split(';')[0]).join('; ');
}
const ideCab=ck=>Object.assign({},IDE_CAB,ck?{cookie:ck}:{});

async function ideLogin(env){
  // Visita previa a la página de login para recoger cookies antes del POST: el
  // portal responde 503 a peticiones que llegan "en frío", sin haber pasado
  // por la web. Si esta visita falla, se intenta el login igualmente.
  let previa='';
  try{
    const w=await pedir('https://www.i-de.es/consumidores/web/guest/login',
      {headers:{'User-Agent':IDE_UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'es-ES,es;q=0.9'}},2);
    previa=galleta(w);
  }catch(e){}
  let r;
  try{
    r=await pedir(IDE+'/loginNew/login/',{method:'POST',headers:ideCab(previa),
      body:JSON.stringify([cred(env.IDE_USER),cred(env.IDE_PASS),'','Android 6.0','Móvil','Chrome 119.0.0.0','0','','s',''])});
  }catch(e){
    // pedir() reintenta los 5xx y acaba lanzando su error genérico, así que el
    // caso interesante hay que explicarlo aquí y no comprobando r.status.
    if(String(e.message).includes('503'))
      throw new Error('i-DE responde 503 al login tras varios intentos. Si el portal te funciona en el navegador, está rechazando la petición por venir de un servidor, y esta vía no sirve: hay que ir por Datadis.');
    throw e;
  }
  if(!r.ok)throw new Error('i-DE: el login devolvió HTTP '+r.status+'.');
  const j=await r.json().catch(()=>({}));
  if(String(j.success)!=='true')
    throw new Error('i-DE: login rechazado'+(j.message?(' ('+j.message+')'):'')+'. Revisa IDE_USER e IDE_PASS.');
  const ck=galleta(r)||previa;
  if(!ck)throw new Error('i-DE: el login no devolvió cookie de sesión.');
  return ck;
}

// El portal trabaja sobre "el contrato seleccionado", así que si la cuenta
// tiene varios hay que elegir el de Gorraiz antes de pedir consumos.
async function ideContratos(env,ck){
  const r=await pedir(IDE+'/cto/listaCtos/',{headers:ideCab(ck)});
  const j=await r.json().catch(()=>({}));
  const lista=Array.isArray(j)?j:(j.contratos||j.lista||[]);
  if(!lista.length)throw new Error('i-DE: la cuenta no devuelve ningún contrato.');
  return lista;
}
async function ideSelecciona(env,ck){
  const lista=await ideContratos(env,ck);
  let i=0;
  if(env.IDE_CUPS){
    const busca=env.IDE_CUPS.toUpperCase();
    // El nombre del campo del CUPS varía según versión del portal, así que se
    // busca por valor en lugar de fiarlo a una clave concreta.
    i=lista.findIndex(c=>Object.values(c).some(v=>String(v).toUpperCase().includes(busca)));
    if(i<0)throw new Error('i-DE: el CUPS '+env.IDE_CUPS+' no está entre los '+lista.length+' contratos de la cuenta.');
  }
  if(lista.length>1){
    const r=await pedir(IDE+'/cto/seleccion/'+i,{headers:ideCab(ck)});
    if(!r.ok)throw new Error('i-DE: no se pudo seleccionar el contrato (HTTP '+r.status+').');
  }
  return{indice:i,contrato:lista[i],total:lista.length};
}

// Cambios de hora: el último domingo de marzo tiene 23 horas y el de octubre
// 25. Sin esto, el reparto de valores por día se desplazaría a partir de ahí.
function ultimoDomingo(y,m){
  const d=new Date(Date.UTC(y,m,0));
  d.setUTCDate(d.getUTCDate()-d.getUTCDay());
  return d.getUTCDate();
}
function horasDelDia(y,m,d){
  if(m===3&&d===ultimoDomingo(y,3))return [0,1,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
  if(m===10&&d===ultimoDomingo(y,10))return [0,1,2,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
  return Array.from({length:24},(_,h)=>h);
}

async function ideConsumo(env,desde,hasta){
  const factor=+(env.IDE_FACTOR||1)||1;
  const ck=await ideLogin(env);
  const sel=await ideSelecciona(env,ck);
  const fmt=d=>pad(d.getUTCDate())+'-'+pad(d.getUTCMonth()+1)+'-'+d.getUTCFullYear();
  const filas=[],fallos=[];
  // Se pide mes a mes para no depender de cuánto rango acepta el portal de una
  // vez y para acotar el efecto de un tramo que venga mal.
  for(const mes of meses(desde,hasta)){
    const p=mes.split('/'),y=+p[0],m=+p[1];
    const ini=new Date(Date.UTC(y,m-1,1)),fin=new Date(Date.UTC(y,m,0));
    try{
      const r=await pedir(IDE+'/consumoNew/obtenerDatosConsumoDH/'+fmt(ini)+'/'+fmt(fin)+'/horas/USU/',{headers:ideCab(ck)});
      if(!r.ok){fallos.push(mes+': HTTP '+r.status);continue}
      const j=await r.json().catch(()=>null);
      const d0=Array.isArray(j)?j[0]:j;
      const vals=d0&&d0.valores;
      if(!Array.isArray(vals)||!vals.length){fallos.push(mes+': sin valores');continue}
      // fechaDesde manda sobre lo pedido: el portal puede recortar el rango.
      const fd=String(d0.fechaDesde||'').split('-');
      let dia=fd.length===3?+fd[0]:1,mm=fd.length===3?+fd[1]:m,yy=fd.length===3?+fd[2]:y;
      let i=0;
      while(i<vals.length){
        const horas=horasDelDia(yy,mm,dia);
        for(const h of horas){
          if(i>=vals.length)break;
          const v=vals[i++];
          let kwh=v&&typeof v==='object'?+v.valor:+v;
          if(isNaN(kwh))continue;
          kwh*=factor;
          const f=yy+'-'+pad(mm)+'-'+pad(dia);
          if(f<desde||f>hasta)continue;
          filas.push({ts:f+'T'+pad(h)+':00:00',consumo:kwh,gen:0,periodo:periodo(yy,mm,dia,h)});
        }
        const ultimo=new Date(Date.UTC(yy,mm,0)).getUTCDate();
        if(++dia>ultimo){dia=1;if(++mm>12){mm=1;yy++}}
      }
    }catch(e){fallos.push(mes+': '+e.message)}
  }
  filas.sort((a,b)=>a.ts<b.ts?-1:a.ts>b.ts?1:0);
  const u=revisaUnidades(filas);
  return{rows:filas,meta:Object.assign({fuente:'i-DE (portal)',contrato:sel.indice+1+' de '+sel.total,
    desde:desde,hasta:hasta,registros:filas.length,mesesConFallo:fallos,factor:factor},u||{})};
}

// Solarman sella en UTC (comprobado: collectTime marcaba 05:04 UTC mientras el
// reloj del inversor decía 07:05, las dos horas de Madrid en agosto). El
// consumo se emite en hora local sin zona, así que la producción se pasa
// también a hora peninsular: si no, abrir el informe desde otro huso
// desplazaría una serie y la otra no.
let fmtMadrid=null;
try{
  fmtMadrid=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',
    year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}catch(e){}
function horaLocal(d){
  if(!fmtMadrid)return d.toISOString();
  return fmtMadrid.format(d).replace(' ','T');
}

// ── SOLARMAN ─────────────────────────────────────────────────────────────
// Requiere appId/appSecret (se piden a customerservice@solarmanpv.com).
async function sha256(txt){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function smPost(env,ruta,cuerpo,tk,base){
  const r=await pedir((base||SOLARMAN_BASES[0])+ruta,{method:'POST',
    headers:Object.assign({'content-type':'application/json'},tk?{Authorization:'Bearer '+tk}:{}),
    body:JSON.stringify(cuerpo)});
  const j=await r.json().catch(()=>({}));
  if(j.success===false)throw new Error('Solarman '+ruta+': '+(j.msg||j.code||'error'));
  return j;
}

// Tres modalidades de login permitidas por la API oficial de SOLARMAN.
// Nunca probar automáticamente identidades alternativas: sería insistir con
// credenciales reales y podría bloquear la cuenta.
const SOLARMAN_LOGIN_FIELDS=Object.freeze({
  email:'SOLARMAN_EMAIL',username:'SOLARMAN_USERNAME',mobile:'SOLARMAN_MOBILE',
});
function smLoginType(env){
  return String(cred(env.SOLARMAN_LOGIN_TYPE)||'email').trim().toLowerCase();
}
function smLoginIdentity(env){
  const tipo=smLoginType(env),variable=SOLARMAN_LOGIN_FIELDS[tipo];
  if(!variable)throw new Error('Solarman: SOLARMAN_LOGIN_TYPE debe ser email, username o mobile.');
  const value=cred(env[variable]);
  if(!value)throw new Error('Solarman: falta '+variable+' en Settings → Variables and Secrets.');
  if(tipo==='email'&&!value.includes('@'))
    throw new Error('Solarman: SOLARMAN_EMAIL no parece un correo electrónico. Si la cuenta entra por nombre de usuario, configura SOLARMAN_LOGIN_TYPE=username y SOLARMAN_USERNAME.');
  if(tipo==='mobile'){
    const code=String(cred(env.SOLARMAN_COUNTRY_CODE)||'').replace(/^\+/,'');
    if(!/^\d{1,4}$/.test(code)||!/^\d{5,20}$/.test(value))
      throw new Error('Solarman: para mobile configura SOLARMAN_COUNTRY_CODE (p. ej. 34) y SOLARMAN_MOBILE solo con dígitos.');
    return {tipo,variable,fields:{mobile:value,countryCode:code}};
  }
  return {tipo,variable,fields:{[tipo]:value}};
}
async function smToken(env,orgForzado){
  const bases=env.SOLARMAN_BASE?[env.SOLARMAN_BASE]:SOLARMAN_BASES;
  // El token de organización exige orgId; el tipo de identificador es
  // independiente (email, username o mobile según el alta de la cuenta).
  const identity=smLoginIdentity(env);
  const pass=cred(env.SOLARMAN_PASS),secret=cred(env.SOLARMAN_APPSECRET);
  if(!pass||!secret)throw new Error('Solarman: faltan SOLARMAN_PASS o SOLARMAN_APPSECRET.');
  const datos={appSecret:secret,...identity.fields,password:await sha256(pass)};
  const org=orgForzado!==undefined&&orgForzado!==null?String(orgForzado):cred(env.SOLARMAN_ORGID);
  if(org)datos.orgId=isNaN(+org)?org:+org;
  const cuerpo=JSON.stringify(datos);
  const fallos=[];
  for(const base of bases){
    const r=await pedir(base+'/account/v1.0/token?appId='+encodeURIComponent(cred(env.SOLARMAN_APPID))+'&language=en',
      {method:'POST',headers:{'content-type':'application/json'},body:cuerpo});
    const j=await r.json().catch(()=>({}));
    if(j.access_token)return{tk:j.access_token,base:base};
    fallos.push(new URL(base).hostname+': '+(j.msg||j.error||('HTTP '+r.status)));
  }
  // Según SOLARMAN, 'auth failed' es ambiguo: método de login, cuenta,
  // contraseña, APPID/APPSECRET, ORGID y centro de datos pueden influir.
  // No afirmar que el APPID sea válido solo porque un centro dice 'auth failed'.
  const auth=fallos.some(f=>/auth failed|AUTH_INVALID_USERNAME_OR_PASSWORD/i.test(f));
  const locked=fallos.some(f=>/locked|AUTH_INVALID_APPID/i.test(f));
  const tipo=identity.tipo;
  const pista=auth
    ? ' Se ha usado el identificador '+tipo+(org?' y un orgId configurado.':', sin orgId.')+
      ' Comprueba que la cuenta accede realmente mediante '+tipo+
      ', la contraseña ORIGINAL sin SHA-256 previo, SOLARMAN_APPSECRET y el orgId correspondiente.'+
      ' El mensaje auth failed no prueba por sí solo que el APPID esté validado.'
    : locked
      ? ' Comprueba el centro del APPID (internacional suele ser globalapi) y su activación con SOLARMAN.'
      : ' Revisa método de login, centro de datos y credenciales sin publicarlas.';
  throw new Error('Solarman: login rechazado. '+fallos.join(' · ')+pista);
}
// En Solarman las plantas de una empresa cuelgan de la ORGANIZACIÓN, no de la
// persona: el token personal ve cero plantas aunque el login sea correcto. Con
// orgId se pide un token de organización, que sí las ve. Esto busca las
// organizaciones de la cuenta para no tener que averiguar el número a mano.
async function smOrganizaciones(env,tk,base){
  const j=await smPost(env,'/account/v1.0/info?language=en',{},tk,base).catch(()=>({}));
  // El nombre de la lista y el del identificador varían entre versiones: la
  // real devuelve orgInfoList con companyId, no una clave llamada 'id'.
  const busca=o=>{
    for(const v of Object.values(o||{})){
      if(Array.isArray(v)&&v.length&&v[0]&&typeof v[0]==='object'&&orgId(v[0])!=null)return v;
      if(v&&typeof v==='object'&&!Array.isArray(v)){const r=busca(v);if(r)return r}
    }
    return null;
  };
  return{orgs:busca(j)||[],crudo:j};
}
const orgId=o=>o.companyId!=null?o.companyId:(o.orgId!=null?o.orgId:(o.id!=null?o.id:null));
const orgNombre=o=>o.companyName||o.orgName||o.name||'sin nombre';
const listaPlantas=l=>l.stationList||l.list||(l.data&&(l.data.stationList||l.data.list))||[];

// Compatibilidad comprobada en Gorraiz (PR #21, agosto de 2026):
// 1. token PERSONAL sin orgId; 2. consultar plantas; 3. descubrir companyId
// en orgInfoList; 4. pedir token de la organización si no hay plantas.
// Un SOLARMAN_ORGID configurado es una pista/fallback, no debe suprimir el
// primer login personal que en Gorraiz sí había funcionado.
// Solo se prueba la misma identidad configurada, como máximo en dos modos;
// nunca se adivinan correos, contraseñas, organizaciones ni centros nuevos.
async function smSesion(env){
  const orgConfigurado=cred(env.SOLARMAN_ORGID);
  const fija=orgConfigurado||GORRAIZ_ORGID;
  let personal;
  try{
    // Pasar '' fuerza omitir orgId incluso cuando existe SOLARMAN_ORGID.
    personal=await smToken(env,'');
  }catch(sinOrg){
    // Algunas cuentas Business exigen el token directo de organización.
    try{
      const org=await smToken(env,fija);
      return{...org,org:{id:fija,
        nombre:orgConfigurado?'organización configurada':'Amixalan (Gorraiz)',
        automatico:!orgConfigurado}};
    }catch(conOrg){
      throw new Error('Solarman: han fallado los dos modos de login (personal sin orgId y organización con orgId). '
        +'Personal: '+sinOrg.message+' · Organización: '+conOrg.message);
    }
  }

  let plantas;
  try{
    const l=await smPost(env,'/station/v1.0/list',{page:1,size:20},personal.tk,personal.base);
    plantas=listaPlantas(l);
  }catch(e){
    // El token personal puede ser válido pero no tener permiso para listar plantas.
    try{
      const org=await smToken(env,fija);
      return{...org,org:{id:fija,nombre:'organización configurada',automatico:false}};
    }catch(conOrg){
      throw new Error('Solarman: token personal aceptado, pero no puede listar plantas; '
        +'el token de organización con orgId también falló. '+conOrg.message);
    }
  }
  if(plantas.length)return personal;

  // Mismo descubrimiento que permitió encontrar Amixalan en agosto.
  const o=await smOrganizaciones(env,personal.tk,personal.base);
  if(orgConfigurado){
    const elegida=o.orgs.find(x=>String(orgId(x))===String(fija));
    if(o.orgs.length&&!elegida)
      throw new Error('Solarman: SOLARMAN_ORGID no coincide con ninguna organización de la cuenta. '
        +'Organizaciones disponibles: '+o.orgs.map(x=>orgNombre(x)+' (orgId '+orgId(x)+')').join(' · '));
    const org=await smToken(env,fija);
    return{...org,org:{id:elegida?orgId(elegida):fija,
      nombre:elegida?orgNombre(elegida):'organización configurada',automatico:false}};
  }
  if(o.orgs.length===1){
    const elegida=o.orgs[0];
    const org=await smToken(env,orgId(elegida));
    return{...org,org:{id:orgId(elegida),nombre:orgNombre(elegida),automatico:true}};
  }
  if(o.orgs.length>1)throw new Error('Solarman: el token personal no ve ninguna planta y la cuenta pertenece a '
    +o.orgs.length+' organizaciones: '+o.orgs.map(x=>orgNombre(x)+' (orgId '+orgId(x)+')').join(' · ')
    +'. Configura SOLARMAN_ORGID con la que tenga la planta.');
  throw new Error('Solarman: el token no ve ninguna planta y no se le encuentra ninguna organización, '
    +'así que la planta debe de estar bajo otra cuenta o compartida en lugar de propia. '
    +'Respuesta de /account/v1.0/info: '+JSON.stringify(o.crudo).slice(0,300));
}

async function smInversores(env,tk,base){
  let sid=cred(env.SOLARMAN_STATION_ID);
  if(!sid){
    const l=await smPost(env,'/station/v1.0/list',{page:1,size:20},tk,base);
    // El nombre de la lista ha cambiado entre versiones de su API, así que se
    // aceptan las variantes conocidas antes de darla por vacía.
    const lista=listaPlantas(l);
    if(!lista.length)throw new Error('Solarman: la organización no tiene plantas. '
      +'Respuesta de /station/v1.0/list: '+JSON.stringify(l).slice(0,250));
    sid=lista[0].id;
  }
  const d=await smPost(env,'/station/v1.0/device?language=en',{stationId:+sid,deviceType:'INVERTER'},tk,base);
  const disp=d.deviceListItems||d.list||(d.data&&(d.data.deviceListItems||d.data.list))||[];
  let inv=disp.map(x=>({sn:x.deviceSn,id:x.deviceId}));
  if(!inv.length)throw new Error('Solarman: la planta '+sid+' no declara inversores. '
    +'Respuesta de /station/v1.0/device: '+JSON.stringify(d).slice(0,400));
  // Sin esto, A y B dependen del orden en que Solarman devuelva los equipos:
  // un orden que es suyo, puede cambiar, y no tiene por qué coincidir con el
  // que se usa en el informe. Con los números de serie configurados, la
  // asignación es explícita.
  const snA=cred(env.SOLARMAN_INV_A),snB=cred(env.SOLARMAN_INV_B);
  let porSerie=false;
  if(snA||snB){
    const busca=sn=>sn?inv.find(x=>String(x.sn).toUpperCase().endsWith(sn.toUpperCase())):null;
    const a=busca(snA),b=busca(snB);
    if(a||b){
      const resto=inv.filter(x=>x!==a&&x!==b);
      inv=[a||resto.shift(),b||resto.shift()].filter(Boolean).concat(resto);
      porSerie=true;
    }
  }
  return{stationId:sid,inv:inv,porSerie:porSerie};
}
// Campos de los KSTAR G50KT, comprobados contra la respuesta real:
//   APo_t1   Total AC Output Power (Active)
//   Et_ge0   Cumulative Production (Active)
//   Etdy_ge1 Daily Production (Active)
// Se busca primero por clave exacta y solo después por nombre. Buscar por
// nombre a secas es peligroso: la misma respuesta trae "Total Production Hour"
// (horas, no kWh) y "Active Power Setting Value" (un ajuste, no una potencia),
// que casaban con los patrones y habrían pasado por buenos sin quejarse.
function smValor(lista,claves,nombres){
  const cs=claves.map(k=>k.toLowerCase()),ns=(nombres||[]).map(n=>n.toLowerCase());
  const num=it=>it.value===undefined||it.value===null||it.value===''?null:(isNaN(+it.value)?null:+it.value);
  for(const it of lista||[]){
    if(cs.includes(String(it.key||'').toLowerCase())){const v=num(it);if(v!==null)return v}
  }
  for(const it of lista||[]){
    const n=String(it.name||'').toLowerCase();
    if(ns.some(x=>n===x||n.startsWith(x+' ('))){const v=num(it);if(v!==null)return v}
  }
  return 0;
}
// APo_t1 (Total AC Output Power, Active) está publicado en W en
// SOLARMAN. Conservar explícitamente la unidad al normalizar; las tarjetas
// del SCADA, los simuladores y el histórico central trabajan en kW.
// Si el proveedor declara kW para otro firmware, respetar esa unidad.
// No inferir una potencia cero por ausencia de una lectura.
function smPotenciaKw(lista){
  const l=Array.isArray(lista)?lista:[];
  const campo=l.find(it=>String(it.key||'').toLowerCase()==='apo_t1')||
    l.find(it=>/^total ac output power(?: \(active\))?$/i.test(String(it.name||'')));
  if(!campo||campo.value===null||campo.value===undefined||campo.value==='')return null;
  const valor=Number(campo.value);
  if(!Number.isFinite(valor))return null;
  const unidad=String(campo.unit||'W').replace(/\s/g,'').toUpperCase();
  if(unidad==='KW')return valor;
  if(unidad==='W')return valor/1000;
  return null;
}
// Solarman solo sirve un día por llamada, así que un rango son muchas. En fila
// el Worker acaba tardando tanto que la conexión se corta y el navegador
// devuelve un escueto "Failed to fetch"; en tandas paralelas va sobrado. La
// tanda se mantiene pequeña para no castigar su API ni acercarse al tope de
// subpeticiones por invocación.
const TANDA=6;
async function enTandas(items,n,fn){
  const out=[];
  for(let i=0;i<items.length;i+=n)out.push(...await Promise.all(items.slice(i,i+n).map(fn)));
  return out;
}

async function smHistorico(env,tk,sn,desde,hasta,base){
  const dias=[];
  for(let d=dUTC(desde);d<=dUTC(hasta);d=new Date(d.getTime()+864e5))dias.push(ymd(d));
  // timeType 1 = por tramos dentro del día; el rango debe ser un solo día.
  // Cada día devuelve una lista de tramos, así que hay que aplanar: sin esto
  // queda una lista de listas y no se lee ningún tramo.
  const porDia=(await enTandas(dias,TANDA,dia=>
    smPost(env,'/device/v1.0/historical?language=en',
      {deviceSn:sn,startTime:dia,endTime:dia,timeType:1},tk,base)
      .then(j=>j.paramDataList||[]).catch(()=>[]))).flat();
  const out=[];
  for(const fr of porDia){
    const l=fr.dataList||[];
    if(!fr.collectTime)continue;
    out.push({ts:horaLocal(new Date(+fr.collectTime*1000)),
      pot:smPotenciaKw(l),potUnit:'kW',
      acum:smValor(l,['Et_ge0'],['cumulative production','cumulative production (active)']),
      dia:smValor(l,['Etdy_ge1'],['daily production','daily production (active)'])});
  }
  return out;
}
async function solarmanProduccion(env,desde,hasta){
  // Aviso claro antes de intentarlo: por encima de esto el Worker se pasa de
  // subpeticiones. El dashboard ya trocea, esto es la red de seguridad.
  const nd=Math.round((dUTC(hasta)-dUTC(desde))/864e5)+1;
  if(nd>20)throw new Error('El rango pedido son '+nd+' días y el máximo por llamada son 20: '
    +'pídelo en tramos más cortos.');
  const a=await smSesion(env);
  const r=await smInversores(env,a.tk,a.base);
  const res={meta:{stationId:r.stationId,inversores:r.inv.map(i=>i.sn),
    asignacion:r.porSerie?'por número de serie configurado':'por el orden que devuelve Solarman',
    centro:new URL(a.base).hostname,organizacion:a.org||null}};
  for(let i=0;i<r.inv.length&&i<2;i++){
    res[i===0?'A':'B']=await smHistorico(env,a.tk,r.inv[i].sn,desde,hasta,a.base);
  }
  return res;
}
// Sin credenciales no se pueden comprobar los nombres reales de los campos:
// esto devuelve un tramo en crudo para poder mapearlos con certeza el 1er día.
// Reparto mañana/tarde de un día: en una cubierta Este-Oeste, el inversor
// orientado al Este produce más antes del mediodía y el del Oeste después.
// Es la forma de saber cuál es cuál sin fiarse de etiquetas ni del orden.
function perfilDia(filas){
  let manana=0,tarde=0,total=0;
  filas.forEach(f=>{
    const h=+f.ts.slice(11,13);
    if(h<14)manana+=f.pot;else tarde+=f.pot;
    total=Math.max(total,f.dia);
  });
  const sum=manana+tarde||1;
  return{diaKWh:+total.toFixed(1),
    manana:Math.round(manana/sum*100)+'%',tarde:Math.round(tarde/sum*100)+'%',
    orientacion:manana>tarde*1.15?'apunta al Este':(tarde>manana*1.15?'apunta al Oeste':'sin sesgo claro')};
}

async function solarmanDiagnostico(env,dia){
  const a=await smSesion(env);
  const orgs=(await smOrganizaciones(env,a.tk,a.base)).orgs
    .map(x=>({id:orgId(x),nombre:orgNombre(x)}));
  const r=await smInversores(env,a.tk,a.base);
  // Un día de cada inversor, para poder compararlos entre sí.
  const perfiles=await Promise.all(r.inv.slice(0,2).map(async(i,n)=>{
    const filas=await smHistorico(env,a.tk,i.sn,dia,dia,a.base);
    return Object.assign({letra:n===0?'A':'B',sn:i.sn,tramos:filas.length},perfilDia(filas));
  }));
  const j=await smPost(env,'/device/v1.0/historical?language=en',
    {deviceSn:r.inv[0].sn,startTime:dia,endTime:dia,timeType:1},a.tk,a.base);
  const fr=(j.paramDataList||[])[0]||{};
  return{centro:new URL(a.base).hostname,organizaciones:orgs,orgUsada:a.org||cred(env.SOLARMAN_ORGID)||null,
    planta:r.stationId,inversores:r.inv.map(i=>i.sn),
    asignacion:r.porSerie?'por número de serie configurado':'por el orden que devuelve Solarman',
    perfiles:perfiles,
    deviceSn:r.inv[0].sn,collectTime:fr.collectTime,
    campos:(fr.dataList||[]).map(x=>({key:x.key,name:x.name,value:x.value}))};
}

// ── ALMACÉN COMPARTIDO ───────────────────────────────────────────────────
// Solo el consumo. La producción no se guarda: Solarman ya es su archivo y
// cualquiera puede traérsela con el botón, así que duplicarla sería mantener
// dos verdades. Cuando Datadis esté dado de alta, esto pasará a ser una
// comodidad en vez de una necesidad.
const CLAVE_DATOS='consumo';
const TOPE=20*1024*1024;   // KV admite 25 MB por valor; se deja margen

async function leeDatos(env){
  if(!env.DATOS)return null;
  return (await env.DATOS.get(CLAVE_DATOS,'json'))||{fuentes:[],actualizado:null};
}
async function escribeDatos(env,cuerpo){
  if(!env.DATOS)throw new Error('No hay almacén configurado en el Worker.');
  const fuentes=Array.isArray(cuerpo&&cuerpo.fuentes)?cuerpo.fuentes:null;
  if(!fuentes)throw new Error('Se esperaba una lista de fuentes.');
  const guardar={fuentes:fuentes,actualizado:cuerpo.actualizado||null,por:cuerpo.por||null};
  const txt=JSON.stringify(guardar);
  if(txt.length>TOPE)throw new Error('Los datos ocupan '+Math.round(txt.length/1048576)
    +' MB y el máximo son 20. Reduce el rango guardado.');
  await env.DATOS.put(CLAVE_DATOS,txt);
  return{ok:true,fuentes:fuentes.length,
    registros:fuentes.reduce((n,f)=>n+((f.rows&&f.rows.length)||0),0),bytes:txt.length};
}

// ── Presupuesto Solarman compartido ─────────────────────────────────────
// Una sola instancia Durable Object centraliza TODOS los accesos nuevos a
// Solarman: tanto /produccion (informe/SCADA) como /solarman/diagnostico.
// Cloudflare KV no sirve como candado por consistencia eventual. DO SQLite
// garantiza reserva atómica y persistente, también desde otros navegadores.
// Una operación /produccion hace varias peticiones HTTP al proveedor.
// El límite es UN LOTE/hora, no 1 petición HTTP upstream.
const SOLARMAN_HORA_MS=60*60*1000;
const SOLARMAN_PRESUPUESTO='solarman:ultima_reserva';
const SOLARMAN_ULTIMO_LOTE='solarman:ultimo_lote';
const SOLARMAN_CACHE_MAX=1_800_000; // SQLite DO limita un valor a ~2 MB.
const validoDia=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)
  &&!Number.isNaN(Date.parse(s+'T00:00:00Z'))
  &&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
export class SolarmanQuota {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async fetch(req){
    if(req.method!=='POST')return json({error:'Método no admitido.'},405);
    const b=await req.json().catch(()=>({}));
    const tipo=b.tipo,desde=b.desde,hasta=b.hasta,dia=b.dia;
    // La consulta y la copia compartida NO consumen presupuesto Solarman.
    // La misma instancia DO con SQLite conserva el orden entre clientes.
    if(tipo==='historico_datos'||tipo==='historico_guardar'||
       tipo==='historico_estado'||tipo==='historico_validar'){
      try{
        if(tipo==='historico_estado')return json(await historyStatus(this.ctx.storage));
        if(tipo==='historico_validar')return json(validateHistory(b.items,this.env));
        if(tipo==='historico_datos')return json(await readHistory(this.ctx.storage,desde,hasta));
        return json(await writeHistory(this.ctx.storage,b.items,this.env));
      }catch(e){
        return json({error:e.message||'No se pudo usar el histórico compartido.'},400);
      }
    }
    if(tipo==='produccion'){
      if(!validoDia(desde)||!validoDia(hasta)||desde>hasta ||
         (Date.parse(hasta+'T00:00:00Z')-Date.parse(desde+'T00:00:00Z'))/864e5>19)
        return json({error:'Rango Solarman inválido o superior a 20 días.'},400);
    }else if(tipo==='diagnostico'){
      if(!validoDia(dia))return json({error:'Día de diagnóstico inválido.'},400);
    }else return json({error:'Operación Solarman desconocida.'},400);
    const solicitud=tipo==='produccion'?
      tipo+'|'+desde+'|'+hasta:tipo+'|'+dia;
    const now=Date.now();
    let decision;
    try{
      decision=await this.ctx.storage.transaction(async tx=>{
        const last=await tx.get(SOLARMAN_PRESUPUESTO);
        const cache=await tx.get(SOLARMAN_ULTIMO_LOTE);
        if(cache&&cache.solicitud===solicitud&&Number.isFinite(cache.at)
           &&now>=cache.at&&now-cache.at<SOLARMAN_HORA_MS)
          return{cache:cache.valor};
        if(typeof last==='number'&&Number.isFinite(last)&&now<last+SOLARMAN_HORA_MS)
          return{retry:Math.max(1,Math.ceil((last+SOLARMAN_HORA_MS-now)/1000))};
        if(last!==undefined&&last!==null&&(!Number.isFinite(last)||last<0))
          return{error:'Estado persistente del presupuesto ilegible; consulta denegada.'};
        await tx.put(SOLARMAN_PRESUPUESTO,now); // Antes de llamar a Solarman.
        return{reserved:true};
      });
    }catch{
      return json({error:'No se puede reservar el presupuesto central de Solarman; consulta bloqueada.'},503);
    }
    if(decision.error)return json({error:decision.error},503);
    if(decision.cache!==undefined)
      return json(decision.cache,200,{'X-Solarman-Cuota':'cache-compartida'});
    if(decision.retry)
      return json({error:'Cupo Solarman agotado: una adquisición nueva cada 60 minutos como máximo.',
        retryAfterSeconds:decision.retry},429,{'Retry-After':String(decision.retry)});
    try{
      const valor=tipo==='produccion'?
        await solarmanProduccion(this.env,desde,hasta):
        await solarmanDiagnostico(this.env,dia);
      // Cada adquisición de producción se guarda una sola vez y la comparten
      // informe/SCADA. No implica nuevas llamadas a Solarman.
      if(tipo==='produccion'){
        const items=[];
        for(const kind of ['A','B']){
          const days=new Map();
          for(const row of Array.isArray(valor[kind])?valor[kind]:[]){
            const date=typeof row.ts==='string'?row.ts.slice(0,10):'';
            if(!/^\d{4}-\d{2}-\d{2}$/.test(date))continue;
            if(!days.has(date))days.set(date,[]);
            days.get(date).push(row);
          }
          for(const [fecha,rows] of days)items.push({tipo:kind,fecha,rows,unidadPotencia:'kW'});
        }
        if(items.length){
          try{
            const stored=await writeHistory(this.ctx.storage,items,this.env);
            valor.meta={...(valor.meta||{}),compartido:{guardadas:stored.guardadas,ok:true}};
          }catch{
            valor.meta={...(valor.meta||{}),compartido:{ok:false,
              aviso:'La producción se ha descargado, pero no se ha podido guardar en el histórico compartido.'}};
          }
        }
      }
      const serialized=JSON.stringify(valor);
      // Se cachea únicamente el último lote: sin crecimiento ilimitado.
      if(serialized.length<=SOLARMAN_CACHE_MAX){
        try{await this.ctx.storage.put(SOLARMAN_ULTIMO_LOTE,{solicitud,at:now,valor});}
        catch{/* Fallar al guardar caché NO libera el presupuesto. */}
      }
      return json(valor,200,{'X-Solarman-Cuota':'origen'});
    }catch(e){
      // Fallar una llamada NO revierte la reserva ni habilita reintentos.
      return json({error:e.message||'Falló una adquisición Solarman.'},502);
    }
  }
}
async function solarmanConCuota(env,operacion,headers){
  if(!env.SOLARMAN_QUOTA)
    return json({error:'Sin coordinador central SOLARMAN_QUOTA. Por seguridad no se consulta Solarman.'},503,headers);
  const stub=env.SOLARMAN_QUOTA.get(env.SOLARMAN_QUOTA.idFromName('gorraiz-solarman-global-v1'));
  const upstream=await stub.fetch('https://presupuesto-solarman.internal/solarman',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(operacion)});
  const respuesta=await upstream.json().catch(()=>({error:'Respuesta ilegible del coordinador Solarman'}));
  const h={...headers};
  const retry=upstream.headers.get('Retry-After'),cache=upstream.headers.get('X-Solarman-Cuota');
  if(retry)h['Retry-After']=retry;
  if(cache)h['X-Solarman-Cuota']=cache;
  return json(respuesta,upstream.status,h);
}

// ── enrutado ─────────────────────────────────────────────────────────────
export default{
  async fetch(req,env){
    const c=cors(env,req),h=c.h;
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:h});
    if(!c.ok)
      return json({error:'Origen no autorizado. Revisa ALLOWED_ORIGIN en el Worker.'},403,h);
    // Distinguir los dos casos ahorra mucho tiempo: si PANEL_KEY no llega, lo
    // habitual es haberla puesto en las variables de *compilación* (Settings →
    // Build) en lugar de en las de ejecución (Settings → Variables and Secrets).
    const url=new URL(req.url);
    const ruta=url.pathname.replace(/\/+$/,'');
    // El estado y los diagnósticos admiten la clave por parámetro y método GET,
    // para poder abrirlos desde la barra del navegador y comprobar la
    // configuración sin herramientas. Solo ellos: /consumo y /produccion
    // siguen exigiendo la cabecera, para no repartir la clave en direcciones
    // que quedan en el historial y en los registros.
    const abrible=ruta==='/estado'||ruta==='/ide/diagnostico'||ruta==='/solarman/diagnostico';
    const clave=req.headers.get('X-Panel-Key')||(abrible?(url.searchParams.get('k')||''):'');

    if(!env.PANEL_KEY)
      return json({error:'El Worker no tiene PANEL_KEY configurada. Compruébalo en Settings → Variables and Secrets (las de ejecución, no las de Build).',
        pistas:{ALLOWED_ORIGIN:env.ALLOWED_ORIGIN||null,IDE_USER:!!env.IDE_USER,IDE_PASS:!!env.IDE_PASS,DATADIS_USER:!!env.DATADIS_USER}},401,h);
    if(clave.trim()!==String(env.PANEL_KEY).trim())
      return json({error:'La clave de panel no coincide con la PANEL_KEY del Worker.'},401,h);

    try{
      // SPC solo consulta equipos. Sus rutas nunca admiten la clave de panel
      // en la URL; el diagnóstico es POST, igual que la descarga de un día.
      if((ruta==='/spc/intercambio'||ruta==='/spc/diagnostico')&&req.method!=='POST')
        return json({error:'Esta consulta SPC requiere POST.'},405,{...h,Allow:'POST'});
      if(ruta==='/spc/datos'&&!['GET','POST'].includes(req.method))
        return json({error:'La consulta del almacén SPC requiere GET o POST.'},405,{...h,Allow:'GET, POST'});
      if(ruta==='/estado'){
        const tipo=smLoginType(env),variable=SOLARMAN_LOGIN_FIELDS[tipo];
        const sm=['SOLARMAN_APPID','SOLARMAN_APPSECRET','SOLARMAN_PASS',
          ...(variable?[variable]:['SOLARMAN_LOGIN_TYPE']),
          ...(tipo==='mobile'?['SOLARMAN_COUNTRY_CODE']:[])];
        const faltan=sm.filter(k=>!env[k]);
        return json({
          datadis:!!(env.DATADIS_USER&&env.DATADIS_PASS),
          datadisAutorizado:!!env.DATADIS_AUTHORIZED_NIF,
          ide:!!(env.IDE_USER&&env.IDE_PASS),
          solarman:!faltan.length,
          // Decir cuáles faltan ahorra adivinar: en Cloudflare, añadir un
          // secreto crea una versión que puede quedarse sin desplegar.
          solarmanFaltan:faltan,
          solarmanLoginType:tipo,
          solarmanLoginVariable:variable||null,
          solarmanLoginConfigurado:!!(variable&&env[variable]),
          solarmanPasswordPareceHashPrevio:typeof env.SOLARMAN_PASS==='string'&&/^[a-f0-9]{64}$/i.test(env.SOLARMAN_PASS.trim()),
          // Huella del appId para poder cotejarlo con el que dio Solarman sin
          // exponerlo entero: un espacio o un carácter de más al pegarlo da el
          // mismo error que un appId bloqueado.
          solarmanAppId:huella(env.SOLARMAN_APPID),
          solarmanAppSecret:huella(env.SOLARMAN_APPSECRET),
          solarmanEmail:huella(env.SOLARMAN_EMAIL),
          solarmanPass:huella(env.SOLARMAN_PASS),
          solarmanOrgId:env.SOLARMAN_ORGID||null,
          solarmanOrgIdEfectivo:cred(env.SOLARMAN_ORGID)||GORRAIZ_ORGID,
          solarmanOrgIdOrigen:cred(env.SOLARMAN_ORGID)?'configurado':'respaldo-gorraiz',
          solarmanInvA:env.SOLARMAN_INV_A||null,
          solarmanInvB:env.SOLARMAN_INV_B||null,
          almacen:!!env.DATOS,
          ...await spcEstado(env),
        },200,h);
      }

      const b=req.method==='POST'?await req.json().catch(()=>({}))
        :Object.fromEntries(url.searchParams);
      const desde=b.desde,hasta=b.hasta;
      if(ruta==='/historico/estado'||ruta==='/historico/datos'||
         ruta==='/historico/guardar'||ruta==='/historico/validar'){
        const onlyState=ruta==='/historico/estado';
        if(!onlyState&&req.method!=='POST')return json({error:'Se requiere POST para esta operación.'},405,h);
        if(onlyState&&req.method!=='GET')return json({error:'Se requiere GET para el estado.'},405,h);
        return solarmanConCuota(env,onlyState?{tipo:'historico_estado'}:
          ruta==='/historico/datos'?{tipo:'historico_datos',desde,hasta}:
            ruta==='/historico/validar'?{tipo:'historico_validar',items:b.items}:
            {tipo:'historico_guardar',items:b.items},h);
      }
      if(ruta==='/spc/intercambio')return json(await spcIntercambio(env,desde,hasta),200,h);
      if(ruta==='/spc/diagnostico')return json(await spcDiagnostico(env,b.dia),200,h);
      if(ruta==='/spc/datos')return json(await spcDatos(env,desde,hasta),200,h);
      if(ruta==='/consumo'||ruta==='/produccion'){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(desde||'')||!/^\d{4}-\d{2}-\d{2}$/.test(hasta||''))
          return json({error:'Faltan las fechas (desde/hasta en formato AAAA-MM-DD).'},400,h);
        if(desde>hasta)return json({error:'La fecha inicial es posterior a la final.'},400,h);
      }
      if(ruta==='/datos'){
        if(!env.DATOS)return json({error:'No hay almacén configurado: falta el enlace KV llamado DATOS en el Worker.'},501,h);
        if(req.method==='POST')return json(await escribeDatos(env,b),200,h);
        return json(await leeDatos(env),200,h);
      }
      if(ruta==='/consumo'){
        // Datadis manda si está configurado (es la vía oficial y estable);
        // i-DE queda como alternativa cuando no hay cuenta de organización.
        const fuente=b.fuente||(env.DATADIS_USER?'datadis':(env.IDE_USER?'ide':''));
        if(fuente==='datadis'){
          if(!env.DATADIS_USER)return json({error:'Datadis no está configurado en el Worker.'},501,h);
          return json(await datadisConsumo(env,desde,hasta),200,h);
        }
        if(fuente==='ide'){
          if(!env.IDE_USER)return json({error:'i-DE no está configurado en el Worker.'},501,h);
          return json(await ideConsumo(env,desde,hasta),200,h);
        }
        return json({error:'No hay ninguna fuente de consumo configurada (ni Datadis ni i-DE).'},501,h);
      }
      if(ruta==='/ide/diagnostico'){
        if(!env.IDE_USER)return json({error:'i-DE no está configurado.'},501,h);
        const ck=await ideLogin(env);
        const contratos=await ideContratos(env,ck);
        const res={contratos:contratos};
        // Un día en crudo: es lo que permite ver de una vez el nombre de los
        // campos, la forma de 'valores' y la magnitud real de las cifras.
        if(b.dia&&/^\d{4}-\d{2}-\d{2}$/.test(b.dia)){
          await ideSelecciona(env,ck);
          const p=b.dia.split('-'),f=p[2]+'-'+p[1]+'-'+p[0];
          const r=await pedir(IDE+'/consumoNew/obtenerDatosConsumoDH/'+f+'/'+f+'/horas/USU/',{headers:ideCab(ck)});
          const j=await r.json().catch(()=>null);
          const d0=Array.isArray(j)?j[0]:j;
          res.dia={http:r.status,claves:d0?Object.keys(d0):null,fechaDesde:d0&&d0.fechaDesde,
            nValores:d0&&d0.valores?d0.valores.length:0,
            primeros:d0&&d0.valores?d0.valores.slice(0,5):null};
        }
        return json(res,200,h);
      }
      if(ruta==='/produccion'){
        if(req.method!=='POST')return json({error:'Producción Solarman requiere POST.'},405,h);
        if(!env.SOLARMAN_APPID)return json({error:'Solarman aún no está configurado: faltan appId y appSecret.'},501,h);
        return solarmanConCuota(env,{tipo:'produccion',desde,hasta},h);
      }
      if(ruta==='/solarman/diagnostico'){
        if(!env.SOLARMAN_APPID)return json({error:'Solarman aún no está configurado.'},501,h);
        return solarmanConCuota(env,{tipo:'diagnostico',dia:b.dia||ymd(new Date(Date.now()-864e5))},h);
      }
      return json({error:'Ruta desconocida.'},404,h);
    }catch(e){
      if(ruta.startsWith('/spc/')){
        const safe=safeSpcError(e);
        return json({error:safe.message,code:safe.code},safe.status,h);
      }
      return json({error:e.message||String(e)},502,h);
    }
  },
  async scheduled(event,env,ctx){
    // Sin SPC_SYNC_ENABLED=true no se consulta ni se escribe nada. El horario
    // se activa por separado en Cloudflare; se lee únicamente ayer en Madrid.
    const work=spcScheduled(env,{now:()=>event?.scheduledTime??Date.now()});
    if(ctx&&typeof ctx.waitUntil==='function'){ctx.waitUntil(work);return;}
    return work;
  },
};
