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
