import { defineConfig } from 'vite';
export default defineConfig({
  build:{
    outDir:'.vite/build',emptyOutDir:false,sourcemap:true,minify:false,
    // Electron's sandboxed preload cannot load ESM; keep this boundary bundled.
    lib:{entry:'src/preload/ui.ts',formats:['cjs'],fileName:()=> 'preload.cjs'},
    rolldownOptions:{external:['electron'],output:{entryFileNames:'preload.cjs',codeSplitting:false}}
  }
});
