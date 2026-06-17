# Gorraiz Dashboard — Informe FV Edificio Gorraiz

> Generador de informes fotovoltaicos en el navegador para el Edificio Gorraiz (123,84 kWp · autoconsumo sin excedentes): réplica del PDF aprobado de 5 páginas.

## Qué es
App **100 % cliente** (sin backend ni base de datos) que reproduce el informe FV aprobado de 5 páginas a partir de los ficheros de producción de los inversores y del consumo horario, y permite comparar dos periodos. Todo el procesado ocurre en el navegador; desplegada en GitHub Pages.

## Funcionalidades
- Carga de `.xlsx`: Inversor A y B (producción, admite varios ficheros) + Consumo i-DE (hoja `Horarias`).
- Informe de 5 páginas: Producción · Inversores · Consumo · Acumulados · Avanzado.
- **Exportación a PDF** apaisado (A4 horizontal) de las 5 páginas.
- **Comparativa entre dos periodos** (A vs B): KPIs, Producción y Económico, con su propio PDF de 3 páginas.
- Datos meteo vía Open-Meteo (GHI medio, horas de sol y temperatura) con conversión de unidades.
- Cálculo de ahorro cruzando la producción horaria con los precios por periodo tarifario **P1–P6** (Impuesto Eléctrico + IVA). Métricas de rendimiento (kWh/kWp).

## Uso
1. Abre `index.html` o el despliegue.
2. Sube los `.xlsx` de producción (Inversor A / B) y el de consumo de i-DE (hoja `Horarias`).
3. Pulsa **⚡ Generar informe** y revisa las 5 páginas.
4. **📄 Descargar PDF (5 páginas)** para exportar el informe.
5. *(Opcional)* En **Comparativa entre dos periodos**, define el Periodo A y el B y genera su PDF de 3 páginas.

## Stack
HTML/CSS/JS sin framework (un único `index.html`) · SheetJS (xlsx) · Chart.js · jsPDF + html2canvas · Open-Meteo · GitHub Pages.

## Despliegue (URL)
GitHub Pages: https://imoriana3.github.io/gorraiz-dashboard/ · `.nojekyll` incluido.

## Notas
- Cliente: **Amixalan Business Group** (Edificio Gorraiz). Modalidad autoconsumo sin excedentes (consumo total = red + FV).
- El **informe se mantiene en tema claro a propósito** para conservar la fidelidad del PDF aprobado; el chrome (barra superior / pie Factiun) es oscuro y se oculta al imprimir/exportar (`@media print`).
- Los datos **no se envían a ningún servidor**: el procesado es local en el navegador.

*Factiun · proyecto interno.*
