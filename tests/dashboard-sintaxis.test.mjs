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
  assert.match(html,/sessionStorage\.setItem\(KSTAR_SESSION_KEY/);
  assert.match(html,/if\(KSTAR_ONLY\)return \{hourly:\[\],daily:\[\]\}/);
  assert.match(html,/spcPeriodos=detalle/);
});
