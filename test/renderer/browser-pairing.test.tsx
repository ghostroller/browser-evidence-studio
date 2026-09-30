/** @vitest-environment jsdom */
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BrowserPairingButton, BrowserPairingPanel } from '@/renderer/components/browser-pairing';
import type { BrowserWorkbenchPairingBridge, BrowserWorkbenchTicket } from '@/contracts/browser-workbench';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const ticket = 'synthetic-test-ticket';
function fixture(enabled = true) {
  const bridge: BrowserWorkbenchPairingBridge = {
    status: vi.fn(async () => ({ enabled, instanceId: 'instance', origin: 'http://127.0.0.1:1234', tickets: 0, sessions: 0 })),
    begin: vi.fn(async () => ({ ticket, instanceId: 'instance', expiresAt: Date.now() + 60_000 })), revoke: vi.fn(async () => {}),
  };
  const onError = vi.fn();
  function Harness() { const [open, setOpen] = useState(false); return <><BrowserPairingButton bridge={bridge} disabled={false} onOpen={() => setOpen(true)} />{open && <><button onClick={() => setOpen(false)}>关闭配对</button><BrowserPairingPanel bridge={bridge} projectId="project" projectName="Orders" onError={onError} /></>}</>; }
  const view = render(<Harness />);
  const open = async () => { fireEvent.click(await screen.findByRole('button', { name: '浏览器配对' })); await waitFor(() => expect((screen.getByRole('button', { name: '生成一次性配对票据' }) as HTMLButtonElement).disabled).toBe(false)); };
  return { bridge, view, open, onError };
}
test('pairing is hidden outside enabled synthetic mode and opening does not issue a ticket', async () => {
  const off = fixture(false); await act(async () => {}); expect(screen.queryByRole('button', { name: '浏览器配对' })).toBeNull(); expect(off.bridge.begin).not.toHaveBeenCalled(); off.view.unmount();
  const f = fixture(); await f.open(); expect(f.bridge.begin).not.toHaveBeenCalled(); expect(screen.queryByLabelText('一次性票据')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '生成一次性配对票据' })); expect(await screen.findByLabelText('一次性票据')).toBeTruthy();
  expect(f.bridge.begin).toHaveBeenCalledWith('project'); expect(f.bridge.revoke).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '关闭配对' })); await waitFor(() => expect(f.bridge.revoke).toHaveBeenCalledTimes(2)); expect(screen.queryByLabelText('一次性票据')).toBeNull();
});
test('a displayed ticket clears at expiry without extending or revoking a paired session', async () => {
  const f = fixture(); await f.open(); vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: '生成一次性配对票据' })); await act(async () => {}); expect(screen.getByLabelText('一次性票据')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.queryByLabelText('一次性票据')).toBeNull(); expect(screen.getByText(/票据显示已到期/)).toBeTruthy(); expect(f.bridge.begin).toHaveBeenCalledTimes(1); expect(f.bridge.revoke).toHaveBeenCalledTimes(1);
});
test('new begin clears old ticket immediately and errors never leave it displayed', async () => {
  const f = fixture(); await f.open(); fireEvent.click(screen.getByRole('button', { name: '生成一次性配对票据' })); await screen.findByLabelText('一次性票据');
  vi.mocked(f.bridge.begin).mockRejectedValueOnce(new Error('private error'));
  fireEvent.click(screen.getByRole('button', { name: '生成一次性配对票据' })); expect(screen.queryByLabelText('一次性票据')).toBeNull();
  await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('private error'); expect(f.bridge.revoke).toHaveBeenCalledTimes(3);
});
test('closing while begin is pending revokes both on close and after late issuance', async () => {
  const f = fixture(); await f.open(); let resolve!: (value: BrowserWorkbenchTicket) => void;
  vi.mocked(f.bridge.begin).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: '生成一次性配对票据' })); await waitFor(() => expect(f.bridge.begin).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: '关闭配对' })); expect(f.bridge.revoke).toHaveBeenCalledTimes(2);
  await act(async () => { resolve({ ticket, instanceId: 'instance', expiresAt: Date.now() + 60_000 }); });
  expect(f.bridge.revoke).toHaveBeenCalledTimes(3); expect(screen.queryByLabelText('一次性票据')).toBeNull();
});
test('unmount revokes even without generating and reports a revoke failure', async () => {
  const f = fixture(); await f.open(); vi.mocked(f.bridge.revoke).mockRejectedValueOnce(new Error('gone'));
  f.view.unmount(); await waitFor(() => expect(f.onError).toHaveBeenCalledWith(expect.stringContaining('配对撤销未能确认'))); expect(f.bridge.begin).not.toHaveBeenCalled();
});
