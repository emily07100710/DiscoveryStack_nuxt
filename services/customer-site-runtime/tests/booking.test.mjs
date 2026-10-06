import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createBooking } from '../lib/booking.mjs'

function fixture(start = '2026-10-01T00:00:00.000Z') {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  let now = new Date(start)
  const booking = createBooking(db, {
    booking: {
      cancellationHours: 24,
      holdMinutes: 30,
      timeZone: 'Asia/Taipei',
    },
    now: () => now,
  })
  return {
    db,
    booking,
    setNow(value) { now = new Date(value) },
  }
}

function addServiceAndSlot(booking, {
  serviceId = 'svc-yoga',
  serviceName = '私人瑜珈',
  durationMinutes = 60,
  creditCost = 2,
  slotId = 'slot-one',
  resourceId = 'room-a',
  startsAt = '2026-10-03T02:00:00.000Z',
} = {}) {
  const service = booking.saveService({
    id: serviceId,
    name: serviceName,
    durationMinutes,
    creditCost,
    active: true,
  })
  const slot = booking.saveSlot({ id: slotId, serviceId, resourceId, startsAt, active: true })
  return { service, slot }
}

function assertError(error, status, code) {
  assert.equal(error?.status, status)
  assert.equal(error?.code, code)
  return true
}

test('services and capacity-one slots are configurable but overlapping resources fail closed', t => {
  const { db, booking } = fixture()
  t.after(() => db.close())

  const { service, slot } = addServiceAndSlot(booking)
  assert.equal(service.name, '私人瑜珈')
  assert.equal(service.durationMinutes, 60)
  assert.equal(service.creditCost, 2)
  assert.equal(slot.capacity, 1)
  assert.equal(slot.endsAt, '2026-10-03T03:00:00.000Z')
  assert.equal(slot.available, true)
  assert.equal(booking.timeZone, 'Asia/Taipei')

  booking.saveService({ id: 'svc-pilates', name: '皮拉提斯', durationMinutes: 45, creditCost: 1 })
  assert.throws(
    () => booking.saveSlot({
      id: 'slot-overlap',
      serviceId: 'svc-pilates',
      resourceId: 'room-a',
      startsAt: '2026-10-03T02:30:00.000Z',
    }),
    error => assertError(error, 409, 'RESOURCE_TIME_CONFLICT'),
  )
  assert.throws(
    () => booking.saveSlot({
      id: 'slot-capacity',
      serviceId: 'svc-pilates',
      resourceId: 'room-b',
      startsAt: '2026-10-03T02:30:00.000Z',
      capacity: 2,
    }),
    error => assertError(error, 422, 'UNSUPPORTED_CAPACITY'),
  )
  assert.throws(
    () => booking.saveService({ ...service, durationMinutes: 90, version: service.version }),
    error => assertError(error, 409, 'SERVICE_DURATION_IN_USE'),
  )

  booking.saveService({ id: 'svc-hidden', name: '尚未開放', durationMinutes: 30, creditCost: 1, active: false })
  booking.saveSlot({
    id: 'slot-hidden', serviceId: 'svc-hidden', resourceId: 'room-hidden',
    startsAt: '2026-10-03T02:00:00.000Z', active: true,
  })
  assert.equal(booking.listServices().some(row => row.id === 'svc-hidden'), false)
  assert.equal(booking.listServices({ admin: true }).some(row => row.id === 'svc-hidden'), true)
  assert.equal(booking.listSlots().some(row => row.id === 'slot-hidden'), false)
  assert.equal(booking.listSlots({ admin: true }).some(row => row.id === 'slot-hidden'), true)
})

test('credit ledger is non-negative and idempotency keys cannot be replayed with changed input', t => {
  const { db, booking } = fixture()
  t.after(() => db.close())

  const first = booking.adjustCredits('member-a', { delta: 3, reason: '購買三堂', idempotencyKey: 'credit-1' })
  assert.equal(first.balance, 3)
  assert.equal(first.replayed, false)
  const replay = booking.adjustCredits('member-a', { delta: 3, reason: '購買三堂', idempotencyKey: 'credit-1' })
  assert.equal(replay.balance, 3)
  assert.equal(replay.ledgerId, first.ledgerId)
  assert.equal(replay.replayed, true)
  assert.deepEqual(booking.balance('member-a'), { memberId: 'member-a', balance: 3 })

  assert.throws(
    () => booking.adjustCredits('member-a', { delta: 4, reason: '不同異動', idempotencyKey: 'credit-1' }),
    error => assertError(error, 409, 'IDEMPOTENCY_CONFLICT'),
  )
  assert.throws(
    () => booking.adjustCredits('member-a', { delta: -4, reason: '超額扣除', idempotencyKey: 'credit-2' }),
    error => assertError(error, 409, 'INSUFFICIENT_CREDITS'),
  )
  assert.equal(booking.balance('member-a').balance, 3)
})

test('member reservation debits the server-owned price once and the slot has one occupant', t => {
  const { db, booking } = fixture()
  t.after(() => db.close())
  addServiceAndSlot(booking)
  booking.adjustCredits('member-a', { delta: 3, reason: '開帳', idempotencyKey: 'm-a-credit' })
  booking.adjustCredits('member-b', { delta: 3, reason: '開帳', idempotencyKey: 'm-b-credit' })

  const reserved = booking.reserve('member-a', {
    serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'reserve-one',
  })
  assert.equal(reserved.status, 'confirmed')
  assert.equal(reserved.service.creditCost, 2)
  assert.equal(booking.balance('member-a').balance, 1)
  const replay = booking.reserve('member-a', {
    serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'reserve-one',
  })
  assert.equal(replay.id, reserved.id)
  assert.equal(replay.replayed, true)
  assert.equal(booking.balance('member-a').balance, 1)
  assert.equal(booking.listSlots()[0].available, false)

  assert.throws(
    () => booking.reserve('member-b', {
      serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'reserve-two',
    }),
    error => assertError(error, 409, 'SLOT_UNAVAILABLE'),
  )
  assert.throws(
    () => booking.reserve('member-a', {
      serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'unsafe-paid', paid: true,
    }),
    error => assertError(error, 422, 'PAYMENT_STATE_NOT_ACCEPTED'),
  )
  assert.equal(booking.balance('member-b').balance, 3)
})

test('cancellation refunds once before the server cutoff and never refunds late cancellation', t => {
  const first = fixture()
  t.after(() => first.db.close())
  addServiceAndSlot(first.booking)
  first.booking.adjustCredits('member-a', { delta: 3, reason: '開帳', idempotencyKey: 'credit' })
  const reserved = first.booking.reserve('member-a', {
    serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'reserve',
  })
  const cancelled = first.booking.change('member-a', reserved.id, { action: 'cancel' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.refundCredits, 2)
  assert.equal(first.booking.balance('member-a').balance, 3)
  const replay = first.booking.change('member-a', reserved.id, { action: 'cancel' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.refundCredits, 2)
  assert.equal(first.booking.balance('member-a').balance, 3)

  const late = fixture()
  t.after(() => late.db.close())
  addServiceAndSlot(late.booking)
  late.booking.adjustCredits('member-b', { delta: 3, reason: '開帳', idempotencyKey: 'credit' })
  const lateReservation = late.booking.reserve('member-b', {
    serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'reserve',
  })
  late.setNow('2026-10-03T01:00:01.000Z')
  const lateCancellation = late.booking.change('member-b', lateReservation.id, { action: 'cancel' })
  assert.equal(lateCancellation.refundCredits, 0)
  assert.equal(late.booking.balance('member-b').balance, 1)
})

test('reschedule is atomic, preserves credits, and rejects occupied targets', t => {
  const { db, booking } = fixture()
  t.after(() => db.close())
  addServiceAndSlot(booking)
  booking.saveSlot({
    id: 'slot-two', serviceId: 'svc-yoga', resourceId: 'room-a', startsAt: '2026-10-04T02:00:00.000Z',
  })
  booking.saveSlot({
    id: 'slot-three', serviceId: 'svc-yoga', resourceId: 'room-a', startsAt: '2026-10-05T02:00:00.000Z',
  })
  booking.adjustCredits('member-a', { delta: 3, reason: '開帳', idempotencyKey: 'a-credit' })
  booking.adjustCredits('member-b', { delta: 3, reason: '開帳', idempotencyKey: 'b-credit' })
  const first = booking.reserve('member-a', {
    serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'a-reserve',
  })
  booking.reserve('member-b', {
    serviceId: 'svc-yoga', slotId: 'slot-two', idempotencyKey: 'b-reserve',
  })

  assert.throws(
    () => booking.change('member-a', first.id, { action: 'reschedule', slotId: 'slot-two' }),
    error => assertError(error, 409, 'SLOT_UNAVAILABLE'),
  )
  assert.equal(booking.listBookings('member-a')[0].slotId, 'slot-one')
  const changed = booking.change('member-a', first.id, { action: 'reschedule', slotId: 'slot-three' })
  assert.equal(changed.slotId, 'slot-three')
  assert.equal(booking.balance('member-a').balance, 1)
  const replay = booking.change('member-a', first.id, { action: 'reschedule', slotId: 'slot-three' })
  assert.equal(replay.replayed, true)
})

test('guest requests are manual-payment holds; expiry and rejection release capacity', t => {
  const { db, booking, setNow } = fixture()
  t.after(() => db.close())
  addServiceAndSlot(booking)
  booking.saveSlot({
    id: 'slot-two', serviceId: 'svc-yoga', resourceId: 'room-a', startsAt: '2026-10-04T02:00:00.000Z',
  })

  const request = booking.requestGuest({
    serviceId: 'svc-yoga',
    slotId: 'slot-one',
    name: '王小美',
    email: 'mei@example.com',
    phone: '+886 912 345 678',
    notes: '第一次體驗',
    idempotencyKey: 'guest-one',
  })
  assert.equal(request.status, 'pending_hold')
  assert.equal(request.paymentMode, 'manual')
  assert.equal(request.paymentStatus, 'manual_required')
  assert.equal(booking.listSlots().find(slot => slot.id === 'slot-one').available, false)
  assert.equal(booking.requestGuest({
    serviceId: 'svc-yoga', slotId: 'slot-one', name: '王小美', email: 'mei@example.com',
    phone: '+886 912 345 678', notes: '第一次體驗', idempotencyKey: 'guest-one',
  }).id, request.id)

  const rejected = booking.requestGuest({
    serviceId: 'svc-yoga', slotId: 'slot-two', name: '陳先生', email: 'chen@example.com',
    phone: '0912-000-000', idempotencyKey: 'guest-two',
  })
  assert.equal(booking.confirmGuest(rejected.id, { action: 'reject' }).status, 'rejected')
  assert.equal(booking.listSlots().find(slot => slot.id === 'slot-two').available, true)

  setNow('2026-10-01T00:31:00.000Z')
  assert.equal(booking.listSlots().find(slot => slot.id === 'slot-one').available, true)
  assert.equal(booking.listBookings().find(row => row.id === request.id).status, 'expired')
  assert.equal(booking.listBookings('member-a').some(row => row.kind === 'guest'), false)
  assert.throws(
    () => booking.confirmGuest(request.id, { action: 'confirm' }),
    error => assertError(error, 409, 'GUEST_HOLD_NOT_ACTIVE'),
  )
})

test('member booking lists are owner-scoped while the no-argument admin view sees all', t => {
  const { db, booking } = fixture()
  t.after(() => db.close())
  addServiceAndSlot(booking)
  booking.saveSlot({
    id: 'slot-two', serviceId: 'svc-yoga', resourceId: 'room-a', startsAt: '2026-10-04T02:00:00.000Z',
  })
  for (const member of ['member-a', 'member-b']) {
    booking.adjustCredits(member, { delta: 2, reason: '開帳', idempotencyKey: `${member}-credit` })
  }
  booking.reserve('member-a', { serviceId: 'svc-yoga', slotId: 'slot-one', idempotencyKey: 'a' })
  booking.reserve('member-b', { serviceId: 'svc-yoga', slotId: 'slot-two', idempotencyKey: 'b' })
  assert.deepEqual(booking.listBookings('member-a').map(row => row.memberId), ['member-a'])
  assert.deepEqual(booking.listBookings('member-b').map(row => row.memberId), ['member-b'])
  assert.equal(booking.listBookings().length, 2)
})
