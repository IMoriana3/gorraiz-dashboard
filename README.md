# Gorraiz Dashboard — informes de autoconsumo

Dashboard de producción, intercambio con la red y valoración económica del Edificio Gorraiz. Frontend en GitHub Pages y conexión opcional a proveedores mediante un Cloudflare Worker.

**Panel:** https://imoriana3.github.io/gorraiz-dashboard/

## Fuentes

| Datos | Fuente | Entrada |
|---|---|---|
| Generación de los dos inversores | Solarman | API del Worker o ficheros XLSX |
| Importación/exportación diaria e histórico del contador | KSTAR SPC01 | Worker independiente en Cloudflare, conectado al dashboard |
| Reparto provisional P1-P6 de energía | Acumulados KSTAR | Solo fechas con intervalos compatibles; sin precios horarios |
| Precios medios por periodo de factura | Configuración privada | Archivo JSON importado en el navegador |

El botón **Traer datos** consulta Solarman y KSTAR por conexiones independientes. i-DE y Datadis permanecen archivados en el código, sin consultas ni curvas en el informe actual. El 19/10/2026 se validó una descarga real de KSTAR: 658,92 kWh importados, 0 kWh exportados, 74 kWh de autoconsumo comunicado y 287 registros del contador.

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
