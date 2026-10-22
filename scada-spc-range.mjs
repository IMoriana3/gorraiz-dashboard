// SPC01: validación de rangos manuales sin consultar APIs.
// El proveedor KSTAR acepta solo un día por petición. El navegador puede
// secuenciar hasta 14 días cerrados, cada uno por separado.
export const SPC_MANUAL_MAX_DAYS=14;
const valid=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&
  Number.isFinite(Date.parse(d+'T00:00:00Z'))&&
  new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export function spcManualRange(desde,hasta,hoyMadrid){
 if(!valid(desde)||!valid(hasta)||!valid(hoyMadrid)||desde>hasta)
   throw new Error('Selecciona dos fechas válidas y ordenadas (Desde/Hasta).');
 if(hasta>=hoyMadrid)throw new Error('SPC solo permite días cerrados, anteriores a hoy en Madrid.');
 const start=Date.parse(desde+'T00:00:00Z'),
   count=1+Math.round((Date.parse(hasta+'T00:00:00Z')-start)/86400000);
 if(count>SPC_MANUAL_MAX_DAYS)throw new Error(
   'El rango SPC supera 14 días naturales. Divídelo en tandas manuales de como máximo 14 días.');
 return Array.from({length:count},(_,i)=>
   new Date(start+i*86400000).toISOString().slice(0,10));
}
