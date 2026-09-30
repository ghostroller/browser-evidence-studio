/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { HostCapabilitiesSummary } from '@/renderer/components/host-capabilities';
import { workbenchHost } from '@/contracts/host-capabilities';

afterEach(cleanup);
test.each(['electron-companion', 'node'] as const)('%s browser UI reports host facts without implying native embedding', backend => {
  render(<HostCapabilitiesSummary host={workbenchHost(backend)} embedded={false} />);
  expect(screen.getByText(/当前网页不嵌入实时浏览器/)).toBeTruthy();
  expect(screen.getByText(/宿主支持不代表本连接已获授权/)).toBeTruthy();
  if (backend === 'node') {
    expect(screen.getByText(/人工输入不被拦截/)).toBeTruthy();
    expect(screen.getByText(/下载与弹出窗口被拒绝/)).toBeTruthy();
  } else expect(screen.getByText(/下载与弹出页面由 Electron 工作台管理/)).toBeTruthy();
});
