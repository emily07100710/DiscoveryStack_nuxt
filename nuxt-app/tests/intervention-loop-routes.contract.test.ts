import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchInterventionRoute } from '../server/intervention-loop/http-router'
const root = new URL('../', import.meta.url).pathname
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []) }
const INTERVENTION_ACTIONS = ['assess', 'cancel', 'check-deployment', 'check-recrawl', 'confirm-deployment', 'confirm-recrawl', 'measure', 'measurements', 'pull-metrics']
describe('intervention owner routes', () => {
  // Exactly one route file is a hard budget, not a preference: this app sits at the TypeScript
  // depth limit for Nitro's typed route map, and a second key here breaks `pnpm typecheck`
  // in unrelated pages (measured: pages/audit-lab.vue TS2589). See INTERVENTION_LOOP_RUNTIME_V1.md.
  it('keeps the route map to a single catch-all file, all private, with mutations same-origin', () => {
    const routeFiles = files(`${root}server/api/interventions`)
    expect(routeFiles.map(file => file.slice(`${root}server/api/interventions/`.length)).sort()).toEqual(['[...path].ts'])
    for (const file of routeFiles) { expect(basename(file).startsWith('_')).toBe(false); expect(readFileSync(file, 'utf8')).not.toContain('console.log') }
    expect(readFileSync(`${root}server/api/interventions/[...path].ts`, 'utf8')).toContain('handleInterventionRoute')
    const router = readFileSync(`${root}server/intervention-loop/http-router.ts`, 'utf8')
    for (const token of ['setInterventionPrivateApiHeaders(event)', 'await requireInterventionOwner(event)', "if (matched.route.method === 'POST') { assertSameOriginMutation(event); body = await readInterventionBody(event) }", 'Unknown intervention route', 'Unknown intervention action', 'Unknown experiment action']) expect(router).toContain(token)
    for (const action of [...INTERVENTION_ACTIONS, 'attach', 'conclude']) expect(router).toContain(`['${action}',`)
    expect(router).not.toContain('console.log')
    expect(readFileSync(`${root}server/intervention-loop/index.ts`, 'utf8')).not.toContain('./http')
  })
  it('matches the documented sub-routes exactly and rejects everything else', () => {
    const cases: Array<[string, string[], string[] | null, string[]]> = [
      ['GET', ['5'], [':id'], ['5']],
      ['POST', ['5', 'confirm-recrawl'], [':id', ':action'], ['5', 'confirm-recrawl']],
      ['GET', ['export'], ['export'], []],
      ['GET', ['experiments'], ['experiments'], []],
      ['POST', ['experiments'], ['experiments'], []],
      ['POST', ['experiments', '3', 'attach'], ['experiments', ':id', ':action'], ['3', 'attach']],
      ['GET', ['list'], ['list'], []], // the collection itself; the bare /api/interventions is not routable
      ['POST', ['register'], ['register'], []],
      ['POST', ['list'], null, []],
      ['GET', ['register'], [':id'], ['register']], // one GET segment is always an id; positiveId() rejects it with 422
      ['GET', ['refresh-policy'], ['refresh-policy'], []],
      ['POST', ['refresh-policy'], ['refresh-policy'], []],
      ['GET', ['refresh-queue'], ['refresh-queue'], []],
      ['POST', ['refresh-queue'], ['refresh-queue'], []],
      ['POST', ['refresh-queue', '7', 'status'], ['refresh-queue', ':id', 'status'], ['7']],
      ['POST', ['tick'], ['tick'], []],
      ['GET', ['tick'], [':id'], ['tick']], // one GET segment is always an id; positiveId() rejects it with 422
      ['POST', ['export'], null, []],
      ['DELETE', ['5'], null, []],
      ['POST', ['5', 'assess', 'extra'], null, []],
      ['GET', [], null, []],
    ]
    for (const [method, segments, pattern, params] of cases) {
      const matched = matchInterventionRoute(method, segments)
      if (pattern === null) expect(matched, `${method} /${segments.join('/')}`).toBeNull()
      else { expect(matched?.route.pattern, `${method} /${segments.join('/')}`).toEqual(pattern); expect(matched?.params).toEqual(params) }
    }
  })
  it('keeps bounded private helpers, page and nav', () => { const helper = readFileSync(`${root}server/intervention-loop/http.ts`, 'utf8'); expect(helper).toContain('64 * 1024'); expect(helper).toContain('no-store'); expect(helper).toContain('noindex, nofollow, noarchive'); const page = readFileSync(`${root}pages/audit-lab/interventions.vue`, 'utf8'); expect(page).toContain("definePageMeta({ layout: 'owner' })"); expect(page).toContain("content: 'noindex,nofollow,noarchive'"); expect(page).toContain('status === 401 || status === 403'); expect(page).toContain('登入已逾期，請重新登入。'); expect(page).toContain('v-if="isUnauthorized" class="card"'); expect(page).toContain("useFetch<any>('/api/interventions/list'"); expect(page).toContain("post('/api/interventions/register',"); expect(page).not.toMatch(/['"`]\/api\/interventions['"`]/u); expect((readFileSync(`${root}layouts/owner.vue`, 'utf8').match(/\/audit-lab\/interventions/g) || []).length).toBe(2) })
  it('does not widen public CORS or forbidden integration areas', () => { const cors = readFileSync(`${root}server/utils/publicCors.ts`, 'utf8'); expect((cors.match(/\/api\//g) || []).length).toBe(2); expect(cors).not.toContain('/api/interventions'); expect(readFileSync(`${root}server/middleware/public-cors.ts`, 'utf8')).not.toContain('/api/interventions'); expect(readFileSync(`${root}server/content-operations/service.ts`, 'utf8').match(/notifyInterventionLoopOutcomeAssessed\(/g)?.length).toBe(1); expect(readFileSync(`${root}server/tasks/content-operations/measurement-tick.ts`, 'utf8')).toContain('runInterventionLoopTickSafely('); for (const path of [`${root}server/content-operations/orchestrator.ts`, `${root}server/content-operations/normalization.ts`]) expect(readFileSync(path, 'utf8')).not.toContain('intervention'); expect(existsSync(`${root}INTERVENTION_LOOP_RUNTIME_V1.md`)).toBe(true); expect(readFileSync(`${root}INTERVENTION_LOOP_RUNTIME_V1.md`, 'utf8')).toContain('RECRAWL_NOT_CONFIRMED') })
})
