/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TaskAuthorizations } from '@/renderer/components/task-authorizations';

afterEach(() => { cleanup(); delete (window as Partial<Window>).studio; });

test('issues an offline history/material grant without a browser session and revokes it explicitly', async () => {
  let grant: any;
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'taskAuthorizations') return { instanceId: 'instance-one', items: grant ? [grant] : [] };
    if (method === 'authorizeTask') { grant = { ...body, authorizationId: 'grant-one', status: 'active', expiresAt: '2030-01-01T00:00:00Z', remainingOperations: 20, maxOperations: 20, origins: [], pages: [] }; return grant; }
    if (method === 'revokeTask') { grant = { ...grant, status: 'revoked', reason: 'Revoked by human' }; return grant; }
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  render(<TaskAuthorizations projectId="project-one" onChanged={vi.fn(async () => undefined)} />);
  fireEvent.click(screen.getByRole('button', { name: '授予这次任务' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('authorizeTask', {
    projectId: 'project-one', capabilities: ['materials-read', 'history-read', 'results-read'], durationMs: 120000, maxOperations: 20,
  }));
  await waitFor(() => expect(screen.getByText(/剩余 20 \/ 20 次/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '撤销此授权' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('revokeTask', { projectId: 'project-one', authorizationId: 'grant-one' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '撤销此授权' })).toBeNull());
});

test('live browser grant requires the current human lease and exact page and origin', async () => {
  const call = vi.fn(async (method: string, body: any) => {
    if (method === 'taskAuthorizations') return { instanceId: 'instance-one', items: [] };
    if (method === 'authorizeTask') return { ...body, authorizationId: 'grant-live', status: 'active', expiresAt: '2030-01-01T00:00:00Z', remainingOperations: 20, maxOperations: 20 };
    throw new Error(method);
  });
  window.studio = { call, bounds: vi.fn() };
  const session = { sessionId: 'session-one', selectedPageId: 'page-one', pages: [{ pageId: 'page-one', targetId: 'target-one', url: 'https://example.test/orders', title: 'Orders' }] };
  const props = { projectId: 'project-one', session, project: { scriptDirectory: 'D:\\workflow' }, onChanged: vi.fn(async () => undefined) };
  const view = render(<TaskAuthorizations {...props} />);
  fireEvent.click(screen.getByLabelText('操作当前页面'));
  expect(screen.getByRole('button', { name: '授予这次任务' }).hasAttribute('disabled')).toBe(true);
  view.rerender(<TaskAuthorizations {...props} active={{ projectId: 'project-one', profileId: 'profile-one', leaseEpoch: 7, controller: 'human', locked: false }} />);
  await waitFor(() => expect(screen.getByLabelText('允许的精确来源')).toHaveProperty('value', 'https://example.test'));
  fireEvent.click(screen.getByRole('button', { name: '授予这次任务' }));
  await waitFor(() => expect(call).toHaveBeenCalledWith('authorizeTask', expect.objectContaining({
    projectId: 'project-one', sessionId: 'session-one', profileId: 'profile-one', leaseEpoch: 7,
    pageIds: ['page-one'], origins: ['https://example.test'], capabilities: expect.arrayContaining(['page-act']),
  })));
});
