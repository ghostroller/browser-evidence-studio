import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from './button';

/** Icon actions retain a stable accessible name and a mouse tooltip. */
export function IconButton({ icon: Icon, label, title = label, ...props }: Omit<React.ComponentProps<typeof Button>, 'children' | 'aria-label'> & { icon: LucideIcon; label: string }) {
  return <Button type="button" variant="ghost" size="icon-sm" {...props} aria-label={label} title={title}><Icon aria-hidden="true" focusable="false" /></Button>;
}
