import React, { useEffect, useRef, useState } from 'react';
import type { BrowserWorkbenchPairingBridge, BrowserWorkbenchPairingStatus, BrowserWorkbenchTicket } from '@/contracts/browser-workbench';
import { Button } from './ui/button';

export function BrowserPairingButton({ bridge, disabled, onOpen }: { bridge?: BrowserWorkbenchPairingBridge; disabled: boolean; onOpen(): void }) {
  const [status, setStatus] = useState<BrowserWorkbenchPairingStatus | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    if (bridge) void bridge.status().then(value => { if (live) setStatus(value); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [bridge]);
  if (error) return <span role="alert">浏览器配对状态读取失败</span>;
  if (!status?.enabled) return null;
  return <Button disabled={disabled} onClick={onOpen}>浏览器配对</Button>;
}

/** Mounted only while the trusted native panel is open. Never copies credentials
 * or starts pairing implicitly. A late begin cannot survive panel disposal. */
export function BrowserPairingPanel({ bridge, projectId, projectName, onError }: {
  bridge: BrowserWorkbenchPairingBridge; projectId: string; projectName: string; onError(message: string): void;
}) {
  const [ticket, setTicket] = useState<BrowserWorkbenchTicket | null>(null);
  const [status, setStatus] = useState<BrowserWorkbenchPairingStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const generation = useRef(0), pending = useRef(false);
  const report = useRef(onError); report.current = onError;
  useEffect(() => {
    const current = ++generation.current;
    void bridge.status().then(value => { if (generation.current === current) setStatus(value); }).catch(() => { if (generation.current === current) setError('配对状态读取失败，请关闭面板后重试。'); });
    return () => { ++generation.current; void bridge.revoke().catch(() => report.current('配对撤销未能确认，请关闭合成实例以结束所有会话。')); };
  }, [bridge, projectId]);
  useEffect(() => {
    if (!ticket) return;
    const timer = setTimeout(() => { setTicket(null); setExpired(true); }, Math.max(0, ticket.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [ticket]);
  const begin = async () => {
    if (pending.current || !status?.enabled || !projectId) return;
    pending.current = true; setBusy(true); setTicket(null); setExpired(false); setError('');
    const current = generation.current;
    try {
      await bridge.revoke();
      if (generation.current !== current) return;
      const issued = await bridge.begin(projectId);
      if (generation.current !== current) { await bridge.revoke(); return; }
      if (issued.expiresAt <= Date.now() || issued.instanceId !== status.instanceId) throw new Error('Invalid pairing ticket');
      setTicket(issued);
    } catch {
      await bridge.revoke().catch(() => report.current('配对撤销未能确认，请关闭合成实例以结束所有会话。'));
      if (generation.current === current) { setTicket(null); setError('未能生成配对票据，请重试。'); }
    } finally { pending.current = false; if (generation.current === current) setBusy(false); }
  };
  return <section className="overlay-body form-stack pairing-panel" aria-label="合成浏览器配对">
    <h3>配对项目：{projectName || projectId}</h3>
    <p>仅允许读取和修改这个合成项目的名称、目录简介。不会开放登录环境、录制、资料或 Agent 权限。</p>
    <p>票据只能使用一次，60 秒内有效。浏览器会话最多 5 分钟；请保持本面板打开。关闭、收起面板或退出、重载、最小化原生窗口会撤销票据和会话。</p>
    {status?.origin && <p>请手动在浏览器打开：<code className="pairing-address">{status.origin}/browser.html</code></p>}
    {status && !status.enabled && <p role="alert">此实例未启用合成浏览器配对。</p>}
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy || !status?.enabled || !projectId} onClick={() => void begin()}>{busy ? '正在生成票据…' : '生成一次性配对票据'}</Button>
    {ticket && <div className="pairing-ticket"><p>请手动核对实例标识，再把票据输入浏览器工作台。不要分享或保存票据。</p><dl><dt>实例标识</dt><dd><code>{ticket.instanceId}</code></dd><dt>一次性票据</dt><dd><code aria-label="一次性票据">{ticket.ticket}</code></dd></dl></div>}
    {expired && <p role="status">票据显示已到期；已建立的会话仍受 5 分钟时限限制。重新配对会撤销先前会话。</p>}
  </section>;
}
