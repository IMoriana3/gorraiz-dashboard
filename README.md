# Gorraiz Dashboard — informes de autoconsumo

Dashboard de producción, intercambio con la red y valoración económica del Edificio Gorraiz. Frontend en GitHub Pages y conexión opcional a proveedores mediante un Cloudflare Worker.

**Panel:** https://imoriana3.github.io/gorraiz-dashboard/

## Fuentes

| Datos | Fuente | Entrada |
|---|---|---|
| Generación de los dos inversores | Solarman | API del Worker o ficheros XLSX |
| Importación horaria del contador | i-DE / Datadis | XLSX de i-DE o API de Datadis |
| Importación y exportación diaria; histórico del medidor | SPC Cloud | API del Worker, caché compartida y sincronización opcional |
| Precios medios por periodo de factura | Configuración privada | Archivo JSON importado en el navegador |

El botón **Traer datos** consulta las fuentes configuradas. Si una falla, las otras pueden continuar. La integración SPC se basa en las llamadas observadas en el cliente web del proveedor: requiere una primera prueba autenticada antes de activarla en producción. No configura ni controla el antivertido.

## Informes y cálculo

- Informe con cinco páginas principales y anexo mensual en PDF; comparación de dos periodos y PDF de tres páginas.
- Las páginas 1–3 usan el rango elegido; las páginas 4–5 muestran el histórico completo con su propia cobertura.
- Balance de días cerrados con datos de ambos inversores y del SPC: **autoconsumo = generación − exportación**; **consumo = importación + autoconsumo**. Se supone una instalación sin almacenamiento y mediciones del mismo perímetro.
- La falta de datos no equivale a cero. Se muestra qué días están cubiertos. El día en curso y los balances incoherentes quedan fuera de los totales cerrados.
- La tarifa indexada se aproxima mediante el término de energía de cada factura dividido entre sus kWh importados. No es el precio horario exacto ni una reconstrucción completa de la factura.
- Los costes de potencia, alquiler y otros cargos fijos no se añaden al ahorro energético. El IE y el IVA se distinguen; no se presupone un ingreso por vender excedentes.
- No se reparte una exportación diaria entre horas. Los perfiles horarios conservan la importación de red y la generación como series separadas.

Ver [configuración y límites económicos](docs/precios.md) y [activación de SPC](worker/SPC.md).

## Uso

1. Configura la URL del Worker y la clave del panel, o carga los XLSX de los inversores y del contador.
2. Pulsa **Comprobar SPC** para validar el acceso. **Traer datos** descarga el rango seleccionado por bloques.
3. Importa el JSON de precios de factura en la sección económica. Se guarda solo en ese navegador.
4. Genera el informe y revisa su cobertura antes de exportar el PDF.

La apertura del panel recupera el almacenamiento local y la caché compartida; no inicia sesión en SPC. Para recoger datos sin tener el navegador abierto, configura el cron del Worker siguiendo su guía.

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

Las pruebas usan respuestas ficticias: validan el cálculo y el tratamiento de errores, pero no acreditan acceso real al servicio SPC. Los precios reales, PDFs de factura, `.env` y `.dev.vars` no deben incorporarse al repositorio público.

*Factiun · Gorraiz.*
