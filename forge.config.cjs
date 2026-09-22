module.exports = {
  packagerConfig: {
    asar: true, executableName: 'BrowserEvidenceStudio',
    ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
    // Puppeteer and ws remain runtime dependencies; Packager prunes development packages.
    ignore: file => !!file && !/^\/(?:\.vite(?:\/|$)|node_modules(?:\/|$)|package(?:-lock)?\.json$)/.test(file),
  },
  makers: [{ name: '@electron-forge/maker-zip', platforms: ['win32'] }],
  plugins: [{ name: '@electron-forge/plugin-vite', config: {
    build: [
      { entry:'src/main/app.ts',config:'vite.main.config.mjs',target:'main' },
      { entry:'src/preload/ui.ts',config:'vite.preload.config.mjs',target:'preload' }
    ],
    renderer: [{name:'main_window',config:'vite.renderer.config.mjs'}]
  } }]
};
