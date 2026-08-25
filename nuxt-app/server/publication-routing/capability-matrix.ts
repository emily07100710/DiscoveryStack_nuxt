import { CAPABILITY_MATRIX, EXECUTOR_AUTHORITIES, FRAMEWORKS, TRANSPORTS } from './constants'
import type { Capability, ExecutorAuthority, Framework, Transport } from './types'

export function capabilityFor(framework: unknown, transport: unknown): Capability | null {
  for (const capability of CAPABILITY_MATRIX) {
    if (capability.framework === framework && capability.transport === transport) return capability
  }
  return null
}

export function isFramework(value: unknown): value is Framework {
  return typeof value === 'string' && FRAMEWORKS.includes(value as Framework)
}

export function isTransport(value: unknown): value is Transport {
  return typeof value === 'string' && TRANSPORTS.includes(value as Transport)
}

export function isExecutorAuthority(value: unknown): value is ExecutorAuthority {
  return typeof value === 'string' && EXECUTOR_AUTHORITIES.includes(value as ExecutorAuthority)
}

export function matrixAuthority(framework: unknown, transport: unknown): ExecutorAuthority | null {
  return capabilityFor(framework, transport)?.authority ?? null
}

export function matrixAllows(framework: unknown, transport: unknown, authority: unknown, executor: unknown): boolean {
  const capability = capabilityFor(framework, transport)
  return capability !== null && capability.authority === authority && capability.executor === executor
}
