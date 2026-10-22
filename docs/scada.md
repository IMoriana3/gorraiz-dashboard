# SCADA Gorraiz · Contrato operativo (PR #53)

## Alcance implementado

El SCADA y el Informe comparten el **archivo central SQLite de Gorraiz** en el Worker, reutilizando el Durable Object `SOLARMAN_QUOTA`. `gorraiz_datos/fuentes` (IndexedDB) permanece como caché local, no como única fuente de verdad. `scada-data.mjs` normaliza las series, `scada-app.mjs` las representa y `scada-sync.mjs` recupera, copia y guarda el histórico. El informe PDF mantiene sus cálculos actuales. Contrato y límites: [histórico compartido](historico-compartido.md).

| Señal visual | Origen | Tipo de dato |
|---|---|---|
| Generación FV (kW) | Solarman: `APo_t1` de los dos G50KT, suma solo de muestras simultáneas | Medida de potencia AC |
| Inversor A y B (kW) | Solarman: `pot` del histórico local | Medida de potencia AC |
| Importación (kW) | `positiveActiveElec` KSTAR | Potencia **media estimada por intervalo** entre contadores en kWh |
| Exportación (kW) | `reverseActiveElec` KSTAR | Potencia **media estimada por intervalo** entre contadores en kWh |
| Consumo (kW) | Generación + importación − exportación | **Derivación** solo con muestras emparejables; por defecto no se mezcla el reloj SPC sin validar |
| Autoconsumo (kWh) | `daily.selfConsumptionKWh` SPC | Energía diaria; **no** potencia instantánea |
| Balance diario (kWh) | Producción diaria de ambos inversores y resumen SPC del mismo día | Derivado; parcial para días en curso |

La instalación cuenta con **123,84 kWp DC** y **2 × 50 kW AC nominales**; el render de concepto que mostraba cientos de kW no son datos reales ni límites del sistema. Las tarjetas no deben mostrar valores de ejemplo.

## Restricciones de integridad

1. **Ninguna medida a cero por ausencia de datos:** se representa con `null`, etiqueta «—» y hueco gráfico (`spanGaps:false`).
2. **SPC requiere** día `meta.completo=true`, datos de medidor único (o metadato sin recuento) y conciliación del incremento primero–último de contadores con el resumen diario (desviación máxima: mayor de 1 kWh y 2 % del total).
3. Se descartan diferencias negativas, reinicios de contador, intervalos inferiores a 2 o superiores a 10 minutos y picos físicamente anómalos. No se interpolan huecos ni se reparte energía diaria ficticiamente entre horas.
4. La marca de tiempo SPC **no tiene huso verificado**. La curva KSTAR usa la hora literal de su dispositivo, señalando esa limitación. El consumo horario permanece sin curva hasta `timezoneVerified=true`, salvo si el usuario activa expresamente el *cruce provisional*. Esa opción es **solo visual** y no altera el informe ni declara válida la medida.
5. `totalActivePower` no se utiliza como kW porque no se han validado escala, signo ni transformadores de corriente.
6. Las tarjetas de equipo indican **disponibilidad de muestra**, no salud real, órdenes de control ni enlace en línea confirmado.
7. Las gráficas **24 h** y **7 días** comparten resolución nominal de 5 minutos y conservan muestras faltantes. Las transiciones DST deben estudiarse antes de afirmar que los relojes de ambas fuentes se encuentran reconciliados; el período seleccionado se representa por reloj civil y no se pretende certificar el número real de minutos de los días de cambio horario.

## Adquisición y límites de refresco

- **Inicial:** IndexedDB local y consulta al histórico central autorizado para recuperar días disponibles sin iniciar sesión en los proveedores. Si el servidor no responde, se mantiene la copia local. No se consulta Solarman ni KSTAR al abrir.
- **Botón «Actualizar Solarman»:** `POST /produccion` para **un día** al Worker habitual, usando `X-Panel-Key` ya configurada en el informe; el Worker guarda automáticamente A/B en el archivo central durante el lote autorizado, y el SCADA actualiza su caché local. No vacía otras claves de IndexedDB.
- **Control de cupo (22/10/2026):** **máximo un intento de actualizar Solarman cada 60 minutos por navegador/origen**, tanto manual como automático. Se guarda el momento del intento en `localStorage` **antes** de conectar; un error de red o proveedor no dispara reintentos inmediatos. Si no se puede guardar la reserva, se bloquea la consulta. El control se comparte entre pestañas y la reserva utiliza Web Locks cuando se encuentra disponible; sin soporte Web Locks no se habilita el modo automático.
- **Automático FV:** *desactivado inicialmente*, opt-in cada 60 minutos y solo mientras permanezca la pestaña abierta y visible. Activarlo, abrir el SCADA, cambiar de día o recargar **no inicia una petición**.
- **Cupo central (implementado en la PR):** el Worker distribuye **un único lote nuevo de Solarman cada 60 minutos** mediante `SOLARMAN_QUOTA`, un Durable Object SQLite con almacenamiento consistente. El cupo se comparte entre dispositivos y tanto `/produccion` como `/solarman/diagnostico`; cada reserva se persiste **antes** de llamar al proveedor. Si el DO no existe o no está disponible, **no se llama a Solarman** (503). Con cuota agotada se devuelve 429 y `Retry-After`. El último lote exitoso se conserva una hora y se puede devolver desde caché sin usar la API.
- **Implicación operativa del cupo:** el informe existente conserva sus cálculos y archivos, pero **una descarga nueva de varios rangos necesitará separar los lotes como mínimo una hora**. El SCADA puede utilizar el mismo resultado de caché cuando coincide exactamente el rango. No existe excepción para peticiones manuales del informe, para evitar que otro navegador eluda el límite.
- **Precisión del cupo:** **un lote/hora no equivale a una petición HTTP/hora**. Un lote incluye login y consultas de histórico de ambos G50KT; confirmar el consumo de llamadas internas y el presupuesto anual real de Solarman antes de activar la actualización automática en producción. No se puede garantizar un único request upstream con la API actual.
- **Despliegue de la cuota:** requiere provisionar el nuevo Durable Object (`[exports.SolarmanQuota]`, almacenamiento SQLite) al desplegar el Worker canónico de `worker/wrangler.toml`. Las previews del Worker no cuentan con acceso a secretos ni KV de producción; si no tienen binding, la adquisición falla cerrada. No desplegar sobre producción hasta las pruebas finales.
- **KSTAR:** histórico de días cerrados desde `Comprobar SPC / Traer datos` en Informe o desde el nuevo botón manual `SPC día cerrado` en SCADA. Se sube al mismo archivo central sin una nueva petición al proveedor. **Nunca** hay descarga SPC automática ni cron, porque Cloudflare → proveedor continúa con riesgo HTTP sin cifrar. Usar cuenta de solo lectura limitada.
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
