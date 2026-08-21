import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const component = readFileSync(new URL('../components/site/CookieConsent.vue', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../layouts/default.vue', import.meta.url), 'utf8')

describe('cookie consent contract', () => {
  it('offers an equally visible necessary-only choice and explicit all-cookie choice', () => {
    expect(component).toContain("@click=\"save('necessary')\"")
    expect(component).toContain("@click=\"save('all')\"")
    expect(component).toContain('cookie-button-secondary')
    expect(component).toContain('cookie-button-primary')
  })

  it('persists a versioned preference and does not claim analytics are already active', () => {
    expect(component).toContain("useCookie<ConsentLevel | null>('discoverystack_consent'")
    expect(component).toContain('目前本站尚未啟用第三方分析追蹤')
    expect(component).toContain('no third-party analytics are currently enabled')
  })

  it('can be reopened from the site footer', () => {
    expect(layout).toContain('openCookieSettings')
    expect(layout).toContain('Cookie 設定')
  })
})
