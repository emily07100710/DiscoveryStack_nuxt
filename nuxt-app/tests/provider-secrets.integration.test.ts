import { describe, expect, it } from 'vitest'

const firecrawlApiKey = process.env.FIRECRAWL_API_KEY
const huggingFaceToken = process.env.HUGGINGFACE_API_TOKEN
const huggingFaceNamespace = process.env.HUGGINGFACE_NAMESPACE
const externalCredentialTestsEnabled = process.env.DS_RUN_EXTERNAL_CREDENTIAL_TESTS === '1'

describe.skipIf(!externalCredentialTestsEnabled)('server-only provider credentials (explicit external opt-in)', () => {
  it('keeps required provider settings available only to the server test runtime', () => {
    expect(firecrawlApiKey).toBeTruthy()
    expect(huggingFaceToken).toBeTruthy()
    expect(huggingFaceNamespace).toBeTruthy()
  })

  it('validates Firecrawl credentials through its read-only team credit-usage endpoint', async () => {
    const response = await fetch('https://api.firecrawl.dev/v2/team/credit-usage', {
      headers: { Authorization: `Bearer ${firecrawlApiKey}` },
    })

    expect(response.ok, await response.text()).toBe(true)
  })

  it('validates the Hugging Face token through the read-only whoami endpoint', async () => {
    const response = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${huggingFaceToken}` },
    })

    expect(response.ok, await response.text()).toBe(true)
  })
})
