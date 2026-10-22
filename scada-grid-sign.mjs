// Convención de flujo de potencia SCADA (solo presentación):
// importación de red positiva, exportación negativa.
// Los contadores de exportación y los totales diarios en kWh conservan
// siempre la magnitud positiva del proveedor.
// NO volver a restar el signo exportado dentro del balance físico.
export function signedExportKW(value){
 if(value===null||value===undefined||!Number.isFinite(value))return null;
 return value>0?-value:0;
}
export function signedExportSeries(values){
 return (Array.isArray(values)?values:[]).map(signedExportKW);
}
