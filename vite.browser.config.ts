import { defineConfig } from 'vite';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { createWorkbenchDevProxy, createNodeOwnerDevProxy } from './src/main/workbench/dev-proxy';

/** Used only by start:workbench's fresh synthetic companion. These are public
 * routing identities, never credentials or VITE_-exposed bearer secrets. */
export default defineConfig(() => {
  const browserPort = Number(process.env.BES_WORKBENCH_BROWSER_PORT);
  const targetPort = Number(process.env.BES_WORKBENCH_TARGET_PORT);
  const instanceId = process.env.BES_WORKBENCH_INSTANCE_ID ?? '';
  if (!Number.isSafeInteger(browserPort) || browserPort < 1 || browserPort > 65535 || !/^[a-zA-Z0-9_-]{1,128}$/.test(instanceId)) throw new Error('Use start:workbench for a synthetic browser connection.');
  const origin = `http://127.0.0.1:${browserPort}`;
  const replayOrigin = process.env.BES_WORKBENCH_REPLAY_ORIGIN;
  const replay = new URL(replayOrigin ?? '');
  if (replay.protocol !== 'http:' || replay.hostname !== '127.0.0.1' || !replay.port || replay.origin !== replayOrigin || replayOrigin === origin) throw new Error('Invalid isolated replay origin');
  const ownerPort=process.env.BES_WORKBENCH_OWNER_PORT?Number(process.env.BES_WORKBENCH_OWNER_PORT):undefined;
  const ownerProxy=ownerPort?createNodeOwnerDevProxy({origin,targetPort:ownerPort}):undefined;
  const proxy = createWorkbenchDevProxy({ origin, targetPort });
  return {
    root: 'src/renderer', base: './',
    plugins: [tailwindcss(), {
      name: 'synthetic-workbench-only',
      configureServer(server) { if(ownerProxy)server.middlewares.use(ownerProxy);server.middlewares.use(proxy); },
      transformIndexHtml(html, context) {
        if (context.path !== '/browser.html' && !(ownerProxy&&context.path==='/node-owner.html')) return html;
        return { html: html.replace("frame-src 'self' about:", `frame-src 'self' about: ${replayOrigin}`), tags: [
          { tag:'meta',attrs:{name:'workbench-backend-kind',content:ownerProxy?'node':'electron-companion'},injectTo:'head'},
          { tag: 'meta', attrs: { name: 'workbench-instance', content: instanceId }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'workbench-replay-origin', content: replayOrigin }, injectTo: 'head' },
        ] };
      },
    }],
    resolve: { tsconfigPaths: true },
    server: { host: '127.0.0.1', port: browserPort, strictPort: true, cors: false,
      allowedHosts: ['127.0.0.1'], fs: { strict: true, allow: [path.resolve('src')] } },
  };
});
