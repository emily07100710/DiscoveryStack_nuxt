import { describe, expect, it } from 'vitest'

describe('Hugging Face namespace secret', () => {
  it('matches the authenticated whoami identity without exposing the token', async () => {
    const token = String(process.env.HUGGINGFACE_API_TOKEN || '').trim()
    const namespace = String(process.env.HUGGINGFACE_NAMESPACE || '').trim()

    expect(token).not.toBe('')
    expect(namespace).not.toBe('')

    const response = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    expect(response.ok).toBe(true)

    const body = await response.json() as { name?: string; preferredUsername?: string }
    const identity = String(body.name || body.preferredUsername || '').trim()
    expect(identity).not.toBe('')
    expect(identity).toBe(namespace)
  })
})

export {}
