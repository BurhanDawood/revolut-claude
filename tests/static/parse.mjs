// T1: a full acorn parse of server.js (ES module, latest syntax) - stricter than `node --check` about the whole file being one
// valid module. acorn is NOT a dependency of the app: CI installs it outside the repo and passes ACORN_PATH (package.json is untouched,
// because Railway redeploys on any package.json change). Exit 0 parsed, 1 syntax error, 3 acorn not available.
// Run: node tests/static/parse.mjs   (or ACORN_PATH=/path/to/node_modules/acorn node tests/static/parse.mjs)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { SERVER } from '../lib.mjs';

const req = createRequire(import.meta.url);
let acorn = null;
for (const p of [process.env.ACORN_PATH, 'acorn'].filter(Boolean)) { try { acorn = req(p); break; } catch (e) { /* next */ } }
if (!acorn) { console.log('acorn parse: SKIP (acorn not installed; set ACORN_PATH)'); process.exit(3); }
const src = readFileSync(SERVER, 'utf8');
try {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
  console.log('acorn parse: PASS  server.js (' + src.split('\n').length + ' lines, ' + ast.body.length + ' top-level statements, acorn ' + acorn.version + ')');
} catch (e) {
  console.log('acorn parse: FAIL  server.js: ' + e.message + (e.loc ? ' (line ' + e.loc.line + ', column ' + e.loc.column + ')' : ''));
  process.exit(1);
}
