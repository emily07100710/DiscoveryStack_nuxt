import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createSiteRuntime } from '../server.mjs'
import { seedPreview } from '../lib/seed.mjs'
const origin = 'http://127.0.0.1:3002'
function fixture(type = 'commerce') { const runtime = createSiteRuntime({ config: { siteId: 'server-test', siteType: type, mode: 'preview', brandName: '測試品牌', commerce: { paymentMode: 'manual' } }, origin, adminPassword: 'local-fixture-admin-password' }); seedPreview(runtime); return runtime }
async function call(runtime, path, { method = 'GET', body, headers = {}, cookie, csrf } = {}) {
  const bytes = body === undefined ? '' : JSON.stringify(body)
  const request = Readable.from(bytes ? [Buffer.from(bytes)] : []); request.url = path; request.method = method; request.socket = { remoteAddress: '127.0.0.1' }; request.headers = { host: '127.0.0.1:3002', origin, 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }
  const result = { statusCode: 200, headers: {}, data: '' }; const response = { set statusCode(value) { result.statusCode = value }, get statusCode() { return result.statusCode }, setHeader(name, value) { result.headers[name.toLowerCase()] = value }, end(value) { result.data = value?.toString() || '' } }
  await runtime.handle(request, response)
  if (result.headers['content-type']?.startsWith('application/json')) result.json = JSON.parse(result.data)
  return result
}
async function session(runtime) { const r = await call(runtime, '/api/session'); return { cookie: r.headers['set-cookie'].split(';')[0], csrf: r.json.csrfToken } }
test('real HTTP handler serves assets, checks host/origin/CSRF and hides admin data', async () => {
  const r = fixture()
  try {
    assert.equal((await call(r, '/assets/site.css')).headers['content-type'], 'text/css')
    assert.equal((await call(r, '/assets/site.js', { method: 'HEAD' })).data, '')
    assert.equal((await call(r, '/', { headers: { host: 'wrong.test' } })).statusCode, 421)
    assert.equal((await call(r, '/api/contact', { method: 'POST', body: {} })).statusCode, 403)
    const s = await session(r)
    assert.equal((await call(r, '/api/contact', { ...s, method: 'POST', headers: { origin: 'https://evil.test' }, body: {} })).statusCode, 403)
    assert.equal((await call(r, '/api/admin/orders', s)).statusCode, 401)
    assert.equal((await call(r, '/admin')).headers.location, '/admin/login')
    assert.equal((await call(r, '/not-a-page')).statusCode, 404)
    assert.equal((await call(r, '/products/missing-product')).statusCode, 404)
    assert.equal((await call(r, '/journal/missing-article')).statusCode, 404)
  } finally { r.close() }
})
test('checkout persists authoritative orders and admin transitions are permission-gated', async () => {
  const r = fixture()
  try {
    const s = await session(r); const product = r.commerce.listProducts()[0]
    const body = { items: [{ productId: product.id, quantity: 1, priceMinor: 1 }], customer: { name: '測試顧客', email: 'fixture@example.invalid', phone: '0912345678', address: '測試地址' }, consent: true, idempotencyKey: 'server-checkout-fixture' }
    const created = await call(r, '/api/orders', { ...s, method: 'POST', body }); assert.equal(created.statusCode, 201); assert.ok(created.json.totalMinor > 1); assert.equal(created.json.paymentStatus, 'pending'); assert.equal(r.notifications.status().configured, false)
    const login = await call(r, '/api/admin/login', { ...s, method: 'POST', body: { password: 'local-fixture-admin-password' } }); assert.equal(login.statusCode, 200)
    const a = { cookie: login.headers['set-cookie'].split(';')[0], csrf: login.json.csrfToken }
    assert.equal((await call(r, '/api/admin/orders', a)).json.orders.length, 1)
    assert.equal((await call(r, '/api/admin/products', { ...a, method: 'DELETE', body: {} })).statusCode, 404)
    assert.equal((await call(r, '/api/auth/password-reset/request', { ...s, method: 'POST', body: { email: 'fixture@example.invalid' } })).statusCode, 403) // rotated session cannot be reused
  } finally { r.close() }
})
test('booking HTTP API isolates two members and guest holds do not create paid claims', async () => {
  const r = fixture('booking_blog')
  try {
    const s = await session(r); const registered = await call(r, '/api/auth/register', { ...s, method: 'POST', body: { name: '會員一', email: 'member@example.invalid', password: 'member-fixture-password', consent: true } }); assert.equal(registered.statusCode, 201)
    const m = { cookie: registered.headers['set-cookie'].split(';')[0], csrf: registered.json.csrfToken }; const memberId = registered.json.actor.id
    r.booking.adjustCredits(memberId, { delta: 2, reason: '合成測試堂數', idempotencyKey: 'http-credits-test' })
    const slot = r.booking.listSlots()[0]
    const reserved = await call(r, '/api/bookings', { ...m, method: 'POST', body: { serviceId: slot.serviceId, slotId: slot.id, idempotencyKey: 'http-booking-test' } }); assert.equal(reserved.statusCode, 201)
    assert.equal((await call(r, '/api/account', m)).json.bookings.length, 1)
    assert.equal((await call(r, '/api/account', await session(r))).statusCode, 401)
    assert.equal((await call(r, '/api/auth/email/request', { ...m, method: 'POST', body: {} })).statusCode, 503)
    const secondSession = await session(r)
    const second = await call(r, '/api/auth/register', { ...secondSession, method: 'POST', body: { name: '會員二', email: 'second@example.invalid', password: 'another-fixture-password', consent: true } })
    const secondMember = { cookie: second.headers['set-cookie'].split(';')[0], csrf: second.json.csrfToken }
    assert.equal((await call(r, '/api/account', secondMember)).json.bookings.length, 0)
    assert.equal((await call(r, `/api/bookings/${reserved.json.id}`, { ...secondMember, method: 'PATCH', body: { action: 'cancel' } })).statusCode, 404)
    assert.equal((await call(r, '/api/account', m)).json.bookings[0].status, 'confirmed')
    const guestSession = await session(r); const guestSlot = r.booking.listSlots().find(value => value.available)
    const guest = { serviceId: guestSlot.serviceId, slotId: guestSlot.id, name: '合成訪客', email: 'guest@example.invalid', phone: '0912345678', idempotencyKey: 'http-guest-test' }
    assert.equal((await call(r, '/api/booking-requests', { ...guestSession, method: 'POST', body: guest })).statusCode, 422)
    const requested = await call(r, '/api/booking-requests', { ...guestSession, method: 'POST', body: { ...guest, consent: true } })
    assert.equal(requested.statusCode, 201)
    assert.equal(requested.json.status, 'pending_hold')
    assert.equal(r.booking.balance(memberId).balance, 1)
  } finally { r.close() }
})
test('commerce member history requires verified email and can never query another mailbox', async () => {
  const r = fixture()
  try {
    const s = await session(r); const registered = await call(r, '/api/auth/register', { ...s, method: 'POST', body: { name: '會員', email: 'member@example.invalid', password: 'member-fixture-password', consent: true } })
    const m = { cookie: registered.headers['set-cookie'].split(';')[0], csrf: registered.json.csrfToken }; const product = r.commerce.listProducts()[0]
    const own = r.commerce.createOrder({ items: [{ productId: product.id, quantity: 1 }], customer: { name: '合成會員', email: 'member@example.invalid', phone: '0912345678', address: '測試地址' }, consent: true, idempotencyKey: 'member-history-test' })
    r.commerce.createOrder({ items: [{ productId: product.id, quantity: 1 }], customer: { name: '別的會員', email: 'other@example.invalid', phone: '0912345678', address: '其他測試地址' }, consent: true, idempotencyKey: 'other-history-test' })
    assert.equal((await call(r, '/api/account', m)).json.orders.length, 0)
    const link = r.auth.requestVerification(registered.json.actor.id); r.auth.confirmVerification({ token: link.delivery.token })
    const result = await call(r, '/api/account?email=other@example.invalid', m); assert.equal(result.json.orders.length, 1); assert.equal(result.json.orders[0].id, own.id); assert.equal(result.json.emailVerificationRequired, false)
  } finally { r.close() }
})
