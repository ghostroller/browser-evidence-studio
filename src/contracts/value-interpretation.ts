import type { FieldSourceProof } from './workflow';

/** Frozen v1: ASCII decimal, optional minus, no whitespace/plus/exponent/units.
 * At most 64 characters and 18 fractional places, |value| <= MAX_SAFE_INTEGER.
 * The number's shortest decimal representation must preserve the exact decimal
 * value (trailing zeroes and negative zero are insignificant). No epsilon.
 */
export type ValueInterpretation = { kind: 'plain-decimal'; version: 1 };
export const DECIMAL_V1_DESCRIPTION = '纯十进制 v1：可带负号；不接受空白、币种、千分位、百分号或指数。最多 64 字符、18 位小数，绝对值不超过安全整数上限，十进制往返不得丢失精度。实体标识仍逐字匹配。';

export function parseValueInterpretation(value: unknown): ValueInterpretation {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['kind', 'version'].includes(key)) ||
      (value as ValueInterpretation).kind !== 'plain-decimal' || (value as ValueInterpretation).version !== 1) {
    throw new Error('Unsupported value interpretation; expected plain-decimal version 1');
  }
  return { kind: 'plain-decimal', version: 1 };
}

function canonicalDecimal(text: string): string {
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const tail = fraction.replace(/0+$/, '');
  return `${negative && (whole !== '0' || tail) ? '-' : ''}${whole}${tail ? `.${tail}` : ''}`;
}
function expandedNumber(value: number): string {
  const text = String(value);
  if (!text.includes('e')) return text;
  const [mantissa, exponentText] = text.split('e');
  const negative = mantissa.startsWith('-'), unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ''] = unsigned.split('.'), digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? '-' : ''}${expanded}`;
}
export function interpretPlainDecimal(text: string): { ok: true; value: number } | { ok: false; reason: string } {
  if (text.length > 64 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(text)) return { ok: false, reason: '原始文本不符合纯十进制 v1 语法（不自动去空白、符号或单位）' };
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || canonicalDecimal(expandedNumber(value)) !== canonicalDecimal(text)) return { ok: false, reason: '原始十进制超出范围或转为 number 会丢失可观察精度' };
  return { ok: true, value: value === 0 ? 0 : value };
}

/** Kept out of material parsing: old immutable materials must remain readable/hash-stable. */
export function sourceProofCompatibility(field: { valueType?: string; sourceProof?: FieldSourceProof }): string | undefined {
  const proof = field.sourceProof;
  if (proof?.kind !== 'dom-text') return undefined;
  if (proof.valueInterpretation) {
    if (field.valueType !== 'number') return '配置不相容：纯十进制 v1 仅适用于明确的 number 字段。';
  } else if (field.valueType && field.valueType !== 'string') return `配置不相容：${field.valueType} 字段不能使用精确文本映射；数值字段需要显式纯十进制 v1。`;
  return undefined;
}
