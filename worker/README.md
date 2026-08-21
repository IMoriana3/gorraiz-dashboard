# Worker de datos — Gorraiz Dashboard

Proxy mínimo que permite al dashboard traerse los datos con un botón, en lugar de descargar y subir ficheros a mano.

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

`rows` sale con la misma forma que produce la lectura de un `.xlsx` de i-DE, así que el informe no distingue de dónde vienen los datos.

## Despliegue

### Desde GitHub (lo que está montado)

El Worker se despliega conectando el repositorio en **Workers & Pages → Create application → Workers → Import a repository**. En **Settings → Build** debe quedar:

- **Root directory**: `worker` ← imprescindible
- **Build command**: vacío
- **Deploy command**: `npx wrangler deploy`
- **Production branch**: `main`

El *Root directory* no es un detalle cosmético: si se deja en la raíz, wrangler no encuentra ningún `wrangler.toml`, deduce que el repositorio es un sitio estático y publica **todos** los ficheros tal cual, incluida la carpeta `.git`, sin llegar a desplegar el Worker.

Cada `push` a `main` que toque esta carpeta redespliega solo.

**`keep_vars = true` en `wrangler.toml` no es opcional.** Por defecto, `wrangler deploy` borra del Worker todo lo configurado desde el panel que no figure en el fichero. Los secretos se guardan en el panel y no pueden estar en el fichero, así que sin ese ajuste cada despliegue los elimina — y el síntoma es desconcertante: los ves listados en el panel pero el Worker no los recibe.

### Sin instalar nada (desde el navegador)

Si no tienes Node en el equipo, `bundle.js` es el Worker entero en un solo fichero, listo para pegar en el editor web de Cloudflare. En el panel de Cloudflare: **Workers & Pages → Create → Worker**, abre **Edit code**, borra lo que venga de ejemplo y pega el contenido de `bundle.js`. Luego, en **Settings → Variables and Secrets**, añade `ALLOWED_ORIGIN` como variable de texto y el resto como *Secret*.

`bundle.js` está generado: si tocas `index.js` o `periodos.js`, regenéralo con `node construir.mjs`.

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

Y cuando lleguen las credenciales de Solarman:

```bash
npx wrangler secret put SOLARMAN_APPID
npx wrangler secret put SOLARMAN_APPSECRET
npx wrangler secret put SOLARMAN_EMAIL
npx wrangler secret put SOLARMAN_PASS       # en claro: el Worker le aplica SHA-256 al vuelo
npx wrangler secret put SOLARMAN_STATION_ID # opcional: si hay una sola planta, sobra
npx wrangler secret put SOLARMAN_ORGID      # SOLO si la cuenta es Business, no Smart
```

**Smart contra Business.** El plan gratuito de la API es solo para cuentas SOLARMAN Smart con 3 plantas o menos. Y hay una diferencia técnica que no se anuncia: **una cuenta Business exige mandar `orgId` en el login**, y sin él responde `auth failed` aunque el correo y la contraseña sean correctos — indistinguible de una contraseña mal puesta.

Los mensajes de error de Solarman despistan más de lo que ayudan: `appId or api is locked` puede ser tanto un appId sin activar como uno con un carácter de más o una llamada al centro de datos equivocado; `auth failed` puede ser credenciales erróneas o un `orgId` que falta. `/estado` devuelve la huella de cada credencial —longitud, extremos, si tiene espacios— para poder cotejarlas sin exponerlas.

Después, en el dashboard: pega la URL del Worker y la `PANEL_KEY` en **⚡ Descarga automática → Worker / Clave** y pulsa Guardar. Se quedan en el `localStorage` de ese navegador.

## Notas de implementación

**Registro como organización.** El CUPS está a nombre de una empresa, así que la cuenta de Datadis se crea como *Organización* (con el CIF), no como *Particulares y autónomos*. Para un edificio de un tercero, lo limpio sería que cada parte tuviera su cuenta y el titular concediera una autorización sobre ese CUPS: queda trazada, es revocable y evita custodiar credenciales ajenas.

**Datadis va mes a mes.** La API sirve como mucho un mes por llamada (`startDate`/`endDate` en formato `AAAA/MM`), que es exactamente el motivo por el que el histórico había que bajarlo a trozos. El Worker recorre los meses del rango por dentro y devuelve todo junto. Si un mes falla, los demás siguen y el mes caído se reporta en `meta.mesesConFallo` en lugar de tumbar la descarga entera.

**Hora final de tramo.** Datadis entrega `time` como `01:00`…`24:00`, donde `01:00` designa el tramo 00:00–01:00. El Worker resta una hora para dejarlo en índice 0–23, que es como lo espera el informe.

**Los periodos P1–P6 se calculan.** Datadis no los devuelve; el `.xlsx` de i-DE sí los traía. `periodos.js` implementa el calendario de la Circular 3/2020 (3.0TD y 6.1TD comparten estructura): festivos nacionales y fines de semana a P6, noches 0–8 h a P6, y punta/llano según temporada del mes. Incluye Viernes Santo por cálculo de Pascua. Los festivos autonómicos y locales no cuentan para el calendario tarifario.

**Cambios de hora en i-DE.** El portal devuelve una lista horaria plana, sin marca de tiempo por valor: hay que repartirla por días contando horas. El último domingo de marzo tiene 23 y el de octubre 25, así que un reparto ingenuo de 24 en 24 desplazaría todo lo posterior al primer cambio de hora del rango. `horasDelDia()` lo contempla: en marzo se salta las 02 h y en octubre se emite dos veces, que es lo que realmente ocurre.

**Cookies a mano.** El `fetch` de Workers no gestiona cookies. La sesión de i-DE se recoge del `Set-Cookie` del login y se reenvía en cada llamada.

**Zona horaria.** El runtime de Cloudflare va en UTC, pero Datadis entrega hora peninsular. Por eso `periodos.js` no construye fechas con zona en ningún momento: trabaja con los componentes tal cual y saca el día de la semana en UTC.

## Estado de verificación

La lógica está probada con las respuestas simuladas (`meses`, conversión horaria, recorte de rango, orden, duplicados, CORS, autenticación, caída de un mes suelto) y el calendario tarifario contra 17.544 horas de 2024–2025.

Lo que **no** he podido comprobar es la llamada real: este entorno no tiene salida hacia `datadis.es`, `i-de.es` ni `solarmanpv.com`. La integración está escrita contra la documentación, así que la primera ejecución con credenciales reales es una prueba de verdad. La forma de validarla sin fiarse: pedir un mes del que ya tengas el `.xlsx` de i-DE y cargar los dos a la vez — el dashboard los une por día y el desglose dirá si cuadran.

Solarman queda escrito pero inerte hasta tener `appId`/`appSecret`. Como no he podido ver los nombres reales de los campos, `smValor()` busca por nombre (igual que la carga de `.xlsx` busca por cabecera) y existe `/solarman/diagnostico` para volcar un tramo en crudo y afinar el mapeo el primer día.
