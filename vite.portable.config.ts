import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

/** A single copyable Node ESM helper, also shipped inside the application archive. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  build: {
    target: 'node24', outDir: '.vite/build', emptyOutDir: false, sourcemap: false, minify: false,
    lib: { entry: 'src/runner/portable.ts', formats: ['es'], fileName: () => 'portable-runner.mjs' },
    rolldownOptions: { external: [...builtinModules, ...builtinModules.map(name => 'node:' + name)] },
  },
});
