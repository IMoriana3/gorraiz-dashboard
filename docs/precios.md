# Precios de factura y ahorro de autoconsumo

## Qué se calcula

El módulo `energia.js` separa el balance energético del precio. Solo valora días cerrados con generación de los dos inversores e importación/exportación del SPC:

```text
autoconsumo = generación Solarman − exportación SPC
consumo del edificio = importación SPC + autoconsumo
precio medio = término de energía de la factura / kWh importados facturados
ahorro de energía estimado = autoconsumo × precio medio
ahorro con IE = ahorro de energía × (1 + IE)
flujo de caja con IVA = ahorro con IE × (1 + IVA)
```

La instalación se considera sin batería y con el mismo perímetro de medición. Si la exportación supera la generación, el día se marca como incoherente; no se oculta mediante un recorte a cero. Los periodos incompletos se presentan con su cobertura. La generación y el intercambio deben compararse en el mismo día local de la instalación.

Los acumulados diarios de ambos inversores deben cubrir el cierre del día. La presencia de una muestra de cada inversor no demuestra por sí sola que un XLSX recortado contenga toda la producción; hay que importar o descargar el día completo. Los días SPC guardados mientras estaban abiertos siguen siendo parciales hasta que se vuelven a consultar cerrados.

El precio medio de una factura indexada es una **aproximación**: el perfil de compra puede tener un precio diferente del perfil solar. Además, si un concepto de gestión no incluye fórmula contractual, el cociente no demuestra que cada componente sea marginal por kWh. Para una valoración exacta harían falta las condiciones contractuales y los precios aplicables a cada intervalo de autoconsumo.

Los precios por P1–P6 que solo correspondan a peajes/cargos no se usan como precio completo. Potencia, alquiler, financiación diaria y otros costes fijos se mantienen fuera del ahorro automático. El IVA se muestra aparte: el panel no determina si el titular lo recupera. El ingreso de excedentes queda **sin valorar** hasta disponer de sus condiciones económicas; ausencia de crédito en una factura no prueba un precio contractual de cero.

## Configuración privada

El JSON se importa y conserva en el navegador. No se manda al Worker, al almacén compartido ni a GitHub. El siguiente ejemplo es ficticio:

```json
{
  "version": 1,
  "currency": "EUR",
  "method": "invoice-average",
  "label": "Precios medios de factura",
  "periods": [
    {
      "from": "2026-05-01",
      "to": "2026-05-31",
      "importKWh": 1000,
      "energyEUR": 200,
      "ie": 0.05,
      "vat": 0.21,
      "source": "Factura de ejemplo, página 2"
    }
  ],
  "notes": ["Ejemplo ficticio; sustituir por datos comprobados de factura."]
}
```

`from` y `to` son inclusivos. Los periodos no pueden solaparse. Los impuestos son fracciones (`0.21`, no `21`). El programa calcula el precio a partir de los importes originales, conserva la precisión interna y redondea al mostrarlo.

Por defecto no aplica precios a fechas fuera de la factura. La opción de usar el último precio para fechas posteriores requiere marcarla expresamente y muestra cuántos días se han valorado así. No rellena huecos intermedios ni periodos anteriores.

## Alcance de los resultados

- Los totales de energía se calculan sobre los mismos días con balance completo.
- Los importes se calculan sobre el subconjunto que, además, tiene precio. El informe presenta ambas coberturas.
- Un dato ausente devuelve `null` y se muestra como no disponible; un cero medido sigue siendo cero.
- La energía exportada no es energía perdida por limitación del inversor. No se estima generación que el antivertido haya impedido producir.
- La exportación **diaria** no se distribuye artificialmente por horas. Si los intervalos acumulados KSTAR cumplen continuidad y reconciliación, `spc-horario.js` ofrece un reparto **aproximado** de kWh P1-P6 según la [Circular 3/2020 (CNMC/BOE)](https://www.boe.es/buscar/act.php?id=BOE-A-2020-1066). Se excluyen intervalos incompletos y días de cambio horario. No se calculan euros por periodo sin precios indexados reales por hora.
- El módulo no calcula automáticamente una compensación regulada, límites de compensación, monedero ni impuestos de una venta de energía.

Para revisar el cálculo: `node --test tests/energia.test.mjs`. Las pruebas utilizan cifras ficticias, no facturas de clientes.
