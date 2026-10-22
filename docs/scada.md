# SCADA Gorraiz · Contrato operativo (PR #53)

## Alcance implementado

El SCADA y el Informe comparten el **archivo central SQLite de Gorraiz** en el Worker, reutilizando el Durable Object `SOLARMAN_QUOTA`. `gorraiz_datos/fuentes` (IndexedDB) permanece como caché local, no como única fuente de verdad. `scada-data.mjs` normaliza las series, `scada-app.mjs` las representa y `scada-sync.mjs` recupera, copia y guarda el histórico. El informe PDF mantiene sus cálculos actuales. Contrato y límites: [histórico compartido](historico-compartido.md).

| Señal visual | Origen | Tipo de dato |
|---|---|---|
| Generación FV (kW) | Solarman: `APo_t1` de los dos G50KT, suma solo de muestras simultáneas | Medida de potencia AC |
| Inversor A y B (kW) | Solarman: `pot` del histórico local | Medida de potencia AC |
| Importación (kW) | `positiveActiveElec` KSTAR | Potencia **media estimada por intervalo** entre contadores en kWh |
| Exportación (kW) | `reverseActiveElec` KSTAR | Media estimada por intervalo a partir de acumulados; **se dibuja NEGATIVA como flujo saliente** (el contador y kWh diarios siguen positivos) |
| Consumo (kW) | Generación + importación − exportación | **ESTIMACIÓN NO VALIDADA** cuando coinciden muestras A+B y SPC en la misma casilla; se muestra por defecto, con opción de ocultarla, sin certificar la hora del SPC |
| Autoconsumo (kWh) | `daily.selfConsumptionKWh` SPC | Energía diaria; **no** potencia instantánea |
| Balance diario (kWh) | Producción diaria de ambos inversores y resumen SPC del mismo día | Derivado; parcial para días en curso |

La instalación cuenta con **123,84 kWp DC** y **2 × 50 kW AC nominales**; el render de concepto que mostraba cientos de kW no son datos reales ni límites del sistema. Las tarjetas no deben mostrar valores de ejemplo.

## Restricciones de integridad

1. **Ninguna medida a cero por ausencia de datos:** se representa con `null`, etiqueta «—» y hueco gráfico (`spanGaps:false`).
2. **SPC requiere** día `meta.completo=true`, datos de medidor único (o metadato sin recuento) y conciliación del incremento primero–último de contadores con el resumen diario (desviación máxima: mayor de 1 kWh y 2 % del total).
3. Se descartan diferencias negativas, reinicios de contador, intervalos inferiores a 2 o superiores a 10 minutos y picos físicamente anómalos. No se interpolan huecos ni se reparte energía diaria ficticiamente entre horas.
4. La marca temporal SPC **no tiene huso verificado**. La curva KSTAR utiliza la hora literal del medidor. Por petición expresa, el SCADA muestra por defecto el **consumo estimado provisional** con esa correspondencia horaria aún sin validar, siempre que coincidan A+B y el intervalo SPC. Puede ocultarse con la casilla «Consumo estimado (relojes SIN validar)». La curva, en azul discontinuo, no supone medición real ni altera el informe. Ausencias o balances negativos siguen siendo huecos, no ceros.
5. `totalActivePower` no se utiliza como kW porque no se han validado escala, signo ni transformadores de corriente.
6. Las tarjetas de equipo indican **disponibilidad de muestra**, no salud real, órdenes de control ni enlace en línea confirmado.
7. Las gráficas **24 h** y **7 días** comparten resolución nominal de 5 minutos y conservan muestras faltantes. Las transiciones DST deben estudiarse antes de afirmar que los relojes de ambas fuentes se encuentran reconciliados; el período seleccionado se representa por reloj civil y no se pretende certificar el número real de minutos de los días de cambio horario.

## Adquisición y límites de refresco

- **Inicial:** IndexedDB local y consulta al histórico central autorizado para recuperar días disponibles sin iniciar sesión en los proveedores. Si el servidor no responde, se mantiene la copia local. No se consulta Solarman ni KSTAR al abrir.
- **Botón «Descargar Solarman»:** `POST /produccion` para **un día** al Worker habitual, usando `X-Panel-Key` ya configurada en el informe; el Worker guarda automáticamente A/B en el archivo central durante el lote autorizado, y el SCADA actualiza su caché local. No vacía otras claves de IndexedDB.
- **Control de cupo (22/10/2026):** **máximo un intento de actualizar Solarman cada 60 minutos por navegador/origen**, tanto manual como automático. Se guarda el momento del intento en `localStorage` **antes** de conectar; un error de red o proveedor no dispara reintentos inmediatos. Si no se puede guardar la reserva, se bloquea la consulta. El control se comparte entre pestañas y la reserva utiliza Web Locks cuando se encuentra disponible; sin soporte Web Locks no se habilita el modo automático.
- **Automático FV:** *desactivado inicialmente*, opt-in cada 60 minutos y solo mientras permanezca la pestaña abierta y visible. Activarlo, abrir el SCADA, cambiar de día o recargar **no inicia una petición**.
- **Cupo central (implementado en la PR):** el Worker distribuye **un único lote nuevo de Solarman cada 60 minutos** mediante `SOLARMAN_QUOTA`, un Durable Object SQLite con almacenamiento consistente. El cupo se comparte entre dispositivos y tanto `/produccion` como `/solarman/diagnostico`; cada reserva se persiste **antes** de llamar al proveedor. Si el DO no existe o no está disponible, **no se llama a Solarman** (503). Con cuota agotada se devuelve 429 y `Retry-After`. El último lote exitoso se conserva una hora y se puede devolver desde caché sin usar la API.
- **Implicación operativa del cupo:** el informe existente conserva sus cálculos y archivos, pero **una descarga nueva de varios rangos necesitará separar los lotes como mínimo una hora**. El SCADA puede utilizar el mismo resultado de caché cuando coincide exactamente el rango. No existe excepción para peticiones manuales del informe, para evitar que otro navegador eluda el límite.
- **Precisión del cupo:** **un lote/hora no equivale a una petición HTTP/hora**. Un lote incluye login y consultas de histórico de ambos G50KT; confirmar el consumo de llamadas internas y el presupuesto anual real de Solarman antes de activar la actualización automática en producción. No se puede garantizar un único request upstream con la API actual.
- **Despliegue de la cuota:** requiere provisionar el nuevo Durable Object (`[exports.SolarmanQuota]`, almacenamiento SQLite) al desplegar el Worker canónico de `worker/wrangler.toml`. Las previews del Worker no cuentan con acceso a secretos ni KV de producción; si no tienen binding, la adquisición falla cerrada. No desplegar sobre producción hasta las pruebas finales.
- **KSTAR:** histórico de días cerrados mediante «Descargar solo SPC» en Informe o SCADA, con selector de fecha independiente de Solarman. Se usa el Worker KSTAR aislado (si está configurado) o el Worker principal con SPC habilitado, y se guarda en el mismo archivo central sin repetir consultas al proveedor. **Nunca** hay descarga SPC automática ni cron, porque Cloudflare → proveedor continúa con riesgo HTTP sin cifrar. Usar cuenta de solo lectura limitada.
- No se envían claves por URL, ni se almacenan contraseñas de proveedor en este código.

## Pendientes para tiempo real auténtico

1. Acreditar huso horario, retardos y resolución de SPC frente a Solarman y al portal original; especialmente un día **con exportación positiva** posterior al 20/10/2026.
2. Validar el significado físico de `totalActivePower`, su escala, relación CT y signo, o solicitar un endpoint explícito con potencia instantánea y marcas de tiempo verificadas.
3. Disponer de transporte cifrado / lectura local segura de solo lectura. Mientras SPC Cloud exija HTTP con credenciales/tokens, evitar polling en producción.
4. Medir cadencia, frescura de muestras, caída de comunicaciones, alarmas y estados reales; no deducir «online» de una muestra histórica. La limitación global **ya está implementada en la PR**, pero aún falta verificarla en Cloudflare desplegado y conocer el coste por lote en el cupo anual de Solarman.
5. Chromium con **datos sintéticos** se ejecuta en CI y guarda dos capturas. Falta revisar manualmente el aspecto y contrastarlo con datos reales de Gorraiz, en especial husos horarios, exportación tras 20/10/2026 y comportamiento de la nueva cuota bajo bindings reales. Mantener la PR en borrador; ningún merge/despliegue automático.

## Pruebas

```sh
node --test tests/scada.test.mjs tests/scada-quota.test.mjs tests/solarman-quota-worker.test.mjs
node --test tests/*.test.mjs
node --check scada-data.mjs
node --check scada-app.mjs
node --check scada-quota.mjs
```

La CI también conserva la compilación / dry-run de Workers, sin despliegue. Abre `scada.html` desde el enlace **SCADA** del informe una vez fusionada la PR; mientras esté en borrador, usar una preview de la rama y comprobar que el navegador muestra las muestras existentes.

**Humo de interfaz:** `node tests/scada-browser.mjs` tras instalar Playwright/Chromium y Chart.js; exclusivamente fixtures ficticios. La CI publica `scada-gorraiz-qa-capturas` con pantallas escritorio y móvil.


## Contraste técnico FV / SPC · 21/10/2026 y otros días

La nueva pestaña **Contraste FV ↔ SPC** trabaja exclusivamente con el histórico recuperado en el navegador. No consulta a Solarman ni a KSTAR y utiliza el día seleccionado en la parte superior (aunque la vista general esté en siete días).

**Señales:** FV representa la suma AC de los inversores A+B obtenida de muestras Solarman en kW. Importación y exportación son potencias medias estimadas mediante diferencias de contadores acumulados SPC. Estos valores de red no equivalen exactamente a una muestra instantánea de Solarman. No se interpolan huecos ni saltos de contadores.

**Consumo inferido:** potencia de consumo = potencia FV + importación SPC − exportación SPC. No es medida independiente. En SCADA se representa por defecto como **estimación NO VALIDADA**, y puede ocultarse. La tabla de contraste permite desactivarlo por separado. Valores calculados inferiores a −0,2 kW se cuentan como incidencias, sin rellenarlos ni inventar consumos positivos.

**Desfase horario:** el slider permite trasladar el reloj *visual* de SPC entre −180 y +180 minutos en pasos de cinco minutos. «SPC +5 minutos» dibuja una lectura original de SPC 09:55 junto a la hora FV 10:00. El ajuste no altera IndexedDB, el Worker, los ficheros, los timestamps ni la marca de huso verificado. Los tramos desplazados fuera de los límites del día se dejan vacíos y no se arrastran de días vecinos. Un desplazamiento visual que reduzca anomalías no acredita por sí solo la sincronización real.

**Balances del día:** FV A+B procede de sus acumulados diarios Solarman; importación y exportación proceden del resumen diario de SPC. El consumo diario derivado se calcula únicamente cuando existen los tres totales y la jornada SPC es completa. También se presenta el autoconsumo FV calculado (FV menos exportación) y la diferencia con el campo autoconsumo del portal KSTAR. Esta diferencia solo es orientativa mientras no se valide el significado del campo, el alcance de ambos medidores y si existe almacenamiento.

**Limitación importante:** la identidad del balance es algebraica y no constituye por sí sola una validación de los relojes. Es necesario cotejar la hora UTC de Solarman y el reloj/configuración SPC frente a una referencia externa, y de ser posible una señal de potencia independiente. Los días de cambio horario de verano requieren tratamiento particular de los intervalos de 23 o 25 horas; los 288 intervalos nominales no deben interpretarse como cobertura real completa de esos días.

**CSV:** se exportan las casillas horarias de 5 minutos con kW, desfase exploratorio y marca «relojes certificados: NO». Si la casilla de visualización del consumo está desmarcada, la columna de consumo inferido se entrega vacía. No se descargan ni envían datos adicionales al proveedor.


## Convención de signos (22/10/2026)

- Importación de red: positiva en kW.
- Exportación de red: **negativa en las gráficas de potencia**, tarjetas de potencia y sinóptico, para que quede por debajo del eje cero. La exportación guardada en los acumulados SPC y en los totales diarios **permanece positiva en kWh**: el signo es una transformación solo de visualización.
- Consumo estimado de potencia: FV + importación + (exportación ya con signo negativo) = FV + importación − exportación (magnitud positiva del contador). Nunca restar dos veces el flujo exportado.
- Los intervalos de consumo estimado requieren simultaneidad nominal de dos inversores y SPC, sin interpolar los huecos. La opción se muestra marcada inicialmente a petición del usuario, con identificación explícita «RELOJ SIN VALIDAR». No equivale a verificar la hora, potencia del contador ni ausencia de acumulación eléctrica.
- La tarjeta de consumo indica el último par temporal con estimación disponible, no una lectura actual del edificio. El cálculo diario en kWh requiere día SPC cerrado y totales de generación más importación y exportación disponibles. No se extrapolan valores instantáneos para compensar huecos nocturnos. Los intervalos que arrojan demanda negativa menor que −0,2 kW se registran como anomalías y no se grafican como consumo.
- El CSV de contraste representa potencia exportada con signo negativo y cabecera explícita. Las series internas y los resúmenes de energía conservan magnitudes de origen positivas.


## Descarga KSTAR SPC por rango desde ambos paneles

El Informe y el SCADA tienen controles separados «SPC desde» y «Hasta». Una operación manual admite **1–14 días cerrados inclusive** y no ejecuta Solarman. El cliente manda una petición secuencial por fecha a la ruta SPC existente, que solo acepta un día por petición. Los días completos ya conservados se omiten, los parciales pueden reconsultarse, y los fallos de una fecha no borran las anteriores. El resumen indica jornadas descargadas, ya existentes, parciales, copias en histórico central y copias guardadas solo localmente. Para más de 14 días, dividir manualmente la petición en tandas; ninguna descarga se ejecuta en segundo plano. Continúa sin cron SPC por el riesgo del enlace HTTP sin cifrar hacia el portal KSTAR. Leer o representar las muestras previamente guardadas no consume peticiones Solarman.


## Instantánea coherente de potencia (22/10/2026)

Las cuatro tarjetas superiores de **generación, consumo estimado, importación y exportación** y el **sinóptico** seleccionan un solo punto temporal con el mismo algoritmo puro `coherentPowerSnapshot()`: última **casilla nominal de cinco minutos** del periodo elegido que contiene simultáneamente FV AC A+B, media de importación SPC y media de exportación SPC, y cuyo consumo calculado no sea físicamente negativo (tolerancia de −0,2 kW). Se identifica arriba la fecha y la hora concretas. Si no hay una casilla conjunta válida, las tarjetas y el sinóptico presentan valores ausentes (`—`), aunque cada proveedor tenga lecturas independientes.

**Error resuelto:** el 21/10/2026 se estaban presentando FV 0 kW y consumo estimado 35,9 kW a las 19:25 junto con importación 11,8 kW a las 23:55. Eran muestras distintas y no podían formar un balance. El algoritmo escoge el último balance admisible para la cabecera y el sinóptico, y enseña por separado una línea «últimas lecturas individuales, NO comparables entre sí» con ambas horas. La opción de ocultar el consumo estimado sigue activa y no cambia los otros valores.

**Separación física de magnitudes:** las tarjetas superiores muestran solo kW de una misma casilla. El **autoconsumo diario SPC en kWh** se ha trasladado a la sección «Balance de energía del último día seleccionado», fechada expresamente y basada en acumulados, junto a generación, importación, exportación y consumo derivado diarios. Ningún valor diario se confunde con potencia instantánea. El diseño conserva cuatro tarjetas equilibradas en escritorio y dos por fila en resoluciones reducidas.

**Limitación deliberada:** mismo índice en rejilla de 5 min no prueba sincronización real entre relojes Solarman y SPC. FV es una muestra instantánea, mientras la potencia SPC es media del intervalo por diferencias de acumulados. Las tarjetas nunca se etiquetan como telemetría en vivo y no se modifica nada del Worker, de IndexedDB o de las cuotas de las APIs. Los registros originales y las curvas históricas permanecen inalterados.

## Dos sinópticos independientes · potencia y energía

La **vista general del SCADA** dispone de dos sinópticos diferenciados:

**Sinóptico de potencia (kW).** Presenta la última casilla nominal de cinco minutos con ambas medidas FV A+B (potencia instantánea AC de Solarman) y los flujos de importación/exportación del SPC (medias por intervalo derivadas de contadores). Las cuatro tarjetas superiores utilizan exactamente la misma casilla; las últimas lecturas independientes, que pueden proceder de horas distintas, se muestran aparte. El signo de potencia de exportación es negativo. El consumo P_FV + P_import − P_export es una **estimación visual**, no una medida real y no implica relojes sincronizados. Si falta una fuente o el balance es incompatible, no se fabrica una instantánea.

**Sinóptico de energía (kWh).** Utiliza energías diarias de origen: último valor diario de cada inversor Solarman (FV A+B) y resumen del día del SPC para importación y exportación. En lugar de dibujar una secuencia físicamente engañosa «FV generada → FV autoconsumida → consumo», enseña **dos ecuaciones separadas**: (1) generación FV − exportación = FV autoconsumida; (2) FV autoconsumida + importación = consumo derivado. El autoconsumo aparece en ambas filas como la **misma cantidad**, no se vuelve a sumar ni se registra dos veces. Se exige una jornada cerrada con SPC conciliado, ambos inversores con energía diaria identificada y balance físicamente admisible. Los kWh exportados siguen positivos porque son magnitudes de contador.

Si está seleccionada la vista de **7 días**, el balance de energía incluye **solo la intersección de días con FV A+B y SPC cerrado/conciliado**. La producción generada en toda la selección se informa también, pero en un recuadro separado y con su propio número de jornadas cubiertas: nunca se resta exportación de tres días a producción de siete. En el día en curso, la generación FV puede figurar como parcial, pero no forma parte de un balance diario cerrado.

El mismo sinóptico informa el **último total acumulado A+B** si ambos inversores tienen un registro de energía acumulada de la misma jornada a menos de 30 minutos; se muestra como lectura del contador, no como producción histórica inferida a partir de una muestra parcial. Si no hay dos acumulados compatibles, el valor queda vacío y se explica por qué.

La discrepancia entre el campo selfConsumptionKWh comunicado por el portal SPC y la energía FV autoconsumida derivada permanece como dato para contrastar; no se presume que los dos campos tengan el mismo alcance. El balance tampoco acredita sincronismo horario ni la ausencia de almacenamiento. Este cambio no agrega llamadas a Solarman/SPC, ni modifica los datos originales ni el control de cuotas.

## Diagnóstico local de huecos de Solarman A/B

En «Huecos de curvas» se añade una tabla para **el día seleccionado** (también si la gráfica general muestra siete días). Reproduce el criterio de casilla de cinco minutos que utiliza `buildSeries` para crear la curva total FV. Delimita la ventana desde la primera hasta la última casilla con potencia válida simultánea de ambos inversores, **sin contar la noche como hueco**.

Cada hueco queda clasificado como ausencia de fila válida A/B, falta de los dos, lectura existente sin potencia validada o presencia de filas de energía sin potencia. Se marcan como **posibles** diferencias de casilla cuando existe una medida válida del inversor que falta en ±5 minutos; esta proximidad NO demuestra desincronización.

La tabla presenta hasta 80 huecos y «Exportar diagnóstico CSV» descarga todas las incidencias del día, con el estado de cada inversor, **sin consumir llamadas a Solarman ni SPC**. Solo inspecciona la copia del navegador recuperada del histórico central; «sin fila» no significa que el inversor o la plataforma de origen dejaran de medir. Para atribuir el corte al firmware, datalogger, nube o ingestión hace falta consultar el registro original de Solarman con trazabilidad temporal. No se interpolan huecos, no se modifica IndexedDB ni se alteran acumulados de energía.
