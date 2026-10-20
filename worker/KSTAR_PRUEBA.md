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

## 4. Cierre

Borrar los secretos y desactivar el Worker temporal una vez validado el formato. El dashboard principal y la PR #36 permanecen sin desplegar a producción; el cron SPC continúa desactivado.
