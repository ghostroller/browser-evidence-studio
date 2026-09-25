import React, { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { StatusBadge } from './status-badge';

type Capability = 'materials-read' | 'materials-edit' | 'history-read' | 'page-read' | 'page-act' | 'page-create' | 'execute' | 'results-read' | 'handoff-export';
type Grant = { authorizationId: string; projectId: string; capabilities: Capability[]; status: string; expiresAt: string;
  remainingOperations: number; maxOperations: number; sessionId?: string; profileId?: string; directory?: string;
  origins: string[]; pages: Array<{ pageId: string; targetId: string }>; reason?: string };
const choices: Array<[Capability, string]> = [
  ['materials-read', '读取任务资料'], ['materials-edit', '编辑任务资料'], ['history-read', '读取历史证据'],
  ['results-read', '读取结果'], ['handoff-export', '导出交接包'], ['page-read', '读取当前页面'],
  ['page-act', '操作当前页面'], ['page-create', '创建页面'], ['execute', '运行登记脚本'],
];
const browserCapabilities: Capability[] = ['page-read', 'page-act', 'page-create', 'execute'];
function origin(url: string): string { try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : ''; } catch { return ''; } }

/** Only the trusted renderer can issue/revoke E's instance-scoped task grants. */
export function TaskAuthorizations({ projectId, session, active, project, onChanged }: {
  projectId: string; session?: any; active?: any; project?: any; onChanged(): Promise<unknown>;
}) {
  const [capabilities, setCapabilities] = useState<Capability[]>(['materials-read', 'history-read', 'results-read']);
  const [minutes, setMinutes] = useState('2');
  const [operations, setOperations] = useState('20');
  const [originsText, setOriginsText] = useState('');
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const scopeRef = useRef(projectId);
  scopeRef.current = projectId;
  const pages: Array<{ pageId: string; targetId: string; url: string; title?: string }> = session?.pages || [];
  const browser = capabilities.some(value => browserCapabilities.includes(value));
  const lease = active?.leaseEpoch;
  const sessionId = session?.sessionId;
  const profileId = active?.profileId;
  const scopeReady = !!active && active.projectId === projectId && !!sessionId && !!profileId &&
    active.controller === 'human' && !active.locked && Number.isSafeInteger(lease);
  const origins = originsText.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean);
  const validOrigins = origins.length > 0 && origins.length <= 32 && origins.every(value => origin(value) === value);
  const validPages = pageIds.length > 0 && pageIds.length <= 32 && pageIds.every(id => pages.some(page => page.pageId === id));
  const durationMs = Number(minutes) * 60_000, maxOperations = Number(operations);
  const budgetReady = Number.isSafeInteger(durationMs) && durationMs >= 1000 && durationMs <= 8 * 60 * 60 * 1000 &&
    Number.isSafeInteger(maxOperations) && maxOperations >= 1 && maxOperations <= 10_000;
  const canIssue = !!projectId && capabilities.length > 0 && budgetReady && (!browser || scopeReady && validOrigins && validPages && (!capabilities.includes('execute') || !!project?.scriptDirectory));
  const load = async () => {
    const token = ++request.current, scope = projectId;
    if (!scope) { setGrants([]); return; }
    try { const result = await window.studio.call('taskAuthorizations', { projectId: scope });
      if (token === request.current && scopeRef.current === scope) { setGrants(result.items || []); setInstanceId(result.instanceId || ''); } }
    catch (failure) { if (token === request.current && scopeRef.current === scope) setError(String(failure)); }
  };
  useEffect(() => {
    ++request.current; setGrants([]); setInstanceId(''); setPending(''); setError(''); setNotice('');
    void load(); const timer = setInterval(() => void load(), 2000);
    return () => { ++request.current; clearInterval(timer); };
  }, [projectId]);
  useEffect(() => {
    const selected = pages.find(page => page.pageId === session?.selectedPageId) || pages[0];
    if (!selected) { setPageIds([]); setOriginsText(''); return; }
    setPageIds([selected.pageId]); setOriginsText(origin(selected.url));
  }, [projectId, sessionId, session?.selectedPageId, pages.find(page => page.pageId === session?.selectedPageId)?.url]);
  const issue = async () => {
    if (!canIssue || pending) return;
    const scope = projectId, token = request.current;
    setPending('创建授权'); setError(''); setNotice('');
    try { const result: Grant = await window.studio.call('authorizeTask', {
      projectId: scope, capabilities, durationMs, maxOperations,
      ...(browser ? { sessionId, profileId, leaseEpoch: lease, pageIds, origins } : {}),
    });
      if (scopeRef.current !== scope) return;
      setNotice(`授权 ${result.authorizationId} 已创建。有效至 ${new Date(result.expiresAt).toLocaleString('zh-CN')}。`);
      await load(); await onChanged();
    } catch (failure) { if (scopeRef.current === scope && token <= request.current) setError(String(failure)); }
    finally { if (scopeRef.current === scope) setPending(''); }
  };
  const revoke = async (grant: Grant) => {
    const scope = projectId;
    if (pending || grant.projectId !== scope || grant.status !== 'active') return;
    setPending('撤销授权'); setError('');
    try { await window.studio.call('revokeTask', { projectId: scope, authorizationId: grant.authorizationId });
      if (scopeRef.current !== scope) return;
      setNotice(`已撤销 ${grant.authorizationId}。`); await load(); await onChanged();
    } catch (failure) { if (scopeRef.current === scope) setError(String(failure)); }
    finally { if (scopeRef.current === scope) setPending(''); }
  };
  return <div className="overlay-body form-stack task-authorizations">
    <p className="hint">逐项授予这次任务所需能力；授权只在当前应用实例有效。页面操作会按所选页面与来源限制，撤销会中断进行中的操作。</p>
    {error && <p role="alert" className="error-inline">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <div className="section-label">能力范围</div><div className="task-capabilities">{choices.map(([value, label]) => <label key={value}><input type="checkbox" checked={capabilities.includes(value)}
      onChange={event => setCapabilities(current => event.target.checked ? [...current, value] : current.filter(item => item !== value))} />{label}</label>)}</div>
    <div className="material-grid"><label>有效分钟数<Input aria-label="有效分钟数" type="number" min="0.02" max="480" step="0.01" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
      <label>最多操作数<Input aria-label="最多操作数" type="number" min="1" max="10000" value={operations} onChange={event => setOperations(event.target.value)} /></label></div>
    {browser && <><p className="hint">浏览器授权要求当前录制、人工控制和当前租约。操作/建页/执行授权发出后，主进程会把浏览器控制权交给 Agent。</p>
      {!scopeReady && <p role="status" className="error-inline">请先开始录制并保持人工控制；当前会话、环境或租约不可用。</p>}
      <div className="section-label">受管理页面</div><div className="task-capabilities">{pages.map(page => <label key={page.pageId}><input type="checkbox" checked={pageIds.includes(page.pageId)}
        onChange={event => setPageIds(current => event.target.checked ? [...current, page.pageId] : current.filter(id => id !== page.pageId))} />{page.title || page.url} · {page.pageId.slice(0, 12)}</label>)}</div>
      <label>允许的精确来源（每行一个）<Textarea aria-label="允许的精确来源" value={originsText} onChange={event => setOriginsText(event.target.value)} placeholder="https://example.com" /></label>
      {capabilities.includes('execute') && <p className="hint">登记脚本目录：<code>{project?.scriptDirectory || '未登记'}</code></p>}
    </>}
    <Button variant="default" className="primary" disabled={!canIssue || !!pending} onClick={() => void issue()}>{pending || '授予这次任务'}</Button>
    <div className="section-label">本实例授权 · {instanceId ? instanceId.slice(0, 12) : '读取中'}</div>
    {grants.map(grant => <div className="task-grant" key={grant.authorizationId}><div className="detail-title"><code>{grant.authorizationId}</code><StatusBadge value={grant.status} /></div>
      <p>{grant.capabilities.join('、')}</p><small>剩余 {grant.remainingOperations} / {grant.maxOperations} 次 · 到期 {new Date(grant.expiresAt).toLocaleString('zh-CN')}</small>
      {grant.sessionId && <small>会话 {grant.sessionId.slice(0, 12)} · 环境 {grant.profileId?.slice(0, 12)} · {grant.pages.length} 页 · {grant.origins.join('、')}</small>}
      {grant.reason && <small>{grant.reason}</small>}{grant.status === 'active' && <Button disabled={!!pending} onClick={() => void revoke(grant)}>撤销此授权</Button>}</div>)}
    {!grants.length && <p className="muted">当前项目没有本实例任务授权。</p>}
  </div>;
}
