import { defineConfig } from 'vite';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  root:'src/renderer',base:'./',
  plugins:[tailwindcss()],
  resolve:{alias:{'@':path.resolve('src/renderer')}},
  build:{outDir:path.resolve('.vite/renderer/main_window'),emptyOutDir:true,sourcemap:true},
  // Let Windows choose an available port; 5173 can fall in a TCP exclusion range.
  // Forge injects the actual listening URL into the main-process bundle.
  server:{host:'127.0.0.1',port:0}
});
