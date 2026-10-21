# Gorraiz Dashboard — informes de autoconsumo

Dashboard de producción, intercambio con la red y valoración económica del Edificio Gorraiz. Frontend en GitHub Pages y conexión opcional a proveedores mediante un Cloudflare Worker.

**Panel:** https://imoriana3.github.io/gorraiz-dashboard/

## Fuentes

| Datos | Fuente | Entrada |
|---|---|---|
| Generación de los dos inversores | Solarman | API del Worker o ficheros XLSX |
| Importación/exportación diaria e histórico del contador | KSTAR SPC01 | Worker independiente en Cloudflare, conectado al dashboard |
| Importación diaria facturada, para contrastar | i-DE | Ficheros XLSX horarios subidos a mano |
| Reparto P1-P6 de importación y vertido | i-DE | Periodo tarifario que la distribuidora marca en cada hora |
| Reparto provisional P1-P6 de energía | Acumulados KSTAR | Respaldo cuando no hay ficheros de i-DE; solo fechas con intervalos compatibles |
| Precios medios por periodo de factura | Configuración privada | Archivo JSON importado en el navegador |

El botón **Traer datos** consulta Solarman y KSTAR por conexiones independientes. La **descarga automática** de i-DE y Datadis sigue archivada en el código, sin consultas. El 19/10/2026 se validó una descarga real de KSTAR: 658,92 kWh importados, 0 kWh exportados, 74 kWh de autoconsumo comunicado y 287 registros del contador.

### Fiabilidad de los datos

La página 1 cierra con una línea que reúne las tres validaciones y la cobertura: sobre cuántos días se ha calculado el balance, cuántos tienen precio, si i-DE y KSTAR cuadran en los días comparables, si lo medido cuadra con lo facturado, y cuántos kWh de vertido se han dejado fuera. Vivían repartidas en tres páginas distintas; quien recibe el informe tiene que poder juzgarlo de un vistazo, porque un informe que se entrega se defiende por esto y no por sus totales.

### Vertido anterior al arreglo del antivertido

`CFG.vertidoDesde` marca desde cuándo se contabiliza el vertido. El anterior a esa fecha procede de un fallo del antivertido, ya corregido, y **por decisión de la propiedad no se cuenta**: queda fuera de las gráficas y del balance. Vaciar el campo vuelve a contarlo todo.

El corte se aplica en `gridDiario()` y solo ahí, que es la serie de la que beben el balance, los recuadros, las gráficas, la tabla por periodo y el anexo: así ninguna vista se queda contando lo que otra descarta.

Consecuencia que conviene tener presente al leer el informe: esos kWh **salieron de verdad a la red**, así que al no restarlos el autoconsumo y el consumo de esos meses quedan por encima de lo que midió la distribuidora. Por eso el informe dice en una línea cuántos kWh ha dejado fuera en el periodo: quien lo cruce con los ficheros de i-DE tiene que poder explicar la diferencia sin pensar que hay un error.

### Contraste con la factura

La factura trae los kWh que la distribuidora ha facturado en cada periodo, y salen del **mismo contador** que la curva horaria de i-DE: tienen que cuadrar. Como el `importKWh` de cada periodo ya está en la configuración de precios, el panel compara lo facturado con lo medido y avisa en pantalla y en el anexo del PDF, que es donde se valora.

- Solo se comparan los periodos de factura **cubiertos por entero**. Un mes a medio cubrir siempre sale corto: eso son días que faltan, no un desvío, y tratarlo como tal sería una alarma falsa.
- Se avisa cuando la diferencia pasa a la vez de 10 kWh y del 1 %. El umbral es más estrecho que el del contraste entre contadores porque aquí debería cuadrar casi al kWh.

Es el tercer eje de validación, y el que cierra el círculo: producción contra sus propios totales diarios, red entre i-DE y KSTAR, y red contra lo que se paga.

### Contraste i-DE ↔ KSTAR

Los ficheros horarios de i-DE **sí** se suben a mano, pero solo se usan por su **total diario**: la curva horaria no se dibuja como medida de intercambio, porque su reparto por horas no está validado contra el contador. Los dos aparatos miden la misma energía de red, así que sus totales diarios se comparan día a día.

- Un día de i-DE al que le falten horas no se declara completo y no entra en la comparación. Los días del cambio de hora tienen 23 y 25 horas, no 24; se cuentan con el huso peninsular, no con el del navegador.
- Se avisa cuando la diferencia supera **a la vez** 1 kWh y el 2 %. Exigir ambos umbrales evita la alarma por un día de consumo mínimo, donde cualquier décima es un gran porcentaje, y por uno de mucho consumo, donde unos kWh son ruido de redondeo.
- En el balance manda i-DE donde haya día completo, por ser la medida que factura; KSTAR cubre lo que la distribuidora todavía no ha publicado. Cada día deja constancia de su origen en `meta.contador`.
- Si hay discrepancia, se dice en el panel **y en la página 3 del PDF**: quien lee el informe no ve la pantalla.

### Reparto P1-P6

La importación y el vertido por periodo tarifario salen del fichero de i-DE, que marca el periodo de cada hora: es medida de la distribuidora y cubre todo el rango. El autoconsumo por periodo **sí es derivado** —producción de las muestras del inversor menos el vertido medido de cada hora— y la nota al pie dice cuántas horas se han quedado sin producción registrada.

El reparto de los acumulados KSTAR queda como respaldo para cuando no hay ficheros de i-DE: solo alcanza los días con intervalos compatibles. No se enseñan los dos a la vez, porque serían lo mismo con distinta cobertura.

Con `pricesByPeriod` en la configuración de precios, la tabla añade €/kWh y ahorro por periodo, valorando cada hora con la factura que cubre su día. El informe nombra la factura aplicada y los kWh autoconsumidos que se han quedado sin precio. Sin ese desglose, la tabla sigue dando kWh y el ahorro queda sin calcular, nunca a cero. Ver [configuración y límites económicos](docs/precios.md).

## Informes y cálculo

- Informe con cinco páginas principales y anexo mensual en PDF; comparación de dos periodos y PDF de tres páginas.
- Las páginas 1–3 usan el rango elegido; las páginas 4–5 muestran el histórico completo con su propia cobertura.
- Balance de días cerrados con datos de ambos inversores y del SPC: **autoconsumo = generación − exportación**; **consumo = importación + autoconsumo**. Se supone una instalación sin almacenamiento y mediciones del mismo perímetro.
- La falta de datos no equivale a cero. Se muestra qué días están cubiertos. El día en curso y los balances incoherentes quedan fuera de los totales cerrados.
- La tarifa indexada se aproxima mediante el término de energía de cada factura dividido entre sus kWh importados. No es el precio horario exacto ni una reconstrucción completa de la factura.
- Los costes de potencia, alquiler y otros cargos fijos no se añaden al ahorro energético. El IE y el IVA se distinguen; no se presupone un ingreso por vender excedentes.
- No se reparte una exportación **diaria** artificialmente entre horas. Un módulo aparte estima kWh por P1-P6 desde intervalos del contador SPC solo si pasan controles de continuidad, límites y reconciliación. No convierte automáticamente esos kWh en facturación exacta.

Ver [configuración y límites económicos](docs/precios.md) y [activación de SPC](worker/SPC.md).

## Uso

1. Configura la URL y la clave del Worker habitual **Solarman**.
2. En la tarjeta **KSTAR SPC01**, indica la URL HTTPS `*.workers.dev` del Worker aislado y su `KSTAR_TEST_KEY` (nunca la contraseña del proveedor). La URL se guarda en el navegador y la clave dura solo esa sesión.
3. Selecciona un día cerrado y pulsa **Comprobar SPC**. **Traer datos** descarga como máximo 14 días KSTAR por tanda y conserva los días en IndexedDB.
4. Importa la configuración privada de precios medios de factura, genera el informe y revisa la cobertura y el reparto provisional P1-P6 antes de exportar el PDF.

La apertura del panel recupera datos de IndexedDB y no inicia sesión en SPC. **No se activa cron KSTAR** mientras el proveedor exija HTTP sin cifrar. Para integración y limitaciones consulta [la guía de Worker aislado](worker/KSTAR_PRUEBA.md).

## Datos y despliegue

Los ficheros originales y la configuración económica no se publican en este repositorio. Producción y SPC se conservan localmente en IndexedDB. El consumo cargado puede compartirse a través del KV del Worker; SPC tiene claves propias por día. La configuración económica permanece en `localStorage` y no se envía al Worker. Las credenciales de los proveedores se guardan como secretos de Cloudflare.

El frontend utiliza HTML/JS, SheetJS, Chart.js, jsPDF y Open-Meteo. El código del Worker y su despliegue se describen en [worker/README.md](worker/README.md).

## Verificación local

Con Node 22 o posterior:

```bash
node --test tests/*.test.mjs
node worker/construir.mjs
node --check worker/bundle.js
```

Las pruebas automáticas utilizan respuestas ficticias. Además, el 19/10/2026 se validó por separado una **descarga autenticada real KSTAR en un Worker de pruebas**, concordante con los totales de su portal. Eso todavía no certifica una automatización de producción. Los precios reales, PDFs de factura, `.env` y `.dev.vars` no deben incorporarse al repositorio público.


### Cloudflare Builds y vistas previas de las PR

La configuración **de producción** está en `worker/wrangler.toml`. El pequeño `wrangler.toml` de la raíz es un shim **solo de preview**: facilita que Cloudflare compile una PR cuando ignora Root directory = `worker`, incidencia [Cloudflare #75](https://github.com/cloudflare/developer-platform/issues/75). No contiene variables de acceso, enlaces KV ni cron y no debe usarse con `wrangler deploy` para actualizar producción.

La CI verifica las dos configuraciones, las pruebas y la compilación. Publicar una preview no activa la conexión real al SPC: requiere secretos y contraste del medidor antes de habilitar el cron.

*Factiun · Gorraiz.*
