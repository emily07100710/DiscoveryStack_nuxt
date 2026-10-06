import { randomUUID } from 'node:crypto'

export function fail(status, message, code = 'INVALID_INPUT') {
  throw Object.assign(new Error(message), { status, code })
}
export function text(value, label, max = 2000) {
  if (typeof value !== 'string') fail(422, `${label}格式不正確`)
  const result = value.normalize('NFC').trim()
  if (!result || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) fail(422, `${label}不可空白或超過 ${max} 字`)
  return result
}
export function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(422, `${label}必須介於 ${min} 至 ${max}`)
  return value
}
export const id = () => randomUUID()
export const iso = (now = new Date()) => new Date(now).toISOString()
