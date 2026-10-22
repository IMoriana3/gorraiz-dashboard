# Gorraiz · Histórico energético compartido

## Arquitectura

**Informe y SCADA utilizan el mismo archivo central**, servido por el Worker gorraiz-dashboard de Cloudflare. El archivo se almacena en el Durable Object SQLite existente SOLARMAN_QUOTA (la misma instancia que coordina las adquisiciones). Los registros se dividen por tipo de equipo (inversor A, inversor B o SPC) y día, y se fusionan mediante transacciones, sin sustituir un día completo por uno parcial.

La base del navegador IndexedDB gorraiz_datos/fuentes se mantiene como caché local. Es distinta por dispositivo, pero ya no es la única fuente para ambas pantallas. El KV anterior DATOS (consumo y SPC de anteriores integraciones) sigue intacto y no se borra. La primera recuperación de históricos antiguos se realiza desde el navegador que tenga una copia, usando el botón de sincronización explícita.

## Contrato de servicio (autenticado con X-Panel-Key)

- GET /historico/estado: muestra cobertura y días almacenados por origen. No solicita información a Solarman ni KSTAR.
- POST /historico/datos: recibe desde/hasta, devuelve hasta 31 días de las tres fuentes, sin consultar proveedores.
- POST /historico/guardar: recibe items de origen y día, guarda hasta 93 conjuntos en un lote, validando identidad, estructura, valores y límites plausibles. No consulta proveedores.

La adquisición Solarman ya autorizada por el cupo de 1 lote nuevo/hora escribe A y B en el archivo compartido dentro de esa misma operación; no realiza peticiones adicionales al proveedor. Si el almacenamiento falla, se advierte en la respuesta y se mantienen los datos locales. El número de peticiones externas por lote debe seguir midiéndose para calcular el cupo anual real.

## Operación desde ambas pantallas

En el Informe se añade la tarjeta Histórico compartido, con Recuperar del servidor y Compartir histórico ya guardado. En SCADA se añaden Recuperar todo, Compartir copia local y SPC día cerrado. Ambas interfaces pueden guardar los registros FV/SPC en el mismo archivo y leerlos. Se conserva la selección de fecha y la caché local, incluso si falla Cloudflare.

Al abrir, se intenta cargar solo la cobertura reciente para no descargar cientos de miles de muestras innecesariamente. Recuperar todo permite importar el resto del archivo central. El histórico anterior que solo esté en el navegador se copia al servidor mediante acción explícita de compartir, sin descargarlo de Solarman.

SPC sigue **solo manual**: el botón toma un día cerrado del Worker de lectura aislado, valida estación, contador, fecha y formato, guarda en memoria local y trata de compartirlo con el mismo Worker central del Informe. No se ha activado cron ni polling de SPC. Su acceso experimental al proveedor aún puede usar HTTP sin cifrar; utilizar únicamente una cuenta revocable y de solo lectura y revisar ese riesgo antes de activar nada automático.

## Integridad y límites

- Los inversores se guardan como potencia AC y acumulados con marca de tiempo y día identificados; fusión por timestamp, no sustitución de un día completo con un fragmento.
- KSTAR conserva contadores y resumen diario; no se certifica el huso SPC solo porque un navegador entregue un metadato. Potencia de intercambio sigue siendo la media deducida de diferencias de contadores, no una potencia instantánea validada.
- Se mantienen 31 días máximos por consulta, 93 objetos por escritura, hasta 600 muestras por equipo/día y tamaño máximo por objeto de aproximadamente 1,8 MB.
- Las rutas exigen la clave de panel en cabecera, nunca en la URL. Los secretos de proveedores no entran en GitHub Pages ni en el archivo.
- No se modifica el consumo proveniente de i-DE ni los precios de facturación: esta fase unifica generación A/B y energía SPC.
- No se borran fuentes previas. La operación admite reintentos; conviene establecer exportación y copia de seguridad del Durable Object antes de depender de una sola copia central.
