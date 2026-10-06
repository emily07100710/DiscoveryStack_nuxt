import { createHash, randomBytes } from 'node:crypto'
import { fail, id, integer, iso, text } from './errors.mjs'
import { transaction } from './store.mjs'
import { mediaUrl } from './config.mjs'

const MAX_MONEY = 1_000_000_000_000
const MAX_STOCK = 1_000_000_000
const MAX_PRODUCTS = 1_000
const MAX_ORDER_ITEMS = 50
const TOKEN_TTL_HOURS = 24

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function optionalText(value, label, max = 2_000) {
  if (value === undefined || value === null || value === '') return ''
  return text(value, label, max)
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(422, `${label}格式不正確`)
  return value
}

function boolean(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') fail(422, `${label}格式不正確`)
  return value
}

function safeIdentifier(value, label, fallback) {
  const result = value === undefined ? fallback : text(value, label, 100)
  if (!result || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(result)) fail(422, `${label}格式不正確`)
  return result
}

function safeSlug(value) {
  const result = text(value, '商品網址', 100).toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result)) fail(422, '商品網址格式不正確')
  return result
}

function safeImage(value) {
  return mediaUrl(text(value, '商品圖片', 2048))
}

function imageList(value, fallback = []) {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length > 20) fail(422, '商品圖片最多 20 張')
  const images = value.map(safeImage)
  if (new Set(images).size !== images.length) fail(422, '商品圖片不可重複')
  return images
}

function normalizeEmail(value) {
  const email = text(value, '電子郵件', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(422, '電子郵件格式不正確')
  return email
}

function normalizeAddress(value) {
  if (typeof value === 'string') return { line1: text(value, '地址', 300) }
  const input = record(value, '地址')
  const address = {
    postalCode: optionalText(input.postalCode, '郵遞區號', 20),
    city: optionalText(input.city, '縣市', 80),
    district: optionalText(input.district, '行政區', 80),
    line1: text(input.line1, '地址', 300),
  }
  if (!address.city && !address.district && !address.postalCode) return { line1: address.line1 }
  return address
}

function normalizeCustomer(value) {
  const input = record(value, '顧客資料')
  return {
    name: text(input.name, '顧客姓名', 100),
    email: normalizeEmail(input.email),
    phone: text(input.phone, '聯絡電話', 40),
    address: normalizeAddress(input.address),
  }
}

function configInteger(value, label, fallback, min, max) {
  return integer(value === undefined ? fallback : value, label, min, max)
}

function settings(config) {
  const commerce = config?.commerce ?? {}
  const currency = commerce.currency ?? 'TWD'
  if (currency !== 'TWD') fail(500, '目前商店僅支援 TWD', 'COMMERCE_CONFIG_INVALID')
  const requestedMode = commerce.paymentMode ?? 'disabled'
  if (!['disabled', 'manual', 'sandbox'].includes(requestedMode)) fail(500, '付款模式設定不正確', 'COMMERCE_CONFIG_INVALID')
  const production = config?.production === true || config?.mode === 'production' || config?.runtimeMode === 'production'
  return Object.freeze({
    currency,
    production,
    requestedPaymentMode: requestedMode,
    paymentMode: production && requestedMode === 'sandbox' ? 'disabled' : requestedMode,
    shippingFeeMinor: configInteger(commerce.shippingFeeMinor, '運費', 120, 0, MAX_MONEY),
    freeShippingThresholdMinor: configInteger(commerce.freeShippingThresholdMinor, '免運門檻', 8_000, 0, MAX_MONEY),
    orderHoldMinutes: configInteger(commerce.orderHoldMinutes, '訂單保留分鐘', 30, 1, 10_080),
  })
}

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_products (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      price_minor INTEGER NOT NULL CHECK(price_minor > 0),
      stock INTEGER NOT NULL CHECK(stock >= 0),
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      images_json TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS commerce_products_public
      ON commerce_products(active, category, name);
    CREATE TABLE IF NOT EXISTS commerce_product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES commerce_products(id),
      label TEXT NOT NULL,
      price_minor INTEGER NOT NULL CHECK(price_minor > 0),
      stock INTEGER NOT NULL CHECK(stock >= 0),
      position INTEGER NOT NULL CHECK(position >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(product_id, label COLLATE NOCASE)
    );
    CREATE INDEX IF NOT EXISTS commerce_variants_product
      ON commerce_product_variants(product_id, position, id);
    CREATE TABLE IF NOT EXISTS commerce_orders (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL COLLATE NOCASE UNIQUE,
      customer_json TEXT NOT NULL,
      email_normalized TEXT NOT NULL,
      subtotal_minor INTEGER NOT NULL CHECK(subtotal_minor >= 0),
      shipping_minor INTEGER NOT NULL CHECK(shipping_minor >= 0),
      total_minor INTEGER NOT NULL CHECK(total_minor >= 0),
      currency TEXT NOT NULL,
      payment_mode TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      fulfillment_status TEXT NOT NULL,
      carrier TEXT NOT NULL DEFAULT '',
      tracking_number TEXT NOT NULL DEFAULT '',
      refund_kind TEXT NOT NULL DEFAULT '',
      refund_reference TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      access_token_hash TEXT NOT NULL,
      access_token_expires_at TEXT NOT NULL,
      inventory_released INTEGER NOT NULL DEFAULT 0 CHECK(inventory_released IN (0,1)),
      expires_at TEXT NOT NULL,
      paid_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS commerce_orders_lookup
      ON commerce_orders(number, email_normalized);
    CREATE INDEX IF NOT EXISTS commerce_orders_expiry
      ON commerce_orders(payment_status, fulfillment_status, expires_at);
    CREATE TABLE IF NOT EXISTS commerce_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES commerce_orders(id),
      product_id TEXT NOT NULL REFERENCES commerce_products(id),
      variant_id TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL,
      variant_label TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor > 0),
      image TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS commerce_items_order ON commerce_order_items(order_id, id);
    CREATE TABLE IF NOT EXISTS commerce_order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES commerce_orders(id),
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS commerce_events_order
      ON commerce_order_events(order_id, created_at, id);
  `)
}

function isConstraintError(error) {
  return typeof error?.code === 'string' && error.code.includes('SQLITE_CONSTRAINT')
}

function asProduct(db, row) {
  const variants = db.prepare(`
    SELECT id, label, price_minor, stock
    FROM commerce_product_variants WHERE product_id=? ORDER BY position, id
  `).all(row.id).map(variant => ({
    id: variant.id,
    label: variant.label,
    priceMinor: variant.price_minor,
    stock: variant.stock,
  }))
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    slug: row.slug,
    category: row.category,
    description: row.description,
    priceMinor: row.price_minor,
    stock: row.stock,
    active: Boolean(row.active),
    images: JSON.parse(row.images_json),
    variants,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function addEvent(db, orderId, kind, label, metadata, at) {
  db.prepare(`
    INSERT INTO commerce_order_events(id, order_id, kind, label, metadata_json, created_at)
    VALUES(?,?,?,?,?,?)
  `).run(id(), orderId, kind, label, JSON.stringify(metadata ?? {}), at)
}

function orderView(db, row) {
  const items = db.prepare(`
    SELECT product_id, variant_id, product_name, variant_label, quantity, unit_price_minor, image
    FROM commerce_order_items WHERE order_id=? ORDER BY id
  `).all(row.id).map(item => ({
    productId: item.product_id,
    ...(item.variant_id ? { variantId: item.variant_id, variantLabel: item.variant_label } : {}),
    name: item.product_name,
    quantity: item.quantity,
    unitPriceMinor: item.unit_price_minor,
    image: item.image,
  }))
  const tracking = db.prepare(`
    SELECT id, kind, label, metadata_json, created_at
    FROM commerce_order_events WHERE order_id=? ORDER BY created_at, rowid
  `).all(row.id).map(event => ({
    id: event.id,
    kind: event.kind,
    label: event.label,
    metadata: JSON.parse(event.metadata_json),
    createdAt: event.created_at,
  }))
  return {
    id: row.id,
    number: row.number,
    customer: JSON.parse(row.customer_json),
    items,
    subtotalMinor: row.subtotal_minor,
    shippingMinor: row.shipping_minor,
    totalMinor: row.total_minor,
    currency: row.currency,
    paymentMode: row.payment_mode,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    refund: row.refund_kind ? { kind: row.refund_kind, reference: row.refund_reference } : null,
    tracking,
    expiresAt: row.expires_at,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function issueToken(db, orderId, at) {
  const accessToken = randomBytes(32).toString('base64url')
  const expiresAt = iso(new Date(new Date(at).getTime() + TOKEN_TTL_HOURS * 60 * 60 * 1_000))
  db.prepare(`
    UPDATE commerce_orders SET access_token_hash=?, access_token_expires_at=? WHERE id=?
  `).run(hash(accessToken), expiresAt, orderId)
  return accessToken
}

function restoreOrderInventory(db, orderId, at) {
  const items = db.prepare(`
    SELECT product_id, variant_id, quantity FROM commerce_order_items WHERE order_id=?
  `).all(orderId)
  for (const item of items) {
    if (item.variant_id) {
      const variant = db.prepare(`
        UPDATE commerce_product_variants SET stock=stock+?, updated_at=?
        WHERE id=? AND product_id=?
      `).run(item.quantity, at, item.variant_id, item.product_id)
      if (variant.changes !== 1) fail(500, '庫存資料不完整，已停止訂單更新', 'INVENTORY_INVARIANT')
    }
    const product = db.prepare(`
      UPDATE commerce_products SET stock=stock+?, version=version+1, updated_at=? WHERE id=?
    `).run(item.quantity, at, item.product_id)
    if (product.changes !== 1) fail(500, '庫存資料不完整，已停止訂單更新', 'INVENTORY_INVARIANT')
  }
}

function expireOrdersLocked(db, at) {
  const expired = db.prepare(`
    SELECT id FROM commerce_orders
    WHERE payment_status='pending' AND fulfillment_status='unfulfilled'
      AND inventory_released=0 AND expires_at<=?
  `).all(at)
  let count = 0
  for (const order of expired) {
    const changed = db.prepare(`
      UPDATE commerce_orders
      SET fulfillment_status='cancelled', inventory_released=1, updated_at=?
      WHERE id=? AND payment_status='pending' AND fulfillment_status='unfulfilled'
        AND inventory_released=0 AND expires_at<=?
    `).run(at, order.id, at)
    if (changed.changes !== 1) continue
    restoreOrderInventory(db, order.id, at)
    addEvent(db, order.id, 'order_expired', '付款期限已過，訂單已取消', {}, at)
    count += 1
  }
  return count
}

function nowIso() {
  return iso()
}

export function createCommerce(db, config = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') fail(500, '商店資料庫未正確連線', 'COMMERCE_DATABASE_REQUIRED')
  const commerceSettings = settings(config)
  initialize(db)

  function listProducts({ admin = false, query, category } = {}) {
    if (typeof admin !== 'boolean') fail(422, '商品查詢格式不正確')
    const normalizedQuery = query === undefined || query === '' ? '' : text(query, '搜尋文字', 100).toLocaleLowerCase('zh-Hant')
    const normalizedCategory = category === undefined || category === '' ? '' : text(category, '商品分類', 80)
    const rows = db.prepare(`
      SELECT * FROM commerce_products
      ${admin ? '' : 'WHERE active=1'}
      ORDER BY created_at, id LIMIT ${MAX_PRODUCTS}
    `).all()
    return rows.map(row => asProduct(db, row)).filter(product => {
      if (normalizedCategory && product.category !== normalizedCategory) return false
      if (!normalizedQuery) return true
      return [product.name, product.slug, product.category, product.description]
        .some(value => value.toLocaleLowerCase('zh-Hant').includes(normalizedQuery))
    })
  }

  function getProduct(slug, { admin = false } = {}) {
    if (typeof admin !== 'boolean') fail(422, '商品查詢格式不正確')
    const normalizedSlug = safeSlug(slug)
    const row = db.prepare(`
      SELECT * FROM commerce_products WHERE slug=? ${admin ? '' : 'AND active=1'}
    `).get(normalizedSlug)
    if (!row) fail(404, '找不到這項商品', 'PRODUCT_NOT_FOUND')
    return asProduct(db, row)
  }

  function saveProduct(value) {
    const input = record(value, '商品')
    try {
      return transaction(db, () => {
        const productId = input.id === undefined ? id() : safeIdentifier(input.id, '商品識別')
        const existing = db.prepare('SELECT * FROM commerce_products WHERE id=?').get(productId)
        if (existing && input.version === undefined) fail(409, '商品已更新，請重新載入後再儲存', 'PRODUCT_VERSION_REQUIRED')
        const expectedVersion = existing ? integer(input.version, '商品版本', 1, Number.MAX_SAFE_INTEGER) : 0
        if (existing && existing.version !== expectedVersion) fail(409, '商品已更新，請重新載入後再儲存', 'PRODUCT_VERSION_CONFLICT')

        const name = input.name === undefined && existing ? existing.name : text(input.name, '商品名稱', 160)
        const slug = input.slug === undefined && existing ? existing.slug : safeSlug(input.slug)
        const category = input.category === undefined && existing ? existing.category : text(input.category, '商品分類', 80)
        const description = input.description === undefined && existing ? existing.description : optionalText(input.description, '商品說明', 10_000)
        const active = boolean(input.active, '商品狀態', existing ? Boolean(existing.active) : false)
        const images = imageList(input.images, existing ? JSON.parse(existing.images_json) : [])
        const currentVariants = existing
          ? db.prepare('SELECT * FROM commerce_product_variants WHERE product_id=? ORDER BY position,id').all(productId)
          : []
        let variants
        if (input.variants === undefined) {
          variants = currentVariants.map(variant => ({
            id: variant.id,
            label: variant.label,
            priceMinor: variant.price_minor,
            stock: variant.stock,
          }))
        } else {
          if (!Array.isArray(input.variants) || input.variants.length > 100) fail(422, '商品規格最多 100 組')
          if (currentVariants.length && input.variants.length < currentVariants.length) fail(409, '既有規格不可直接移除，請保留規格並將庫存調整為零', 'VARIANT_REMOVAL_BLOCKED')
          variants = input.variants.map((raw, position) => {
            const variant = record(raw, `規格 ${position + 1}`)
            return {
              id: safeIdentifier(variant.id, `規格 ${position + 1} 識別`, id()),
              label: text(variant.label, `規格 ${position + 1} 名稱`, 120),
              priceMinor: integer(variant.priceMinor, `規格 ${position + 1} 售價`, 1, MAX_MONEY),
              stock: integer(variant.stock, `規格 ${position + 1} 庫存`, 0, MAX_STOCK),
            }
          })
          if (new Set(variants.map(variant => variant.id)).size !== variants.length) fail(422, '商品規格識別不可重複')
          if (new Set(variants.map(variant => variant.label.toLocaleLowerCase('zh-Hant'))).size !== variants.length) fail(422, '商品規格名稱不可重複')
          const submitted = new Set(variants.map(variant => variant.id))
          if (currentVariants.some(variant => !submitted.has(variant.id))) fail(409, '既有規格不可直接移除，請保留規格並將庫存調整為零', 'VARIANT_REMOVAL_BLOCKED')
          for (const variant of variants) {
            const owner = db.prepare('SELECT product_id FROM commerce_product_variants WHERE id=?').get(variant.id)
            if (owner && owner.product_id !== productId) fail(409, '規格識別已由其他商品使用', 'VARIANT_ID_CONFLICT')
          }
        }
        const priceMinor = variants.length
          ? Math.min(...variants.map(variant => variant.priceMinor))
          : integer(input.priceMinor === undefined && existing ? existing.price_minor : input.priceMinor, '商品售價', 1, MAX_MONEY)
        const stock = variants.length
          ? variants.reduce((total, variant) => total + variant.stock, 0)
          : integer(input.stock === undefined && existing ? existing.stock : input.stock, '商品庫存', 0, MAX_STOCK)
        if (!Number.isSafeInteger(stock) || stock > MAX_STOCK) fail(422, `商品庫存必須介於 0 至 ${MAX_STOCK}`)
        const at = nowIso()

        if (!existing) {
          const slugOwner = db.prepare('SELECT id FROM commerce_products WHERE slug=?').get(slug)
          if (slugOwner) fail(409, '商品網址已被使用', 'PRODUCT_SLUG_CONFLICT')
          db.prepare(`
            INSERT INTO commerce_products(
              id,slug,name,category,description,price_minor,stock,active,images_json,version,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)
          `).run(productId, slug, name, category, description, priceMinor, stock, Number(active), JSON.stringify(images), at, at)
        } else {
          const slugOwner = db.prepare('SELECT id FROM commerce_products WHERE slug=? AND id<>?').get(slug, productId)
          if (slugOwner) fail(409, '商品網址已被使用', 'PRODUCT_SLUG_CONFLICT')
          const changed = db.prepare(`
            UPDATE commerce_products
            SET slug=?,name=?,category=?,description=?,price_minor=?,stock=?,active=?,images_json=?,version=version+1,updated_at=?
            WHERE id=? AND version=?
          `).run(slug, name, category, description, priceMinor, stock, Number(active), JSON.stringify(images), at, productId, expectedVersion)
          if (changed.changes !== 1) fail(409, '商品已更新，請重新載入後再儲存', 'PRODUCT_VERSION_CONFLICT')
        }
        for (const [position, variant] of variants.entries()) {
          db.prepare(`
            INSERT INTO commerce_product_variants(id,product_id,label,price_minor,stock,position,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              label=excluded.label,price_minor=excluded.price_minor,stock=excluded.stock,
              position=excluded.position,updated_at=excluded.updated_at
            WHERE commerce_product_variants.product_id=excluded.product_id
          `).run(variant.id, productId, variant.label, variant.priceMinor, variant.stock, position, at, at)
        }
        return asProduct(db, db.prepare('SELECT * FROM commerce_products WHERE id=?').get(productId))
      })
    } catch (error) {
      if (error?.status) throw error
      if (isConstraintError(error)) fail(409, '商品資料與既有內容衝突', 'PRODUCT_CONFLICT')
      throw error
    }
  }

  function expireOrders() {
    const at = nowIso()
    return transaction(db, () => expireOrdersLocked(db, at))
  }

  function createOrder(value) {
    if (commerceSettings.paymentMode === 'disabled') {
      const code = commerceSettings.production && commerceSettings.requestedPaymentMode === 'sandbox'
        ? 'SANDBOX_DISABLED_IN_PRODUCTION'
        : 'PAYMENT_DISABLED'
      fail(503, '付款方式尚未開放，暫時無法建立訂單', code)
    }
    const input = record(value, '訂單')
    if (input.consent !== true) fail(422, '請先同意購物條款與隱私說明', 'CONSENT_REQUIRED')
    const customer = normalizeCustomer(input.customer)
    const idempotencyKey = text(input.idempotencyKey, '下單識別碼', 160)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/u.test(idempotencyKey)) fail(422, '下單識別碼格式不正確')
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_ORDER_ITEMS) fail(422, `訂單商品必須介於 1 至 ${MAX_ORDER_ITEMS} 項`)
    const items = input.items.map((raw, index) => {
      const item = record(raw, `訂單商品 ${index + 1}`)
      return {
        productId: safeIdentifier(item.productId, `訂單商品 ${index + 1}`),
        variantId: item.variantId === undefined || item.variantId === '' ? '' : safeIdentifier(item.variantId, `訂單規格 ${index + 1}`),
        quantity: integer(item.quantity, `訂單數量 ${index + 1}`, 1, 100),
      }
    }).sort((left, right) => left.productId.localeCompare(right.productId) || left.variantId.localeCompare(right.variantId))
    const keys = items.map(item => `${item.productId}\u0000${item.variantId}`)
    if (new Set(keys).size !== keys.length) fail(422, '相同商品規格不可重複列出')
    const requestHash = hash(JSON.stringify({ customer, items, consent: true }))

    try {
      return transaction(db, () => {
        const at = nowIso()
        expireOrdersLocked(db, at)
        const prior = db.prepare('SELECT * FROM commerce_orders WHERE idempotency_key=?').get(idempotencyKey)
        if (prior) {
          if (prior.request_hash !== requestHash) fail(409, '下單識別碼已用於不同內容，請重新確認購物袋', 'IDEMPOTENCY_CONFLICT')
          const accessToken = issueToken(db, prior.id, at)
          return { ...orderView(db, db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(prior.id)), accessToken }
        }

        const snapshots = items.map(item => {
          const product = db.prepare('SELECT * FROM commerce_products WHERE id=? AND active=1').get(item.productId)
          if (!product) fail(409, '購物袋內有商品已下架，請重新確認', 'PRODUCT_UNAVAILABLE')
          const variants = db.prepare('SELECT * FROM commerce_product_variants WHERE product_id=? ORDER BY position,id').all(item.productId)
          let variant
          if (variants.length) {
            if (!item.variantId) fail(422, `請選擇${product.name}的規格`, 'VARIANT_REQUIRED')
            variant = variants.find(candidate => candidate.id === item.variantId)
            if (!variant) fail(409, `${product.name}的規格已變更`, 'VARIANT_UNAVAILABLE')
            if (variant.stock < item.quantity) fail(409, `${product.name} ${variant.label}庫存不足`, 'INSUFFICIENT_STOCK')
          } else if (item.variantId) fail(422, `${product.name}沒有這項規格`, 'VARIANT_UNAVAILABLE')
          if (product.stock < item.quantity) fail(409, `${product.name}庫存不足`, 'INSUFFICIENT_STOCK')
          return {
            productId: product.id,
            variantId: variant?.id ?? '',
            name: product.name,
            variantLabel: variant?.label ?? '',
            quantity: item.quantity,
            unitPriceMinor: variant?.price_minor ?? product.price_minor,
            image: JSON.parse(product.images_json)[0] ?? '',
          }
        })
        const subtotalMinor = snapshots.reduce((total, item) => total + item.unitPriceMinor * item.quantity, 0)
        if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor > MAX_MONEY) fail(422, '訂單金額超過可處理範圍')
        const shippingMinor = commerceSettings.freeShippingThresholdMinor === 0 || subtotalMinor >= commerceSettings.freeShippingThresholdMinor
          ? 0
          : commerceSettings.shippingFeeMinor
        const totalMinor = subtotalMinor + shippingMinor
        if (!Number.isSafeInteger(totalMinor) || totalMinor > MAX_MONEY) fail(422, '訂單金額超過可處理範圍')
        const orderId = id()
        const orderNumber = `DS-${at.slice(0, 10).replaceAll('-', '')}-${randomBytes(5).toString('hex').toUpperCase()}`
        const expiresAt = iso(new Date(new Date(at).getTime() + commerceSettings.orderHoldMinutes * 60 * 1_000))
        const accessToken = randomBytes(32).toString('base64url')
        const accessTokenExpiresAt = iso(new Date(new Date(at).getTime() + TOKEN_TTL_HOURS * 60 * 60 * 1_000))
        db.prepare(`
          INSERT INTO commerce_orders(
            id,number,customer_json,email_normalized,subtotal_minor,shipping_minor,total_minor,currency,
            payment_mode,payment_status,fulfillment_status,idempotency_key,request_hash,
            access_token_hash,access_token_expires_at,expires_at,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,'pending','unfulfilled',?,?,?,?,?,?,?)
        `).run(
          orderId, orderNumber, JSON.stringify(customer), customer.email,
          subtotalMinor, shippingMinor, totalMinor, commerceSettings.currency, commerceSettings.paymentMode,
          idempotencyKey, requestHash, hash(accessToken), accessTokenExpiresAt, expiresAt, at, at,
        )
        const insertItem = db.prepare(`
          INSERT INTO commerce_order_items(
            order_id,product_id,variant_id,product_name,variant_label,quantity,unit_price_minor,image
          ) VALUES(?,?,?,?,?,?,?,?)
        `)
        for (const item of snapshots) {
          if (item.variantId) {
            const variant = db.prepare(`
              UPDATE commerce_product_variants SET stock=stock-?,updated_at=?
              WHERE id=? AND product_id=? AND stock>=?
            `).run(item.quantity, at, item.variantId, item.productId, item.quantity)
            if (variant.changes !== 1) fail(409, '規格庫存剛剛發生變動，請重新確認', 'INVENTORY_CONFLICT')
          }
          const product = db.prepare(`
            UPDATE commerce_products
            SET stock=stock-?,version=version+1,updated_at=?
            WHERE id=? AND active=1 AND stock>=?
          `).run(item.quantity, at, item.productId, item.quantity)
          if (product.changes !== 1) fail(409, '商品庫存剛剛發生變動，請重新確認', 'INVENTORY_CONFLICT')
          insertItem.run(orderId, item.productId, item.variantId, item.name, item.variantLabel, item.quantity, item.unitPriceMinor, item.image)
        }
        addEvent(db, orderId, 'order_created', '訂單已建立，等待付款確認', { paymentMode: commerceSettings.paymentMode }, at)
        return { ...orderView(db, db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(orderId)), accessToken }
      })
    } catch (error) {
      if (error?.status) throw error
      if (isConstraintError(error)) fail(409, '訂單資料發生衝突，請重新確認', 'ORDER_CONFLICT')
      throw error
    }
  }

  function lookupOrder(value) {
    const input = record(value, '訂單查詢')
    const number = text(input.number, '訂單編號', 80).toUpperCase()
    const email = normalizeEmail(input.email)
    return transaction(db, () => {
      const at = nowIso()
      expireOrdersLocked(db, at)
      const row = db.prepare('SELECT * FROM commerce_orders WHERE number=? AND email_normalized=?').get(number, email)
      if (!row) fail(404, '找不到符合的訂單', 'ORDER_NOT_FOUND')
      const accessToken = issueToken(db, row.id, at)
      return { ...orderView(db, db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(row.id)), accessToken }
    })
  }

  function getOrder(orderIdValue, tokenValue) {
    const orderId = safeIdentifier(orderIdValue, '訂單識別')
    const token = text(tokenValue, '訂單存取憑證', 200)
    if (!/^[A-Za-z0-9_-]{32,200}$/u.test(token)) fail(404, '找不到這筆訂單', 'ORDER_NOT_FOUND')
    expireOrders()
    const row = db.prepare(`
      SELECT * FROM commerce_orders
      WHERE id=? AND access_token_hash=? AND access_token_expires_at>?
    `).get(orderId, hash(token), nowIso())
    if (!row) fail(404, '找不到這筆訂單', 'ORDER_NOT_FOUND')
    return orderView(db, row)
  }

  function listOrders() {
    expireOrders()
    return db.prepare('SELECT * FROM commerce_orders ORDER BY created_at DESC, id DESC LIMIT 500').all()
      .map(row => orderView(db, row))
  }
  // The HTTP boundary must supply an authenticated, verified mailbox, never query/body email.
  function listMemberOrders(email) {
    expireOrders()
    return db.prepare('SELECT * FROM commerce_orders WHERE email_normalized=? ORDER BY created_at DESC,id DESC LIMIT 100').all(normalizeEmail(email)).map(row => orderView(db, row))
  }

  function transitionOrder(orderIdValue, value) {
    const orderId = safeIdentifier(orderIdValue, '訂單識別')
    const input = record(value, '訂單操作')
    const action = text(input.action, '訂單操作', 40)
    if (!['confirm_manual_payment', 'ship', 'cancel', 'refund'].includes(action)) fail(422, '不支援這項訂單操作')
    return transaction(db, () => {
      const at = nowIso()
      expireOrdersLocked(db, at)
      let row = db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(orderId)
      if (!row) fail(404, '找不到這筆訂單', 'ORDER_NOT_FOUND')

      if (action === 'confirm_manual_payment') {
        if (!['manual', 'sandbox'].includes(row.payment_mode)) fail(409, '此訂單不支援人工付款確認', 'PAYMENT_TRANSITION_BLOCKED')
        if (row.payment_status === 'paid') return orderView(db, row)
        if (row.payment_status === 'refunded' || row.fulfillment_status === 'cancelled') fail(409, '此訂單已取消或退款，無法確認付款', 'PAYMENT_TRANSITION_BLOCKED')
        const reference = optionalText(input.reference, '付款參考', 120)
        db.prepare(`
          UPDATE commerce_orders
          SET payment_status='paid',fulfillment_status='processing',paid_at=?,updated_at=? WHERE id=?
        `).run(at, at, orderId)
        const sandbox = row.payment_mode === 'sandbox'
        addEvent(
          db,
          orderId,
          sandbox ? 'sandbox_payment_confirmed' : 'manual_payment_confirmed',
          sandbox ? '沙盒付款已模擬完成' : '已人工確認離線付款',
          { ...(reference ? { reference } : {}) },
          at,
        )
      }

      if (action === 'ship') {
        if (row.payment_status !== 'paid') fail(409, '尚未確認付款，不能標記出貨', 'PAYMENT_REQUIRED')
        if (!['processing', 'unfulfilled'].includes(row.fulfillment_status)) {
          if (row.fulfillment_status === 'shipped') return orderView(db, row)
          fail(409, '目前訂單狀態不能出貨', 'FULFILLMENT_TRANSITION_BLOCKED')
        }
        const carrier = text(input.carrier, '物流商', 100)
        const trackingNumber = text(input.trackingNumber, '物流單號', 120)
        const note = optionalText(input.note, '物流備註', 500)
        db.prepare(`
          UPDATE commerce_orders SET fulfillment_status='shipped',carrier=?,tracking_number=?,updated_at=? WHERE id=?
        `).run(carrier, trackingNumber, at, orderId)
        addEvent(db, orderId, 'order_shipped', '訂單已交付物流', { carrier, trackingNumber, ...(note ? { note } : {}) }, at)
      }

      if (action === 'cancel') {
        if (row.fulfillment_status === 'cancelled') return orderView(db, row)
        if (row.payment_status === 'paid') fail(409, '已付款訂單須先記錄退款，不能直接取消', 'REFUND_REQUIRED')
        if (['shipped', 'delivered'].includes(row.fulfillment_status)) fail(409, '已出貨訂單不能直接取消', 'FULFILLMENT_TRANSITION_BLOCKED')
        const note = optionalText(input.note, '取消備註', 500)
        const changed = db.prepare(`
          UPDATE commerce_orders
          SET fulfillment_status='cancelled',inventory_released=1,updated_at=?
          WHERE id=? AND inventory_released=0
        `).run(at, orderId)
        if (changed.changes === 1) restoreOrderInventory(db, orderId, at)
        addEvent(db, orderId, 'order_cancelled', '訂單已取消', { ...(note ? { note } : {}) }, at)
      }

      if (action === 'refund') {
        if (row.payment_status === 'refunded') return orderView(db, row)
        if (row.payment_status !== 'paid') fail(409, '只有已付款訂單能記錄退款', 'REFUND_TRANSITION_BLOCKED')
        const reference = text(input.reference, '人工退款參考', 120)
        const note = optionalText(input.note, '退款備註', 500)
        const canRestore = !['shipped', 'delivered'].includes(row.fulfillment_status) && !row.inventory_released
        db.prepare(`
          UPDATE commerce_orders
          SET payment_status='refunded',
              fulfillment_status=CASE WHEN fulfillment_status IN ('shipped','delivered') THEN fulfillment_status ELSE 'cancelled' END,
              refund_kind='manual_record',refund_reference=?,inventory_released=?,updated_at=?
          WHERE id=?
        `).run(reference, canRestore ? 1 : row.inventory_released, at, orderId)
        if (canRestore) restoreOrderInventory(db, orderId, at)
        addEvent(db, orderId, 'manual_refund_recorded', '已記錄人工退款確認', { reference, ...(note ? { note } : {}), inventoryRestored: canRestore }, at)
      }

      row = db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(orderId)
      return orderView(db, row)
    })
  }

  return Object.freeze({
    settings: commerceSettings,
    listProducts,
    getProduct,
    saveProduct,
    listOrders,
    listMemberOrders,
    createOrder,
    lookupOrder,
    getOrder,
    transitionOrder,
    expireOrders,
  })
}
