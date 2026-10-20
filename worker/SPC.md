# Automatización de SPC Cloud

## Qué está preparado

El Worker obtiene las mediciones del SPC, guarda cada día en el KV existente y las ofrece al dashboard. La lectura usa las llamadas observadas en el JavaScript público del portal. **No se ha validado todavía una descarga autenticada de esta planta**, por lo que el conector requiere una prueba real antes de activar el cron.

No hay rutas de control, ajustes del antivertido ni cambios de los inversores. El cliente usa exclusivamente `https://spc.ksdatacloud.com`, no sigue redirecciones y no cambia a HTTP cuando falla.

## 1. Desplegar y configurar

Despliega el código revisado del Worker con el procedimiento habitual del repositorio. En Cloudflare, abre el Worker y **Settings → Variables and Secrets**. Añade como secretos:

| Nombre | Valor |
|---|---|
| `SPC_USER` | Usuario del portal SPC con acceso a la planta |
| `SPC_PASS` | Contraseña de ese usuario |

Las variables no secretas vienen en `wrangler.toml`:

| Nombre | Valor / comportamiento |
|---|---|
| `SPC_STATION_ID` | ID de la planta de Gorraiz ya configurado |
| `SPC_TIMEZONE` | `Europe/Madrid` |
| `SPC_METER_ID` | Opcional: necesario si la planta devuelve varios medidores |
| `SPC_SYNC_ENABLED` | `false` hasta terminar la prueba |

Se reutilizan `PANEL_KEY`, `ALLOWED_ORIGIN` y el binding KV `DATOS`. La contraseña del proveedor no se escribe en el HTML, la clave del panel ni el JSON económico. Si usas CLI, `npx wrangler secret put SPC_USER` y `npx wrangler secret put SPC_PASS` solicitan los valores por teclado.

## 2. Probar un día cerrado

1. Abre el dashboard con su URL del Worker y clave habituales.
2. En **Hasta**, elige un día anterior a hoy y pulsa **Comprobar SPC**. El botón consulta esa fecha.
3. Revisa que la planta y el medidor sean los esperados y que importación/exportación coincidan con la pantalla o exportación del portal para ese mismo día.
4. Contrasta las unidades y el perímetro con el contador de i-DE. Un total diario del SPC corresponde a la estación; el histórico procede del medidor seleccionado. Con varios medidores, valida especialmente esa correspondencia.
5. Pulsa **Traer datos** para descargar el rango. Cada día se solicita por separado; un fallo no borra los días anteriores.

`SPC configurado` solo indica que existen las variables necesarias. `Conexión comprobada` requiere una respuesta autenticada válida. El día en curso sigue siendo parcial. El huso de los timestamps del histórico se conserva sin afirmar que haya sido verificado; no se fabrican kWh horarios a partir de esas filas.

Si el diagnóstico responde que no hay acceso por HTTPS, la descarga no está operativa. En la comprobación sin credenciales realizada durante el desarrollo, HTTPS devolvió 503 desde el entorno de trabajo; esto **no determina** lo que responderá desde Cloudflare. Hay que probar allí. Si también falla, será necesario que KSTAR confirme un endpoint HTTPS accesible o facilite una API compatible; no debe enviarse la contraseña por HTTP como alternativa.

## 3. Recoger datos sin abrir el navegador

Tras validar la lectura, cambia `SPC_SYNC_ENABLED` a `"true"` en `wrangler.toml` y activa su bloque comentado:

```toml
[triggers]
crons = ["17 * * * *"]
```

Después despliega. Cada hora el Worker actualiza **el día anterior de Madrid** en KV. Repetir la lectura permite recoger correcciones y reintentar fallos transitorios. El cron es UTC; el día de energía lo determina `SPC_TIMEZONE`. Este cron solo sincroniza SPC, no la producción Solarman ni Datadis. El informe sigue obteniendo esas fuentes mediante su flujo habitual.

Los huecos de varios días o el histórico anterior se recuperan eligiendo el rango y pulsando **Traer datos**. El cron de ayer no realiza un relleno ilimitado de fechas antiguas. Desactivar `SPC_SYNC_ENABLED` detiene las consultas del manejador aunque permanezca el cron.

Las variables declaradas en `wrangler.toml` se vuelven a aplicar al desplegar: conserva el cambio de activación en ese fichero. `keep_vars` permite mantener variables de texto adicionales del panel; los secretos se gestionan por separado.

## Contrato HTTP

Las rutas nuevas exigen `X-Panel-Key` en cabecera. No aceptan la clave en parámetros de la URL.

| Ruta | Método | Cuerpo | Uso |
|---|---|---|---|
| `/spc/diagnostico` | POST | `{ "dia": "AAAA-MM-DD" }` | Prueba real y resumen seguro de un día |
| `/spc/intercambio` | POST | `{ "desde": "AAAA-MM-DD", "hasta": "AAAA-MM-DD" }` | Descarga real; máximo un día |
| `/spc/datos` | POST | Mismo rango | Solo caché; máximo 31 días, sin login SPC |
| `/estado` | GET | — | Configuración y última operación |

La respuesta de datos contiene `rows`, `daily` y `meta`. La caché añade `fuentes`, un payload independiente por día. `rows` conserva `saveTime`, `positiveActiveElec`, `reverseActiveElec`, `totalActivePower` y `currentRatio`; no aplica la relación CT. `daily` normaliza importación, exportación y autoconsumo como campos distintos, manteniendo `null` si falta un valor.

El histórico admite como máximo 25 páginas de 100 filas y cada operación tiene un presupuesto de 36 solicitudes externas, incluidos los logins. Se comprueban total declarado, páginas repetidas y formato. Un día sin histórico pero con resumen válido se devuelve parcial; no reemplaza una copia anterior completa. `resumenDiarioCompleto` distingue un resumen válido de día cerrado de la integridad del histórico del medidor. Ni los tokens ni los cuerpos de autenticación se almacenan en KV o se devuelven al navegador.

`/estado` incluye `spcUltima.lastAttempt`, `lastSuccess`, `lastError`, `status` y `date`. `lastSuccess` corresponde a una descarga completa, no a la mera presencia de credenciales.

## Pruebas y referencias

```bash
node --test tests/spc.test.mjs
node worker/construir.mjs
node --check worker/bundle.js
```

Las pruebas simulan las respuestas del portal; no prueban credenciales, conectividad real, límites de la cuenta o fidelidad metrológica del SPC.

- [Cloudflare: Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare: configuración de Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare: límites de Workers](https://developers.cloudflare.com/workers/platform/limits/)
- [Cliente web SPC](http://spc.ksdatacloud.com/), consultado para identificar su protocolo. El conector utiliza HTTPS.
