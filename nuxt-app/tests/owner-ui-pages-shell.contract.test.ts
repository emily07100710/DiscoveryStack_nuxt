import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nuxtConfig = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8')
const asyncState = readFileSync(new URL('../components/OwnerAsyncState.vue', import.meta.url), 'utf8')
const pager = readFileSync(new URL('../components/OwnerPager.vue', import.meta.url), 'utf8')
const confirmAction = readFileSync(new URL('../components/OwnerConfirmAction.vue', import.meta.url), 'utf8')

const OWNER_SUB_PAGES = [
  { route: '/audit-lab/managed-sites/projects', file: '../pages/audit-lab/managed-sites/projects.vue' },
  { route: '/audit-lab/content-operations/strategy', file: '../pages/audit-lab/content-operations/strategy.vue' },
  { route: '/audit-lab/system-factory/tenants', file: '../pages/audit-lab/system-factory/tenants.vue' },
  { route: '/audit-lab/measurement-operations/runs', file: '../pages/audit-lab/measurement-operations/runs.vue' },
] as const

const PARENT_PAGES = [
  { file: '../pages/audit-lab/managed-sites.vue', child: '/audit-lab/managed-sites/projects' },
  { file: '../pages/audit-lab/content-operations.vue', child: '/audit-lab/content-operations/strategy' },
  { file: '../pages/audit-lab/system-factory.vue', child: '/audit-lab/system-factory/tenants' },
  { file: '../pages/audit-lab/measurement-operations.vue', child: '/audit-lab/measurement-operations/runs' },
] as const

function read(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('owner sub-page shell contract', () => {
  it('gives every new owner sub-page its own noindex/no-store routeRule', () => {
    // The '/audit-lab/**' wildcard already covers these; pinning each route means a change to the
    // wildcard cannot quietly turn a private workbench page into an indexable, cacheable one.
    for (const { route } of OWNER_SUB_PAGES) {
      const rule = nuxtConfig.split('\n').find(line => line.includes(`'${route}':`))
      expect(rule, `missing routeRule for ${route}`).toBeTruthy()
      expect(rule).toContain('noindex, nofollow, noarchive')
      expect(rule).toContain('private, no-store, max-age=0')
    }
  })

  it('keeps every new owner sub-page on the owner layout behind the server-side guard', () => {
    for (const { file, route } of OWNER_SUB_PAGES) {
      const page = read(file)
      expect(page, `${route} must use the owner layout`).toContain("definePageMeta({ layout: 'owner' })")
      expect(page).toContain('noindex, nofollow, noarchive')
      // Owner authority is established server-side; a page must never assert its own.
      expect(page).not.toContain('requireOwner')
      expect(page).not.toContain("credentials: 'include'")
      expect(page).not.toContain("from '../../server/")
      expect(page).not.toContain("from '../../../server/")
      expect(page).not.toContain('v-html')
    }
  })

  it('reaches every new sub-page from its parent page through a nested route', () => {
    for (const { file, child } of PARENT_PAGES) {
      const parent = read(file)
      expect(parent, `${file} must render its child route`).toContain('<NuxtPage')
      expect(parent, `${file} must link to ${child}`).toContain(child)
    }
  })

  it('loads a parent page that defers its data when the owner navigates back from a child route', () => {
    // Leaving a child route reuses the parent component, so onMounted never fires again; only a
    // watcher on isNestedRoute can start the first load, and a once-guard keeps it from repeating.
    const measurement = read('../pages/audit-lab/measurement-operations.vue')
    expect(measurement).toContain('function loadWhenParentVisible() { if (isNestedRoute.value || workspaceRequested) return; workspaceRequested = true; void loadWorkspace() }')
    expect(measurement).toContain('onMounted(loadWhenParentVisible)')
    expect(measurement).toContain('watch(isNestedRoute, loadWhenParentVisible)')
    const systemFactory = read('../pages/audit-lab/system-factory.vue')
    expect(systemFactory).toContain('async function loadOverview() { if (isNestedRoute.value || overviewRequested) return; overviewRequested = true;')
    expect(systemFactory).toContain('onMounted(loadOverview)')
    expect(systemFactory).toContain('watch(isNestedRoute, () => { void loadOverview() })')
  })

  it('handles loading, error and empty in one shared state envelope', () => {
    expect(asyncState).toContain('owner-state--loading')
    expect(asyncState).toContain('owner-state--error')
    expect(asyncState).toContain('owner-state--empty')
    expect(asyncState).toContain("role=\"alert\"")
    expect(asyncState).toContain("$emit('retry')")
    // The default slot must stay behind all three states, or a page renders rows it does not have.
    expect(asyncState).toContain('<slot v-else />')
  })

  it('never lets the pager step outside a known page range', () => {
    expect(pager).toContain("emit('update:page', props.page - 1)")
    expect(pager).toContain("emit('update:page', props.page + 1)")
    expect(pager).toContain('if (canPrev.value)')
    expect(pager).toContain('if (canNext.value)')
    expect(pager).toContain('props.hasMore === true')
  })

  it('unlocks a destructive action only after the operator retypes the exact target name', () => {
    expect(confirmAction).toContain("typed.value.trim() === props.target.trim()")
    expect(confirmAction).toContain('props.target.trim().length > 0')
    expect(confirmAction).toContain(':disabled="!canConfirm"')
    expect(confirmAction).toContain('if (canConfirm.value) emit(\'confirm\')')
    // Reopening the dialog must not inherit the previous confirmation.
    expect(confirmAction).toContain("watch(() => props.open, (open) => { if (!open) typed.value = '' })")
  })

  it('states plainly when an action has no real counterpart behind it', () => {
    expect(confirmAction).toContain('未接真實對端')
    expect(confirmAction).toContain('不會真的開通')
  })

  it('never asserts irreversibility itself; each action supplies its own consequence text', () => {
    // Suspend, invitation revoke and domain release differ in whether they can be undone, so the
    // shared dialog cannot claim every confirmed action is permanent.
    expect(confirmAction).not.toContain('無法復原')
    expect(confirmAction).toContain('consequence?: string')
    expect(confirmAction).toContain('<p v-if="consequence" class="owner-confirm__consequence">{{ consequence }}</p>')
  })

  it('carries no credential, endpoint secret or connection string in the shared components', () => {
    for (const source of [asyncState, pager, confirmAction]) {
      expect(source).not.toMatch(/api[_-]?key/i)
      expect(source).not.toMatch(/mysql:\/\/|postgres:\/\/|https?:\/\/[^\s"'`]*:[^\s"'`]*@/i)
      expect(source).not.toMatch(/process\.env/)
    }
  })

  it('gives every owner sub-page list a text filter, a select filter, pagination and at least one write action', () => {
    for (const { route, file } of OWNER_SUB_PAGES) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, route).toContain('type="search"')
      expect(source, route).toMatch(/<select v-model="[A-Za-z]+"/u)
      expect(source, route).toMatch(/const filtered[A-Za-z]* = computed/u)
      expect(source, route).toContain('<OwnerPager')
      expect(source, route).toMatch(/:total="filtered[A-Za-z]*\.length"/u)
      expect(source, route).toContain("method: 'POST'")
    }
  })
})
