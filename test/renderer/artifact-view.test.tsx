/** @vitest-environment jsdom */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ArtifactView } from '@/renderer/components/evidence-view';

afterEach(cleanup);

test('shows a real JSON null instead of falling back to another field', () => {
  const onRead = vi.fn();
  const { rerender } = render(<ArtifactView value={{ artifact: { id: 'artifact-1' }, value: null, text: 'fallback text' }} onRead={onRead} />);

  expect(screen.getByText('null', { selector: 'pre' })).toBeTruthy();
  expect(screen.queryByText('fallback text')).toBeNull();

  rerender(<ArtifactView value={{ artifact: { id: 'artifact-1' }, text: 'fallback text' }} onRead={onRead} />);

  expect(screen.getByText('fallback text', { selector: 'pre' })).toBeTruthy();
  expect(screen.queryByText('null', { selector: 'pre' })).toBeNull();
});

test('marks a budget-truncated response and offers its next slice', () => {
  const onRead = vi.fn();
  render(<ArtifactView value={{ artifact: { id: 'artifact-2' }, value: 'first slice', nextCursor: 'cursor-2', outputTruncated: true }} onRead={onRead} />);

  expect(screen.getByText(/达到单次输出预算/).textContent).toContain('未把截断当作完整');
  fireEvent.click(screen.getByRole('button', { name: '读取下一片' }));
  expect(onRead).toHaveBeenCalledExactlyOnceWith('artifact-2', { cursor: 'cursor-2' });
});

test('passes the selected JSON path into targeted and cursor reads', () => {
  const onRead = vi.fn();
  render(<ArtifactView value={{ artifact: { id: 'artifact-3' }, value: { records: [{ id: 7 }] }, nextCursor: 'cursor-3' }} onRead={onRead} />);

  fireEvent.change(screen.getByRole('textbox', { name: 'JSON 定向路径' }), { target: { value: '$.records[0].id' } });
  fireEvent.click(screen.getByRole('button', { name: '定向读取' }));
  expect(onRead).toHaveBeenLastCalledWith('artifact-3', { jsonPath: '$.records[0].id' });

  fireEvent.click(screen.getByRole('button', { name: '读取下一片' }));
  expect(onRead).toHaveBeenLastCalledWith('artifact-3', { cursor: 'cursor-3', jsonPath: '$.records[0].id' });

  fireEvent.change(screen.getByRole('textbox', { name: 'JSON 定向路径' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '读取下一片' }));
  expect(onRead).toHaveBeenLastCalledWith('artifact-3', { cursor: 'cursor-3' });
  fireEvent.click(screen.getByRole('button', { name: '定向读取' }));
  expect(onRead).toHaveBeenLastCalledWith('artifact-3', {});
  expect(onRead).toHaveBeenCalledTimes(4);
});
