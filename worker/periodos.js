// ═══════════════════════════════════════════════════════════════════
// Periodos tarifarios P1–P6 (3.0TD / 6.1TD, peninsular)
//
// Datadis NO devuelve el periodo tarifario en los datos de consumo: el
// fichero de i-DE sí lo traía, así que hay que calcularlo aquí para que
// el reparto del ahorro por periodo siga saliendo igual.
//
// Calendario de la Circular 3/2020 de la CNMC (mismo para 3.0TD y 6.1TD):
//   · Sábados, domingos y festivos nacionales: P6 las 24 h.
//   · Días laborables, horas 0–8: P6.
//   · Días laborables, resto de horas, según temporada del mes:
//        alta        (ene feb jul dic) → punta P1 / llano P2
//        media-alta  (mar nov)         → punta P2 / llano P3
//        media       (jun ago sep)     → punta P3 / llano P4
//        baja        (abr may oct)     → punta P4 / llano P5
//     punta = 9–14 y 18–22 · llano = 8–9, 14–18 y 22–24
// ═══════════════════════════════════════════════════════════════════

// Temporada por mes (1–12) → [periodo punta, periodo llano]
const TEMPORADA = {
  1:[1,2], 2:[1,2], 12:[1,2], 7:[1,2],        // alta
  3:[2,3], 11:[2,3],                          // media-alta
  6:[3,4], 8:[3,4], 9:[3,4],                  // media
  4:[4,5], 5:[4,5], 10:[4,5],                 // baja
};

// OJO con la zona horaria: el Worker corre en UTC, pero Datadis entrega fecha y
// hora ya en hora peninsular. Por eso aquí NUNCA se construye una fecha local:
// se trabaja con los componentes (año, mes, día, hora) tal cual vienen, y el día
// de la semana se saca en UTC, que para una fecha sin hora es estable.
function diaSemana(y,m,d){return new Date(Date.UTC(y,m-1,d)).getUTCDay()}

// Domingo de Pascua (algoritmo de Meeus/Jones/Butcher) → Viernes Santo = -2 días
function pascua(y){
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,
        f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,
        i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
        mes=Math.floor((h+l-7*m+114)/31),dia=((h+l-7*m+114)%31)+1;
  return new Date(Date.UTC(y,mes-1,dia));
}

// Festivos nacionales no sustituibles. Los autonómicos y locales NO cuentan
// para el calendario tarifario, solo estos.
const FIJOS=['01-01','01-06','05-01','08-15','10-12','11-01','12-06','12-08','12-25'];
const cacheFest={};
function festivos(y){
  if(cacheFest[y])return cacheFest[y];
  const s=new Set(FIJOS);
  const vs=new Date(pascua(y).getTime()-2*864e5);              // Viernes Santo
  s.add(String(vs.getUTCMonth()+1).padStart(2,'0')+'-'+String(vs.getUTCDate()).padStart(2,'0'));
  return cacheFest[y]=s;
}

// (año, mes 1-12, día, hora 0-23) en hora peninsular → 'P1'...'P6'
function periodo(y,mes,dia,h){
  const dow=diaSemana(y,mes,dia);
  const md=String(mes).padStart(2,'0')+'-'+String(dia).padStart(2,'0');
  if(dow===0||dow===6||festivos(y).has(md))return 'P6';
  if(h<8)return 'P6';
  const [punta,llano]=TEMPORADA[mes];
  const esPunta=(h>=9&&h<14)||(h>=18&&h<22);
  return 'P'+(esPunta?punta:llano);
}

export {periodo,pascua,festivos,diaSemana};
