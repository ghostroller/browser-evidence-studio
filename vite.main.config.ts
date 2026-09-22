import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
export default defineConfig({
  resolve:{tsconfigPaths:true},
  build: { target:'node24',outDir:'.vite/build',emptyOutDir:false,sourcemap:true,minify:false,
    lib:{entry:{index:'src/main/app.ts','runner-worker':'src/runner/worker.ts'},formats:['es'],fileName:(_format,name)=>name+'.js'},
    rolldownOptions:{
      external:['electron','puppeteer-core','ws',...builtinModules,...builtinModules.map(x=>'node:'+x)],
      // Runtime asset/worker URLs are relative to modules in this build directory.
      output:{chunkFileNames:'[name]-[hash].js'}
    }
  },
  define:{'process.env.BES_RENDERER_URL':JSON.stringify(process.env.BES_RENDERER_URL||'')}
});
