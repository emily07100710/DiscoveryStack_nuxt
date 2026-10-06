import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createCommerce } from '../lib/commerce.mjs'

const databases = []
const directories = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function database(filename = ':memory:') {
  const result = new DatabaseSync(filename)
  result.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  databases.push(result)
  return result
}

function commerce(options = {}) {
  const db = database(options.filename)
  const service = createCommerce(db, {
    mode: options.mode ?? 'preview',
    commerce: {
      paymentMode: options.paymentMode ?? 'manual',
      shippingFeeMinor: options.shippingFeeMinor ?? 0,
      freeShippingThresholdMinor: options.freeShippingThresholdMinor ?? 0,
      orderHoldMinutes: options.orderHoldMinutes ?? 30,
    },
  })
  return { db, service }
}

function product(service, overrides = {}) {
  return service.saveProduct({
    name: '雲朵商品',
    slug: 'cloud-product',
    category: 'daily',
    description: '測試用的公開商品。',
    priceMinor: 1_000,
    stock: 3,
    active: true,
    images: [`/media/${'a'.repeat(64)}.webp`],
    ...overrides,
  })
}

const customer = {
  name: '測試顧客',
  email: 'shopper@example.test',
  phone: '0900000000',
  address: { postalCode: '000', city: '測試市', district: '測試區', line1: '非真實測試地址' },
}

function checkout(productId, idempotencyKey, overrides = {}) {
  return {
    customer,
    consent: true,
    idempotencyKey,
    items: [{ productId, quantity: 1 }],
    ...overrides,
  }
}

function rejects(status, code) {
  return error => error?.status === status && (!code || error.code === code)
}

test('server catalog owns price and idempotency reserves stock only once', () => {
  const { service } = commerce()
  const item = product(service)
  const input = checkout(item.id, 'checkout-price-001', {
    items: [{ productId: item.id, quantity: 2, priceMinor: 1, stock: 999 }],
  })

  const created = service.createOrder(input)
  assert.equal(created.subtotalMinor, 2_000)
  assert.equal(created.totalMinor, 2_000)
  assert.equal(created.paymentStatus, 'pending')
  assert.ok(created.accessToken)
  assert.equal(service.getProduct(item.slug).stock, 1)

  const retried = service.createOrder(input)
  assert.equal(retried.id, created.id)
  assert.notEqual(retried.accessToken, created.accessToken)
  assert.equal(service.getProduct(item.slug).stock, 1)
  assert.throws(
    () => service.createOrder({ ...input, items: [{ productId: item.id, quantity: 1 }] }),
    rejects(409, 'IDEMPOTENCY_CONFLICT'),
  )
})

test('a mixed unavailable cart rolls the whole inventory reservation back', () => {
  const { service } = commerce()
  const first = product(service, { slug: 'available-product', stock: 2 })
  const second = product(service, { slug: 'sold-out-product', stock: 0 })
  assert.throws(() => service.createOrder(checkout(first.id, 'checkout-rollback-001', {
    items: [{ productId: first.id, quantity: 1 }, { productId: second.id, quantity: 1 }],
  })), rejects(409, 'INSUFFICIENT_STOCK'))
  assert.equal(service.getProduct(first.slug).stock, 2)
  assert.equal(service.listOrders().length, 0)
})

test('expired orders release stock exactly once and remain readable with their capability', () => {
  const { db, service } = commerce()
  const item = product(service, { stock: 1 })
  const order = service.createOrder(checkout(item.id, 'checkout-expiry-001'))
  db.prepare("UPDATE commerce_orders SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(order.id)

  assert.equal(service.expireOrders(), 1)
  assert.equal(service.expireOrders(), 0)
  assert.equal(service.getProduct(item.slug).stock, 1)
  assert.equal(service.getOrder(order.id, order.accessToken).fulfillmentStatus, 'cancelled')
})

test('repeated cancellation never replenishes inventory twice', () => {
  const { service } = commerce()
  const item = product(service, { stock: 2 })
  const order = service.createOrder(checkout(item.id, 'checkout-cancel-001'))
  assert.equal(service.getProduct(item.slug).stock, 1)

  assert.equal(service.transitionOrder(order.id, { action: 'cancel', note: '顧客取消測試' }).fulfillmentStatus, 'cancelled')
  assert.equal(service.transitionOrder(order.id, { action: 'cancel' }).fulfillmentStatus, 'cancelled')
  assert.equal(service.getProduct(item.slug).stock, 2)
})

test('two handles sharing one site database cannot sell the last unit twice', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ds-commerce-last-unit-'))
  directories.push(directory)
  const filename = join(directory, 'site.sqlite')
  const first = commerce({ filename })
  const secondDb = database(filename)
  const second = createCommerce(secondDb, {
    mode: 'preview',
    commerce: { paymentMode: 'manual', shippingFeeMinor: 0, freeShippingThresholdMinor: 0, orderHoldMinutes: 30 },
  })
  const item = product(first.service, { stock: 1 })

  first.service.createOrder(checkout(item.id, 'checkout-last-unit-001'))
  assert.throws(
    () => second.createOrder(checkout(item.id, 'checkout-last-unit-002')),
    rejects(409, 'INSUFFICIENT_STOCK'),
  )
  assert.equal(second.getProduct(item.slug).stock, 0)
  assert.equal(second.listOrders().length, 1)
})

test('variant stock is authoritative and order snapshots survive later product edits', () => {
  const { service } = commerce()
  const item = product(service, {
    priceMinor: 1,
    stock: 999,
    variants: [
      { id: 'variant-black', label: '黑色', priceMinor: 1_200, stock: 1 },
      { id: 'variant-white', label: '白色', priceMinor: 1_300, stock: 2 },
    ],
  })
  const order = service.createOrder(checkout(item.id, 'checkout-variant-001', {
    items: [{ productId: item.id, variantId: 'variant-black', quantity: 1, priceMinor: 1 }],
  }))
  assert.equal(order.subtotalMinor, 1_200)
  assert.equal(service.getProduct(item.slug).stock, 2)
  assert.throws(
    () => service.createOrder(checkout(item.id, 'checkout-variant-002', {
      items: [{ productId: item.id, variantId: 'variant-black', quantity: 1 }],
    })),
    rejects(409, 'INSUFFICIENT_STOCK'),
  )

  const current = service.getProduct(item.slug, { admin: true })
  const edited = service.saveProduct({
    ...current,
    name: '更新後商品名稱',
    variants: current.variants.map(variant => ({ ...variant, label: `${variant.label}新版` })),
  })
  const authorized = service.getOrder(order.id, order.accessToken)
  assert.equal(edited.name, '更新後商品名稱')
  assert.equal(authorized.items[0].name, '雲朵商品')
  assert.equal(authorized.items[0].variantLabel, '黑色')
})

test('guest order capabilities isolate orders and lookup rotates a short-lived token', () => {
  const { service } = commerce()
  const item = product(service, { stock: 3 })
  const first = service.createOrder(checkout(item.id, 'checkout-isolation-001'))
  const second = service.createOrder(checkout(item.id, 'checkout-isolation-002', {
    customer: { ...customer, email: 'second@example.test' },
  }))

  assert.throws(() => service.getOrder(first.id, second.accessToken), rejects(404, 'ORDER_NOT_FOUND'))
  assert.throws(() => service.lookupOrder({ number: first.number, email: 'second@example.test' }), rejects(404, 'ORDER_NOT_FOUND'))
  const recovered = service.lookupOrder({ number: first.number.toLowerCase(), email: customer.email.toUpperCase() })
  assert.equal(recovered.id, first.id)
  assert.ok(recovered.accessToken)
  assert.throws(() => service.getOrder(first.id, first.accessToken), rejects(404, 'ORDER_NOT_FOUND'))
  assert.equal(service.getOrder(first.id, recovered.accessToken).id, first.id)
  assert.ok(service.listOrders().every(order => !('accessToken' in order)))
})

test('manual payment, shipping and refund require explicit safe transitions', () => {
  const { service } = commerce()
  const item = product(service, { stock: 2 })
  const order = service.createOrder(checkout(item.id, 'checkout-manual-001'))
  assert.throws(
    () => service.transitionOrder(order.id, { action: 'ship', carrier: '測試物流', trackingNumber: 'TEST-001' }),
    rejects(409, 'PAYMENT_REQUIRED'),
  )
  const paid = service.transitionOrder(order.id, { action: 'confirm_manual_payment', reference: 'offline-confirmation' })
  assert.equal(paid.paymentStatus, 'paid')
  assert.equal(paid.fulfillmentStatus, 'processing')
  assert.throws(() => service.transitionOrder(order.id, { action: 'cancel' }), rejects(409, 'REFUND_REQUIRED'))
  const shipped = service.transitionOrder(order.id, { action: 'ship', carrier: '測試物流', trackingNumber: 'TEST-001' })
  assert.equal(shipped.fulfillmentStatus, 'shipped')
  const refunded = service.transitionOrder(order.id, { action: 'refund', reference: 'manual-refund-record' })
  assert.deepEqual(refunded.refund, { kind: 'manual_record', reference: 'manual-refund-record' })
  assert.equal(refunded.paymentStatus, 'refunded')
  assert.equal(refunded.fulfillmentStatus, 'shipped')
  assert.equal(service.getProduct(item.slug).stock, 1, 'shipped goods are never silently restocked')
  assert.equal(refunded.tracking.at(-1).kind, 'manual_refund_recorded')
})

test('product versioning rejects stale writes and existing variants cannot disappear', () => {
  const { service } = commerce()
  const item = product(service, {
    variants: [{ id: 'variant-stable', label: '固定規格', priceMinor: 1_000, stock: 2 }],
  })
  const updated = service.saveProduct({ ...item, description: '第一個更新' })
  assert.equal(updated.version, item.version + 1)
  assert.throws(() => service.saveProduct({ ...item, description: '過期的更新' }), rejects(409, 'PRODUCT_VERSION_CONFLICT'))
  assert.throws(() => service.saveProduct({ ...updated, variants: [] }), rejects(409, 'VARIANT_REMOVAL_BLOCKED'))
})

test('disabled payment and production sandbox both refuse to create pretend paid orders', () => {
  const disabled = commerce({ paymentMode: 'disabled' }).service
  const disabledProduct = product(disabled)
  assert.throws(() => disabled.createOrder(checkout(disabledProduct.id, 'checkout-disabled-001')), rejects(503, 'PAYMENT_DISABLED'))

  const production = commerce({ paymentMode: 'sandbox', mode: 'production' }).service
  const productionProduct = product(production, { slug: 'production-product' })
  assert.equal(production.settings.paymentMode, 'disabled')
  assert.throws(
    () => production.createOrder(checkout(productionProduct.id, 'checkout-production-001')),
    rejects(503, 'SANDBOX_DISABLED_IN_PRODUCTION'),
  )
})
