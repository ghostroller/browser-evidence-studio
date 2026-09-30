/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '@/renderer/app';
import { SessionThemeProvider } from '@/renderer/components/theme-provider';
import { BrowserWorkbenchClient } from '@/renderer/lib/browser-workbench-client';
import type { BrowserProjectMetadata, BrowserUpdateProject } from '@/contracts/browser-workbench';

const ticket = 'a'.repeat(43), token = 'b'.repeat(43);
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); delete window.studio; document.documentElement.classList.remove('dark'); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture() {
  let project: BrowserProjectMetadata = { id: 'project', name: 'Orders', objective: 'Read amounts', revision: 1 };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let update: ((input: BrowserUpdateProject) => Promise<Response>) | undefined;
  let read: (() => Promise<Response>) | undefined;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const envelope = JSON.parse(String(init!.body));
    if (url === '/workbench/session') return json({ token, instanceId: 'instance', projectId: 'project', expiresAt: Date.now() + 300_000 });
    if (url === '/workbench/events') return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } });
    if (envelope.method === 'state') return read ? read() : json({ project });
    if (envelope.method === 'updateProject') {
      if (update) return update(envelope.body);
      project = { ...project, name: envelope.body.name, objective: envelope.body.objective, revision: project.revision + 1 }; return json(project);
    }
    throw new Error(`Not allowed: ${String(url)}`);
  });
  const client = new BrowserWorkbenchClient({ instanceId: 'instance', fetch: fetcher as typeof fetch, retryDelaysMs: [] });
  const rendered = render(<SessionThemeProvider><App host="browser" client={client} /></SessionThemeProvider>);
  const connect = async () => {
    fireEvent.change(screen.getByLabelText('一次性配对票据'), { target: { value: ticket } });
    fireEvent.click(screen.getByRole('button', { name: '连接合成项目' }));
    await screen.findByLabelText('项目名称');
  };
  return { client, fetcher, rendered, connect, setUpdate: (value: typeof update) => { update = value; }, setRead: (value: typeof read) => { read = value; }, setProject: (value: BrowserProjectMetadata) => { project = value; },
    invalidate: () => controller.enqueue(new TextEncoder().encode('event: scope-invalidated\ndata: {"projectId":"project"}\n\n')),
    writes: () => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body))).filter(value => value.method === 'updateProject') };
}

test('browser App mounts no native/material/profile API and theme is session-only', async () => {
  const native = vi.fn(() => { throw new Error('Native API must not run'); });
  window.studio = { call: native, bounds: native, onChanged: native };
  const local = vi.spyOn(Storage.prototype, 'setItem');
  const f = fixture(); expect(f.fetcher).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '切换为暗色主题' }));
  await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
  expect(local).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  await f.connect();
  expect(native).not.toHaveBeenCalled(); expect(f.client.nativePresentation).toBeNull();
  expect(f.writes()).toHaveLength(0);
  expect(f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).method).filter(Boolean)).toEqual(['state']);
  expect(screen.queryByRole('button', { name: '开始录制' })).toBeNull();
  expect(screen.queryByRole('button', { name: '新建项目' })).toBeNull();
  expect(screen.getByRole('region', { name: '浏览器能力边界' }).textContent).toContain('尚未开放浏览器能力');
});
test('manual exchange clears the ticket after an attempted exchange and never exposes a token', async () => {
  const f = fixture();
  fireEvent.change(screen.getByLabelText('一次性配对票据'), { target: { value: 'invalid' } }); fireEvent.click(screen.getByRole('button', { name: '连接合成项目' }));
  await screen.findByRole('alert'); expect((screen.getByLabelText('一次性配对票据') as HTMLInputElement).value).toBe(''); expect(f.fetcher).not.toHaveBeenCalled();
  await f.connect(); expect(document.body.textContent).not.toContain(token); expect(document.body.textContent).not.toContain(ticket);
  fireEvent.click(screen.getByRole('button', { name: '断开连接并清除资料' })); expect(screen.queryByLabelText('项目名称')).toBeNull(); expect(screen.getByLabelText('一次性配对票据')).toBeTruthy();
});
test('shared metadata form cancels edits without writes and repeated submit has one operation', async () => {
  const f = fixture(); await f.connect();
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Discard me' } });
  fireEvent.click(screen.getByRole('button', { name: '撤销项目输入' })); expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Orders'); expect(f.writes()).toHaveLength(0);
  let resolve!: (response: Response) => void; f.setUpdate(() => new Promise(done => { resolve = done; }));
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Saved' } });
  const form = screen.getByLabelText('项目名称').closest('form')!;
  fireEvent.submit(form); fireEvent.submit(form); expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0].body).toMatchObject({ projectId: 'project', expectedRevision: 1, name: 'Saved', objective: 'Read amounts', operationId: expect.any(String) });
  f.setProject({ id: 'project', name: 'Saved', objective: 'Read amounts', revision: 2 });
  await act(async () => { resolve(json({ id: 'project', name: 'Saved', objective: 'Read amounts', revision: 2 })); });
  expect(await screen.findByText('项目名称和简介已保存。')).toBeTruthy(); expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Saved');
});
test('failed mutation keeps draft, stable operation ID and CAS for an explicit retry', async () => {
  const f = fixture(); await f.connect(); f.setUpdate(async () => json({ error: { code: 'busy' } }, 503));
  fireEvent.change(screen.getByLabelText('目录简介'), { target: { value: 'Retain this' } }); fireEvent.click(screen.getByRole('button', { name: '保存项目修改' }));
  await waitFor(() => expect(f.writes()).toHaveLength(1)); await waitFor(() => expect((screen.getByRole('button', { name: '保存项目修改' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('目录简介') as HTMLTextAreaElement).value).toBe('Retain this');
  f.setUpdate(undefined); fireEvent.click(screen.getByRole('button', { name: '保存项目修改' })); await screen.findByText('项目名称和简介已保存。');
  expect(f.writes()).toHaveLength(2); expect(f.writes()[1].body).toEqual(f.writes()[0].body);
});
test('conflict preserves edits and baseline until explicit cancel takes current revision', async () => {
  const f = fixture(); await f.connect(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'My edit' } });
  f.setProject({ id: 'project', name: 'Native edit', objective: 'Other', revision: 2 });
  f.setUpdate(async () => json({ error: { code: 'conflict' } }, 409)); fireEvent.click(screen.getByRole('button', { name: '保存项目修改' }));
  await screen.findByText(/输入已保留，请撤销输入以读取最新版本/);
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('My edit'); expect(f.writes()[0].body.expectedRevision).toBe(1);
  await screen.findByText(/服务端版本已更新/); fireEvent.click(screen.getByRole('button', { name: '撤销项目输入' }));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Native edit');
  f.setUpdate(undefined); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Reconciled' } }); fireEvent.click(screen.getByRole('button', { name: '保存项目修改' }));
  await screen.findByText('项目名称和简介已保存。'); expect(f.writes()[1].body.expectedRevision).toBe(2); expect(f.writes()[1].body.operationId).not.toBe(f.writes()[0].body.operationId);
});
test('stale reads remain visible with writes disabled, recovery does not overwrite dirty fields', async () => {
  const f = fixture(); await f.connect(); fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'Unsaved' } });
  f.setRead(async () => { throw new Error('temporary'); }); await act(async () => { f.invalidate(); });
  await screen.findByText('以下是此前读取的资料，可能已过时。当前禁止保存。');
  expect((screen.getByRole('button', { name: '保存项目修改' }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Unsaved');
  f.setRead(undefined); f.setProject({ id: 'project', name: 'Latest server', objective: '', revision: 2 });
  fireEvent.click(screen.getByRole('button', { name: '刷新授权项目' })); await waitFor(() => expect((screen.getByRole('button', { name: '保存项目修改' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Unsaved'); expect(f.writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '撤销项目输入' })); expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('Latest server');
});
test('revocation and unmount clear all authorized form data and abort the connection', async () => {
  const f = fixture(); await f.connect(); f.setRead(async () => json({ error: { code: 'unauthorized' } }, 401));
  fireEvent.click(screen.getByRole('button', { name: '刷新授权项目' })); await waitFor(() => expect(screen.queryByLabelText('项目名称')).toBeNull());
  expect(screen.getByLabelText('一次性配对票据')).toBeTruthy();
  f.setRead(undefined); await f.connect(); f.rendered.unmount(); expect(f.client.getSnapshot()).toEqual({ status: 'disconnected', state: null, error: '' });
  expect(f.fetcher.mock.calls.filter(([url]) => url === '/workbench/events').every(([, init]) => init!.signal!.aborted)).toBe(true);
});
