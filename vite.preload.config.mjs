import { defineConfig } from 'vite';
export default defineConfig({ build:{outDir:'.vite/build',emptyOutDir:false,sourcemap:true,minify:false,lib:{entry:'src/preload/ui.ts',formats:['cjs'],fileName:()=> 'preload.js'},rollupOptions:{external:['electron'],output:{entryFileNames:'preload.js'}}} });
