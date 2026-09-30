import { defineConfig } from 'vite';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { createWorkbenchDevProxy } from './src/main/workbench/dev-proxy';

/** Used only by start:workbench's fresh synthetic companion. These are public
 * routing identities, never credentials or VITE_-exposed bearer secrets. */
export default defineConfig(() => {
  const browserPort = Number(process.env.BES_WORKBENCH_BROWSER_PORT);
  const targetPort = Number(process.env.BES_WORKBENCH_TARGET_PORT);
  const instanceId = process.env.BES_WORKBENCH_INSTANCE_ID ?? '';
  if (!Number.isSafeInteger(browserPort) || browserPort < 1 || browserPort > 65535 || !/^[a-zA-Z0-9_-]{1,128}$/.test(instanceId)) throw new Error('Use start:workbench for a synthetic browser connection.');
  const origin = `http://127.0.0.1:${browserPort}`;
  const proxy = createWorkbenchDevProxy({ origin, targetPort });
  return {
    root: 'src/renderer', base: './',
    plugins: [tailwindcss(), {
      name: 'synthetic-workbench-only',
      configureServer(server) { server.middlewares.use(proxy); },
      transformIndexHtml(html, context) {
        if (context.path !== '/browser.html') return html;
        return [{ tag: 'meta', attrs: { name: 'workbench-instance', content: instanceId }, injectTo: 'head' }];
      },
    }],
    resolve: { tsconfigPaths: true },
    server: { host: '127.0.0.1', port: browserPort, strictPort: true, cors: false,
      allowedHosts: ['127.0.0.1'], fs: { strict: true, allow: [path.resolve('src')] } },
  };
});
