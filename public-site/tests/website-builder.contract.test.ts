import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const component = readFileSync(resolve(process.cwd(), 'src/components/WebsiteBuilderConcept.vue'), 'utf8')
const model = readFileSync(resolve(process.cwd(), 'src/lib/website-builder-model.ts'), 'utf8')
const styles = readFileSync(resolve(process.cwd(), 'src/styles/website-builder.css'), 'utf8')

const publicApiPaths = [...component.matchAll(/publicApiFetch(?:<[^>]+>)?\('([^']+)'/g)].map((match) => match[1])

describe('website builder safety and presentation contracts', () => {
  it('uses only the existing public site-analysis API and never introduces private credentials or persistence', () => {
    expect(publicApiPaths).toEqual(['/api/site-analysis'])
    expect(component).not.toMatch(/\/api\/(?!site-analysis|leads)[A-Za-z0-9/_-]+/)
    expect(component).not.toMatch(/(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)|document\.cookie\s*=|v-model[^\n]*(?:password|api[_-]?key|access[_-]?token)/i)
    expect(component).toContain('不收集密碼、身分證、付款資料或 API key')
    expect(component).toContain('沒有保存聯絡資料')
  })

  it('keeps preview-only claims explicit and never presents simulated domain/Shopify/payment actions as completed', () => {
    expect(component).toContain('不會扣款')
    expect(component).toContain('不會購買網域')
    expect(component).toContain('不會部署')
    expect(component).toContain('尚未確認可購買')
    expect(component).toContain('SHOPIFY READY / NOT CONNECTED')
    expect(component).toContain('這份預覽不會建立 Shopify 商店')
    expect(component).toContain('NOT A PRODUCTION ORDER')
    expect(component).toContain('不是已付款、已購買網域或已部署的正式成品')
  })

  it('keeps state machine, cadence options, and client-owned domain language in model/data contracts', () => {
    expect(model).toContain("'entry'")
    expect(model).toContain("'interactive_preview'")
    expect(model).toContain("'review_order'")
    expect(model).toContain('export const cadences = [3, 7, 15, 30]')
    expect(component).toContain('CLIENT OWNED DOMAIN')
    expect(component).toContain('網域原則上歸客戶所有')
  })

  it('supports elaborate motion without locking out reduced-motion users or relying on infinite animation loops', () => {
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('animation-iteration-count: 1')
    expect(styles).toContain('@media (max-width: 40rem)')
    expect(styles).toContain('min-height: 2.8rem')
    expect(styles).not.toMatch(/animation:[^;]*(?:infinite|infinity)/i)
  })

  it('includes keyboard dialog semantics, focus-visible styling, and mobile action affordance', () => {
    expect(component).toContain('role="dialog"')
    expect(component).toContain('aria-modal="true"')
    expect(component).toContain('@keydown.esc="closeHandoff"')
    expect(component).toContain('function trapHandoff')
    expect(styles).toContain('button:focus-visible')
    expect(styles).toContain('position: fixed')
    expect(styles).toContain('backdrop-filter: blur(12px)')
  })
})
