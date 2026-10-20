# Worker de datos — Gorraiz Dashboard

Conexión del dashboard a Datadis, Solarman y SPC Cloud. Guarda las credenciales en Cloudflare y ofrece descarga por botón, caché compartida y sincronización SPC opcional.

**SPC:** una descarga real del 19/10/2026 fue validada en el Worker aislado KSTAR. El dashboard puede usar su ruta `POST /spc/intercambio` con origen restringido y una clave independiente; consulta la guía [KSTAR_PRUEBA.md](KSTAR_PRUEBA.md). No hay cron activo y el Worker principal se mantiene ajeno a los secretos de esa prueba. [Detalles generales SPC](SPC.md).

## Por qué hace falta

El dashboard es una página estática en GitHub Pages, y desde el navegador **no se puede** llamar ni a Datadis ni a Solarman:

- Ninguna de las dos manda cabeceras CORS: el navegador cancela la petición antes de que salga.
- Ambas exigen credenciales, y en una página pública cualquiera las leería con Ctrl+U.

Este Worker es la pieza más pequeña que resuelve las dos cosas: guarda las credenciales fuera del navegador y hace las llamadas por su cuenta. El dashboard sigue siendo estático.

## Qué expone

Todas las rutas exigen la cabecera `X-Panel-Key` y un `Origin` que figure en `ALLOWED_ORIGIN`.

| Ruta | Método | Cuerpo | Devuelve |
|---|---|---|---|
| `/estado` | GET | — | Qué integraciones están configuradas |
| `/consumo` | POST | `{desde, hasta}` en `AAAA-MM-DD` | `{rows:[{ts, consumo, gen, periodo}], meta}` |
| `/produccion` | POST | `{desde, hasta}` | `{A:[{ts, pot, acum, dia}], B:[…], meta}` |
| `/solarman/diagnostico` | POST | `{dia}` | Campos en crudo de un tramo, para mapear |
| `/ide/diagnostico` | POST | — | Lista de contratos en crudo del portal de i-DE |
| `/datos` | GET / POST | Fuentes de consumo al escribir | Histórico compartido de consumo |
| `/spc/diagnostico` | POST | `{dia}` | Prueba real y resumen seguro del día |
| `/spc/intercambio` | POST | `{desde, hasta}`; máximo un día | Histórico y balance diario del SPC |
| `/spc/datos` | POST | `{desde, hasta}`; máximo 31 días | Solo caché SPC, sin login |

En `/consumo`, `rows` tiene la forma de la lectura de un XLSX de i-DE. SPC conserva una estructura y almacenamiento propios: no se mezcla con el consumo horario ni sobrescribe la clave `consumo`.

## Despliegue

### Desde GitHub (lo que está montado)

El Worker se despliega conectando el repositorio en **Workers & Pages → Create application → Workers → Import a repository**. En **Settings → Build** debe quedar:

- **Root directory**: `worker` ← imprescindible
- **Build command**: vacío
- **Deploy command**: `npx wrangler deploy`
- **Production branch**: `main`

El *Root directory* de producción debe seguir siendo `worker`. La raíz del repositorio tiene ahora un `wrangler.toml` mínimo **solo para las vistas previas de las PR**, porque Cloudflare Builds puede ignorar ese directorio al compilar ramas ([incidencia pública #75](https://github.com/cloudflare/developer-platform/issues/75)). Ese fichero no monta el KV de producción ni incorpora credenciales; **no debe usarse para desplegar producción**. La configuración completa y única de producción es `worker/wrangler.toml`.

Cada `push` a `main` que toque esta carpeta redespliega solo.

**`keep_vars = true` conserva variables de texto añadidas desde el panel.** Los secretos se gestionan aparte. Las variables declaradas en `wrangler.toml` sí se aplican al desplegar: un cambio de `SPC_SYNC_ENABLED` debe conservarse también en ese fichero. [Referencia de configuración](https://developers.cloudflare.com/workers/wrangler/configuration/).

### Sin instalar nada (desde el navegador)

Si no tienes Node en el equipo, `bundle.js` es el Worker entero en un solo fichero, listo para pegar en el editor web de Cloudflare. En el panel de Cloudflare: **Workers & Pages → Create → Worker**, abre **Edit code**, borra lo que venga de ejemplo y pega el contenido de `bundle.js`. Luego, en **Settings → Variables and Secrets**, añade `ALLOWED_ORIGIN` como variable de texto y el resto como *Secret*.

`bundle.js` está generado: si tocas `index.js`, `periodos.js` o `spc.js`, regenéralo con `node construir.mjs` desde `worker/`.

### Con wrangler

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

Luego los secretos, uno a uno (`wrangler` los pide por teclado y nunca quedan en el repositorio):

```bash
npx wrangler secret put PANEL_KEY        # inventada por ti; es la que se teclea en el dashboard
npx wrangler secret put DATADIS_USER     # NIF del titular, el usuario de datadis.es
npx wrangler secret put DATADIS_PASS
npx wrangler secret put DATADIS_CUPS     # opcional: si la cuenta tiene un solo suministro, sobra
npx wrangler secret put DATADIS_AUTHORIZED_NIF   # SOLO si el CUPS es de un tercero; para Gorraiz NO
```

**Sobre `DATADIS_AUTHORIZED_NIF`:** cuando el suministro no es de la propia cuenta sino de un cliente que te ha autorizado — el caso normal cuando la instaladora consulta el edificio de su cliente — la API exige el NIF/CIF del titular en `authorizedNif`, tanto al listar suministros como al pedir consumos. Sin él, la cuenta no ve el CUPS y Datadis responde una lista vacía. Si el suministro es propio, este secreto no debe configurarse: el parámetro no puede viajar.

**El caso de Gorraiz no lo necesita:** el CUPS es de Amixalan y la cuenta de Datadis será de Amixalan, así que el suministro es propio. Este secreto queda para cuando haya que sacar el informe de un edificio de un tercero.

### Alternativa: i-DE en vez de Datadis

El alta en Datadis como organización exige certificado digital. Si no lo tienes a mano, el Worker puede tirar del portal de clientes de i-DE con las credenciales de siempre:

```bash
npx wrangler secret put IDE_USER
npx wrangler secret put IDE_PASS
npx wrangler secret put IDE_CUPS   # opcional: si la cuenta tiene un solo contrato, sobra
npx wrangler secret put IDE_FACTOR # opcional: 0.001 si el portal resulta servir Wh
```

**Antes de desplegar puedes probarlo en local** con `npx wrangler dev` y los secretos en un `.dev.vars` (no lo subas al repositorio). Las llamadas sin cabecera `Origin` —curl, wrangler dev— se aceptan si traen la clave de panel: CORS solo protege llamadas de navegador.

```bash
curl -s localhost:8787/consumo -H 'X-Panel-Key: TU_CLAVE' \
  -H 'content-type: application/json' -d '{"desde":"2025-06-01","hasta":"2025-06-30"}' | head -c 600
```

**Unidades.** No está confirmado si el portal sirve kWh o Wh. La respuesta incluye `meta.totalKWh` y `meta.mediaHoraria` para verlo de un vistazo, y si la media sale desproporcionada para esta instalación lo dice en `meta.aviso`. La corrección es `IDE_FACTOR=0.001`, sin tocar código.

Si están configuradas las dos fuentes manda Datadis, por ser la oficial. Se puede forzar una en concreto mandando `{"fuente":"ide"}` o `{"fuente":"datadis"}` en el cuerpo de `/consumo`.

**Probado y NO funciona desde Cloudflare (agosto 2026).** El portal responde `503` al login, con el mismo resultado tras añadir visita previa para recoger cookies y cabeceras completas de navegador (`Accept`, `Accept-Language`, `Origin`, `Referer`, User-Agent real). El portal funcionaba con normalidad desde un navegador en esos mismos momentos, así que el rechazo es por venir la petición de un centro de datos, no por cómo está formada.

Se deja el código porque puede servir desde otra red — un equipo en la oficina, por ejemplo — pero **no desde un Worker**. No merece la pena insistir imitando al navegador con más detalle: es una carrera que se pierde y deja el informe colgando de algo que se rompe sin aviso.

**Esto tampoco es una API pública.** Es la que usa por dentro el área privada del portal, la misma que emplean las integraciones de Home Assistant: no está documentada ni soportada y puede cambiar en cualquier momento. Datadis es la vía buena.

`/ide/diagnostico` vuelca la lista de contratos en crudo, útil si hay varios y hay que averiguar cuál es el de Gorraiz. Pasándole `{"dia":"AAAA-MM-DD"}` añade además un día de consumo sin procesar: claves devueltas, número de valores y los primeros, que es lo que permite ver de una vez la forma real y la magnitud de las cifras.

Los secretos utilizados por el flujo Solarman existente son:

```bash
npx wrangler secret put SOLARMAN_APPID
npx wrangler secret put SOLARMAN_APPSECRET
npx wrangler secret put SOLARMAN_EMAIL
npx wrangler secret put SOLARMAN_PASS       # en claro: el Worker le aplica SHA-256 al vuelo
npx wrangler secret put SOLARMAN_STATION_ID # opcional: si hay una sola planta, sobra
npx wrangler secret put SOLARMAN_ORGID      # SOLO si la cuenta es Business, no Smart
```

**El rango se trocea en el dashboard.** El límite de subpeticiones del plan gratuito es 50 por invocación. Cada día de producción necesita dos llamadas de inversor más las de sesión. El dashboard solicita producción en bloques de **10 días**, consumo en bloques de **600 días**, consulta SPC de **un día** y lectura de caché SPC de **31 días**. Si cambia el número de inversores, debe revisarse el tamaño del bloque. [Límites de Workers](https://developers.cloudflare.com/workers/platform/limits/).

**Cuál es el inversor A y cuál el B.** Sin configurar nada, A es simplemente el primero que devuelve `/station/v1.0/device`: un orden que decide Solarman, que puede cambiar, y que no tiene por qué coincidir con el del informe. `SOLARMAN_INV_A` y `SOLARMAN_INV_B` lo fijan por número de serie —basta con los últimos dígitos— y la respuesta indica si la asignación fue explícita o por orden.

En Gorraiz, **A = `...500004`** y **B = `...500002`**, según los ficheros diarios que se venían usando.

Para comprobarlo sin fiarse de etiquetas, `/solarman/diagnostico` devuelve el reparto mañana/tarde de cada inversor en el día pedido: en una cubierta Este-Oeste, el que apunta al Este produce claramente más antes del mediodía.

**Campos de los inversores (KSTAR G50KT, comprobados en la instalación).** `APo_t1` potencia AC total, `Et_ge0` producción acumulada, `Etdy_ge1` producción diaria. Se buscan **por clave exacta** y solo después por nombre: buscar por nombre a secas es peligroso, porque la misma respuesta trae `HR_Ege_t1` *"Total Production Hour"* (horas, no kWh) y `SV_AP` *"Active Power Setting Value"* (un ajuste, no una potencia), que casaban con los patrones y habrían pasado por buenos sin quejarse.

**Zona horaria de Solarman.** `collectTime` viene en UTC de verdad: en la instalación marcaba 05:04 UTC mientras el reloj del inversor decía 07:05, las dos horas de Madrid en agosto. Como el consumo se emite en hora local sin zona, la producción se convierte también a hora peninsular; si no, abrir el informe desde otro huso desplazaría una serie y la otra no.

**Organizaciones.** Las plantas de una empresa cuelgan de la organización, no de la persona: el token personal ve cero plantas aunque el login sea correcto. Si la cuenta pertenece a una sola organización, el Worker rehace el login con su `orgId` automáticamente; con varias, el error las enumera y hay que fijar `SOLARMAN_ORGID`. En Gorraiz es Amixalan, `orgId 10865841`.

**Identidad de SOLARMAN.** El login oficial permite **email**, **username** o **mobile** (con `countryCode`) y exige que se envíe **solo uno** de ellos. Por defecto se conserva el modo `email` mediante `SOLARMAN_EMAIL`; si la cuenta se identifica por usuario, configura `SOLARMAN_LOGIN_TYPE=username` (texto) y `SOLARMAN_USERNAME` (secreto); para teléfono, `SOLARMAN_LOGIN_TYPE=mobile`, `SOLARMAN_MOBILE` (secreto) y `SOLARMAN_COUNTRY_CODE=34` (texto, para España). El Worker nunca probará automáticamente modalidades alternativas. El `orgId` de la organización se sigue enviando si se configura, con independencia del método de login. `SOLARMAN_PASS` es la contraseña original: el Worker calcula SHA-256 en minúsculas. Fuente: [API oficial, obtención de token](https://doc.solarmanpv.com/en/Account%20Interface/2.1Obtain%20Token).

Los mensajes de error de Solarman no identifican por sí solos la causa: `auth failed` puede deberse al identificador de login, su contraseña original, `appSecret`, `orgId`, API/dominio incorrecto o alta de la aplicación. `appId or api is locked` en un centro diferente no demuestra que ese centro sea el correcto. `/estado` informa `solarmanLoginType`, `solarmanLoginVariable`, variables ausentes y si `SOLARMAN_PASS` parece un hash hexadecimal de 64 caracteres. No compartir las huellas completas ni secretos en el chat.

Después, en el dashboard: pega la URL del Worker y la `PANEL_KEY` en **⚡ Descarga automática → Worker / Clave** y pulsa Guardar. Se quedan en el `localStorage` de ese navegador.

## Almacén compartido del consumo

Los `.xlsx` de consumo solo existen en el equipo de quien los descarga, así que sin esto un compañero abría el dashboard y lo veía vacío. El Worker guarda esas fuentes en un espacio KV (`binding = "DATOS"`, configurado en `wrangler.toml`) y las sirve en `/datos`; el dashboard las sube al cargar ficheros y se las baja al abrir.

**La producción se conserva en el navegador, pero no en KV.** Cualquier equipo puede solicitarla a Solarman con el botón. SPC utiliza su propia caché por día (`spc:v1:<stationId>:<fecha>`), que permite recuperar lecturas realizadas por el cron sin iniciar sesión en el proveedor desde el navegador.

Sin el enlace KV el Worker funciona igual: `/datos` responde que no hay almacén y cada navegador se queda con su copia local en IndexedDB.

**Límite conocido:** quien tenga la `PANEL_KEY` puede leer y sobrescribir el consumo guardado. No hay control de quién escribe ni historial de cambios. Entre unas pocas personas de confianza es razonable; para más manos habría que añadir identidad y permisos.

## Notas de implementación

**Registro como organización.** El CUPS está a nombre de una empresa, así que la cuenta de Datadis se crea como *Organización* (con el CIF), no como *Particulares y autónomos*. Para un edificio de un tercero, lo limpio sería que cada parte tuviera su cuenta y el titular concediera una autorización sobre ese CUPS: queda trazada, es revocable y evita custodiar credenciales ajenas.

**Datadis va mes a mes.** La API sirve como mucho un mes por llamada (`startDate`/`endDate` en formato `AAAA/MM`), que es exactamente el motivo por el que el histórico había que bajarlo a trozos. El Worker recorre los meses del rango por dentro y devuelve todo junto. Si un mes falla, los demás siguen y el mes caído se reporta en `meta.mesesConFallo` en lugar de tumbar la descarga entera.

**Hora final de tramo.** Datadis entrega `time` como `01:00`…`24:00`, donde `01:00` designa el tramo 00:00–01:00. El Worker resta una hora para dejarlo en índice 0–23, que es como lo espera el informe.

**Los periodos P1–P6 se calculan.** Datadis no los devuelve; el `.xlsx` de i-DE sí los traía. `periodos.js` implementa el calendario de la Circular 3/2020 (3.0TD y 6.1TD comparten estructura): festivos nacionales y fines de semana a P6, noches 0–8 h a P6, y punta/llano según temporada del mes. Incluye Viernes Santo por cálculo de Pascua. Los festivos autonómicos y locales no cuentan para el calendario tarifario.

**Cambios de hora en i-DE.** El portal devuelve una lista horaria plana, sin marca de tiempo por valor: hay que repartirla por días contando horas. El último domingo de marzo tiene 23 y el de octubre 25, así que un reparto ingenuo de 24 en 24 desplazaría todo lo posterior al primer cambio de hora del rango. `horasDelDia()` lo contempla: en marzo se salta las 02 h y en octubre se emite dos veces, que es lo que realmente ocurre.

**Cookies a mano.** El `fetch` de Workers no gestiona cookies. La sesión de i-DE se recoge del `Set-Cookie` del login y se reenvía en cada llamada.

**Zona horaria.** El runtime de Cloudflare va en UTC, pero Datadis entrega hora peninsular. Por eso `periodos.js` no construye fechas con zona en ningún momento: trabaja con los componentes tal cual y saca el día de la semana en UTC.

## Estado de verificación

El flujo Solarman existente tiene mapeadas las claves de los G50KT indicadas arriba. Las nuevas pruebas de `tests/spc.test.mjs` verifican autenticación acotada, respuestas inválidas, paginación, caché, ceros/ausencias, permisos de rutas y cron con datos ficticios. `tests/energia.test.mjs` comprueba el balance y la valoración por factura.

Estas pruebas no acreditan conectividad real ni credenciales SPC. La aceptación de esa integración requiere comparar un día cerrado con el portal, confirmar el medidor y comprobar las unidades desde el Worker. El procedimiento y el límite observado de HTTPS están descritos en [SPC.md](SPC.md).
