import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFirstPartyMarkdownArtifact } from '../server/first-party-publishing/artifact'
import { canonicalFingerprint } from '../server/managed-sites/page-editor/canonical'
import {
  parseManagedPageTransport,
  serializeManagedPageTransport,
} from '../server/managed-sites/page-editor/transport'
import type { CompiledPageArtifact } from '../server/managed-sites/page-editor/types'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function compiled(route: string, contentType: CompiledPageArtifact['contentType'], pageVersion = 1): CompiledPageArtifact {
  const stable = {
    version: 'managed-site-page-artifact-v1' as const,
    pageId: `page-${contentType}`,
    pageVersion,
    route,
    locale: 'zh-hant',
    contentType,
    design: {
      palette: 'indigo_sand' as const,
      typeScale: 'balanced' as const,
      spacing: 'balanced' as const,
      radius: 'soft' as const,
      maxWidth: 'standard' as const,
      contrast: 'aa' as const,
    },
    blocks: [
      {
        blockId: `block-${contentType}`,
        type: 'rich_text' as const,
        visible: true,
        layoutVariant: 'prose',
        data: { nodes: [{ type: 'paragraph', text: `Rendered ${contentType}` }] },
        mediaBindingIds: [],
        schedule: null,
        responsive: { desktop: 'prose-readable', tablet: 'prose-readable', mobile: 'prose-mobile' },
        media: [],
      },
    ],
    seo: {
      title: `Title ${contentType}`,
      description: `Description ${contentType}`,
      canonicalPath: route,
      noindex: false,
      ogBindingId: null,
    },
    pageFingerprint: sha256(`page-${contentType}-${pageVersion}`),
    mediaSetFingerprint: canonicalFingerprint([]),
  }
  return {
    ...stable,
    artifactFingerprint: canonicalFingerprint(stable),
    generatedAt: '2026-08-29T00:00:00.000Z',
  }
}

function publication(artifact: CompiledPageArtifact) {
  const body = serializeManagedPageTransport(artifact)
  if (!body) throw new Error('fixture transport failed')
  const slug = artifact.route === '/' ? 'index' : artifact.route.slice(1).replaceAll('/', '--')
  return {
    body,
    approved: {
      ownerScopeKey: 'owner-fixture',
      scheduleEntryId: `entry-${artifact.pageId}`,
      productionPlanId: 'plan-managed-page-fixture',
      productionDeliverableId: `deliverable-${artifact.pageId}`,
      jobId: `job-${artifact.pageId}`,
      draftId: `draft-${artifact.pageId}`,
      draftVersion: artifact.pageVersion,
      draftStage: 'optimized',
      reviewId: `review-${artifact.pageId}`,
      reviewDecision: 'approved_for_delivery',
      riskGateStatus: 'passed',
      evidenceSnapshotHash: artifact.pageFingerprint,
      contentHash: sha256(body),
      title: artifact.seo.title,
      body,
      slug,
      contentType: 'managed_page',
      language: artifact.locale,
      scheduledAt: artifact.generatedAt,
      scheduleKey: `managed-page-${artifact.pageId}-${artifact.pageVersion}`,
      authoritySourceIds: ['managed-site-release-fixture'],
      ruleIds: ['managed-site-page-publish-v1'],
    },
  }
}

async function materializeFixture(framework: 'astro' | 'nuxt', artifact: CompiledPageArtifact) {
  const root = await mkdtemp(join(tmpdir(), `managed-page-${framework}-`))
  created.push(root)
  const { approved } = publication(artifact)
  const result = buildFirstPartyMarkdownArtifact('src/content', approved)
  if (result.status !== 'ok') throw new Error(`artifact failed: ${result.code}`)
  const destination = join(root, result.artifact.path)
  await mkdir(join(destination, '..'), { recursive: true })
  await writeFile(destination, result.artifact.body, 'utf8')
  const parsed = parseManagedPageTransport(await readFile(destination, 'utf8'))
  if (!parsed) throw new Error('fixture transport parse failed')
  const rendered = `<main data-framework="${framework}" data-route="${parsed.route}" data-page-type="${parsed.pageType}">${parsed.artifact.blocks.map(block => `<section data-block="${block.blockId}">${JSON.stringify(block.data)}</section>`).join('')}</main>`
  return { result, parsed, rendered, destination }
}

describe('Managed page transport contract', () => {
  for (const framework of ['astro', 'nuxt'] as const) {
    it(`materializes and renders homepage, service, case and contact routes in a disposable ${framework} fixture`, async () => {
      const cases = [
        ['/', 'home', 'index'],
        ['/services', 'services', 'services'],
        ['/cases', 'cases', 'cases'],
        ['/contact', 'contact', 'contact'],
      ] as const
      for (const [route, pageType, slug] of cases) {
        const fixture = await materializeFixture(framework, compiled(route, pageType))
        expect(fixture.result.artifact.path).toBe(`src/content/zh-hant/pages/${slug}.json`)
        expect(fixture.parsed).toMatchObject({ route, pageType, artifactFingerprint: fixture.parsed.artifact.artifactFingerprint })
        expect(fixture.parsed.artifact.blocks).toHaveLength(1)
        expect(fixture.parsed.mediaManifest).toEqual([])
        expect(fixture.rendered).toContain(`data-route="${route}"`)
        expect(fixture.rendered).toContain(`Rendered ${pageType}`)
        expect(fixture.result.artifact.frontmatter).toBe('')
        expect(fixture.result.artifact.path).not.toContain('/articles/')
      }
    })
  }

  it('rolls back by replacing the same canonical route artifact with the exact prior version bytes', async () => {
    const first = await materializeFixture('astro', compiled('/services', 'services', 1))
    const secondBytes = publication(compiled('/services', 'services', 2)).body
    await writeFile(first.destination, secondBytes, 'utf8')
    expect(parseManagedPageTransport(await readFile(first.destination, 'utf8'))?.artifact.pageVersion).toBe(2)
    await writeFile(first.destination, first.result.artifact.body, 'utf8')
    const rolledBack = await readFile(first.destination, 'utf8')
    expect(rolledBack).toBe(first.result.artifact.body)
    expect(parseManagedPageTransport(rolledBack)?.artifact.pageVersion).toBe(1)
  })

  it('fails closed when route, page type, block tree, media manifest, fingerprint or bytes are changed', () => {
    const bytes = publication(compiled('/contact', 'contact')).body
    const source = JSON.parse(bytes)
    for (const mutate of [
      (value: any) => { value.route = '/other' },
      (value: any) => { value.pageType = 'services' },
      (value: any) => { value.artifact.blocks[0].data = { nodes: [] } },
      (value: any) => { value.mediaManifest = [{ bindingId: 'forged' }] },
      (value: any) => { value.transportFingerprint = '0'.repeat(64) },
    ]) {
      const changed = structuredClone(source)
      mutate(changed)
      expect(parseManagedPageTransport(JSON.stringify(changed))).toBeNull()
    }
    expect(parseManagedPageTransport(`${bytes}\n`)).toBeNull()
  })
})
