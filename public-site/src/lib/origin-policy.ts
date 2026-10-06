export function isPlaceholderPublicOrigin(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return ['example.com', 'example.net', 'example.org', 'example', 'test', 'invalid', 'localhost', 'local', 'internal'].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
  } catch { return true }
}
