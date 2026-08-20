// Genera bundle.js: un único fichero para pegar en el editor web de
// Cloudflare, para quien no pueda usar wrangler desde su equipo.
// Uso: node construir.mjs
import {readFileSync,writeFileSync} from 'node:fs';

const per=readFileSync(new URL('./periodos.js',import.meta.url),'utf8')
  .replace(/^export\s*\{[^}]*\};?\s*$/m,'')          // fuera el export
  .trim();
const idx=readFileSync(new URL('./index.js',import.meta.url),'utf8')
  .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/periodos\.js';\s*$/m,'')  // fuera el import
  .trim();

const cab=`// ═══════════════════════════════════════════════════════════════════════════
// GENERADO AUTOMÁTICAMENTE — no editar a mano.
// Es index.js + periodos.js en un solo fichero, para pegarlo en el editor web
// de Cloudflare cuando no se puede usar wrangler desde el equipo.
// Para regenerarlo tras cambiar cualquiera de los dos: node construir.mjs
// ═══════════════════════════════════════════════════════════════════════════

`;
writeFileSync(new URL('./bundle.js',import.meta.url),cab+per+'\n\n'+idx+'\n');
console.log('bundle.js generado');
