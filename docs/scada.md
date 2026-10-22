# SCADA Gorraiz · Contrato operativo (PR #53)

## Alcance implementado

La vista \`scada.html\` lee el mismo IndexedDB \`gorraiz_datos/fuentes\` del generador de informes. No crea otra fuente de verdad. \`scada-data.mjs\` normaliza las series y \`scada-app.mjs\` representa el sinóptico y las gráficas. No se han modificado los Workers ni el informe PDF.

| Señal visual | Origen | Tipo de dato |
|---|---|---|
| Generación FV (kW) | Solarman: \`APo_t1\` de los dos G50KT, suma solo de muestras simultáneas | Medida de potencia AC |
| Inversor A y B (kW) | Solarman: \`pot\` del histórico local | Medida de potencia AC |
| Importación (kW) | \`positiveActiveElec\` KSTAR | Potencia **media estimada por intervalo** entre contadores en kWh |
| Exportación (kW) | \`reverseActiveElec\` KSTAR | Potencia **media estimada por intervalo** entre contadores en kWh |
| Consumo (kW) | Generación + importación − exportación | **Derivación** solo con muestras emparejables; por defecto no se mezcla el reloj SPC sin validar |
| Autoconsumo (kWh) | \`daily.selfConsumptionKWh\` SPC | Energía diaria; **no** potencia instantánea |
| Balance diario (kWh) | Producción diaria de ambos inversores y resumen SPC del mismo día | Derivado; parcial para días en curso |

La instalación cuenta con **123,84 kWp DC** y **2 × 50 kW AC nominales**; el render de concepto que mostraba cientos de kW no son datos reales ni límites del sistema. Las tarjetas no deben mostrar valores de ejemplo.

## Restricciones de integridad

1. **Ninguna medida a cero por ausencia de datos:** se representa con \`null\`, etiqueta «—» y hueco gráfico (\`spanGaps:false\`).
2. **SPC requiere** día \`meta.completo=true\`, datos de medidor único (o metadato sin recuento) y conciliación del incremento primero–último de contadores con el resumen diario (desviación máxima: mayor de 1 kWh y 2 % del total).
3. Se descartan diferencias negativas, reinicios de contador, intervalos inferiores a 2 o superiores a 10 minutos y picos físicamente anómalos. No se interpolan huecos ni se reparte energía diaria ficticiamente entre horas.
4. La marca de tiempo SPC **no tiene huso verificado**. La curva KSTAR usa la hora literal de su dispositivo, señalando esa limitación. El consumo horario permanece sin curva hasta \`timezoneVerified=true\`, salvo si el usuario activa expresamente el *cruce provisional*. Esa opción es **solo visual** y no altera el informe ni declara válida la medida.
5. \`totalActivePower\` no se utiliza como kW porque no se han validado escala, signo ni transformadores de corriente.
6. Las tarjetas de equipo indican **disponibilidad de muestra**, no salud real, órdenes de control ni enlace en línea confirmado.
7. Las gráficas **24 h** y **7 días** comparten resolución nominal de 5 minutos y conservan muestras faltantes. Las transiciones DST deben estudiarse antes de afirmar que los relojes de ambas fuentes se encuentran reconciliados; el período seleccionado se representa por reloj civil y no se pretende certificar el número real de minutos de los días de cambio horario.

## Adquisición y límites de refresco

- **Inicial:** IndexedDB local, que comparte el informe existente. Si no hay datos, no hay valores artificiales ni llamadas automáticas.
- **Botón «Actualizar Solarman»:** \`POST /produccion\` para **un día** al Worker habitual, usando \`X-Panel-Key\` ya configurada en el informe; guarda únicamente dos claves \`A|SCADA Solarman AAAA-MM-DD\` y \`B|...\`. No vacía otras claves de IndexedDB.
- **Automático FV:** opt-in cada 5 minutos, mientras la pestaña permanezca abierta/visible. No significa telemetría a segundos ni acceso al medidor de red.
- **KSTAR:** únicamente histórico de **días cerrados**, previamente descargado desde el informe. No se consulta KSTAR desde la vista SCADA, ni se activa cron. La conexión SPC por HTTP hacia el proveedor sigue sin cifrado, de modo que no se autoriza un sondeo en tiempo real sin solucionar primero ese riesgo.
- No se envían claves por URL, ni se almacenan contraseñas de proveedor en este código.

## Pendientes para tiempo real auténtico

1. Acreditar huso horario, retardos y resolución de SPC frente a Solarman y al portal original; especialmente un día **con exportación positiva** posterior al 20/10/2026.
2. Validar el significado físico de \`totalActivePower\`, su escala, relación CT y signo, o solicitar un endpoint explícito con potencia instantánea y marcas de tiempo verificadas.
3. Disponer de transporte cifrado / lectura local segura de solo lectura. Mientras SPC Cloud exija HTTP con credenciales/tokens, evitar polling en producción.
4. Medir cadencia, frescura de muestras, caída de comunicaciones, alarmas y estados reales; no deducir «online» de una muestra histórica.
5. Verificar el aspecto con Chromium y datos locales reales antes de solicitar merge. Mantener la PR en borrador hasta terminar.

## Pruebas

\`\`\`sh
node --test tests/scada.test.mjs
node --test tests/*.test.mjs
node --check scada-data.mjs
node --check scada-app.mjs
\`\`\`

La CI también conserva la compilación / dry-run de Workers, sin despliegue. Abre \`scada.html\` desde el enlace **SCADA** del informe una vez fusionada la PR; mientras esté en borrador, usar una preview de la rama y comprobar que el navegador muestra las muestras existentes.
