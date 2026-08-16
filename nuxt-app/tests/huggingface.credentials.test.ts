import { describe, expect, it } from 'vitest'

describe('Hugging Face server credential', () => {
  it('authenticates through the lightweight whoami endpoint without exposing the token', async () => {
    const token = process.env.HUGGINGFACE_API_TOKEN
    expect(token, 'HUGGINGFACE_API_TOKEN must be configured in server secrets.').toBeTruthy()
    const response = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    expect(response.ok, `Hugging Face credential validation failed with HTTP ${response.status}`).toBe(true)
    const profile = await response.json() as { type?: string, name?: string }
    expect(profile.type || profile.name).toBeTruthy()
  }, 20_000)
})
