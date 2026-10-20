// Prueba aislada de lectura SPC. No contiene credenciales ni rutas de control.
// Para copiar este Worker en Cloudflare, usar kstar-prueba-bundle.js generado.
import {spcDiagnostico, safeSpcError} from './spc.js';

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

function output(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: {...HEADERS, 'content-type': 'application/json; charset=utf-8'}});
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
    if (path !== '/comprobar' && path !== '/sondeo') return output({error: 'Ruta no disponible.'}, 404);
    if (req.method !== 'POST') return output({error: 'Se requiere POST.'}, 405);
    if (!env.KSTAR_TEST_KEY || String(env.KSTAR_TEST_KEY).length < 24)
      return output({error: 'Configura KSTAR_TEST_KEY como secreto de al menos 24 caracteres.'}, 503);
    if (!await equalSecret(req.headers.get('X-KSTAR-Test-Key'), env.KSTAR_TEST_KEY))
      return output({error: 'Clave de prueba incorrecta.'}, 401);
    if (path === '/sondeo') return output(await probeNetwork());
    if (env.SPC_TRANSPORT !== 'http' || env.SPC_HTTP_RISK_ACK !== 'I_ACCEPT_UNENCRYPTED_CREDENTIALS')
      return output({error: 'La prueba HTTP no está habilitada. Revisa ambas variables de aceptación.'}, 501);
    if (!env.SPC_USER || !env.SPC_PASS || !env.SPC_STATION_ID)
      return output({error: 'Faltan SPC_USER, SPC_PASS o SPC_STATION_ID en el Worker.'}, 501);
    let text;
    try { text = await req.text(); }
    catch { return output({error: 'Cuerpo de consulta no disponible.'}, 400); }
    if (text.length > 200) return output({error: 'Consulta demasiado larga.'}, 413);
    let body;
    try { body = JSON.parse(text); }
    catch { return output({error: 'Formato de consulta incorrecto.'}, 400); }
    if (!validPastDate(body?.dia)) return output({error: 'Selecciona un día cerrado válido.'}, 400);
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
