import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => io);

import { archiveGrowth } from '../desktop/archive-growth';

const file = (name: string) => ({ name, isDirectory: () => false, isFile: () => true });
const missing = () => Object.assign(new Error('File was renamed after directory enumeration'), { code: 'ENOENT' });

describe('archive growth measurement', () => {
  beforeEach(() => { io.readdir.mockReset(); io.stat.mockReset(); });

  it('does not stat an atomic index staging file that can disappear on publication', async () => {
    io.readdir.mockResolvedValue([file('stream.json'), file('stream.json.977faf34-fbf1-4d5a-9127-c13fbd810a41.tmp')]);
    io.stat.mockImplementation(async (name: string) => {
      if (name.endsWith('.tmp')) throw missing();
      return { size: 7 };
    });
    await expect(archiveGrowth('run')).resolves.toEqual({ files: 1, bytes: 7 });
    expect(io.stat).toHaveBeenCalledTimes(1);
  });

  it('still reports a missing durable archive file', async () => {
    io.readdir.mockResolvedValue([file('stream.json')]);
    io.stat.mockRejectedValue(missing());
    await expect(archiveGrowth('run')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('counts a durable file whose name merely ends in tmp', async () => {
    io.readdir.mockResolvedValue([file('source.tmp')]);
    io.stat.mockResolvedValue({ size: 11 });
    await expect(archiveGrowth('run')).resolves.toEqual({ files: 1, bytes: 11 });
  });
});
