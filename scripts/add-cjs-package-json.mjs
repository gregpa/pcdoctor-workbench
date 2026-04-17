// Writes a tiny package.json into dist-electron/ so Node/Electron treats the
// bundled main + preload as CommonJS even though the project root is
// "type": "module" (which we need for Vitest + ESM dev tooling).
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.cwd(), 'dist-electron', 'package.json');
const dir = resolve(process.cwd(), 'dist-electron');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(target, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log('[postbuild] wrote', target);
