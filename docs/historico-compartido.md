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

## Revisión 22/10/2026 · unidades de potencia y migraciones grandes

Solarman devuelve el campo `APo_t1` con su unidad en `dataList[].unit`. En el modelo de Gorraiz la potencia AC se expresa **siempre en kW**: si el dato llega en **W**, el Worker lo divide entre 1.000 y etiqueta la copia como kW. Si el proveedor declara kW, lo conserva. La falta de lectura no se reemplaza por cero.

La primera versión del importador rechazaba por completo un paquete si encontraba un valor de potencia mayor que 65, incluso si representaba una lectura antigua en W. Este bloqueo se ha corregido:

- Los datos antiguos identificados como fuentes Solarman previas se interpretan en W por su procedencia conocida, y solo la **copia enviada** se convierte a kW. No se alteran los registros originales del navegador.
- Los registros ya etiquetados como kW se mantienen en kW. Las copias centrales siguen teniendo esa unidad.
- Los XLSX antiguos con cabeceras de unidad perdidas no se convierten automáticamente: sus potencias se guardan como `potSinValidar` y `pot:null`; se mantienen sus energías diarias y acumulados. En Informe puede elegirse W o kW para esos archivos **solo tras comprobar su unidad real**. Si los archivos mezclan unidades, deberán separarse antes.
- Un pico físicamente incompatible con cada G50KT no se presenta como kW válido. Se conserva el valor original para investigación.
- La migración masiva procesa lotes pequeños y, ante un día defectuoso, lo aísla por división progresiva. Continúa con los demás días y muestra cuántos conjuntos se han copiado, cuántos quedan pendientes y cuántos valores de potencia carecen de unidad validada.
- Volver a sincronizar no descarga datos nuevos de Solarman ni KSTAR: únicamente actualiza el mismo registro central por equipo y fecha. La copia local nunca se borra durante la operación.

La aceptación de un día en el archivo central no certifica por sí sola la calidad de todas sus potencias. El SCADA excluye las potencias sin unidad verificada de las curvas y muestra los huecos sin rellenarlos con valores inventados. Las mediciones reales tras la migración deben contrastarse con el portal original antes de emplearse para informes de rendimiento.
