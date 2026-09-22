import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
export default defineConfig({
  build: { outDir:'.vite/build',emptyOutDir:false,sourcemap:true,minify:false,
    lib:{entry:{index:'src/main/app.ts','runner-worker':'src/runner/worker.ts'},formats:['cjs'],fileName:(_format,name)=>name+'.js'},
    rollupOptions:{external:['electron','puppeteer-core','ws',...builtinModules,...builtinModules.map(x=>'node:'+x)]}
  },
  define:{'process.env.BES_RENDERER_URL':JSON.stringify(process.env.BES_RENDERER_URL||'')}
});
