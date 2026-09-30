import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
export default defineConfig({resolve:{tsconfigPaths:true},build:{target:'node24',outDir:'.vite/node',emptyOutDir:true,sourcemap:true,minify:false,
  lib:{entry:{'node-studio':'src/node/main.ts','runner-worker':'src/runner/worker.ts'},formats:['es'],fileName:(_format,name)=>name+'.js'},
  rolldownOptions:{external:['puppeteer-core','ws','vite',...builtinModules,...builtinModules.map(name=>'node:'+name)],output:{chunkFileNames:'[name]-[hash].js'}}}});
