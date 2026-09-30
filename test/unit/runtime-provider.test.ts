import { expect, test } from 'vitest';
import { assertProfileProvider, profileProvider } from '@/main/browser/runtime';
test('provider boundaries are explicit and never change legacy storage',()=>{
  const legacy={storageRef:'persist:custom'};
  expect(profileProvider(legacy)).toBe('electron');expect(()=>assertProfileProvider(legacy,'electron')).not.toThrow();
  expect(()=>assertProfileProvider(legacy,'chromium')).toThrow('different browser provider');
  expect(legacy).toEqual({storageRef:'persist:custom'});
  const chromium={provider:'chromium' as const,storageRef:'chromium:12345678-1234-1234-1234-123456789abc'};
  expect(()=>assertProfileProvider(chromium,'chromium')).not.toThrow();expect(()=>assertProfileProvider(chromium,'electron')).toThrow('different browser provider');
  expect(()=>assertProfileProvider({...chromium,storageRef:'persist:custom'},'chromium')).toThrow('storage reference');
});
