// Selección temporal coherente para las tarjetas y el sinóptico del SCADA.
// Nunca se mezclan los valores "últimos" de Solarman y KSTAR medidos a horas
// distintas. Se utiliza la última casilla nominal de 5 minutos que contiene
// FV A+B y los dos flujos medios del SPC, con consumo físicamente plausible.
// Un mismo índice NO certifica sincronismo de relojes ni equivalencia entre
// potencia FV instantánea y potencia media deducida de contadores SPC.
const finite=value=>typeof value==='number'&&Number.isFinite(value);

export function coherentPowerSnapshot(result){
 const keys=result?.keys||[],v=result?.series||{},n=keys.length;
 for(let i=n-1;i>=0;i--){
  const generation=v.generation?.[i],importKW=v.import?.[i],exportKW=v.export?.[i];
  if(!finite(generation)||!finite(importKW)||!finite(exportKW))continue;
  if(generation<0||importKW<0||exportKW<0)continue;
  const rawLoad=generation+importKW-exportKW;
  // No mostrar una falsa instantánea si el balance calculado resulta
  // incompatible: se busca la última casilla anterior utilizable.
  if(!finite(rawLoad)||rawLoad< -0.2)continue;
  const date=keys[i]?.slice(0,10);
  if(!date)continue;
  const day=result.gridState?.[date];
  return {
   index:i,key:keys[i],date,time:keys[i].slice(11,16),
   generation,importKW,exportKW,
   signedExportKW:exportKW===0?0:-exportKW,
   consumptionKW:Math.max(0,rawLoad),
   gridClockVerified:day?.ready===true&&day.meta?.timezoneVerified===true
  };
 }
 return null;
}
export function independentLatestTimes(result){
 const lasts=result?.last||{};
 const solar=lasts.generation?.key||null;
 const grid=lasts.import?.key||lasts.export?.key||null;
 const gridExport=lasts.export?.key||null;
 return {solar,grid,gridExport};
}
