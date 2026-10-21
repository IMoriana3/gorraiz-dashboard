import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('todo el JavaScript inline del dashboard es sintacticamente valido',()=>{
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const inline=scripts.map(x=>x[1]).filter(x=>x.trim());
  assert.equal(inline.length,1,'Se espera un único script inline de dashboard');
  assert.doesNotThrow(()=>new vm.Script(inline[0],{filename:'gorraiz/index.html'}));
});
test('UI KSTAR contiene conexión aislada y previene mostrar i-DE como fuente actual',()=>{
  for(const id of ['cfgKstar','spcPeriodosKwh','spcAccion','btnSpc',
    'aDesde','aHasta','btnAuto','zSpc','zPrecios'])
    assert.match(html,new RegExp('id="'+id+'"'),id);
  assert.match(html,/spc-horario\.js/);
  assert.match(html,/KSTAR_ONLY=true/);
  assert.match(html,/kstarCall\(bl\[i\]\.desde,bl\[i\]\.hasta\)/);
  assert.match(html,/!KSTAR_ONLY&&est\.datadis/);
  // La clave de KSTAR se guarda en este equipo, como la del Worker principal,
  // y se sigue leyendo la antigua de sesión para no perderla a media sesión.
  assert.match(html,/localStorage\.setItem\(KSTAR_CLAVE_KEY,clave\)/);
  assert.match(html,/localStorage\.getItem\(KSTAR_CLAVE_KEY\)\|\|sessionStorage\.getItem\(KSTAR_SESSION_KEY\)/);
  assert.match(html,/if\(KSTAR_ONLY\)return \{hourly:\[\],daily:\[\]\}/);
  assert.match(html,/spcPeriodos=detalle/);
});
test('las graficas entran en el PDF compuestas sobre blanco, no sobre el negro del JPEG',()=>{
  // JPEG no guarda transparencia y el navegador compone lo transparente sobre
  // negro. Los lienzos de Chart.js no pintan fondo, asi que codificarlos
  // directamente metia cada grafica del informe en un recuadro negro.
  assert.match(html,/function pdfLienzoBlanco\(cv\)/);
  const fn=html.match(/function pdfLienzoBlanco\(cv\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn,/fillStyle='#ffffff'/);
  assert.match(fn,/fillRect\(0,0,off\.width,off\.height\)/);
  assert.ok(fn.indexOf('fillRect')<fn.indexOf('drawImage'),
    'hay que pintar el blanco antes de volcar el lienzo encima');
  assert.match(html,/doc\.addImage\(pdfLienzoBlanco\(cv\),'JPEG'/);
  // Nadie mas puede codificar un lienzo en JPEG sin pasar por ahi.
  assert.equal((html.match(/toDataURL\('image\/jpeg'/g)||[]).length,1,
    'el unico toDataURL JPEG debe ser el de pdfLienzoBlanco');
  // El mapa de calor si pinta su propio fondo oscuro y se queda en PNG.
  assert.match(html,/doc\.addImage\(cv\.toDataURL\('image\/png'\),'PNG'/);
});
test('las cuatro graficas que ignoraban el vertido ya lo pintan',()=>{
  // Media por dia de semana: en pila aparte, porque importacion + autoconsumo
  // ES el consumo y meter el vertido dentro rompe esa lectura.
  assert.match(html,/\{label:'Vertido',data:R\.weekly\.map\(w=>w\.export\),backgroundColor:'#5c95cf',stack:'v'\}/);
  assert.match(html,/\{label:'Autoconsumo',data:R\.weekly\.map\(w=>w\.pv\),backgroundColor:'#d4a039',stack:'a'\}/);
  // Perfil horario: cada serie de red con su pareja de vertido, en discontinuo.
  for(const s of ['vLV','vS','vD'])
    assert.match(html,new RegExp("data:R\\.hpCons\\."+s+",borderColor:'#[0-9a-f]{6}',borderDash:\\[4,2\\]"),s);
  // Donut de tres porciones.
  assert.match(html,/labels:\['Autoconsumo','Importación','Vertido'\]/);
  assert.match(html,/data:\[R\.tPV,R\.tR,R\.tExport\]/);
  // Perfil de dia laborable de la pagina del historico.
  assert.match(html,/data:an\.perfil\.map\(p=>p\.vert\)/);
  // El nombre «Cobertura FV» se reserva para el recuadro del porcentaje: el
  // donut ya no suma el consumo, asi que no puede llamarse igual.
  assert.match(html,/<h4>Reparto de energía<\/h4>/);
  assert.equal((html.match(/'Cobertura FV'/g)||[]).length,1,
    'solo el KPI del porcentaje conserva el nombre');
  // El corte del vertido tiene un unico juez, compartido por balance y perfil.
  assert.match(html,/function vertidoCuenta\(date\)/);
  assert.match(html,/if\(vertidoCuenta\(d\.date\)\)return d;/);
  assert.match(html,/vertidoCuenta\(spcFecha\(dk\(r\.ts\)\)\)\?Math\.max\(0,r\.gen\):0/);
});
