# Informe FV — Edificio Gorraiz

Generador de **informes fotovoltaicos en el navegador** para la instalación de
autoconsumo del Edificio Gorraiz (**123,84 kWp · autoconsumo SIN excedentes**).
Replica el PDF aprobado de 5 páginas a partir de los ficheros de producción de
los inversores y de consumo, y permite comparar dos periodos.

Funciona **100 % en el cliente**: no hay backend ni base de datos. Todo el
procesado ocurre en el navegador y la app está desplegada en GitHub Pages.

🔗 **App:** https://imoriana3.github.io/gorraiz-dashboard

## ✨ Funcionalidades

- **Carga de datos `.xlsx`:**
  - Inversor A — ficheros de producción (uno o varios)
  - Inversor B — ficheros de producción (uno o varios)
  - Consumo horario de i-DE (hoja `Horarias`)
- **Informe de 5 páginas:**
  1. Producción
  2. Inversores
  3. Consumo
  4. Acumulados
  5. Avanzado
- **Exportación a PDF** apaisado (A4 horizontal) de las 5 páginas.
- **Comparativa entre dos periodos** (A vs B) con 3 vistas — KPIs, Producción y
  Económico — y su propio PDF de 3 páginas.
- **Datos meteorológicos** vía Open-Meteo (GHI medio, horas de sol y temperatura
  media), con conversión de unidades.
- **Cálculo de ahorro** cruzando la producción horaria con los precios por
  periodo tarifario **P1–P6** (incluye Impuesto Eléctrico e IVA).
- Métricas de rendimiento (kWh/kWp).

## 🚀 Uso

1. Abre la app: https://imoriana3.github.io/gorraiz-dashboard
2. Sube los `.xlsx` de producción (Inversor A / B) y el de consumo de i-DE
   (hoja `Horarias`).
3. Pulsa **⚡ Generar informe** y revisa las 5 páginas.
4. Pulsa **📄 Descargar PDF (5 páginas)** para exportar el informe.
5. *(Opcional)* En la sección **Comparativa entre dos periodos**, define el
   Periodo A y el Periodo B y pulsa **⚡ Generar comparativa**; podrás descargar
   también su PDF de 3 páginas.

## 🛠️ Tecnologías

- HTML/CSS/JS sin framework (un único `index.html`)
- [SheetJS (xlsx)](https://sheetjs.com/) — lectura de ficheros `.xlsx`
- [Chart.js](https://www.chartjs.org/) — gráficas
- [jsPDF](https://github.com/parallax/jsPDF) + [html2canvas](https://html2canvas.hertzen.com/) — exportación a PDF
- [Open-Meteo API](https://open-meteo.com/) — datos meteorológicos
- GitHub Pages — despliegue

## 📁 Ficheros de entrada

| Fuente        | Formato | Notas                                   |
|---------------|---------|-----------------------------------------|
| Inversor A    | `.xlsx` | Producción; admite varios ficheros      |
| Inversor B    | `.xlsx` | Producción; admite varios ficheros      |
| Consumo i-DE  | `.xlsx` | Hoja `Horarias` (consumo horario)       |

## ⚠️ Notas

- Modalidad **autoconsumo sin excedentes**: el consumo total = red + FV.
- El ahorro emplea los precios por periodo P1–P6 configurados en la app (con un
  valor por defecto si falta alguno).
- Los datos **no se envían a ningún servidor**; el procesado es local en el
  navegador.
