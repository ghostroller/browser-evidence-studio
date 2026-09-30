import React from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

/** Shared controlled project metadata form. Hosts retain their own authorization,
 * revision, operation ID and lifecycle semantics; this form never reads or writes. */
export function ProjectMetadataForm({ name, objective, onName, onObjective, onSubmit, onCancel, dirty, busy, disabled = false, creating = false, children }: {
  name: string; objective: string; onName(value: string): void; onObjective(value: string): void;
  onSubmit(): void; onCancel(): void; dirty: boolean; busy: boolean; disabled?: boolean; creating?: boolean; children?: React.ReactNode;
}) {
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); if (!busy && !disabled && name.trim()) onSubmit(); }}>
    <h3>{creating ? '创建项目' : '项目资料'}</h3>
    {creating && <p className="hint">创建后先整理项目资料；设为当前浏览项目后开始整理保存点。</p>}
    <Label>项目名称<Input aria-label="项目名称" value={name} onChange={event => onName(event.target.value)} maxLength={200} disabled={busy || disabled} /></Label>
    <Label>目录简介<Textarea aria-label="目录简介" value={objective} onChange={event => onObjective(event.target.value)} maxLength={4000} disabled={busy || disabled} /></Label>
    <div className="button-row"><Button variant="default" type="submit" disabled={busy || disabled || !name.trim()}>{creating ? '创建项目' : '保存项目修改'}</Button>
    {dirty && <Button type="button" disabled={busy} onClick={onCancel}>撤销项目输入</Button>}
    </div>
    {children}
  </form>;
}
