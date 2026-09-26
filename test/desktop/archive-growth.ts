import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Snapshot the durable archive footprint for the fixed-load soak. */
export async function archiveGrowth(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        // atomicFile publishes these by rename; a readdir snapshot can outlive the staging name.
        if (/\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(entry.name)) continue;
        files++; bytes += (await stat(absolute)).size;
      }
    }
  };
  await visit(root);
  return { files, bytes };
}
