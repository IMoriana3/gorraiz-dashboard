# Gorraiz · prueba aislada KSTAR (después de HTTP 200 / API 401)

**Resultado previo:** el Worker `gorraiz-kstar-prueba` ya puede llegar al portal por HTTP, y la API devuelve 401 sin sesión. El siguiente ensayo es autenticado, **exclusivamente con una cuenta KSTAR temporal y de solo lectura**. No utilizar la cuenta principal con permisos de control.

## 1. Código del Worker de pruebas

En Cloudflare, abre el Worker **gorraiz-kstar-prueba → Edit code**. Sustituye el anterior Hello World por el contenido completo de **`worker/kstar-prueba-bundle.js`** y despliega. Es un único fichero generado desde `worker/spc.js` y `worker/kstar-prueba.js`; nunca contiene credenciales.

El Worker muestra una página de prueba con dos campos: clave de la prueba y día cerrado. No configura cron ni KV, y la API del Worker solo expone `POST /comprobar` después de comprobar una clave de prueba independiente.

## 2. Variables y secretos SOLO en el Worker de pruebas

En **Settings → Variables and Secrets**, añade:

| Nombre | Tipo | Valor |
|---|---|---|
| `KSTAR_TEST_KEY` | Secret | Clave aleatoria propia de al menos 24 caracteres, guardada en lugar seguro |
| `SPC_USER` | Secret | Usuario de una **cuenta de prueba KSTAR de solo lectura** |
| `SPC_PASS` | Secret | Contraseña temporal de esa cuenta |
| `SPC_STATION_ID` | Text | `2026032317114373` |
| `SPC_TRANSPORT` | Text | `http` |
| `SPC_HTTP_RISK_ACK` | Text | `I_ACCEPT_UNENCRYPTED_CREDENTIALS` |

No introducir las contraseñas en código, GitHub, URL, ni en el chat.

**Advertencia:** el acceso KSTAR utiliza HTTP y envía nombre de usuario y contraseña en la URL de login, además de token de sesión sin cifrar. Es posible que se intercepten. El enlace HTTPS del navegador al Worker **no cifra** el tramo Worker → KSTAR. Para operación permanente, solicitar HTTPS al fabricante o lectura local segura.

## 3. Primera comprobación

1. En el Worker, pulsa **Visit**.
2. En el formulario escribe tu `KSTAR_TEST_KEY` (no la contraseña de KSTAR).
3. Elige un día cerrado, por ejemplo **2026-10-19**.
4. Pulsa **Comprobar lectura KSTAR**.
5. Revisa `importKWh`, `exportKWh`, `stationId`, `meterId` y `complete`.

El formulario solo enseña valores resumidos o errores saneados. No guarda el histórico. **No significa que las medidas sean correctas**: comparar con el portal KSTAR antes de incorporarlas al informe.

Si sale `SPC_SCHEMA` o `SPC_PROVIDER_ERROR`, no inventar campos: inspeccionar el formato de respuesta mediante una vía segura y ajustar el conector. Si sale `SPC_AUTH`, confirmar permisos/credenciales, sin compartirlas por chat.

## Diagnóstico cuando aparece `SPC_NETWORK`

El error `SPC_NETWORK` no prueba que la contraseña esté mal: puede ser un fallo de conexión en cualquiera de las llamadas. El Worker ahora muestra `etapa` (autenticación, lista de medidores, histórico o resumen diario) y `detalleRed` (`fallo_de_transporte` o `tiempo_agotado`), pero **nunca el mensaje de error bruto**, porque puede incluir usuario, contraseña o token en la URL.

Antes de intentar otro login por HTTP, pulsa **Comprobar red sin credenciales KSTAR**. Solo precisa la clave `KSTAR_TEST_KEY` y realiza tres peticiones públicas: `GET /`, `GET /api/station/monitor/detail/self` sin token y `POST /api/authentication/form` sin usuario ni contraseña. Informa exclusivamente de código HTTP, tipo de contenido o tipo genérico de fallo. No utiliza `SPC_USER` ni `SPC_PASS`.

Si el POST sin credenciales falla en transporte mientras los GET devuelven HTTP, probablemente el problema esté relacionado con el método POST, el endpoint o el tratamiento de Cloudflare/KSTAR; **no seguir intentando login con la cuenta de control**. Si el POST responde HTTP pero el intento autenticado falla, revisar la petición de autenticación mediante un canal seguro (sin reproducir la contraseña en logs).

Este sondeo no cambia configuración de planta, no valida el usuario y no confirma la API de lectura. La primera conexión autenticada continúa pendiente. Si se usó una cuenta con permisos de control durante HTTP, considerar cambiar su contraseña, porque pudo haber quedado expuesta durante la petición, incluso si terminó con error.

## Resultado real 20/10/2026: `SPC_PROVIDER_ERROR` en `resumen_diario`

El usuario ha superado el login, listado de medidores e histórico. El resumen diario `GET /station/monitor/detail/self` devuelve error de aplicación. Se verificó en el JavaScript público que KSTAR utiliza **exactamente** `GET /station/monitor/detail/self` con parámetros `{startTime, stationId}`, por lo que no se cambia el endpoint a ciegas.

El comprobador actualizado devuelve información **saneada** para depurar un único ensayo: `proveedor.codigo` (solo números, si existen), `proveedor.success`, `proveedor.tipoDatos`, y `historico` con medidor, número de registros y dos muestras de los campos `positiveActiveElec` y `reverseActiveElec`. Estas muestras pueden ser acumulados o lecturas parciales; **no equivalen a importación/exportación diaria hasta demostrar unidades y cobertura**. El Worker nunca publica mensajes ni respuestas completas del proveedor, porque podrían incluir secretos.

**No repetir una sesión por HTTP con cuenta principal de control.** La siguiente ejecución, solo si existe una cuenta de prueba limitada, debe realizarse con el bundle actualizado, y comprobarse el código numérico antes de decidir si el problema se debe a permisos, fecha o datos ausentes.

## Conexión directa al dashboard (sin credenciales KSTAR en GitHub Pages)

El Worker independiente ofrece `POST /spc/intercambio` con un único día cerrado, devuelve `{rows,daily,meta}` y exige la cabecera `X-KSTAR-Test-Key`. Solo admite peticiones CORS desde `https://imoriana3.github.io`; no expone rutas de control ni activa cron. Las credenciales y el token de SPC permanecen en Cloudflare, no en el dashboard.

Cuando hayas pegado y desplegado la última versión de `worker/kstar-prueba-bundle.js` en `gorraiz-kstar-prueba`, abre el dashboard actualizado y guarda en la sección KSTAR la URL `https://<tu-worker>.workers.dev` y la clave `KSTAR_TEST_KEY`. La **URL** queda guardada en `localStorage` y la **clave de prueba** solo en `sessionStorage` (pide introducirla de nuevo en una sesión distinta). No introducir `SPC_USER` ni `SPC_PASS` en el navegador.

`Comprobar SPC` trae un día cerrado y lo conserva en IndexedDB. `Traer datos` consulta a Solarman con el Worker habitual y a KSTAR con este Worker aislado, limita los días KSTAR a 14 por tanda y omite el día en curso. El PDF calcula el balance diario con KSTAR+Solarman; el reparto P1-P6 es **provisional**, sin valorar el precio indexado exacto.

**Estado:** validada en vivo la lectura del 19/10/2026 (658,92 kWh entrantes; 0 kWh salientes; 74 kWh de autoconsumo KSTAR). Pendiente probar la exportación positiva del 20/10 después de su cierre, mañana 21/10. Todavía no hay activación de Cron y **HTTP entre Cloudflare y KSTAR continúa sin cifrado**; usar solo cuenta temporal y de permisos limitados.

## 4. Cierre

Borrar los secretos y desactivar el Worker temporal una vez validado el formato. El dashboard principal y la PR #36 permanecen sin desplegar a producción; el cron SPC continúa desactivado.
