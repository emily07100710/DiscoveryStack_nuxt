import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildContentOperationsAuthorization, contentTargetFrameworkDefaults, newWeeklyAuthorizationTargets, type ContentAuthorizationInput } from '../utils/contentOperationsAuthorization'
import { parseAutopilotPolicyInput } from '../server/content-operations/normalization'
import { enableOwnerAutopilotPolicy } from '../server/content-operations/autopilot-policy'
const NOW = new Date('2026-10-04T12:00:00.000Z')
const CLIENT = { id: 2, framework: 'nextjs', requireCustomerApproval: true }
const TARGET = { id: 3, clientId: 2, targetId: 'synthetic-customer-blog', websiteId: 'synthetic-website', status: 'active', executionEnabled: true, allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'] }
const PROFILE = { profileId: 'entity-profile-synthetic-existing', clientId: 2, websiteId: TARGET.websiteId, canonicalBrandName: 'Synthetic customer', status: 'active', revokedAt: null }
const CONTEXT = { policiesLoaded: true, policies: [], profiles: [PROFILE] }
const INPUT: ContentAuthorizationInput = { mode: 'weekly_customer_approval', expiresOn: '2026-11-04', maximumRiskLevel: 'general', targetRowId: 3, entityStrategyProfileId: PROFILE.profileId, generationBudget: 12, publicationBudget: 4, confirmed: true }
function build(change: Partial<ContentAuthorizationInput> = {}) { return buildContentOperationsAuthorization({ ...INPUT, ...change }, CLIENT, [TARGET], NOW, CONTEXT) }
describe('explicit weekly customer approval policy request', () => {
 it('does not construct a request before explicit owner confirmation or mode choice', () => {
  expect(() => build({confirmed:false})).toThrow('確認')
  expect(() => build({mode:''})).toThrow('選擇')
  expect(() => buildContentOperationsAuthorization(Object.assign({},INPUT,{confirmed:'true'}),CLIENT,[TARGET],NOW,CONTEXT)).toThrow('確認')
 })
 it('sends the selected target and bounded budgets as a seven-day V4 policy accepted by the actual API parser', () => {
  const body=build()
  expect(body).toMatchObject({policyVersion:'governed-autopilot-policy-v4',cadenceDays:7,allowedCadences:[7],targetRowId:3,allowedTargetIds:[TARGET.targetId],allowedDestinations:[TARGET.targetId],generationBudget:12,publicationBudget:4,websiteId:TARGET.websiteId,entityStrategyProfileId:PROFILE.profileId,allowedContentTypes:['article'],allowedLanguages:['zh-hant'],requireApprovedForDelivery:false,maximumRiskSeverity:'moderate',allowedBusinessRiskClasses:['general']})
  expect(parseAutopilotPolicyInput(body)).toMatchObject(body)
  const canonical=enableOwnerAutopilotPolicy({...parseAutopilotPolicyInput(body),allowedRiskClasses:undefined,ownerUserId:1,authorizedByOwnerUserId:1,clientId:2,targetRowId:3,targetId:TARGET.targetId,authorizedAt:NOW.toISOString()})
  expect(canonical.policyVersion).toBe('governed-autopilot-policy-v4');expect(canonical.cadenceDays).toBe(7);expect(canonical.generationBudget).toBe(12);expect(canonical.publicationBudget).toBe(4);expect(canonical.requireApprovedForDelivery).toBe(false);expect(canonical.requiredQualityGateVersion).toBe('content-risk-gate-v1')
  for (const field of ['ownerUserId','clientId','authorizedByOwnerUserId','lineUserId','actionToken','readToken']) expect(body).not.toHaveProperty(field)
 })
 for(const field of ['generationBudget','publicationBudget'] as const) it.each([null,undefined,'', '12',true,0,-1,1.5,NaN,Infinity,1000001,Number.MAX_SAFE_INTEGER])(`rejects blank, implicit or unbounded ${field} = %s`, value => {
  expect(() => build({[field]:value})).toThrow('整數額度')
 })
 it.each([1,1000000])('accepts exact API budget bounds %s without silently replacing the owner value', value => {
  const body=build({generationBudget:value,publicationBudget:value});expect(body.generationBudget).toBe(value);expect(body.publicationBudget).toBe(value);expect(parseAutopilotPolicyInput(body).generationBudget).toBe(value)
 })
 it.each([undefined,false])('refuses a client without the server-owned customer approval protection %s', requireCustomerApproval => {
  expect(() => buildContentOperationsAuthorization(INPUT,{...CLIENT,requireCustomerApproval},[TARGET],NOW,CONTEXT)).toThrow('同意後才發文')
 })
 it.each([null,undefined,'3',0,-1,1.5])('requires an explicit numeric target choice %s', targetRowId => {expect(() => build({targetRowId})).toThrow('發布目標')})
 it.each([{clientId:9},{status:'paused'},{executionEnabled:false},{allowedContentTypes:['faq']},{allowedLanguages:['en']},{allowedContentTypes:undefined},{allowedLanguages:undefined},{targetId:''}])('rejects a foreign or ineligible current target %j', change => {
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[{...TARGET,...change}],NOW,CONTEXT)).toThrow('發布目標')
 })
 it('does not fall back to another target if the selected target disappeared', () => {
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[{...TARGET,id:4}],NOW,CONTEXT)).toThrow('發布目標')
 })
 it.each(['2026-10-03','2026-02-30','not-a-date','2026-1-01'])('rejects stale or invalid expiry %s', expiresOn => {expect(() => build({expiresOn})).toThrow('到期日')})
 it('rechecks expiry and a valid clock at confirmation time', () => {
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[TARGET],new Date('2026-11-05T00:00:00Z'),CONTEXT)).toThrow('到期日')
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[TARGET],new Date(NaN),CONTEXT)).toThrow('到期日')
 })
 it('keeps weekly quality conservative and does not authorize high-risk business content', () => {
  expect(() => build({maximumRiskLevel:'high'})).toThrow('低風險')
  expect(build({maximumRiskLevel:'low'}).maximumRiskSeverity).toBe('low')
 })
 it.each([null, undefined, '', 42])('requires an explicit saved profile choice %s', entityStrategyProfileId => {
  expect(() => build({entityStrategyProfileId})).toThrow('實體策略')
 })
 it.each([{clientId:9}, {websiteId:'other-website'}, {status:'revoked'}, {revokedAt:NOW}, {profileId:'other-profile'}])('rejects a foreign, replaced or revoked profile %j', change => {
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[TARGET],NOW,{...CONTEXT,profiles:[{...PROFILE,...change}]})).toThrow('實體策略')
 })
 it('does not silently bind a generated default profile when the saved profile is missing', () => {
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[TARGET],NOW,{...CONTEXT,profiles:[]})).toThrow('實體策略')
 })
 it.each(['enabled', 'paused', 'revoked'])('never upgrades or re-authorizes an already represented target %s', status => {
  const context={...CONTEXT,policies:[{targetRowId:TARGET.id,targetId:TARGET.targetId,status}]}
  expect(newWeeklyAuthorizationTargets(CLIENT,[TARGET],context.policies,true)).toEqual([])
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[TARGET],NOW,context)).toThrow('發布目標')
 })
 it('only offers genuinely new targets, and refuses to infer them when reading policies failed', () => {
  const existing={...TARGET,id:4,targetId:'already-authorized'}
  const policies=[{targetRowId:existing.id,targetId:existing.targetId,status:'revoked'}]
  expect(newWeeklyAuthorizationTargets(CLIENT,[TARGET,existing],policies,true)).toEqual([TARGET])
  expect(newWeeklyAuthorizationTargets(CLIENT,[TARGET,existing],policies,false)).toEqual([])
  expect(() => buildContentOperationsAuthorization(INPUT,CLIENT,[TARGET],NOW,{...CONTEXT,policiesLoaded:false})).toThrow('尚未確認')
  expect(newWeeklyAuthorizationTargets(CLIENT,[TARGET],[{targetId:TARGET.targetId}],true)).toEqual([])
  expect(newWeeklyAuthorizationTargets(CLIENT,[{...TARGET,websiteId:null}],[],true)).toEqual([])
 })
 it('preserves the explicit legacy V3 option and its original framework allowlists without any V4 budgets', () => {
  const body=buildContentOperationsAuthorization({...INPUT,mode:'legacy_v3',generationBudget:null,publicationBudget:null,targetRowId:null,maximumRiskLevel:'high'}, {...CLIENT,framework:'astro',requireCustomerApproval:false},[],NOW)
  expect(body).toEqual({policyVersion:'governed-autopilot-policy-v3',expiresAt:'2026-11-04T23:59:59.000Z',maximumRiskLevel:'high',allowedContentTypes:['article','faq','service_page'],allowedLanguages:['en','zh-hant']})
  expect(parseAutopilotPolicyInput(body).policyVersion).toBe('governed-autopilot-policy-v3')
 })
 it('retains the Next legacy article/Traditional Chinese restrictions', () => {
  const body=build({mode:'legacy_v3',generationBudget:null,publicationBudget:null,targetRowId:null});expect(body.allowedContentTypes).toEqual(['article']);expect(body.allowedLanguages).toEqual(['zh-hant'])
 })
})

describe('content publication form integration', () => {
 it('uses the Do receiver-compatible Next defaults without overriding other framework roots', () => {
  const original = { contentRoot: 'custom/articles', maximumPayloadBytes: 524288, endpointPath: '/my/cms-ingest' }
  expect(contentTargetFrameworkDefaults('nextjs', original)).toEqual({ contentRoot: 'journal', maximumPayloadBytes: 196608, endpointPath: '/api/first-party/content-ingest' })
  expect(original).toEqual({ contentRoot: 'custom/articles', maximumPayloadBytes: 524288, endpointPath: '/my/cms-ingest' })
  for (const framework of ['astro', 'nuxt', 'wordpress', 'php_agent', 'generic_http', 'geoflow_local', 'static_site']) expect(contentTargetFrameworkDefaults(framework, original)).toEqual(original)
 })
 it('wires the selected mode and initially blank budgets through the typed owner confirmation', () => {
  const page = readFileSync(new URL('../pages/audit-lab/content-operations.vue', import.meta.url), 'utf8')
  expect(page).toContain('autopilotGenerationBudgets[key] ??= null; autopilotPublicationBudgets[key] ??= null; autopilotTargetRows[key] ??= null; autopilotProfileIds[key] ??= \'\'')
  expect(page).toContain('v-model="autopilotModes[String(client.id)]"')
  expect(page).toContain('value="weekly_customer_approval" :disabled="client.requireCustomerApproval !== true"')
  expect(page).toContain('v-model.number="autopilotGenerationBudgets[String(client.id)]"')
  expect(page).toContain('v-model.number="autopilotPublicationBudgets[String(client.id)]"')
  expect(page).toContain('v-model.number="autopilotTargetRows[String(client.id)]"')
  expect(page).toContain('v-model="autopilotProfileIds[String(client.id)]"')
  expect(page).toContain('newWeeklyAuthorizationTargets(client, workspace.value.publicationTargets, autopilotPoliciesFor(client.id), autopilotPoliciesLoaded[String(client.id)] === true)')
  expect(page).toContain('@click="beginAutopilotAuthorization(client)"')
  expect(page).not.toContain('@click="enableAutopilot(client)"')
  expect(page).toContain(':target="autopilotAuthorization?.displayName')
  expect(page).toContain('@confirm="enableAutopilot" @cancel="closeAutopilotAuthorization"')
  expect(page).toContain('機器品質審核不能代替客戶在 LINE 同意')
  const confirm = page.slice(page.indexOf('async function enableAutopilot()'), page.indexOf('const autopilotRevokeClient'))
  expect(confirm.indexOf('buildContentOperationsAuthorization')).toBeLessThan(confirm.indexOf('await fetchContent'))
  expect(confirm).toContain('{ ...choice.input, confirmed: true }')
  expect(confirm).toContain('workspace.value.publicationTargets, new Date()')
  expect(confirm).toContain('`/api/content-operations/clients/${client.id}/autopilot-policy`')
  expect(confirm.indexOf('autopilotAuthorization.value = null')).toBeLessThan(confirm.indexOf('await refresh()'))
  expect(confirm).toContain('不要重送已保存的授權')
  expect(page).toContain('contentTargetFrameworkDefaults(targetForm.framework, targetForm)')
 })
})
