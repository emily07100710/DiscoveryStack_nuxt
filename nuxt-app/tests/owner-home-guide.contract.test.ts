import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const homePath = new URL('../pages/audit-lab.vue', import.meta.url)
const source = readFileSync(homePath, 'utf8')
const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>') + '</template>'.length)

describe('owner home work guide integration contract', () => {
  it('shows the guide only inside the authenticated overview and leaves advanced tools closed by default', () => {
    const authBranch = template.indexOf('v-else-if="state === \'signin\'"')
    const errorBranch = template.indexOf('v-else-if="state === \'error\'"')
    const overviewBranch = template.indexOf('v-else-if="overview"')
    const guide = template.indexOf('<OwnerWorkGuide />')
    const advanced = template.indexOf('<details class="audit-advanced-tools" id="audit-advanced-tools">')
    expect(authBranch).toBeGreaterThan(-1)
    expect(errorBranch).toBeGreaterThan(authBranch)
    expect(overviewBranch).toBeGreaterThan(errorBranch)
    expect(guide).toBeGreaterThan(overviewBranch)
    expect(advanced).toBeGreaterThan(guide)
    expect(template.match(/<OwnerWorkGuide\s*\/>/g)).toHaveLength(1)
    const advancedStart = template.slice(advanced, template.indexOf('>', advanced) + 1)
    expect(advancedStart).not.toMatch(/\sopen(?:\s|>)/)
    expect(template.slice(advanced, advanced + 350)).toContain('需要建立來源、人工標註或審核訓練資料時再展開')
  })

  it('keeps nested audit pages mounted through NuxtPage and reloads the overview on return', () => {
    expect(source).toContain("const isNestedAuditRoute = computed(() => route.path.startsWith('/audit-lab/'))")
    expect(template).toMatch(/<NuxtPage\s+v-if="isNestedAuditRoute"\s*\/>/)
    expect(source).toContain('onMounted(() => { if (!isNestedAuditRoute.value) void loadOverview() })')
    expect(source).toContain('watch(isNestedAuditRoute, (isNested) => { if (!isNested) void loadOverview() })')
  })

  it('retains explicit source, review, removal, and immutable manifest handler safeguards', () => {
    expect(source).toMatch(/async function createPublicSource\(\)[\s\S]*?fetchWorkspace\('\/api\/intelligence\/sources', \{ method: 'POST'/)
    expect(source).toMatch(/async function submitSourceReview\(\)[\s\S]*?if \(!activeSourceReview\.value\) return[\s\S]*?\$\{activeSourceReview\.value\.id\}\/review`, \{ method: 'POST'/)
    expect(source).toMatch(/async function removePublicSource\(source: PublicSource\)[\s\S]*?window\.confirm\([\s\S]*?\$\{source\.id\}\/remove`, \{ method: 'POST'/)
    expect(source).toMatch(/async function createDatasetManifest\(\)[\s\S]*?\/api\/intelligence\/datasets', \{ method: 'POST'/)
    expect(source).toMatch(/async function approvePublicDataset\(datasetId: number\)[\s\S]*?\$\{datasetId\}\/approve`, \{ method: 'POST'/)
    expect(template).toContain("v-if=\"dataset.status === 'ready_for_review'\"")
    expect(template).toContain('至少 16 字的核准理由')
    expect(template).toContain("(datasetApprovalNotes[dataset.id] || '').trim().length < 16")
    expect(template).toContain('固定成員、固定雜湊、可逐項覆核。')
  })
})
