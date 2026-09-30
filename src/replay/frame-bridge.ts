import type { materializeReplayEvents } from './materialize';
import type { rewriteReplayEvent } from '../resources/replay-event-rewrite';
import type { rewriteCssUrls } from '../resources/rewrite';
import type { WebReplayBundle } from '../contracts/web-replay';
/** Serialized into the dedicated cross-origin document. All incoming data is
 * presentation-only. This bridge cannot call the management service. */
export function installReplayFrameBridge(parentOrigin: string, instanceId: string, rewriteEvent: typeof rewriteReplayEvent, rewriteCss: typeof rewriteCssUrls, materialize: typeof materializeReplayEvents) {
  const scope = window as any;
  let replayId = '', generation = 0, command = 0, sequence = 0, selectionId = '', selecting = false, playing = false;
  let bundle: WebReplayBundle | undefined, currentIndex = 0;
  const urls: string[] = [];
  const release = () => { for (const url of urls.splice(0)) URL.revokeObjectURL(url); };
  const send = (type: string, extra: Record<string, unknown> = {}) => parent.postMessage({ type, instanceId, replayId, generation, command, sequence: ++sequence, ...extra }, parentOrigin);
  const sample = () => {
    if (!bundle || !scope.__besPlayer) return;
    const clock = scope.__besPlayer.getCurrentTime();
    let index = 0;
    for (let i = 0; i < bundle.offsets.length; i++) if (bundle.offsets[i].offset <= clock + 0.0001) index = i;
    if (scope.__besPlaybackEnded) { index = bundle.offsets.length - 1; playing = false; }
    currentIndex = index;
    return { index, playing, position: bundle.offsets[index].position };
  };
  let selectedSequence = 0;
  const timer = setInterval(() => {
    if (!bundle) return;
    if (playing) send('state', sample());
    const selected = scope.__besReplay;
    if (selecting && !playing && selected?.sequence > selectedSequence) {
      selectedSequence = selected.sequence;
      if (Number.isSafeInteger(selected.nodeId) && selected.nodeId >= 0) send('selection', { selectionId, nodeId: selected.nodeId, index: currentIndex, position: bundle.offsets[currentIndex].position });
      else send('selection-error');
    }
  }, 100);
  addEventListener('pagehide', () => { clearInterval(timer); release(); });
  addEventListener('keydown', event => { if (event.key === 'Escape') { selecting = false; scope.__besReplayController.select(false, generation, command); send('selection-cancelled'); } });
  addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== parentOrigin) return;
    const message = event.data;
    if (!message || message.instanceId !== instanceId || typeof message.replayId !== 'string' || !Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.command) || message.generation < 1 || message.command < 1) return;
    if (message.type === 'load') {
      if (message.generation <= generation || message.command <= command || replayId && replayId !== message.replayId) return;
      const next = message.bundle as WebReplayBundle;
      if (!next || next.replayId !== message.replayId || next.generation !== message.generation || !Array.isArray(next.events) || next.events.length > 4097 || !Array.isArray(next.offsets) || !next.offsets.length || next.offsets.length > 4096 || !Array.isArray(next.resources) || next.resources.length > 128 || JSON.stringify(next).length > 16 * 1024 * 1024) return;
      replayId = message.replayId; generation = message.generation; command = message.command;
      const ownGeneration = generation, ownCommand = command;
      playing = false; selecting = false; selectionId = ''; selectedSequence = 0; bundle = undefined;
      scope.__besReplayController.reset(generation, command); release();
      try {
        const resources = new Map(next.resources.map(item => [item.key, item]));
        const mapped = new Map<string, string>(); let bytes = 0;
        const resolve = (key: string, depth = 0): string => {
          if (mapped.has(key)) return mapped.get(key)!;
          const resource = resources.get(key); if (!resource || depth > 16) return 'about:blank';
          mapped.set(key, 'about:blank');
          const raw = atob(resource.base64); bytes += raw.length; if (bytes > 8 * 1024 * 1024) throw new Error('Resource budget exceeded');
          let data: BlobPart = Uint8Array.from(raw, char => char.charCodeAt(0));
          if (/^text\/css(?:;|$)/i.test(resource.mime)) data = rewriteCss(new TextDecoder().decode(data as Uint8Array), value => value.startsWith('bes-inline:') ? resolve(value, depth + 1) : value);
          const url = URL.createObjectURL(new Blob([data], { type: resource.mime })); urls.push(url); mapped.set(key, url); return url;
        };
        const events = materialize(next.events, value => value.startsWith('bes-inline:') ? resolve(value) : value, rewriteEvent);
        bundle = next; currentIndex = next.offsets.length - 1;
        const failures = await scope.__besReplayController.mount(events, next.offsets[currentIndex].offset, generation, command);
        if (generation !== ownGeneration || command !== ownCommand) return;
        // Retain only presentation events for bounded local exact seeks.
        bundle = { ...next, events, resources: [] };
        send('ready', { index: currentIndex, position: next.offsets[currentIndex].position, failures });
      } catch { if (generation === ownGeneration) { bundle = undefined; release(); send('error'); } }
      return;
    }
    if (!bundle || message.replayId !== replayId || message.generation !== generation || message.command <= command) return;
    command = message.command;
    const ownGeneration = generation, ownCommand = command;
    try {
      if (message.type === 'seek') {
        if (!Number.isSafeInteger(message.index) || message.index < 0 || message.index >= bundle.offsets.length) return;
        playing = false; selecting = false; selectionId = ''; currentIndex = message.index; selectedSequence = 0;
        await scope.__besReplayController.mount(bundle.events, bundle.offsets[currentIndex].offset, generation, command);
        if (generation !== ownGeneration || command !== ownCommand) return;
        send('state', { index: currentIndex, playing: false, position: bundle.offsets[currentIndex].position });
      } else if (message.type === 'play') {
        if (selecting) return;
        playing = scope.__besReplayController.play(generation, command, 1); send('state', sample());
      } else if (message.type === 'pause') {
        scope.__besReplayController.pause(generation, command); playing = false; send('state', sample());
      } else if (message.type === 'select') {
        if (playing || typeof message.selectionId !== 'string' || message.selectionId.length > 128) return;
        selectionId = message.selectionId; selecting = true; selectedSequence = scope.__besReplay?.sequence ?? 0;
        scope.__besReplayController.select(true, generation, command); send('selecting');
      } else if (message.type === 'cancel-selection') {
        selecting = false; selectionId = ''; scope.__besReplayController.select(false, generation, command); send('state', sample());
      }
    } catch { if (generation === ownGeneration && command === ownCommand) send('error'); }
  });
  parent.postMessage({ type: 'boot', instanceId }, parentOrigin);
}
