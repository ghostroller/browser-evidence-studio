import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({root:'src/renderer',base:'./',build:{outDir:path.resolve('.vite/renderer/main_window'),emptyOutDir:true,sourcemap:true},server:{host:'127.0.0.1'}});
