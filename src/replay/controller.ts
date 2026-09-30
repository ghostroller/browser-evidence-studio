import type { eventWithTime } from '@rrweb/types';
import type { fitReplayViewport, replayHit, waitReplayPresentation } from './presentation';
/** Serialized trusted code shared by Native and Web. It has no import, network,
 * backend authority, source metadata or management DOM dependency at runtime. */
export function installReplayController(hitTest: typeof replayHit, fit: typeof fitReplayViewport, wait: typeof waitReplayPresentation) {
  const scope = window as any;
  const overlay = document.querySelector<HTMLElement>('#selection')!;
  scope.__besReplay = { sequence: 0, nodeId: null };
  overlay.addEventListener('click', event => {
    event.preventDefault(); event.stopImmediatePropagation();
    const frame = document.querySelector<HTMLIFrameElement>('#replay iframe'); if (!frame) return;
    const hit = hitTest(frame, event.clientX, event.clientY), id = hit && scope.__besPlayer?.getMirror().getId(hit.node);
    if (!Number.isSafeInteger(id) || id < 0) { scope.__besReplay = { sequence: scope.__besReplay.sequence + 1, nodeId: null, error: '此位置没有可解析的源节点；frame/shadow可能不可用' }; return; }
    const marker = document.querySelector<HTMLElement>('#selected')!;
    Object.assign(marker.style, { display: 'block', left: hit!.rect.x + 'px', top: hit!.rect.y + 'px', width: hit!.rect.width + 'px', height: hit!.rect.height + 'px' });
    scope.__besReplay = { sequence: scope.__besReplay.sequence + 1, nodeId: id };
  });
  const reset = (generation: number, command: number) => {
    if ((scope.__besGeneration || 0) > generation) return false;
    scope.__besCommand = Math.max(scope.__besCommand || 0, command); scope.__besGeneration = generation;
    scope.__besFitReplay?.(); scope.__besFitReplay = null; scope.__besPlayer?.destroy(); scope.__besPlayer = null;
    overlay.style.display = 'none'; document.querySelector<HTMLElement>('#selected')!.style.display = 'none';
    scope.__besReplay = { sequence: 0, nodeId: null }; return true;
  };
  scope.__besReplayController = {
    reset,
    async mount(events: eventWithTime[], offset: number, generation: number, command: number, speed = 1, playing = false) {
      if (!reset(generation, command)) return [];
      const player = new scope.rrweb.Replayer(events, { root: document.querySelector('#replay'), speed, showWarning: false, showDebug: false, UNSAFE_replayCanvas: false });
      scope.__besPlayer = player; scope.__besPlaybackEnded = false;
      player.on('finish', () => { if (scope.__besGeneration === generation && scope.__besPlayer === player) scope.__besPlaybackEnded = true; });
      player.pause(offset);
      const frame = document.querySelector<HTMLIFrameElement>('#replay iframe')!;
      frame.style.pointerEvents = 'none'; frame.tabIndex = -1;
      const child = frame.contentDocument!;
      for (const event of ['click', 'auxclick', 'submit', 'keydown']) child.addEventListener(event, input => { input.preventDefault(); input.stopImmediatePropagation(); }, true);
      scope.__besFitReplay = fit(document.querySelector<HTMLElement>('#replay-stage')!, document.querySelector<HTMLElement>('#replay')!);
      const errors = await wait(document.querySelector<HTMLIFrameElement>('#replay iframe')!.contentDocument!, generation);
      if (playing && scope.__besGeneration === generation && scope.__besCommand === command) player.play(offset);
      return errors;
    },
    select(enabled: boolean, generation: number, command: number) {
      if (scope.__besGeneration !== generation || command < scope.__besCommand || !scope.__besPlayer) return false;
      scope.__besCommand = command; overlay.style.display = enabled ? 'block' : 'none';
      if (enabled) overlay.focus(); else document.querySelector<HTMLElement>('#selected')!.style.display = 'none';
      return true;
    },
    pause(generation: number, command: number) {
      if (scope.__besGeneration !== generation || command < scope.__besCommand) return null;
      scope.__besCommand = command; if (!scope.__besPlayer) return null; scope.__besPlayer.pause(); return scope.__besPlayer.getCurrentTime();
    },
    play(generation: number, command: number, speed: number) {
      if (scope.__besGeneration !== generation || command < scope.__besCommand || !scope.__besPlayer) return false;
      scope.__besCommand = command; overlay.style.display = 'none'; scope.__besPlayer.setConfig({ speed }); scope.__besPlaybackEnded = false;
      scope.__besPlayer.play(scope.__besPlayer.getCurrentTime()); return true;
    },
  };
}
export const REPLAY_SHELL_STYLE = 'html,body{margin:0;height:100%;overflow:auto;background:white}#replay-stage{position:relative;overflow:hidden}#replay{position:absolute;left:0;top:0;transform-origin:top left}#selection{position:fixed;inset:0;z-index:2147483647;display:none;cursor:crosshair;background:transparent}#selected{position:fixed;pointer-events:none;border:2px solid #2563eb;z-index:2147483646;display:none}';
export const REPLAY_SHELL_BODY = '<div id="replay-stage"><div id="replay"></div></div><div id="selected"></div><div id="selection" tabindex="0" aria-label="选择历史元素；Escape 退出"></div>';
