import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { afterEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createAuth } from '../lib/auth.mjs'
import { createSiteRuntime } from '../server.mjs'

const databases = []
const runtimes = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const database of databases.splice(0)) database.close()
})

function database() {
  const result = new DatabaseSync(':memory:')
  result.exec('PRAGMA foreign_keys=ON')
  databases.push(result)
  return result
}

function auth(options = {}) {
  const db = database()
  const service = createAuth(db, {
    mode: options.mode ?? 'preview',
    sessionSecret: options.sessionSecret ?? 's'.repeat(64),
    adminPassword: options.adminPassword,
  })
  return { db, service }
}

function rejects(status, code) {
  return error => error?.status === status && (!code || error.code === code)
}

function request(origin, path = '/api/session') {
  const stream = Readable.from([])
  stream.method = 'GET'
  stream.url = path
  stream.headers = { host: new URL(origin).host }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}

function response() {
  const headers = new Map()
  return {
    headers,
    statusCode: 200,
    setHeader(name, value) { headers.set(name.toLowerCase(), value) },
    end(body = '') { this.body = body },
  }
}

function runtimeConfig(mode) {
  return {
    siteId: `auth-${mode}`,
    siteType: 'commerce',
    preset: 'atelier',
    brandName: '授權測試網站',
    mode,
    commerce: { paymentMode: 'disabled', shippingFeeMinor: 0, freeShippingThresholdMinor: 0, orderHoldMinutes: 30 },
  }
}

test('anonymous sessions require their exact CSRF proof and expire closed', () => {
  const { db, service } = auth()
  const issued = service.issue()
  assert.equal(issued.actor, null)
  assert.equal(issued.role, 'anonymous')
  assert.match(issued.token, /^[a-f0-9]{64}$/u)
  assert.match(issued.csrfToken, /^[a-f0-9]{64}$/u)
  assert.doesNotThrow(() => service.verifyCsrf(issued.token, issued.csrfToken))
  assert.throws(() => service.verifyCsrf(issued.token, '0'.repeat(64)), rejects(403, 'CSRF_FAILED'))
  assert.throws(() => service.verifyCsrf('', issued.csrfToken), rejects(403, 'CSRF_FAILED'))

  db.prepare('UPDATE site_sessions SET expires_at=0').run()
  assert.equal(service.session(issued.token), null)
  assert.throws(() => service.verifyCsrf(issued.token, issued.csrfToken), rejects(403, 'CSRF_FAILED'))
})

test('session issuance removes expired rows and bounds anonymous database growth', () => {
  const { db, service } = auth()
  service.issue()
  db.prepare('UPDATE site_sessions SET expires_at=0').run()
  const replacement = service.issue()
  assert.equal(db.prepare('SELECT count(*) AS count FROM site_sessions').get().count, 1)
  assert.equal(service.session(replacement.token).role, 'anonymous')

  let latest
  for (let index = 0; index < 2_055; index += 1) latest = service.issue()
  assert.equal(db.prepare("SELECT count(*) AS count FROM site_sessions WHERE role='anonymous'").get().count, 2_048)
  assert.equal(service.session(latest.token).role, 'anonymous')
})

test('member sessions expose only their own public actor and logout revokes access', () => {
  const { service } = auth()
  const first = service.register({
    name: '第一位會員',
    email: 'first@example.test',
    password: `member-${'a'.repeat(12)}`,
    consent: true,
  }, 'address-one')
  const second = service.register({
    name: '第二位會員',
    email: 'second@example.test',
    password: `member-${'b'.repeat(12)}`,
    consent: true,
  }, 'address-two')

  assert.notEqual(first.actor.id, second.actor.id)
  assert.deepEqual(service.session(first.token).actor, first.actor)
  assert.deepEqual({ ...service.member(first.actor.id) }, {
    id: first.actor.id,
    name: '第一位會員',
    email: 'first@example.test',
    createdAt: first.actor.createdAt,
    emailVerified: false,
  })
  assert.equal('password' in first.actor, false)
  assert.equal('password_hash' in first.actor, false)
  assert.equal('token' in first.actor, false)
  assert.deepEqual(new Set(service.listMembers().map(member => member.id)), new Set([first.actor.id, second.actor.id]))

  service.logout(first.token)
  assert.equal(service.session(first.token), null)
  assert.equal(service.session(second.token).actor.id, second.actor.id)
})

test('wrong member and administrator credentials never create authenticated sessions', () => {
  const adminPassword = `admin-${'c'.repeat(14)}`
  const { db, service } = auth({ adminPassword })
  service.register({ name: '會員', email: 'member@example.test', password: `member-${'d'.repeat(12)}`, consent: true }, 'register-address')
  const before = db.prepare('SELECT count(*) AS count FROM site_sessions').get().count

  assert.throws(
    () => service.login({ email: 'member@example.test', password: `wrong-${'x'.repeat(12)}` }, 'login-address'),
    rejects(401, 'LOGIN_FAILED'),
  )
  assert.throws(
    () => service.login({ password: `wrong-${'y'.repeat(12)}` }, 'admin-address', true),
    rejects(401, 'LOGIN_FAILED'),
  )
  assert.equal(db.prepare('SELECT count(*) AS count FROM site_sessions').get().count, before)

  const administrator = service.login({ password: adminPassword }, 'admin-address-two', true)
  assert.deepEqual(administrator.actor, { role: 'admin', name: '網站管理者' })
  assert.equal('token' in administrator.actor, false)
})

test('production auth fails closed without independent secrets and administrator password', () => {
  assert.throws(
    () => createAuth(database(), { mode: 'production', sessionSecret: '', adminPassword: '' }),
    rejects(503, 'SESSION_NOT_CONFIGURED'),
  )
  assert.throws(
    () => createAuth(database(), { mode: 'production', sessionSecret: 's'.repeat(64), adminPassword: '' }),
    rejects(503, 'ADMIN_NOT_CONFIGURED'),
  )
  assert.throws(
    () => createAuth(database(), { mode: 'production', sessionSecret: 's'.repeat(64), adminPassword: 'short' }),
    rejects(503, 'ADMIN_NOT_CONFIGURED'),
  )
})

test('runtime session cookies are HttpOnly, same-site, bounded and secure in production', async () => {
  const previewOrigin = 'http://preview.example.test'
  const preview = createSiteRuntime({ config: runtimeConfig('preview'), origin: previewOrigin, databasePath: ':memory:' })
  runtimes.push(preview)
  const previewResponse = response()
  await preview.handle(request(previewOrigin), previewResponse)
  const previewCookie = previewResponse.headers.get('set-cookie')
  const previewBody = JSON.parse(previewResponse.body)
  assert.match(previewCookie, /^ds_customer_site_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800$/u)
  assert.equal(previewBody.actor, null)
  assert.match(previewBody.csrfToken, /^[a-f0-9]{64}$/u)
  assert.equal('token' in previewBody, false)

  const productionOrigin = 'https://production.example.test'
  const production = createSiteRuntime({
    config: runtimeConfig('production'),
    origin: productionOrigin,
    databasePath: ':memory:',
    adminPassword: `admin-${'p'.repeat(14)}`,
    sessionSecret: 'z'.repeat(64),
  })
  runtimes.push(production)
  const productionResponse = response()
  await production.handle(request(productionOrigin), productionResponse)
  assert.match(productionResponse.headers.get('set-cookie'), /; Secure$/u)
  assert.equal(JSON.parse(productionResponse.body).actor, null)
})

test('email verification tokens are hash-only, member-scoped, expiring and single-use', () => {
  const { db, service } = auth()
  const first = service.register({ name: '待驗證會員', email: 'verify@example.test', password: `member-${'v'.repeat(12)}`, consent: true }, 'verify-register')
  const second = service.register({ name: '其他會員', email: 'other@example.test', password: `member-${'o'.repeat(12)}`, consent: true }, 'other-register')
  const requested = service.requestVerification(first.actor.id)

  assert.equal(requested.receipt.accepted, true)
  assert.deepEqual({ to: requested.delivery.to, kind: requested.delivery.kind }, { to: 'verify@example.test', kind: 'email_verification' })
  const stored = db.prepare("SELECT token_hash,member_id,expires_at,consumed_at FROM auth_action_tokens WHERE kind='email_verification'").get()
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/u)
  assert.notEqual(stored.token_hash, requested.delivery.token)
  assert.equal(stored.member_id, first.actor.id)
  assert.ok(stored.expires_at > Date.now())
  assert.equal(stored.consumed_at, null)

  assert.deepEqual(service.confirmVerification({ token: requested.delivery.token }), { emailVerified: true })
  assert.equal(service.member(first.actor.id).emailVerified, true)
  assert.equal(service.member(second.actor.id).emailVerified, false)
  assert.equal(service.session(first.token).actor.emailVerified, true)
  assert.throws(() => service.confirmVerification({ token: requested.delivery.token }), rejects(410, 'ACTION_TOKEN_INVALID'))
  assert.equal(service.requestVerification(first.actor.id).delivery, null)

  const expiring = service.requestVerification(second.actor.id)
  db.prepare("UPDATE auth_action_tokens SET expires_at=0 WHERE kind='email_verification' AND member_id=?").run(second.actor.id)
  assert.throws(() => service.confirmVerification({ token: expiring.delivery.token }), rejects(410, 'ACTION_TOKEN_INVALID'))
  assert.equal(service.member(second.actor.id).emailVerified, false)
})

test('password reset gives unknown email the same receipt, resets one member and revokes only their sessions', () => {
  const { db, service } = auth()
  const firstPassword = `member-${'r'.repeat(12)}`
  const secondPassword = `member-${'q'.repeat(12)}`
  const newPassword = `renewed-${'n'.repeat(12)}`
  const first = service.register({ name: '重設會員', email: 'reset@example.test', password: firstPassword, consent: true }, 'reset-register')
  const second = service.register({ name: '保留會員', email: 'retain@example.test', password: secondPassword, consent: true }, 'retain-register')

  const known = service.requestPasswordReset({ email: 'RESET@EXAMPLE.TEST' })
  const unknown = service.requestPasswordReset({ email: 'unknown@example.test' })
  assert.deepEqual(known.receipt, unknown.receipt)
  assert.equal(known.delivery.kind, 'password_reset')
  assert.equal(known.delivery.to, 'reset@example.test')
  assert.equal(unknown.delivery, null)
  assert.equal(db.prepare("SELECT count(*) AS count FROM auth_action_tokens WHERE kind='password_reset'").get().count, 1)
  assert.notEqual(db.prepare("SELECT token_hash FROM auth_action_tokens WHERE kind='password_reset'").get().token_hash, known.delivery.token)

  assert.deepEqual(service.resetPassword({ token: known.delivery.token, password: newPassword }), { reset: true })
  assert.equal(service.session(first.token), null)
  assert.equal(service.session(second.token).actor.id, second.actor.id)
  assert.throws(() => service.resetPassword({ token: known.delivery.token, password: newPassword }), rejects(410, 'ACTION_TOKEN_INVALID'))
  assert.throws(() => service.login({ email: 'reset@example.test', password: firstPassword }, 'old-password-login'), rejects(401, 'LOGIN_FAILED'))
  assert.equal(service.login({ email: 'reset@example.test', password: newPassword }, 'new-password-login').actor.id, first.actor.id)
  assert.equal(service.login({ email: 'retain@example.test', password: secondPassword }, 'retained-password-login').actor.id, second.actor.id)
})

test('expired password reset tokens fail closed without revoking the current session', () => {
  const { db, service } = auth()
  const current = service.register({ name: '到期會員', email: 'expired@example.test', password: `member-${'e'.repeat(12)}`, consent: true }, 'expired-register')
  const request = service.requestPasswordReset({ email: current.actor.email })
  db.prepare("UPDATE auth_action_tokens SET expires_at=0 WHERE kind='password_reset'").run()

  assert.throws(
    () => service.resetPassword({ token: request.delivery.token, password: `renewed-${'x'.repeat(12)}` }),
    rejects(410, 'ACTION_TOKEN_INVALID'),
  )
  assert.equal(service.session(current.token).actor.id, current.actor.id)
})
