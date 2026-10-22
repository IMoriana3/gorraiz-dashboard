// Genera bundle.js: un único fichero para pegar en el editor web de
// Cloudflare, para quien no pueda usar wrangler desde su equipo.
// Uso: node construir.mjs
import {readFileSync,writeFileSync} from 'node:fs';

const per=readFileSync(new URL('./periodos.js',import.meta.url),'utf8')
  .replace(/^export\s*\{[^}]*\};?\s*$/m,'')          // fuera el export
  .trim();
const spc=readFileSync(new URL('./spc.js',import.meta.url),'utf8')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm,'')
  .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm,'')
  .trim();
const sharedHistory=readFileSync(new URL('./shared-history.js',import.meta.url),'utf8')
  .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm,'')
  .trim();
const idx=readFileSync(new URL('./index.js',import.meta.url),'utf8')
  .replace(/^import\s*\{[^}]*\}\s*from\s*['"]\.\/(?:periodos|spc|shared-history)\.js['"];?\s*$/gm,'')
  .trim();

const cab=`// ═══════════════════════════════════════════════════════════════════════════
// GENERADO AUTOMÁTICAMENTE — no editar a mano.
// Es index.js + periodos.js + spc.js, para pegarlo en el editor web
// de Cloudflare cuando no se puede usar wrangler desde el equipo.
// Para regenerarlo tras cambiar cualquiera de ellos: node construir.mjs
// ═══════════════════════════════════════════════════════════════════════════

`;
writeFileSync(new URL('./bundle.js',import.meta.url),cab+per+'\n\n'+spc+'\n\n'+sharedHistory+'\n\n'+idx+'\n');
console.log('bundle.js generado');

const prueba = readFileSync(new URL('./kstar-prueba.js',import.meta.url),'utf8')
  .replace(/^import\s*\{[^}]*\}\s*from\s*['"]\.\/spc\.js['"];?\s*$/gm,'')
  .trim();
const pruebaHeader=`// GENERADO AUTOMÁTICAMENTE: SOLO PRUEBA AISLADA DE KSTAR SPC.
// No copiar credenciales a este fichero. Regenerar: node worker/construir.mjs

`;
writeFileSync(new URL('./kstar-prueba-bundle.js',import.meta.url),
  pruebaHeader+spc+'\n\n'+prueba+'\n');
console.log('kstar-prueba-bundle.js generado');
