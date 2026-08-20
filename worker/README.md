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

`rows` sale con la misma forma que produce la lectura de un `.xlsx` de i-DE, así que el informe no distingue de dónde vienen los datos.

## Despliegue

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
npx wrangler secret put DATADIS_AUTHORIZED_NIF   # CIF del titular, SOLO si el CUPS es de un cliente
```

**Sobre `DATADIS_AUTHORIZED_NIF`:** cuando el suministro no es de la propia cuenta sino de un cliente que te ha autorizado — el caso normal cuando la instaladora consulta el edificio de su cliente — la API exige el NIF/CIF del titular en `authorizedNif`, tanto al listar suministros como al pedir consumos. Sin él, la cuenta no ve el CUPS y Datadis responde una lista vacía. Si el suministro es propio, este secreto no debe configurarse: el parámetro no puede viajar.

Y cuando lleguen las credenciales de Solarman:

```bash
npx wrangler secret put SOLARMAN_APPID
npx wrangler secret put SOLARMAN_APPSECRET
npx wrangler secret put SOLARMAN_EMAIL
npx wrangler secret put SOLARMAN_PASS       # en claro: el Worker le aplica SHA-256 al vuelo
npx wrangler secret put SOLARMAN_STATION_ID # opcional: si hay una sola planta, sobra
```

Después, en el dashboard: pega la URL del Worker y la `PANEL_KEY` en **⚡ Descarga automática → Worker / Clave** y pulsa Guardar. Se quedan en el `localStorage` de ese navegador.

## Notas de implementación

**Registro como organización.** Para un CUPS a nombre de una empresa hay que registrarse en Datadis como *Organización*, no como *Particulares y autónomos*. Si el titular es un cliente, lo limpio es que cada parte tenga su cuenta y el titular conceda una autorización sobre ese CUPS: queda trazada, es revocable y evita custodiar credenciales ajenas.

**Datadis va mes a mes.** La API sirve como mucho un mes por llamada (`startDate`/`endDate` en formato `AAAA/MM`), que es exactamente el motivo por el que el histórico había que bajarlo a trozos. El Worker recorre los meses del rango por dentro y devuelve todo junto. Si un mes falla, los demás siguen y el mes caído se reporta en `meta.mesesConFallo` en lugar de tumbar la descarga entera.

**Hora final de tramo.** Datadis entrega `time` como `01:00`…`24:00`, donde `01:00` designa el tramo 00:00–01:00. El Worker resta una hora para dejarlo en índice 0–23, que es como lo espera el informe.

**Los periodos P1–P6 se calculan.** Datadis no los devuelve; el `.xlsx` de i-DE sí los traía. `periodos.js` implementa el calendario de la Circular 3/2020 (3.0TD y 6.1TD comparten estructura): festivos nacionales y fines de semana a P6, noches 0–8 h a P6, y punta/llano según temporada del mes. Incluye Viernes Santo por cálculo de Pascua. Los festivos autonómicos y locales no cuentan para el calendario tarifario.

**Zona horaria.** El runtime de Cloudflare va en UTC, pero Datadis entrega hora peninsular. Por eso `periodos.js` no construye fechas con zona en ningún momento: trabaja con los componentes tal cual y saca el día de la semana en UTC.

## Estado de verificación

La lógica está probada con las respuestas simuladas (`meses`, conversión horaria, recorte de rango, orden, duplicados, CORS, autenticación, caída de un mes suelto) y el calendario tarifario contra 17.544 horas de 2024–2025.

Lo que **no** he podido comprobar es la llamada real: este entorno no tiene salida hacia `datadis.es` ni `solarmanpv.com`. La integración está escrita contra la documentación, así que la primera ejecución con credenciales reales es una prueba de verdad. La forma de validarla sin fiarse: pedir un mes del que ya tengas el `.xlsx` de i-DE y cargar los dos a la vez — el dashboard los une por día y el desglose dirá si cuadran.

Solarman queda escrito pero inerte hasta tener `appId`/`appSecret`. Como no he podido ver los nombres reales de los campos, `smValor()` busca por nombre (igual que la carga de `.xlsx` busca por cabecera) y existe `/solarman/diagnostico` para volcar un tramo en crudo y afinar el mapeo el primer día.
