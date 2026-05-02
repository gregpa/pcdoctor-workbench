import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';

const aliases = {
  '@shared': path.resolve(__dirname, 'src/shared'),
  '@main': path.resolve(__dirname, 'src/main'),
  '@renderer': path.resolve(__dirname, 'src/renderer'),
};

export default defineConfig({
  root: '.',
  resolve: {
    alias: aliases,
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/main.ts',
        vite: {
          resolve: {
            alias: aliases,
          },
          build: {
            outDir: 'dist-electron/main',
            lib: {
              entry: 'src/main/main.ts',
              formats: ['cjs'],
              fileName: () => '[name].cjs',
            },
            rollupOptions: {
              external: ['better-sqlite3', 'electron', 'node-pty'],
              output: {
                // v2.5.22: explicit format:'cjs' + inlineDynamicImports.
                // Pre-2.5.22 only `lib.formats: ['cjs']` was set. That worked
                // for full `vite build` runs but vite-plugin-electron's
                // dev-mode incremental rebuilds split the entry on dynamic
                // imports and emitted the entry stub as ESM (`import "electron"`)
                // even though the chunks were CJS. The mismatched stub crashed
                // Electron on reload with "Cannot use import statement outside
                // a module" because dist-electron/package.json forces `.cjs`
                // extension to be treated as CommonJS. Mirror what preload
                // already does (explicit `format: 'cjs'`) and inline dynamic
                // imports so there is no chunk split for the bundler to drop
                // an ESM facade onto.
                format: 'cjs',
                inlineDynamicImports: true,
                entryFileNames: '[name].cjs',
                chunkFileNames: '[name].cjs',
              },
            },
          },
        },
      },
      preload: {
        input: 'src/preload/preload.ts',
        vite: {
          resolve: {
            alias: aliases,
          },
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: ['electron'],
              output: {
                format: 'cjs',
                entryFileNames: '[name].cjs',
                chunkFileNames: '[name].cjs',
              },
            },
          },
        },
      },
    }),
  ],
  build: {
    outDir: 'dist',
  },
});
