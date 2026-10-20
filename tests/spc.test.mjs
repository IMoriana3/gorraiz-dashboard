import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SPC_FIELDS, SPC_LIMITS, createSpcClient, normaliseSpcRow, normaliseSpcDaily,
  safeSpcError, spcDatos, spcDiagnostico, spcEstado, spcIntercambio,
  spcScheduled, validateSpcRange,
} from '../worker/spc.js';
import worker from '../worker/index.js';

// Todos los identificadores, usuarios, claves, tokens y datos son ficticios.
// Las consultas SPC siempre reciben un fetch simulado. No se contacta al portal.
const DAY = '2026-10-19';
const NOW = Date.parse('2026-10-20T10:00:00Z');
const ENV = {
  SPC_USER: 'example-only@example.invalid',
  SPC_PASS: 'fictional-password-for-tests',
  SPC_STATION_ID: 'STATION_TEST',
  SPC_TIMEZONE: 'Europe/Madrid',
  PANEL_KEY: 'fictional-panel-key',
  ALLOWED_ORIGIN: 'https://dashboard.example.invalid',
};
const DATA_KEY = 'spc:v1:STATION_TEST:' + DAY;
const STATUS_KEY = 'spc:v1:STATION_TEST:estado';
const PATHS = {
  login: '/api/authentication/form',
  meters: '/api/station/monitor/detail/meter/list',
  history: '/api/meter/monitor/detail/history/data',
  daily: '/api/station/monitor/detail/self',
};

class FakeKV {
  constructor() {
    this.data = new Map([['consumo', JSON.stringify({fuentes: [{nombre: 'fixture existente'}]})]]);
  }
  async get(key, type) {
    const value = this.data.get(key);
    return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.data.set(key, value); }
}

function sampleRow(index = 0, date = DAY) {
  return {
    saveTime: new Date(Date.parse(date + 'T00:00:00Z') + index * 60000)
      .toISOString().replace('T', ' ').replace('.000Z', ''),
    positiveActiveElec: String(100 + index),
    reverseActiveElec: index === 0 ? null : String(20 + index),
    totalActivePower: index === 0 ? 0 : 1000,
    currentRatio: 40,
    ignored: 'Este campo del proveedor no forma parte del contrato.',
  };
}

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: {'content-type': 'application/json'},
});

function fixture({
  rows = [sampleRow(), sampleRow(1)],
  daily = {positiveElec: 2, reverseElec: 3, selfConsumption: 4},
  meters = [{deviceId: 'METER_TEST', stationId: ENV.SPC_STATION_ID}],
  override,
  protocol = 'https:',
} = {}) {
  const calls = [];
  let logins = 0;
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    calls.push({url: parsed, init});
    assert.equal(parsed.protocol, protocol);
    assert.equal(parsed.hostname, 'spc.ksdatacloud.com');
    assert.ok(Object.values(PATHS).includes(parsed.pathname), 'Solo rutas de lectura conocidas');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    if (override) {
      const result = await override(parsed, init, calls);
      if (result) return result;
    }
    if (parsed.pathname === PATHS.login) {
      logins++;
      assert.equal(init.method, 'POST');
      assert.equal(parsed.searchParams.get('username'), ENV.SPC_USER);
      assert.equal(parsed.searchParams.get('password'), ENV.SPC_PASS);
      assert.equal(parsed.searchParams.get('langType'), 'en');
      assert.equal(init.headers.Authorization, 'Basic ' + btoa('kstar:kstarSecret'));
      return jsonResponse({token: {access_token: 'fictional-token-' + logins, expires_in: 3600}});
    }
    assert.match(init.headers.Authorization, /^Bearer fictional-token-/);
    assert.equal(init.headers.language, 'en');
    assert.match(init.headers.client_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(parsed.searchParams.has('password'), false);
    if (parsed.pathname === PATHS.meters) {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        pageNumber: 1, pageSize: 100, stationId: ENV.SPC_STATION_ID,
        collectId: '', orderField: '', orderDirection: '',
      });
      return jsonResponse({code: 200, rows: meters, total: meters.length});
    }
    if (parsed.pathname === PATHS.history) {
      assert.equal(init.method, 'GET');
      assert.equal(parsed.searchParams.get('pageSize'), '100');
      const page = Number(parsed.searchParams.get('pageNumber'));
      return jsonResponse({code: 200, rows: rows.slice((page - 1) * 100, page * 100), total: rows.length});
    }
    assert.equal(init.method, 'GET');
    assert.equal(parsed.searchParams.get('stationId'), ENV.SPC_STATION_ID);
    return jsonResponse({code: 200, data: daily});
  };
  return {
    calls, fetch, options: {fetch, now: () => NOW, sessionCache: new Map()},
    get logins() { return logins; },
  };
}

const hasCode = code => error => error.code === code;
function assertSanitised(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [ENV.SPC_USER, ENV.SPC_PASS, 'fictional-token-', 'username=', 'password=']) {
    assert.equal(text.includes(forbidden), false, 'No expone ' + forbidden);
  }
}


test('SPC bloquea HTTP salvo doble activación explícita y conserva HTTPS por defecto', async () => {
  const missingAck = {...ENV, SPC_TRANSPORT: 'http'};
  let attempts = 0;
  const noNetwork = () => { attempts++; throw new Error('Network should not be called'); };
  assert.throws(() => createSpcClient(missingAck, {fetch: noNetwork}),
    e => e.code === 'SPC_HTTP_LOCKED' && e.status === 403);
  assert.equal(attempts, 0);
  const noAccess = await spcEstado(missingAck);
  assert.equal(noAccess.spc, false);
  assert.match(noAccess.spcConfigError, /HTTP sin cifrar/);
  assertSanitised(noAccess);
  assert.throws(() => createSpcClient({...ENV, SPC_TRANSPORT: 'http', SPC_HTTP_RISK_ACK: 'yes'}, {fetch: noNetwork}),
    e => e.code === 'SPC_HTTP_LOCKED');
  assert.equal(attempts, 0);

  const enabledHttp = {...ENV, SPC_TRANSPORT: 'http',
    SPC_HTTP_RISK_ACK: 'I_ACCEPT_UNENCRYPTED_CREDENTIALS'};
  const f = fixture({protocol: 'http:'});
  const day = await createSpcClient(enabledHttp, f.options).readDay(DAY);
  assert.equal(day.meta.transport, 'http');
  assert.equal(day.meta.unencryptedTransport, true);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(c => c.url.protocol === 'http:'));
  assert.equal(f.calls[0].url.hostname, 'spc.ksdatacloud.com');
  const state = await spcEstado(enabledHttp);
  assert.equal(state.spc, true);
  assert.equal(state.spcTransport, 'http');
  assert.equal(state.spcUnencryptedTransport, true);
  assertSanitised(state);

  const fSecure = fixture();
  const secure = await createSpcClient(ENV, fSecure.options).readDay(DAY);
  assert.equal(secure.meta.unencryptedTransport, false);
  assert.equal((await spcEstado(ENV)).spcUnencryptedTransport, false);
  assert.ok(fSecure.calls.every(c => c.url.protocol === 'https:'));
});

test('SPC modo HTTP rechaza redirecciones y sanea errores de red', async () => {
  const env = {...ENV, SPC_TRANSPORT: 'http',
    SPC_HTTP_RISK_ACK: 'I_ACCEPT_UNENCRYPTED_CREDENTIALS'};
  const f = fixture({protocol: 'http:', override: () => {
    throw new Error('URL HTTP con password=' + ENV.SPC_PASS);
  }});
  await assert.rejects(createSpcClient(env, f.options).readDay(DAY), e => {
    assert.equal(e.code, 'SPC_NETWORK');
    assertSanitised(safeSpcError(e));
    return true;
  });
  const redirect = fixture({protocol: 'http:', override: () =>
    new Response(null, {status: 302, headers: {location: 'https://other.example.invalid'}})});
  await assert.rejects(createSpcClient(env, redirect.options).readDay(DAY),
    e => e.code === 'SPC_REDIRECT');
  assert.equal(redirect.calls.length, 1);
});

test('SPC conserva crudos, nulos y ceros; no multiplica por CT; reutiliza sesión y aísla KV', async () => {
  const env = {...ENV, DATOS: new FakeKV()}, f = fixture();
  const oldConsumption = env.DATOS.data.get('consumo');
  const result = await spcIntercambio(env, DAY, DAY, f.options);
  assert.deepEqual(Object.keys(result.rows[0]), [...SPC_FIELDS]);
  assert.equal(result.rows[0].positiveActiveElec, 100);
  assert.equal(result.rows[0].reverseActiveElec, null);
  assert.equal(result.rows[0].totalActivePower, 0);
  assert.equal(result.rows[0].currentRatio, 40);
  assert.equal(result.rows[0].saveTime, sampleRow().saveTime);
  assert.deepEqual(result.daily, [{date: DAY, importKWh: 2, exportKWh: 3, selfConsumptionKWh: 4}]);
  assert.equal(result.meta.timezoneVerified, false);
  assert.equal(result.meta.coberturaHorariaVerificada, false);
  assert.deepEqual(result.meta.solicitado, {desde: DAY, hasta: DAY});
  assert.equal(result.meta.fetchedAt, new Date(NOW).toISOString());
  assert.equal(result.meta.completo, true);
  assert.equal(result.meta.persistido, true);
  await spcIntercambio(env, DAY, DAY, f.options);
  assert.equal(f.logins, 1);
  assert.equal(env.DATOS.data.get('consumo'), oldConsumption);
  assert.deepEqual([...env.DATOS.data.keys()].sort(), ['consumo', DATA_KEY, STATUS_KEY].sort());
  assertSanitised(result);
  assertSanitised([...env.DATOS.data.values()]);
  assert.equal((await spcEstado(env)).spcLastSuccess, new Date(NOW).toISOString());
});

test('SPC completa la paginación por total y no trunca al superar el límite', async () => {
  const f = fixture({rows: Array.from({length: 101}, (_, i) => sampleRow(i))});
  const result = await createSpcClient(ENV, f.options).readDay(DAY);
  assert.equal(result.rows.length, 101);
  assert.equal(result.meta.paginas, 2);
  assert.equal(f.calls.filter(c => c.url.pathname === PATHS.history).length, 2);
  const tooLarge = fixture({override: url => url.pathname === PATHS.history
    ? jsonResponse({rows: [sampleRow()], total: 2501}) : undefined});
  await assert.rejects(createSpcClient(ENV, tooLarge.options).readDay(DAY), hasCode('SPC_PAGE_LIMIT'));
});

test('SPC limita también los logins por TTL cero y no sustituye la caché por un histórico truncado', async () => {
  const env = {...ENV, DATOS: new FakeKV()}, good = fixture();
  await spcIntercambio(env, DAY, DAY, good.options);
  const before = env.DATOS.data.get(DATA_KEY);
  const shortSession = fixture({
    rows: Array.from({length: 2500}, (_, i) => sampleRow(i / 2)),
    override: url => url.pathname === PATHS.login
      ? jsonResponse({token: {access_token: 'fictional-token-short', expires_in: 0}})
      : undefined,
  });
  await assert.rejects(spcIntercambio(env, DAY, DAY, shortSession.options), hasCode('SPC_REQUEST_LIMIT'));
  assert.equal(SPC_LIMITS.maxRequests, 36);
  assert.equal(shortSession.calls.length, SPC_LIMITS.maxRequests);
  assert.ok(shortSession.calls.filter(c => c.url.pathname === PATHS.history).length < 25);
  assert.equal(shortSession.calls.some(c => c.url.pathname === PATHS.daily), false);
  assert.equal(env.DATOS.data.get(DATA_KEY), before);
  const state = await spcEstado(env);
  assert.equal(state.spcUltima.status, 'error');
  assert.equal(state.spcError.code, 'SPC_REQUEST_LIMIT');
  assert.equal(state.spcLastSuccess, new Date(NOW).toISOString());
  assertSanitised(state);
});

test('SPC rechaza páginas repetidas, vacías antes del total o con total cambiante', async () => {
  for (const problem of ['repeated', 'empty', 'changed']) {
    const f = fixture({override: url => {
      if (url.pathname !== PATHS.history) return;
      const page = Number(url.searchParams.get('pageNumber'));
      if (problem === 'empty') return jsonResponse({rows: [], total: 1});
      return jsonResponse({rows: [sampleRow()], total: problem === 'changed' && page === 2 ? 3 : 2});
    }});
    await assert.rejects(createSpcClient(ENV, f.options).readDay(DAY), hasCode('SPC_PAGINATION'), problem);
  }
});

test('SPC conserva la última copia completa cuando llega un día sin histórico con ceros medidos', async () => {
  const env = {...ENV, DATOS: new FakeKV()}, good = fixture();
  await spcIntercambio(env, DAY, DAY, good.options);
  const before = env.DATOS.data.get(DATA_KEY);
  const partial = fixture({rows: [], daily: {positiveElec: 0, reverseElec: 0, selfConsumption: 0}});
  const result = await spcIntercambio(env, DAY, DAY, partial.options);
  assert.equal(result.daily[0].importKWh, 0);
  assert.equal(result.daily[0].exportKWh, 0);
  assert.equal(result.meta.sinHistorico, true);
  assert.equal(result.meta.completo, false);
  assert.equal(result.meta.persistido, false);
  assert.equal(result.meta.cacheConservada, true);
  assert.equal(env.DATOS.data.get(DATA_KEY), before);
  const status = await spcEstado(env);
  assert.equal(status.spcUltima.status, 'partial');
  assert.equal(status.spcLastSuccess, new Date(NOW).toISOString());
});

test('SPC no declara medición válida un día vacío o con solo relación CT', async () => {
  for (const rows of [[], [{...sampleRow(), positiveActiveElec: null, reverseActiveElec: null, totalActivePower: null}]]) {
    const f = fixture({rows, daily: {positiveElec: null, reverseElec: '', selfConsumption: null}});
    await assert.rejects(createSpcClient(ENV, f.options).readDay(DAY), hasCode('SPC_EMPTY'));
  }
  assert.throws(() => normaliseSpcDaily({data: {}}, DAY), hasCode('SPC_SCHEMA'));
  assert.throws(() => normaliseSpcDaily({data: Object.create({positiveElec: 0})}, DAY), hasCode('SPC_SCHEMA'));
});

test('SPC conserva los negativos diarios como crudos, pero no marca completo ni un último éxito', async () => {
  for (const negativeField of ['positiveElec', 'reverseElec']) {
    const daily = {positiveElec: 2, reverseElec: 3, selfConsumption: 4, [negativeField]: '-1.25'};
    const field = negativeField === 'positiveElec' ? 'importKWh' : 'exportKWh';
    assert.equal(normaliseSpcDaily({data: daily}, DAY)[field], -1.25);
    const f = fixture({daily}), env = {...ENV, DATOS: new FakeKV()};
    const result = await spcIntercambio(env, DAY, DAY, f.options);
    assert.equal(result.daily[0][field], -1.25);
    assert.equal(result.meta.completo, false);
    assert.equal(result.meta.resumenDiarioCompleto, false);
    const state = await spcEstado(env);
    assert.equal(state.spcUltima.status, 'partial');
    assert.equal(state.spcLastSuccess, null);
  }
});

test('SPC separa el resumen diario completo del histórico ausente y no completa el día abierto', async () => {
  for (const [now, closed] of [[NOW, true], [Date.parse(DAY + 'T12:00:00Z'), false]]) {
    const env = {...ENV, DATOS: new FakeKV()};
    const f = fixture({rows: [], daily: {positiveElec: 0, reverseElec: 3, selfConsumption: null}});
    const options = {...f.options, now: () => now};
    const result = await spcIntercambio(env, DAY, DAY, options);
    assert.equal(result.meta.sinHistorico, true);
    assert.equal(result.meta.completo, false);
    assert.equal(result.meta.resumenDiarioCompleto, closed);
    assert.equal(result.meta.diaCerrado, closed);
    const cached = await spcDatos(env, DAY, DAY, options);
    assert.equal(cached.fuentes[0].meta.resumenDiarioCompleto, closed);
    assert.equal(cached.fuentes[0].meta.completo, false);
    assert.equal((await spcEstado(env)).spcLastSuccess, null);
  }
});

test('SPC un día abierto mantiene las lecturas, pero no se presenta como completo', async () => {
  const f = fixture();
  const result = await createSpcClient(ENV, {...f.options, now: () => Date.parse(DAY + 'T12:00:00Z')}).readDay(DAY);
  assert.equal(result.rows.length, 2);
  assert.equal(result.meta.diaCerrado, false);
  assert.equal(result.meta.completo, false);
  assert.equal(result.meta.resumenDiarioCompleto, false);
});

test('SPC un fallo HTTPS guarda un estado saneado y conserva los datos válidos', async () => {
  const env = {...ENV, DATOS: new FakeKV()}, good = fixture();
  await spcIntercambio(env, DAY, DAY, good.options);
  const before = env.DATOS.data.get(DATA_KEY);
  const bad = fixture({override: () => new Response(ENV.SPC_PASS, {status: 503})});
  await assert.rejects(spcIntercambio(env, DAY, DAY, bad.options), error => {
    assert.equal(error.code, 'SPC_HTTP');
    assert.match(error.message, /HTTPS/);
    assertSanitised(safeSpcError(error));
    return true;
  });
  assert.equal(env.DATOS.data.get(DATA_KEY), before);
  const status = await spcEstado(env);
  assert.equal(status.spcUltima.status, 'error');
  assert.equal(status.spcLastSuccess, new Date(NOW).toISOString());
  assertSanitised(status);
});

test('SPC no refleja la URL de autenticación si fetch falla', async () => {
  const f = fixture({override: url => { throw new Error('Network error: ' + url.toString()); }});
  await assert.rejects(createSpcClient(ENV, f.options).readDay(DAY), error => {
    assert.equal(error.code, 'SPC_NETWORK');
    assert.equal(error.status, 503);
    assertSanitised(safeSpcError(error));
    return true;
  });
  assertSanitised(safeSpcError(new Error(ENV.SPC_PASS)));
});

test('SPC rechaza HTML, JSON ilegible y errores de aplicación aunque HTTP sea 200', async () => {
  const cases = [
    [() => new Response('<html>' + ENV.SPC_PASS + '</html>', {headers: {'content-type': 'text/html'}}), 'SPC_NOT_JSON'],
    [() => new Response('{invalid', {headers: {'content-type': 'application/json'}}), 'SPC_NOT_JSON'],
    [() => jsonResponse({code: 666, message: ENV.SPC_PASS}), 'SPC_PROVIDER_ERROR'],
    [() => jsonResponse({success: false, message: ENV.SPC_PASS}), 'SPC_PROVIDER_ERROR'],
    [() => jsonResponse({error: ENV.SPC_PASS}), 'SPC_PROVIDER_ERROR'],
    [() => jsonResponse([]), 'SPC_SCHEMA'],
  ];
  for (const [response, code] of cases) {
    const f = fixture({override: response});
    await assert.rejects(createSpcClient(ENV, f.options).readDay(DAY), error => {
      assert.equal(error.code, code);
      assertSanitised(safeSpcError(error));
      return true;
    });
  }
});


test('SPC acepta 000000 real, importacion 658.92 y exportacion 0 con datos simulados', async () => {
  const f=fixture({override: url => url.pathname===PATHS.daily
    ? jsonResponse({code:'000000',success:true,data:{
      positiveElec:658.92,reverseElec:0,selfConsumption:74}})
    : undefined});
  const result=await createSpcClient(ENV,f.options).readDay(DAY);
  assert.deepEqual(result.daily,[{
    date:DAY,importKWh:658.92,exportKWh:0,selfConsumptionKWh:74}]);
  assert.equal(result.meta.completo,true);
  assert.equal(result.meta.coberturaHorariaVerificada,false);
});
test('SPC no acepta 000401 ni falsos exitos con 000000', async () => {
  const casos=[
    {code:'000401',success:true,data:{positiveElec:1}},
    {code:'000000',success:false,data:{positiveElec:1}},
    {code:'000000',success:true,error:'denied',data:{positiveElec:1}},
  ];
  for(const d of casos) {
    const f=fixture({override: url => url.pathname===PATHS.daily ? jsonResponse(d) : undefined});
    await assert.rejects(createSpcClient(ENV,f.options).readDay(DAY),e=>e.code==='SPC_PROVIDER_ERROR');
  }
});

for (const expired of [401, 10031, 10032]) {
  test('SPC renueva una sola vez la sesión caducada ' + expired, async () => {
    let attempts = 0;
    const f = fixture({override: url => {
      if (url.pathname !== PATHS.meters || attempts++ !== 0) return;
      return expired === 401 ? jsonResponse({}, 401) : jsonResponse({code: expired});
    }});
    const result = await createSpcClient(ENV, f.options).readDay(DAY);
    assert.equal(result.rows.length, 2);
    assert.equal(f.logins, 2);
    assert.equal(attempts, 2);
  });
}

test('SPC termina con error si la sesión renovada también falla, sin bucle', async () => {
  const f = fixture({override: url => url.pathname === PATHS.meters ? jsonResponse({code: 10031}) : undefined});
  await assert.rejects(createSpcClient(ENV, f.options).readDay(DAY), hasCode('SPC_AUTH'));
  assert.equal(f.logins, 2);
  assert.equal(f.calls.filter(c => c.url.pathname === PATHS.meters).length, 2);
});

test('SPC valida pertenencia y selección de medidor antes de leer su histórico', async () => {
  const cases = [
    [[], {}, 'SPC_NO_METER'],
    [[{deviceId: 'FOREIGN_METER', stationId: 'OTHER_STATION'}], {}, 'SPC_METER_MEMBERSHIP'],
    [[{deviceId: 'METER_A'}, {deviceId: 'METER_B'}], {}, 'SPC_MULTIPLE_METERS'],
    [[{deviceId: 'METER_A'}], {SPC_METER_ID: 'METER_B'}, 'SPC_METER_MEMBERSHIP'],
  ];
  for (const [meters, settings, code] of cases) {
    const f = fixture({meters});
    await assert.rejects(createSpcClient({...ENV, ...settings}, f.options).readDay(DAY), hasCode(code));
    assert.equal(f.calls.some(c => c.url.pathname === PATHS.history), false);
  }
  const chosen = fixture({meters: [{deviceId: 'METER_A'}, {deviceId: 'METER_B'}]});
  const result = await createSpcClient({...ENV, SPC_METER_ID: 'METER_B'}, chosen.options).readDay(DAY);
  assert.equal(result.meta.meterId, 'METER_B');
  assert.equal(result.meta.medidoresEstacion, 2);
  assert.equal(chosen.calls.find(c => c.url.pathname === PATHS.history).url.searchParams.get('deviceId'), 'METER_B');
});

test('SPC valida días reales y límites; conserva marcas literales y ausencias numéricas', () => {
  for (const [from, to, limit] of [
    ['2026-02-30', '2026-02-30', 1], [DAY, '2026-10-20', 1],
    ['2026-10-01', '2026-11-01', 31], [DAY + 'T00:00:00', DAY, 1],
  ]) assert.throws(() => validateSpcRange(from, to, limit), hasCode('SPC_RANGE'));
  assert.equal(validateSpcRange('2026-10-01', '2026-10-31', 31).length, 31);
  for (const time of ['2026-10-19 99:00:00', '2026-10-19T12:00:00+99:99']) {
    assert.throws(() => normaliseSpcRow({...sampleRow(), saveTime: time}), hasCode('SPC_SCHEMA'));
  }
  const literal = '2026-10-19T02:05:00+02:00';
  const row = normaliseSpcRow({...sampleRow(), saveTime: literal,
    positiveActiveElec: '', reverseActiveElec: false, totalActivePower: 'NaN', currentRatio: null});
  assert.deepEqual(row, {saveTime: literal, positiveActiveElec: null,
    reverseActiveElec: null, totalActivePower: null, currentRatio: null});
});

test('SPC la caché conserva procedencia diaria y distingue días ausentes o dañados', async () => {
  const env = {...ENV, DATOS: new FakeKV()}, f = fixture();
  await spcIntercambio(env, DAY, DAY, f.options);
  env.DATOS.data.set('spc:v1:STATION_TEST:2026-10-17', '{broken');
  const cached = await spcDatos({SPC_STATION_ID: ENV.SPC_STATION_ID, DATOS: env.DATOS}, '2026-10-17', DAY, f.options);
  assert.deepEqual(cached.meta.diasCache, [DAY]);
  assert.deepEqual(cached.meta.diasFaltan, ['2026-10-18']);
  assert.deepEqual(cached.meta.diasErrores, ['2026-10-17']);
  assert.equal(cached.meta.completo, false);
  assert.equal(cached.fuentes.length, 1);
  assert.equal(cached.fuentes[0].date, DAY);
  assert.deepEqual(cached.fuentes[0].rows, cached.rows);
  assert.equal(cached.fuentes[0].meta.fetchedAt, new Date(NOW).toISOString());
  const differentMeter = await spcDatos({...env, SPC_METER_ID: 'OTHER_METER'}, DAY, DAY, f.options);
  assert.deepEqual(differentMeter.meta.diasFaltan, [DAY]);
  assert.equal(differentMeter.rows.length, 0);
});

test('SPC los fallos de KV no borran ni invalidan una lectura válida', async () => {
  const env = {...ENV, DATOS: {get: async () => null, put: async () => { throw new Error(ENV.SPC_PASS); }}};
  const f = fixture();
  const result = await spcIntercambio(env, DAY, DAY, f.options);
  assert.equal(result.rows.length, 2);
  assert.equal(result.meta.persistido, false);
  assert.ok(result.meta.avisoCache);
  assert.ok(result.meta.avisoEstado);
  assertSanitised(result);
});

test('SPC diagnóstico devuelve campos y resumen seguro sin tokens ni filas crudas', async () => {
  const f = fixture();
  const diagnostic = await spcDiagnostico(ENV, DAY, f.options);
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.complete, true);
  assert.equal(diagnostic.registros, 2);
  assert.deepEqual(diagnostic.campos, [...SPC_FIELDS]);
  assert.equal(diagnostic.rows, undefined);
  assert.equal(diagnostic.persistido, false);
  assertSanitised(diagnostic);
});

test('SPC cron desactivado no hace nada; activado descarga ayer según Europe/Madrid', async () => {
  let forbiddenCalls = 0;
  const disabled = await spcScheduled({}, {fetch: () => { forbiddenCalls++; throw new Error('Network forbidden'); }});
  assert.deepEqual(disabled, {skipped: true, reason: 'disabled'});
  assert.equal(forbiddenCalls, 0);
  // 22:30 UTC ya es el día 20 en Madrid; ayer local es el 19.
  const env = {...ENV, DATOS: new FakeKV(), SPC_SYNC_ENABLED: 'true'}, f = fixture();
  const result = await spcScheduled(env, {...f.options, now: () => Date.parse('2026-10-19T22:30:00Z')});
  assert.equal(result.ok, true);
  assert.equal(result.date, DAY);
  assert.equal(result.complete, true);
  assert.equal((await spcEstado(env)).spcUltima.source, 'scheduled');
  assert.ok(f.calls.filter(c => [PATHS.history, PATHS.daily].includes(c.url.pathname))
    .every(c => c.url.searchParams.get('startTime') === DAY));
});

test('SPC las rutas exigen clave por header; estado configurado no implica autenticación verificada', async t => {
  const noNetwork = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network forbidden in route tests'); });
  const env = {...ENV, DATOS: new FakeKV()};
  const request = (path, {method = 'GET', body, header = true} = {}) => new Request(
    'https://worker.example.invalid' + path, {method,
      headers: {...(header ? {'X-Panel-Key': ENV.PANEL_KEY} : {}), 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  for (const route of ['/spc/diagnostico', '/spc/intercambio', '/spc/datos']) {
    const r = await worker.fetch(request(route + '?k=' + ENV.PANEL_KEY, {header: false}), env);
    assert.equal(r.status, 401);
  }
  assert.equal((await worker.fetch(request('/spc/diagnostico'), env)).status, 405);
  assert.equal((await worker.fetch(request('/spc/intercambio'), env)).status, 405);
  const stateResponse = await worker.fetch(request('/estado'), env);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.spc, true);
  assert.deepEqual(state.spcFaltan, []);
  assert.equal(state.spcLastSuccess, null);
  assert.equal(state.spcSync, false);
  assertSanitised(state);
  const cached = await worker.fetch(request('/spc/datos', {method: 'POST', body: {desde: DAY, hasta: DAY}}), env);
  assert.equal(cached.status, 200);
  assert.deepEqual((await cached.json()).meta.diasFaltan, [DAY]);
  const badRange = await worker.fetch(request('/spc/intercambio', {method: 'POST',
    body: {desde: DAY, hasta: '2026-10-20'}}), env);
  assert.equal(badRange.status, 400);
  assert.equal((await badRange.json()).code, 'SPC_RANGE');
  assert.equal(noNetwork.mock.callCount(), 0);
});
