import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, eventHandler, toNodeListener } from 'h3'
import { strictManagedSiteBody } from '../server/managed-sites/live-connectors/http'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

async function schemaRequest(body: unknown, allowed: string[]) {
  const app = createApp(); app.use('/fixed-mutation', eventHandler(event => strictManagedSiteBody(event, allowed)))
  const server = createServer(toNodeListener(app)); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return fetch(`http://127.0.0.1:${address.port}/fixed-mutation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('managed-site fixed mutation route body schema', () => {
  it('accepts an exact fixed-route body and rejects unknown action/API-key fields at runtime', async () => {
    const accepted = await schemaRequest({ executionMode: 'live', idempotencyKey: 'route-schema-001' }, ['executionMode', 'idempotencyKey'])
    expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ executionMode: 'live', idempotencyKey: 'route-schema-001' })
    const action = await schemaRequest({ action: 'deploy', executionMode: 'live', idempotencyKey: 'route-schema-002' }, ['executionMode', 'idempotencyKey'])
    expect(action.status).toBe(422)
    const credential = await schemaRequest({ executionMode: 'live', idempotencyKey: 'route-schema-003', apiKey: 'forbidden-browser-value' }, ['executionMode', 'idempotencyKey'])
    expect(credential.status).toBe(422)
  })
})
