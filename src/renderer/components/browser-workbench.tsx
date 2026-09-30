import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import type { BrowserProjectMetadata, BrowserUpdateProject } from '@/contracts/browser-workbench';
import { BrowserWorkbenchClient, BrowserWorkbenchClientError } from '../lib/browser-workbench-client';
import { WorkbenchHeader, WorkbenchShell } from './workbench-shell';
import { ProjectMetadataForm } from './project-metadata-form';
import { usePreferences } from './theme-provider';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const connectionLabels = { disconnected: '尚未配对', exchanging: '正在交换一次性票据', connecting: '正在读取已授权项目', connected: '已连接', stale: '连接待恢复 · 资料可能已过时', expired: '会话已结束，请重新配对', error: '连接失败' };
export function BrowserWorkbench({ client }: { client: BrowserWorkbenchClient }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const { preferences, setTheme } = usePreferences();
  const [ticket, setTicket] = useState('');
  const connecting = snapshot.status === 'exchanging' || snapshot.status === 'connecting';
  const attempt = useRef(false);
  useEffect(() => () => client.disconnect(), [client]);
  const connect = async () => {
    if (attempt.current) return;
    attempt.current = true;
    const input = ticket.trim(); setTicket('');
    try { await client.connect(input); } catch { /* Client exposes a sanitized connection error. */ }
    finally { attempt.current = false; }
  };
  return <WorkbenchShell browser>
    <WorkbenchHeader><span className="host-label">浏览器 · 合成项目元数据</span><Button variant="ghost" size="icon" aria-label={preferences.theme === 'light' ? '切换为暗色主题' : '切换为亮色主题'} onClick={() => void setTheme(preferences.theme === 'light' ? 'dark' : 'light')}>{preferences.theme === 'light' ? <Moon /> : <Sun />}</Button><span className="hint">主题仅本次页面有效</span></WorkbenchHeader>
    <main className="browser-workbench-content">
      <section className="browser-connection form-stack" aria-label="浏览器工作台连接">
        <h2>浏览器工作台</h2>
        <p role="status" aria-live="polite">{connectionLabels[snapshot.status]}</p>
        <p>实例标识：<code>{client.instanceId}</code></p>
        <p className="hint">在此合成实例的 Electron 工作台打开“浏览器配对”，核对实例标识后手动输入一次性票据。会话最多 5 分钟，原生配对面板需保持打开。</p>
        {!snapshot.projectId && <form className="form-stack" autoComplete="off" onSubmit={event => { event.preventDefault(); if (ticket.trim() && !connecting) void connect(); }}>
          <Label>一次性配对票据<Input aria-label="一次性配对票据" type="password" autoComplete="off" spellCheck={false} value={ticket} onChange={event => setTicket(event.target.value)} maxLength={128} disabled={connecting} /></Label>
          <Button type="submit" disabled={!ticket.trim() || connecting}>连接合成项目</Button>
        </form>}
        {(snapshot.projectId || connecting) && <div className="button-row"><Button onClick={() => { attempt.current = false; setTicket(''); client.disconnect(); }}>断开连接并清除资料</Button>{snapshot.projectId && <Button disabled={connecting} onClick={() => void client.refresh().catch(() => {})}>刷新授权项目</Button>}</div>}
        {snapshot.error && <p role="alert">{snapshot.error}</p>}
        {snapshot.expiresAt && <p className="hint">会话到期：{new Date(snapshot.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}，不会自动续期</p>}
      </section>
      {snapshot.state && <section className="browser-project form-stack" aria-label="授权项目元数据">
        {snapshot.status !== 'connected' && <p role="status">以下是此前读取的资料，可能已过时。当前禁止保存。</p>}
        <p>项目标识：<code>{snapshot.state.project.id}</code> · 版本 {snapshot.state.project.revision}</p>
        <BrowserProjectEditor key={snapshot.state.project.id} client={client} project={snapshot.state.project} writable={snapshot.status === 'connected'} />
      </section>}
      <section className="browser-capabilities" aria-label="浏览器能力边界"><h3>此连接的能力范围</h3><p>本次只提供已配对项目的名称、目录简介和版本。仅明确点击保存时修改元数据。</p><ul><li>登录环境、原生浏览器呈现和录制：请使用 Electron 工作台</li><li>任务资料、保存点、回放、复制和固定版本：尚未开放浏览器能力</li><li>Agent 授权和执行：此连接不具备权限</li></ul></section>
    </main>
    <footer className="statusbar"><span>合成实例 · 项目元数据配对</span><span>录制完成 ≠ 需求通过</span></footer>
  </WorkbenchShell>;
}
function BrowserProjectEditor({ client, project, writable }: { client: BrowserWorkbenchClient; project: BrowserProjectMetadata; writable: boolean }) {
  const [name, setName] = useState(project.name), [objective, setObjective] = useState(project.objective);
  const [baseline, setBaseline] = useState(project);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(false), generation = useRef(0);
  const operations = useRef(new Map<string, string>());
  const dirty = name !== baseline.name || objective !== baseline.objective;
  const load = (value: BrowserProjectMetadata) => { setBaseline(value); setName(value.name); setObjective(value.objective); };
  useEffect(() => { if (!dirty && !pending.current) load(project); }, [project.id, project.revision, project.name, project.objective]);
  useEffect(() => () => { ++generation.current; }, []);
  const save = async () => {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    const current = generation.current;
    const fields = { projectId: baseline.id, expectedRevision: baseline.revision, name, objective };
    const fingerprint = JSON.stringify(fields);
    if (!operations.current.has(fingerprint)) operations.current.set(fingerprint, crypto.randomUUID());
    const input: BrowserUpdateProject = { ...fields, operationId: operations.current.get(fingerprint)! };
    try {
      const result = await client.updateProject(input);
      if (generation.current !== current) return;
      operations.current.delete(fingerprint); load(result); setMessage('项目名称和简介已保存。');
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof BrowserWorkbenchClientError ? failure.message : '项目未能保存；输入已保留，请刷新核对后重试。');
    } finally { pending.current = false; if (generation.current === current) setBusy(false); }
  };
  return <>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {dirty && baseline.revision !== project.revision && <p role="status">服务端版本已更新；当前输入仍基于版本 {baseline.revision}。撤销输入后可编辑最新版本。</p>}
    <ProjectMetadataForm name={name} objective={objective} onName={setName} onObjective={setObjective} dirty={dirty} busy={busy} disabled={!writable} onSubmit={() => void save()} onCancel={() => { load(project); setError(''); setMessage(''); operations.current.clear(); }} />
  </>;
}
