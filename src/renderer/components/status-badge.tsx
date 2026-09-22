import { Badge } from './ui/badge';

const labels: Record<string, string> = { recording: '正在记录', starting: '准备采集', paused: '已暂停', degraded: '采集降级', stopped: '已停止', sealed: '已封存', human: '人工控制', agent: '自动化控制', none: '输入已锁定', ready: '就绪', running: '执行中', 'waiting-human': '等待人工', finalizing: '正在保存报告', stopping: '正在停止', completed: '执行完成', failed: '失败', cancelled: '已取消', interrupted: '异常中断', complete: '完整', empty: '真实空值', missing: '缺失', truncated: '已截断', 'read-failed': '读取失败', excluded: '未采集', consistent: '同一导航代际', mixed: '跨越导航', unknown: '未知', pass: '通过', fail: '不通过', inconclusive: '证据不足', 'not-run': '未覆盖' };
export const statusLabel = (value: unknown) => labels[String(value)] || String(value ?? '—');
export function StatusBadge({ value, text }: { value: unknown; text?: string }) {
  return <Badge variant="outline" className={`badge ${String(value)}`}>{text || statusLabel(value)}</Badge>;
}
