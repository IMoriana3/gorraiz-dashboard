// Unidades de potencia en fuentes históricas Gorraiz.
// La API antigua dejó APo_t1 en W; la API corregida y las copias centrales
// declaran kW explícitos. Nunca adivinar la unidad de un XLSX antiguo.
export function sourcePowerUnit(source){
 const unit=source?.unidadPotencia??source?.potUnit;
 if(['W','kW','desconocida'].includes(unit))return unit;
 const name=String(source?.nombre||source?.name||'');
 if(/^Solarman(?:\s|$)|^SCADA Solarman(?:\s|$)/i.test(name))return 'W';
 if(/^Histórico central Gorraiz$|^Compartido(?:\s|$)/i.test(name))return 'kW';
 return 'desconocida';
}
export function normalizeSourcePower(source,value){
 const raw=value===null||value===undefined||value===''?null:Number(value);
 if(raw===null||!Number.isFinite(raw))return {pot:null,potSinValidar:null};
 const unit=sourcePowerUnit(source);
 const converted=unit==='W'?raw/1000:unit==='kW'?raw:null;
 const valid=converted!==null&&converted>=0&&converted<=65;
 return valid?{pot:converted,potSinValidar:null}:
   {pot:null,potSinValidar:raw};
}
