import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appRoot = new URL('../', import.meta.url)
const source = (path: string) => readFileSync(new URL(path, appRoot), 'utf8')

describe('Knowledge consumer binding owner UI contract', () => {
  const component = source('components/KnowledgeConsumerBindings.vue')
  const page = source('pages/audit-lab/knowledge.vue')

  it('is mounted in the existing private Knowledge workspace beside impact and history', () => {
    expect(page).toContain('<KnowledgeImpactPreview :entities="entities" :claims="claims" :sources="sources" />')
    expect(page).toContain('<KnowledgeRevisionHistory :entities="entities" :claims="claims" :sources="sources" />')
    expect(page).toContain('<KnowledgeConsumerBindings :entities="entities" :claims="claims" :sources="sources" />')
  })

  it('uses explicit owner reads, exact subject history checks, and immutable native catalogs without guessing', () => {
    expect(component).toContain("request('/api/knowledge/consumer-bindings')")
    expect(component).toContain("request('/api/knowledge/consumer-catalog', { query: { kind: selectedKind } })")
    expect(component).toContain("request('/api/knowledge/revision-history', { query: { kind, id } })")
    expect(component).toContain("scope !== 'owner_native_immutable_consumers_v1'")
    expect(component).toContain('nativeAvailability === \'missing\'')
    expect(component).toContain('generation !== requestGeneration')
    expect(component).toContain('selectedKind !== consumerKind.value')
    expect(component).toContain('catalogAfterId.value')
    expect(component).toContain('new Set(catalog.items.map(item => item.consumerId))')
    expect(component).not.toMatch(/onMounted\s*\(/u)
    expect(component).not.toMatch(/watch\(consumerKind,[\s\S]{0,300}?request\(/u)
  })

  it('requires current revision and owner acknowledgment before mutations; replay retry retains one exact body', () => {
    expect(component).toContain('crypto.randomUUID()')
    expect(component).toContain('expectedRevisionFingerprint: operation === \'bind\' ? revision.value!.revisionFingerprint : null')
    expect(component).toContain('expectedBindingFingerprint: currentBinding.value?.bindingFingerprint ?? null')
    expect(component).toContain('我了解這只登錄依賴，不核准訓練或發布。')
    expect(component).toContain('checked.value && !!selectedNative.value')
    expect(component).toContain("status === 409")
    expect(component).toContain('pendingCommand.value = command')
    expect(component).toContain('request(\'/api/knowledge/consumer-bindings\', { method: \'POST\', body: command.body })')
    expect(component).toContain('重試同一命令')
    expect(component).toContain('重新綁定目前修訂')
    expect(component).toContain('撤銷依賴')
    expect(component).not.toMatch(/\.catch\([^)]*=>[^)]*uuid/u)
  })

  it('validates bounded, private DTOs and preserves absent public-api/reviewer adapters as explicit scope', () => {
    expect(component).toContain('catalog.items.length > 25')
    expect(component).toContain('catalog.nextAfterId <= afterId')
    expect(component).toContain('Number(value.consumerVersion) <= 2_147_483_647')
    expect(component).toContain('catalog.nextAfterId !== ids.at(-1)')
    expect(component).toContain('catalog.items.length !== 25')
    expect(component).toContain('page.items.some(item => catalogItems.value.some(existing => existing.consumerId === item.consumerId))')
    expect(component).toContain("['category', 'state', 'scope', 'limitationCodes', 'registeredConsumerCount']")
    expect(component).not.toContain('value.consumers')
    expect(component).not.toContain('value.items')
    expect(component).toContain('公開 API 與 reviewer 尚未接入。')
    expect(component).toContain('未登錄關係不在範圍內')
    expect(component).toContain('automaticPublication !== false')
    expect(component).toContain('automaticTrainingAdmission !== false')
    expect(component).toContain('productionActivation !== false')
  })

  it('has responsive and accessible confirmation, pending, error, and recovery surfaces', () => {
    expect(component).toContain('aria-labelledby="consumer-bindings-title"')
    expect(component).toContain('aria-label="選擇 native consumer"')
    expect(component).toContain('role="alert"')
    expect(component).toContain('role="status"')
    expect(component).toContain('aria-live="polite"')
    expect(component).toContain('@media(max-width:720px)')
    expect(component).toContain('需要重新核對')
    expect(component).toContain('命令結果尚未確認')
  })
})
