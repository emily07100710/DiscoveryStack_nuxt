import { createHash } from 'node:crypto'
import { fail, id, integer, iso, text } from './errors.mjs'
import { transaction } from './store.mjs'

function boolean(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(422, '啟用狀態格式不正確')
  return value
}

function identity(value, label) {
  return text(value, label, 200)
}

function identifier(value, label) {
  const result = text(value, label, 100)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(result)) fail(422, `${label}格式不正確`)
  return result
}

function instant(value, label) {
  const result = text(value, label, 80)
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(result)) fail(422, `${label}必須包含時區`)
  const milliseconds = Date.parse(result)
  if (!Number.isFinite(milliseconds)) fail(422, `${label}格式不正確`)
  return new Date(milliseconds).toISOString()
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function rejectPaymentClaims(input) {
  for (const field of ['paid', 'isPaid', 'paymentStatus', 'paymentMode', 'amountPaid']) {
    if (Object.hasOwn(input, field)) fail(422, '付款狀態只能由受信任的付款流程決定', 'PAYMENT_STATE_NOT_ACCEPTED')
  }
}

function validateEmail(value) {
  const result = text(value, 'Email', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) fail(422, 'Email 格式不正確')
  return result
}

function validatePhone(value) {
  const result = text(value, '電話', 40)
  if (!/^\+?[0-9 ()-]{6,40}$/u.test(result)) fail(422, '電話格式不正確')
  return result
}

function validateTimeZone(value) {
  const result = text(value ?? 'UTC', '時區', 100)
  try {
    new Intl.DateTimeFormat('zh-TW', { timeZone: result }).format(new Date(0))
  } catch {
    fail(422, '時區格式不正確')
  }
  return result
}

function serviceView(row) {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    creditCost: row.credit_cost,
    active: Boolean(row.active),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function slotView(row, nowMilliseconds = Date.now()) {
  const occupied = Boolean(row.occupied)
  return {
    id: row.id,
    serviceId: row.service_id,
    resourceId: row.resource_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    active: Boolean(row.active),
    capacity: 1,
    available: Boolean(row.active) && Date.parse(row.starts_at) > nowMilliseconds && !occupied,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function bookingView(row, { replayed = false, refundCredits } = {}) {
  const result = {
    id: row.id,
    kind: row.kind,
    memberId: row.member_id,
    serviceId: row.service_id,
    slotId: row.slot_id,
    service: {
      name: row.service_name,
      durationMinutes: row.duration_minutes,
      creditCost: row.credit_cost,
    },
    slot: {
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      resourceId: row.resource_id,
      capacity: 1,
    },
    serviceName: row.service_name,
    durationMinutes: row.duration_minutes,
    creditCost: row.credit_cost,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    resourceId: row.resource_id,
    status: row.status,
    holdExpiresAt: row.hold_expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.kind === 'guest') {
    result.contact = {
      name: row.guest_name,
      email: row.guest_email,
      phone: row.guest_phone,
      notes: row.guest_notes,
    }
    result.paymentMode = 'manual'
    result.paymentStatus = 'manual_required'
  }
  if (replayed) result.replayed = true
  if (refundCredits !== undefined) result.refundCredits = refundCredits
  return result
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 5 AND 1440),
      credit_cost INTEGER NOT NULL CHECK(credit_cost BETWEEN 0 AND 1000000),
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS booking_slots (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES booking_services(id),
      resource_id TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(starts_at < ends_at)
    );
    CREATE INDEX IF NOT EXISTS booking_slots_service_time ON booking_slots(service_id, starts_at);
    CREATE INDEX IF NOT EXISTS booking_slots_resource_time ON booking_slots(resource_id, starts_at, ends_at);

    CREATE TABLE IF NOT EXISTS booking_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('member', 'guest')),
      member_id TEXT,
      service_id TEXT NOT NULL REFERENCES booking_services(id),
      slot_id TEXT NOT NULL REFERENCES booking_slots(id),
      service_name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      credit_cost INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('confirmed', 'cancelled', 'pending_hold', 'rejected', 'expired')),
      guest_name TEXT,
      guest_email TEXT,
      guest_phone TEXT,
      guest_notes TEXT,
      hold_expires_at TEXT,
      request_owner TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((kind = 'member' AND member_id IS NOT NULL AND hold_expires_at IS NULL)
        OR (kind = 'guest' AND member_id IS NULL)),
      UNIQUE(kind, request_owner, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS booking_slot_single_occupant
      ON booking_records(slot_id)
      WHERE status IN ('confirmed', 'pending_hold');
    CREATE INDEX IF NOT EXISTS booking_records_member ON booking_records(member_id, created_at);

    CREATE TABLE IF NOT EXISTS booking_credit_ledger (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      delta INTEGER NOT NULL CHECK(delta != 0),
      balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
      reason TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('adjustment', 'booking_debit', 'cancellation_refund')),
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      booking_id TEXT REFERENCES booking_records(id),
      created_at TEXT NOT NULL,
      UNIQUE(member_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS booking_credit_single_booking_entry
      ON booking_credit_ledger(booking_id, entry_type)
      WHERE booking_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS booking_events (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES booking_records(id),
      event_type TEXT NOT NULL,
      from_slot_id TEXT,
      to_slot_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS booking_events_history ON booking_events(booking_id, created_at);
  `)
}

export function createBooking(db, config = {}) {
  const bookingConfig = config.booking ?? {}
  const cancellationHours = integer(bookingConfig.cancellationHours ?? 24, '取消期限', 0, 24 * 365)
  const guestHoldMinutes = integer(bookingConfig.holdMinutes ?? bookingConfig.guestHoldMinutes ?? 30, '訪客保留分鐘', 1, 24 * 60)
  const timeZone = validateTimeZone(bookingConfig.timeZone ?? config.timeZone ?? 'UTC')
  const nowProvider = typeof config.now === 'function' ? config.now : () => new Date()

  const currentDate = () => {
    const value = new Date(nowProvider())
    if (!Number.isFinite(value.getTime())) fail(500, '伺服器時間設定不正確', 'INVALID_SERVER_TIME')
    return value
  }

  ensureSchema(db)

  const serviceById = db.prepare('SELECT * FROM booking_services WHERE id = ?')
  const slotById = db.prepare(`
    SELECT s.*, EXISTS(
      SELECT 1 FROM booking_records b
      WHERE b.slot_id = s.id AND b.status IN ('confirmed', 'pending_hold')
    ) AS occupied
    FROM booking_slots s WHERE s.id = ?
  `)
  const bookingById = db.prepare('SELECT * FROM booking_records WHERE id = ?')

  function addEvent(bookingId, eventType, nowIso, { fromSlotId = null, toSlotId = null, detail = null } = {}) {
    db.prepare(`
      INSERT INTO booking_events(id, booking_id, event_type, from_slot_id, to_slot_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id(), bookingId, eventType, fromSlotId, toSlotId, detail === null ? null : JSON.stringify(detail), nowIso)
  }

  function expireGuestHolds(nowIso) {
    const expired = db.prepare(`
      SELECT id, slot_id FROM booking_records
      WHERE status = 'pending_hold' AND hold_expires_at <= ?
      ORDER BY id
    `).all(nowIso)
    for (const row of expired) {
      const changed = db.prepare(`
        UPDATE booking_records
        SET status = 'expired', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'pending_hold' AND hold_expires_at <= ?
      `).run(nowIso, row.id, nowIso)
      if (changed.changes) addEvent(row.id, 'guest_hold_expired', nowIso, { fromSlotId: row.slot_id })
    }
  }

  function currentBalance(memberId) {
    return db.prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM booking_credit_ledger WHERE member_id = ?')
      .get(memberId).balance
  }

  function loadBooking(bookingId) {
    const row = bookingById.get(bookingId)
    if (!row) fail(404, '找不到預約', 'BOOKING_NOT_FOUND')
    return row
  }

  function assertSlotOpen(slot, serviceId, nowMilliseconds) {
    if (slot.service_id !== serviceId) fail(422, '服務與時段不相符', 'SERVICE_SLOT_MISMATCH')
    if (!slot.active) fail(409, '此時段目前未開放', 'SLOT_UNAVAILABLE')
    if (Date.parse(slot.starts_at) <= nowMilliseconds) fail(409, '此時段已開始或已結束', 'SLOT_UNAVAILABLE')
    if (slot.occupied) fail(409, '此時段已被預約', 'SLOT_UNAVAILABLE')
  }

  function listServices({ admin = false } = {}) {
    if (typeof admin !== 'boolean') fail(422, '服務查詢模式不正確')
    const rows = admin
      ? db.prepare('SELECT * FROM booking_services ORDER BY active DESC, name, id').all()
      : db.prepare('SELECT * FROM booking_services WHERE active = 1 ORDER BY name, id').all()
    return rows.map(serviceView)
  }

  function saveService(input) {
    if (!input || typeof input !== 'object') fail(422, '服務資料格式不正確')
    const serviceId = input.id === undefined ? id() : identifier(input.id, '服務識別')
    const name = text(input.name, '服務名稱', 200)
    const durationMinutes = integer(input.durationMinutes, '服務時間', 5, 1440)
    const creditCost = integer(input.creditCost, '所需堂數', 0, 1000000)
    const active = boolean(input.active, true)
    const nowIso = iso(currentDate())

    return transaction(db, () => {
      const existing = serviceById.get(serviceId)
      if (!existing) {
        if (input.version !== undefined) fail(409, '新服務不可指定舊版本', 'VERSION_CONFLICT')
        db.prepare(`
          INSERT INTO booking_services(id, name, duration_minutes, credit_cost, active, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run(serviceId, name, durationMinutes, creditCost, active ? 1 : 0, nowIso, nowIso)
        return serviceView(serviceById.get(serviceId))
      }

      const version = integer(input.version, '服務版本', 1, Number.MAX_SAFE_INTEGER)
      if (existing.version !== version) fail(409, '服務已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      if (existing.duration_minutes !== durationMinutes) {
        const slotCount = db.prepare('SELECT COUNT(*) AS count FROM booking_slots WHERE service_id = ?').get(serviceId).count
        if (slotCount) fail(409, '已有時段的服務不可直接變更時間，請建立新的服務', 'SERVICE_DURATION_IN_USE')
      }
      const result = db.prepare(`
        UPDATE booking_services
        SET name = ?, duration_minutes = ?, credit_cost = ?, active = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(name, durationMinutes, creditCost, active ? 1 : 0, nowIso, serviceId, version)
      if (!result.changes) fail(409, '服務已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      return serviceView(serviceById.get(serviceId))
    })
  }

  function listSlots({ serviceId, from, to, admin = false } = {}) {
    if (typeof admin !== 'boolean') fail(422, '時段查詢模式不正確')
    const normalizedServiceId = serviceId === undefined ? undefined : identifier(serviceId, '服務識別')
    const normalizedFrom = from === undefined ? undefined : instant(from, '起始時間')
    const normalizedTo = to === undefined ? undefined : instant(to, '結束時間')
    if (normalizedFrom && normalizedTo && normalizedFrom >= normalizedTo) fail(422, '查詢起始時間必須早於結束時間')
    const now = currentDate()
    const clauses = []
    const values = []
    if (!admin) clauses.push('s.active = 1 AND EXISTS (SELECT 1 FROM booking_services visible_service WHERE visible_service.id = s.service_id AND visible_service.active = 1)')
    if (normalizedServiceId) { clauses.push('s.service_id = ?'); values.push(normalizedServiceId) }
    if (normalizedFrom) { clauses.push('s.ends_at > ?'); values.push(normalizedFrom) }
    if (normalizedTo) { clauses.push('s.starts_at < ?'); values.push(normalizedTo) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

    return transaction(db, () => {
      expireGuestHolds(iso(now))
      return db.prepare(`
        SELECT s.*, EXISTS(
          SELECT 1 FROM booking_records b
          WHERE b.slot_id = s.id AND b.status IN ('confirmed', 'pending_hold')
        ) AS occupied
        FROM booking_slots s ${where}
        ORDER BY s.starts_at, s.resource_id, s.id
      `).all(...values).map(row => slotView(row, now.getTime()))
    })
  }

  function saveSlot(input) {
    if (!input || typeof input !== 'object') fail(422, '時段資料格式不正確')
    if (input.capacity !== undefined && input.capacity !== 1) fail(422, '首版每個時段容量固定為 1', 'UNSUPPORTED_CAPACITY')
    if (input.endsAt !== undefined) fail(422, '結束時間由服務時間自動計算', 'SERVER_OWNED_FIELD')
    const slotId = input.id === undefined ? id() : identifier(input.id, '時段識別')
    const serviceId = identifier(input.serviceId, '服務識別')
    const resourceId = identifier(input.resourceId ?? 'default', '資源識別')
    const startsAt = instant(input.startsAt, '開始時間')
    const active = boolean(input.active, true)
    const nowIso = iso(currentDate())

    return transaction(db, () => {
      const service = serviceById.get(serviceId)
      if (!service) fail(404, '找不到服務', 'SERVICE_NOT_FOUND')
      const endsAt = iso(new Date(Date.parse(startsAt) + service.duration_minutes * 60_000))
      const existing = db.prepare('SELECT * FROM booking_slots WHERE id = ?').get(slotId)
      if (existing && input.version === undefined) fail(409, '時段已存在，更新時必須提供版本', 'VERSION_CONFLICT')
      if (!existing && input.version !== undefined) fail(409, '新時段不可指定舊版本', 'VERSION_CONFLICT')

      const overlap = db.prepare(`
        SELECT id FROM booking_slots
        WHERE id != ? AND resource_id = ? AND active = 1 AND ? = 1
          AND starts_at < ? AND ends_at > ?
        ORDER BY id LIMIT 1
      `).get(slotId, resourceId, active ? 1 : 0, endsAt, startsAt)
      if (overlap) fail(409, '同一資源已有重疊時段', 'RESOURCE_TIME_CONFLICT')

      if (!existing) {
        db.prepare(`
          INSERT INTO booking_slots(id, service_id, resource_id, starts_at, ends_at, active, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(slotId, serviceId, resourceId, startsAt, endsAt, active ? 1 : 0, nowIso, nowIso)
      } else {
        const version = integer(input.version, '時段版本', 1, Number.MAX_SAFE_INTEGER)
        if (existing.version !== version) fail(409, '時段已被其他人更新，請重新載入', 'VERSION_CONFLICT')
        const historyCount = db.prepare('SELECT COUNT(*) AS count FROM booking_records WHERE slot_id = ?').get(slotId).count
        const scheduleChanged = existing.service_id !== serviceId || existing.resource_id !== resourceId
          || existing.starts_at !== startsAt || existing.ends_at !== endsAt
        if (historyCount && scheduleChanged) fail(409, '已有預約紀錄的時段不可改變服務或時間', 'SLOT_HISTORY_LOCKED')
        const occupant = db.prepare(`
          SELECT id FROM booking_records WHERE slot_id = ? AND status IN ('confirmed', 'pending_hold') LIMIT 1
        `).get(slotId)
        if (occupant && !active) fail(409, '已有預約的時段不可停用，請先處理預約', 'SLOT_OCCUPIED')
        const result = db.prepare(`
          UPDATE booking_slots
          SET service_id = ?, resource_id = ?, starts_at = ?, ends_at = ?, active = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(serviceId, resourceId, startsAt, endsAt, active ? 1 : 0, nowIso, slotId, version)
        if (!result.changes) fail(409, '時段已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      }
      return slotView(slotById.get(slotId), Date.parse(nowIso))
    })
  }

  function listBookings(memberId) {
    const owner = memberId === undefined ? undefined : identity(memberId, '會員識別')
    const nowIso = iso(currentDate())
    return transaction(db, () => {
      expireGuestHolds(nowIso)
      const rows = owner === undefined
        ? db.prepare('SELECT * FROM booking_records ORDER BY starts_at DESC, id').all()
        : db.prepare("SELECT * FROM booking_records WHERE kind = 'member' AND member_id = ? ORDER BY starts_at DESC, id").all(owner)
      return rows.map(row => bookingView(row))
    })
  }

  function adjustCredits(memberId, input) {
    const member = identity(memberId, '會員識別')
    if (!input || typeof input !== 'object') fail(422, '堂數資料格式不正確')
    const delta = integer(input.delta, '堂數異動', -1000000, 1000000)
    if (delta === 0) fail(422, '堂數異動不可為 0')
    const reason = text(input.reason, '堂數異動原因', 500)
    const idempotencyKey = text(input.idempotencyKey, '冪等識別', 200)
    const storedKey = `adjust:${idempotencyKey}`
    const requestFingerprint = fingerprint({ delta, reason })
    const nowIso = iso(currentDate())

    return transaction(db, () => {
      const previous = db.prepare(`
        SELECT * FROM booking_credit_ledger WHERE member_id = ? AND idempotency_key = ?
      `).get(member, storedKey)
      if (previous) {
        if (previous.request_fingerprint !== requestFingerprint) fail(409, '相同冪等識別已用於不同堂數異動', 'IDEMPOTENCY_CONFLICT')
        return { memberId: member, balance: previous.balance_after, ledgerId: previous.id, replayed: true }
      }
      const nextBalance = currentBalance(member) + delta
      if (nextBalance < 0) fail(409, '可用堂數不足', 'INSUFFICIENT_CREDITS')
      const ledgerId = id()
      db.prepare(`
        INSERT INTO booking_credit_ledger(
          id, member_id, delta, balance_after, reason, entry_type,
          idempotency_key, request_fingerprint, booking_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'adjustment', ?, ?, NULL, ?)
      `).run(ledgerId, member, delta, nextBalance, reason, storedKey, requestFingerprint, nowIso)
      return { memberId: member, balance: nextBalance, ledgerId, replayed: false }
    })
  }

  function balance(memberId) {
    const member = identity(memberId, '會員識別')
    return { memberId: member, balance: currentBalance(member) }
  }

  function reserve(memberId, input) {
    const member = identity(memberId, '會員識別')
    if (!input || typeof input !== 'object') fail(422, '預約資料格式不正確')
    rejectPaymentClaims(input)
    const serviceId = identifier(input.serviceId, '服務識別')
    const slotId = identifier(input.slotId, '時段識別')
    const idempotencyKey = text(input.idempotencyKey, '冪等識別', 200)
    const requestFingerprint = fingerprint({ serviceId, slotId })
    const requestOwner = `member:${member}`
    const now = currentDate()
    const nowIso = iso(now)

    return transaction(db, () => {
      expireGuestHolds(nowIso)
      const replay = db.prepare(`
        SELECT * FROM booking_records
        WHERE kind = 'member' AND request_owner = ? AND idempotency_key = ?
      `).get(requestOwner, idempotencyKey)
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) fail(409, '相同冪等識別已用於不同預約', 'IDEMPOTENCY_CONFLICT')
        return bookingView(replay, { replayed: true })
      }

      const service = serviceById.get(serviceId)
      if (!service || !service.active) fail(409, '此服務目前未開放', 'SERVICE_UNAVAILABLE')
      const slot = slotById.get(slotId)
      if (!slot) fail(404, '找不到時段', 'SLOT_NOT_FOUND')
      assertSlotOpen(slot, serviceId, now.getTime())
      const availableBalance = currentBalance(member)
      if (availableBalance < service.credit_cost) fail(409, '可用堂數不足', 'INSUFFICIENT_CREDITS')

      const bookingId = id()
      db.prepare(`
        INSERT INTO booking_records(
          id, kind, member_id, service_id, slot_id, service_name, duration_minutes, credit_cost,
          starts_at, ends_at, resource_id, status, guest_name, guest_email, guest_phone, guest_notes,
          hold_expires_at, request_owner, idempotency_key, request_fingerprint, version, created_at, updated_at
        ) VALUES (?, 'member', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NULL, NULL, NULL, NULL,
          NULL, ?, ?, ?, 1, ?, ?)
      `).run(
        bookingId, member, service.id, slot.id, service.name, service.duration_minutes, service.credit_cost,
        slot.starts_at, slot.ends_at, slot.resource_id, requestOwner, idempotencyKey, requestFingerprint, nowIso, nowIso,
      )
      if (service.credit_cost > 0) {
        db.prepare(`
          INSERT INTO booking_credit_ledger(
            id, member_id, delta, balance_after, reason, entry_type,
            idempotency_key, request_fingerprint, booking_id, created_at
          ) VALUES (?, ?, ?, ?, ?, 'booking_debit', ?, ?, ?, ?)
        `).run(
          id(), member, -service.credit_cost, availableBalance - service.credit_cost,
          `預約：${service.name}`, `reserve:${bookingId}`, fingerprint({ bookingId, cost: service.credit_cost }), bookingId, nowIso,
        )
      }
      addEvent(bookingId, 'member_reserved', nowIso, { toSlotId: slot.id, detail: { creditCost: service.credit_cost } })
      return bookingView(loadBooking(bookingId))
    })
  }

  function change(memberId, bookingId, input) {
    const member = identity(memberId, '會員識別')
    const normalizedBookingId = identifier(bookingId, '預約識別')
    if (!input || typeof input !== 'object') fail(422, '預約異動格式不正確')
    if (!['cancel', 'reschedule'].includes(input.action)) fail(422, '預約異動動作不正確')
    const targetSlotId = input.action === 'reschedule' ? identifier(input.slotId, '新時段識別') : undefined
    const now = currentDate()
    const nowIso = iso(now)

    return transaction(db, () => {
      expireGuestHolds(nowIso)
      let booking = loadBooking(normalizedBookingId)
      if (booking.kind !== 'member' || booking.member_id !== member) fail(404, '找不到預約', 'BOOKING_NOT_FOUND')

      if (input.action === 'cancel') {
        if (booking.status === 'cancelled') {
          const refund = db.prepare(`
            SELECT delta FROM booking_credit_ledger
            WHERE booking_id = ? AND entry_type = 'cancellation_refund'
          `).get(booking.id)
          return bookingView(booking, { replayed: true, refundCredits: refund?.delta ?? 0 })
        }
        if (booking.status !== 'confirmed') fail(409, '此預約目前無法取消', 'BOOKING_NOT_CHANGEABLE')
        const refundable = now.getTime() <= Date.parse(booking.starts_at) - cancellationHours * 3_600_000
        const refundCredits = refundable ? booking.credit_cost : 0
        db.prepare(`
          UPDATE booking_records SET status = 'cancelled', version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'confirmed'
        `).run(nowIso, booking.id)
        if (refundCredits > 0) {
          const before = currentBalance(member)
          db.prepare(`
            INSERT INTO booking_credit_ledger(
              id, member_id, delta, balance_after, reason, entry_type,
              idempotency_key, request_fingerprint, booking_id, created_at
            ) VALUES (?, ?, ?, ?, ?, 'cancellation_refund', ?, ?, ?, ?)
          `).run(
            id(), member, refundCredits, before + refundCredits, `取消預約：${booking.service_name}`,
            `cancel:${booking.id}`, fingerprint({ bookingId: booking.id, refundCredits }), booking.id, nowIso,
          )
        }
        addEvent(booking.id, 'member_cancelled', nowIso, {
          fromSlotId: booking.slot_id,
          detail: { refundCredits, cancellationHours },
        })
        booking = loadBooking(booking.id)
        return bookingView(booking, { refundCredits })
      }

      if (booking.status !== 'confirmed') fail(409, '此預約目前無法改期', 'BOOKING_NOT_CHANGEABLE')
      if (booking.slot_id === targetSlotId) return bookingView(booking, { replayed: true })
      if (now.getTime() > Date.parse(booking.starts_at) - cancellationHours * 3_600_000) {
        fail(409, `開始前 ${cancellationHours} 小時內不可改期`, 'RESCHEDULE_CUTOFF_PASSED')
      }

      const orderedIds = [booking.slot_id, targetSlotId].sort()
      const lockedSlots = db.prepare('SELECT * FROM booking_slots WHERE id IN (?, ?) ORDER BY id').all(...orderedIds)
      const target = lockedSlots.find(row => row.id === targetSlotId)
      if (!target) fail(404, '找不到新時段', 'SLOT_NOT_FOUND')
      const occupied = db.prepare(`
        SELECT id FROM booking_records
        WHERE slot_id = ? AND id != ? AND status IN ('confirmed', 'pending_hold')
        LIMIT 1
      `).get(targetSlotId, booking.id)
      assertSlotOpen({ ...target, occupied: Boolean(occupied) }, booking.service_id, now.getTime())
      const result = db.prepare(`
        UPDATE booking_records
        SET slot_id = ?, starts_at = ?, ends_at = ?, resource_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'confirmed' AND slot_id = ?
      `).run(target.id, target.starts_at, target.ends_at, target.resource_id, nowIso, booking.id, booking.slot_id)
      if (!result.changes) fail(409, '預約已被其他人更新，請重新載入', 'VERSION_CONFLICT')
      addEvent(booking.id, 'member_rescheduled', nowIso, { fromSlotId: booking.slot_id, toSlotId: target.id })
      return bookingView(loadBooking(booking.id))
    })
  }

  function requestGuest(input) {
    if (!input || typeof input !== 'object') fail(422, '訪客預約資料格式不正確')
    rejectPaymentClaims(input)
    const serviceId = identifier(input.serviceId, '服務識別')
    const slotId = identifier(input.slotId, '時段識別')
    const guestName = text(input.name, '姓名', 200)
    const guestEmail = validateEmail(input.email)
    const guestPhone = validatePhone(input.phone)
    const guestNotes = input.notes === undefined || input.notes === null || input.notes === ''
      ? null
      : text(input.notes, '備註', 2000)
    const idempotencyKey = text(input.idempotencyKey, '冪等識別', 200)
    const requestOwner = `guest:${guestEmail}`
    const requestFingerprint = fingerprint({ serviceId, slotId, guestName, guestEmail, guestPhone, guestNotes })
    const now = currentDate()
    const nowIso = iso(now)

    return transaction(db, () => {
      expireGuestHolds(nowIso)
      const replay = db.prepare(`
        SELECT * FROM booking_records
        WHERE kind = 'guest' AND request_owner = ? AND idempotency_key = ?
      `).get(requestOwner, idempotencyKey)
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) fail(409, '相同冪等識別已用於不同訪客預約', 'IDEMPOTENCY_CONFLICT')
        return bookingView(replay, { replayed: true })
      }

      const service = serviceById.get(serviceId)
      if (!service || !service.active) fail(409, '此服務目前未開放', 'SERVICE_UNAVAILABLE')
      const slot = slotById.get(slotId)
      if (!slot) fail(404, '找不到時段', 'SLOT_NOT_FOUND')
      assertSlotOpen(slot, serviceId, now.getTime())
      const holdExpiresAt = iso(new Date(Math.min(
        now.getTime() + guestHoldMinutes * 60_000,
        Date.parse(slot.starts_at),
      )))
      const bookingId = id()
      db.prepare(`
        INSERT INTO booking_records(
          id, kind, member_id, service_id, slot_id, service_name, duration_minutes, credit_cost,
          starts_at, ends_at, resource_id, status, guest_name, guest_email, guest_phone, guest_notes,
          hold_expires_at, request_owner, idempotency_key, request_fingerprint, version, created_at, updated_at
        ) VALUES (?, 'guest', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_hold', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        bookingId, service.id, slot.id, service.name, service.duration_minutes, service.credit_cost,
        slot.starts_at, slot.ends_at, slot.resource_id, guestName, guestEmail, guestPhone, guestNotes,
        holdExpiresAt, requestOwner, idempotencyKey, requestFingerprint, nowIso, nowIso,
      )
      addEvent(bookingId, 'guest_hold_requested', nowIso, {
        toSlotId: slot.id,
        detail: { holdExpiresAt, paymentMode: 'manual' },
      })
      return bookingView(loadBooking(bookingId))
    })
  }

  function confirmGuest(bookingId, input) {
    const normalizedBookingId = identifier(bookingId, '預約識別')
    if (!input || typeof input !== 'object' || !['confirm', 'reject'].includes(input.action)) {
      fail(422, '訪客預約確認動作不正確')
    }
    const nowIso = iso(currentDate())
    return transaction(db, () => {
      expireGuestHolds(nowIso)
      let booking = loadBooking(normalizedBookingId)
      if (booking.kind !== 'guest') fail(409, '此預約不是訪客預約', 'BOOKING_KIND_MISMATCH')
      const desiredStatus = input.action === 'confirm' ? 'confirmed' : 'rejected'
      if (booking.status === desiredStatus) return bookingView(booking, { replayed: true })
      if (booking.status !== 'pending_hold') fail(409, '訪客保留已失效或已處理', 'GUEST_HOLD_NOT_ACTIVE')
      db.prepare(`
        UPDATE booking_records
        SET status = ?, hold_expires_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'pending_hold'
      `).run(desiredStatus, nowIso, booking.id)
      addEvent(booking.id, input.action === 'confirm' ? 'guest_confirmed' : 'guest_rejected', nowIso, {
        fromSlotId: input.action === 'reject' ? booking.slot_id : null,
        detail: { paymentMode: 'manual', paymentRecorded: false },
      })
      booking = loadBooking(booking.id)
      return bookingView(booking)
    })
  }

  return {
    timeZone,
    cancellationHours,
    guestHoldMinutes,
    listServices,
    saveService,
    listSlots,
    saveSlot,
    listBookings,
    reserve,
    change,
    adjustCredits,
    balance,
    requestGuest,
    confirmGuest,
  }
}
