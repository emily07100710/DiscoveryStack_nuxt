import { fingerprint } from './canonical'
import { GEO_OUTCOME_SPLIT_POLICY_VERSION } from './constants'
import type { DatasetMember, SplitAssignment } from './types'

const PARTITIONS = ['train', 'validation', 'test', 'siteHoldout', 'queryHoldout', 'temporalHoldout'] as const
type Partition = typeof PARTITIONS[number]
type Component = { key: string, rows: DatasetMember[], minimumTime: number, maximumTime: number }

function codeUnitCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function canonicalTime(member: DatasetMember): number {
  const value = member.observation.runTimestamp
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('gate_blocked: split requires a canonical ISO-8601 UTC timestamp.')
  return date.getTime()
}
function flatten(components: readonly Component[]): string[] { return components.flatMap(component => component.rows.map(row => row.observationFingerprint)).sort(codeUnitCompare) }

/** Build transitive leakage components across sites, normalized queries, runs and same-run query groups. */
function connectedComponents(members: readonly DatasetMember[]): Component[] {
  const parent = members.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    while (parent[index] !== index) { const next = parent[index]!; parent[index] = root; index = next }
    return root
  }
  const union = (left: number, right: number) => { const a = find(left); const b = find(right); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b) }
  const identityOwner = new Map<string, number>()
  members.forEach((member, index) => {
    canonicalTime(member)
    const identities = [`site:${member.websiteIdentityHash}`, `query:${member.normalizedQueryHash}`, `run:${member.runIdentity}`, `query-group:${member.queryGroupKey}`]
    for (const identity of identities) { const previous = identityOwner.get(identity); if (previous === undefined) identityOwner.set(identity, index); else union(index, previous) }
  })
  const groups = new Map<number, DatasetMember[]>()
  members.forEach((member, index) => { const root = find(index); const rows = groups.get(root) || []; rows.push(member); groups.set(root, rows) })
  return [...groups.values()].map(rows => {
    const sorted = [...rows].sort((a, b) => codeUnitCompare(a.observationFingerprint, b.observationFingerprint))
    const times = sorted.map(canonicalTime)
    return { key: fingerprint(sorted.map(row => row.observationFingerprint)), rows: sorted, minimumTime: Math.min(...times), maximumTime: Math.max(...times) }
  }).sort((a, b) => a.minimumTime - b.minimumTime || a.maximumTime - b.maximumTime || codeUnitCompare(a.key, b.key))
}

function deterministicReservation(components: readonly Component[], identity: (component: Component) => string): Component {
  const selected = [...components].sort((a, b) => codeUnitCompare(identity(a), identity(b)) || codeUnitCompare(a.key, b.key))[0]
  if (!selected) throw new Error('gate_blocked: holdout reservation is empty.')
  return selected
}

export function splitDatasetMembers(members: readonly DatasetMember[]): SplitAssignment {
  if (members.length < 6) throw new Error('gate_blocked: at least six eligible rows are required for six non-empty partitions.')
  const fingerprints = new Set<string>()
  for (const member of members) { if (fingerprints.has(member.observationFingerprint)) throw new Error('gate_blocked: duplicate observation fingerprint.'); fingerprints.add(member.observationFingerprint) }
  const components = connectedComponents(members)
  if (components.length < 6) throw new Error('gate_blocked: leakage topology cannot produce six non-empty partitions.')

  let temporalIndex = components.length - 1
  while (temporalIndex > 0) {
    const temporalMinimum = Math.min(...components.slice(temporalIndex).map(component => component.minimumTime))
    const earlierMaximum = Math.max(...components.slice(0, temporalIndex).map(component => component.maximumTime))
    if (temporalMinimum >= earlierMaximum && temporalIndex >= 5) break
    temporalIndex -= 1
  }
  if (temporalIndex < 5) throw new Error('gate_blocked: canonical temporal topology cannot preserve five earlier partitions.')
  const temporal = components.slice(temporalIndex)
  const remaining = components.slice(0, temporalIndex)
  const site = deterministicReservation(remaining, component => component.rows.map(row => row.websiteIdentityHash).sort(codeUnitCompare).join(':'))
  const afterSite = remaining.filter(component => component !== site)
  const query = deterministicReservation(afterSite, component => component.rows.map(row => row.normalizedQueryHash).sort(codeUnitCompare).join(':'))
  const pool = afterSite.filter(component => component !== query)
  if (pool.length < 3) throw new Error('gate_blocked: remaining components cannot produce train/validation/test.')
  const trainCount = Math.max(1, Math.floor(pool.length * 0.6))
  const validationCount = Math.max(1, Math.floor(pool.length * 0.2))
  const testCount = pool.length - trainCount - validationCount
  if (testCount < 1) throw new Error('gate_blocked: test partition would be empty.')
  const split: SplitAssignment = {
    train: flatten(pool.slice(0, trainCount)),
    validation: flatten(pool.slice(trainCount, trainCount + validationCount)),
    test: flatten(pool.slice(trainCount + validationCount)),
    siteHoldout: flatten([site]),
    queryHoldout: flatten([query]),
    temporalHoldout: flatten(temporal),
  }
  assertDisjointComplete(split, members)
  return split
}

export function assertDisjointComplete(split: SplitAssignment, members: readonly DatasetMember[]): void {
  const byFingerprint = new Map(members.map(member => [member.observationFingerprint, member]))
  if (byFingerprint.size !== members.length) throw new Error('gate_blocked: duplicate observation fingerprint.')
  const partitionByFingerprint = new Map<string, Partition>()
  const identityToPartition = new Map<string, Partition>()
  for (const partition of PARTITIONS) {
    const rows = split[partition]
    if (!rows.length) throw new Error(`gate_blocked: ${partition} is empty.`)
    for (const rowFingerprint of rows) {
      const member = byFingerprint.get(rowFingerprint)
      if (!member) throw new Error(`gate_blocked: unknown fingerprint ${rowFingerprint}.`)
      if (partitionByFingerprint.has(rowFingerprint)) throw new Error(`gate_blocked: fingerprint overlaps ${partitionByFingerprint.get(rowFingerprint)} and ${partition}.`)
      partitionByFingerprint.set(rowFingerprint, partition)
      const identities = [`site:${member.websiteIdentityHash}`, `query:${member.normalizedQueryHash}`, `run:${member.runIdentity}`, `query-group:${member.queryGroupKey}`]
      for (const identity of identities) {
        const previous = identityToPartition.get(identity)
        if (previous && previous !== partition) throw new Error(`gate_blocked: leakage identity ${identity} overlaps ${previous} and ${partition}.`)
        identityToPartition.set(identity, partition)
      }
    }
  }
  if (partitionByFingerprint.size !== byFingerprint.size) throw new Error('gate_blocked: split union does not equal eligible members.')
  const temporalTimes = split.temporalHoldout.map(row => canonicalTime(byFingerprint.get(row)!))
  const earlierTimes = [...split.train, ...split.validation, ...split.test, ...split.siteHoldout, ...split.queryHoldout].map(row => canonicalTime(byFingerprint.get(row)!))
  if (Math.min(...temporalTimes) < Math.max(...earlierTimes)) throw new Error('gate_blocked: temporal holdout is earlier than another partition.')
}

export function splitPolicyVersion(): string { return GEO_OUTCOME_SPLIT_POLICY_VERSION }
export function splitFingerprint(split: SplitAssignment): string { return fingerprint({ version: GEO_OUTCOME_SPLIT_POLICY_VERSION, train: [...split.train].sort(codeUnitCompare), validation: [...split.validation].sort(codeUnitCompare), test: [...split.test].sort(codeUnitCompare), siteHoldout: [...split.siteHoldout].sort(codeUnitCompare), queryHoldout: [...split.queryHoldout].sort(codeUnitCompare), temporalHoldout: [...split.temporalHoldout].sort(codeUnitCompare) }) }
