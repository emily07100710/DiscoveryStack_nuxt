import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builderPhases, builderSteps, motionOptions, phaseForStep } from '../src/lib/website-builder-model'

const component = readFileSync(resolve(process.cwd(), 'src/components/WebsiteBuilderConcept.vue'), 'utf8')
const model = readFileSync(resolve(process.cwd(), 'src/lib/website-builder-model.ts'), 'utf8')
const styles = readFileSync(resolve(process.cwd(), 'src/styles/website-builder.css'), 'utf8')

describe('website builder safety and presentation contracts', () => {
  it('keeps public diagnosis on the homepage and starts the builder without API calls or persistence', () => {
    expect(component).not.toMatch(/publicApiFetch|\bfetch\s*\(|\/api\//)
    expect(component).not.toMatch(/runDiagnosis|analysisResult|entryMode|builder-existing-url/)
    expect(component).toContain("const currentStep = ref<BuilderStep>('diagnosis_or_brief')")
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
    expect(builderSteps).toHaveLength(9)
    expect(builderSteps[0]).toEqual({ id: 'diagnosis_or_brief', label: '理解你的品牌', shortLabel: '品牌' })
    expect(builderSteps.map(step => step.id)).not.toContain('entry')
    expect(model).toContain("'interactive_preview'")
    expect(model).toContain("'review_order'")
    expect(model).toContain('export const cadences = [3, 7, 15, 30]')
    expect(component).toContain('CLIENT OWNED DOMAIN')
    expect(component).toContain('網域原則上歸客戶所有')
  })

  it('groups all nine internal steps into three clear phases without skipping any step', () => {
    expect(builderPhases.map(phase => [phase.id, phase.label])).toEqual([
      ['create', '建立網站'],
      ['plan', '選擇方案'],
      ['launch', '確認上線'],
    ])
    expect(builderPhases.flatMap(phase => phase.steps)).toEqual(builderSteps.map(step => step.id))
    builderSteps.forEach(step => expect(phaseForStep(step.id).steps).toContain(step.id))
  })

  it('offers explicit motion levels and captures a style brief without claiming AI inference', () => {
    expect(motionOptions.map(option => [option.id, option.label])).toEqual([
      ['none', '靜態簡潔'],
      ['refined', '輕盈細節'],
      ['expressive', '互動層次'],
    ])
    expect(component).toContain('builder-style-description')
    expect(component).toContain('motion-choice')
    expect(component).toContain(':data-motion="motionPreference"')
    expect(component).toContain('此預覽尚未連接 AI 風格判讀')
    expect(component).not.toMatch(/publicApiFetch|\bfetch\s*\(|\/api\//)
  })

  it('keeps primary CTA label and arrow readable across enabled and disabled states', () => {
    expect(styles).toContain('.builder-experience .builder-primary {')
    expect(styles).toContain('.builder-experience .builder-primary > span')
    expect(styles).toContain('.builder-experience .builder-primary:disabled { opacity: 1;')
    expect(styles).toContain('color: rgba(255,255,255,.82)')
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
