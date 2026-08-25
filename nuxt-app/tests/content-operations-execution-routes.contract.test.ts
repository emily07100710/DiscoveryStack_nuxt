import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const route = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

describe('content operations execution route contracts', () => {
  it('uses the only allowed target creation endpoint and derives owner/client identity server-side', () => {
    const source = route('../server/api/content-operations/clients/[id]/publication-target.post.ts')
    expect(source).toContain('requireOwner')
    expect(source).toContain("getRouterParam(event, 'id')")
    expect(source).toContain('createOwnerPublicationTarget')
    expect(source).toContain('readBody(event)')
    expect(source).not.toContain('body.clientId')
    expect(source).not.toContain('ownerScopeKey')
    expect(source).not.toContain('configurationFingerprint')
    expect(source).not.toContain('targetId:')
  })

  it('uses a fixed POST execute endpoint with server-resolved lineage and no client-controlled ids', () => {
    const source = route('../server/api/content-operations/entries/[id]/execute.post.ts')
    expect(source).toContain('requireOwner')
    expect(source).toContain("getRouterParam(event, 'id')")
    expect(source).toContain('executeContentOperationEntry')
    expect(source).toContain('readBody(event)')
    expect(source).not.toContain('jobId')
    expect(source).not.toContain('draftId')
    expect(source).not.toContain('reviewId')
    expect(source).not.toContain('riskGateId')
    expect(source).not.toContain('targetId')
    expect(source).not.toContain('contentHash')
  })
})
