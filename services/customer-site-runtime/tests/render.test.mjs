import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../lib/render.mjs';

const config = { siteId: 'site-1', siteType: 'commerce', preset: 'atelier', brandName: 'Lune & Co', tagline: 'A thoughtful home', description: 'Objects for daily rituals', hero: { title: 'A softer <morning>', description: 'Made with care' }, currency: 'TWD', mode: 'preview' };

test('renders distinct preset layouts and escapes merchant copy', () => {
  const atelier = renderPage({ config, path: '/' });
  const bloom = renderPage({ config: { ...config, preset: 'bloom' }, path: '/' });
  const alignment = renderPage({ config: { ...config, preset: 'alignment' }, path: '/' });
  assert.match(atelier, /hero-atelier/);
  assert.match(bloom, /hero-bloom/);
  assert.match(alignment, /hero-alignment/);
  assert.match(atelier, /A softer &lt;morning&gt;/);
  assert.match(atelier, /Lune &amp; Co/);
});

test('only requests and renders private admin data for an admin actor', () => {
  let orderCalls = 0;
  let bookingArgs;
  const commerce = { listProducts: ({ admin }) => [{ id: 'p1', name: admin ? 'Draft piece' : 'Public piece', slug: 'piece', priceMinor: 1000, stock: 3 }], listOrders: () => { orderCalls++; return [{ id: 'secret-order', number: 'ORDER-1' }]; } };
  const booking = { listServices: () => [], listSlots: () => [], listBookings: (...args) => { bookingArgs = args; return [{ serviceName: 'Private visit', memberId: 'person-1' }]; } };
  const blog = { list: ({ admin }) => [{ title: 'Story', slug: 'story', status: admin ? 'draft' : 'published', renderedBody: '<p>Safe</p>' }] };
  const publicHtml = renderPage({ config, path: '/admin', commerce, booking, blog, actor: { role: 'member', id: 'person-1' } });
  assert.equal(orderCalls, 0);
  assert.doesNotMatch(publicHtml, /secret-order|Private visit/);
  const adminHtml = renderPage({ config, path: '/admin', commerce, booking, blog, actor: { role: 'admin', id: 'admin-1', name: 'Ari' } });
  assert.equal(orderCalls, 1);
  assert.deepEqual(bookingArgs, [undefined]);
  assert.match(adminHtml, /secret-order/);
  assert.match(adminHtml, /Private visit/);
});

test('renders storefront, booking, journal, contact and safe administration controls', () => {
  const commerce = { listProducts: () => [{ id: 'p1', slug: 'vase', name: '<Vase>', priceMinor: 12900, stock: 2, images: ['javascript:alert(1)'] }], getProduct: () => ({ id: 'p1', slug: 'vase', name: 'Vase', priceMinor: 12900, stock: 2 }) };
  const booking = { listServices: () => [{ id: 's1', name: 'Consultation', priceMinor: 0, durationMinutes: 30 }], listSlots: () => [{ id: 'slot1', startsAt: '2026-10-10 10:00' }], listBookings: () => [] };
  const blog = { list: () => [{ id: 'b1', title: 'Notes', slug: 'notes', status: 'published' }], get: () => ({ title: 'Notes', renderedBody: '<p>Sanitized body</p>' }) };
  assert.match(renderPage({ config, path: '/shop', commerce }), /&lt;Vase&gt;/);
  assert.doesNotMatch(renderPage({ config, path: '/products/vase', commerce }), /javascript:alert/);
  assert.match(renderPage({ config: { ...config, siteType: 'booking_blog' }, path: '/book', booking }), /data-booking-form/);
  assert.match(renderPage({ config, path: '/journal/notes', blog }), /Sanitized body/);
  assert.match(renderPage({ config, path: '/contact' }), /data-contact-form/);
  const admin = renderPage({ config, path: '/admin', actor: { role: 'admin', name: 'A' }, commerce, booking, blog, members: [{ id: 'm1', email: 'member@example.test', balance: 4 }] });
  assert.match(admin, /data-media-upload/);
  assert.match(admin, /data-credit-form/);
  assert.match(admin, /data-contact-messages/);
});

test('renders local booking times and translates operational states', () => {
  const booking = {
    listServices: () => [{ id: 's1', name: '諮詢', durationMinutes: 30, creditCost: 1 }],
    listSlots: () => [{ id: 'slot1', startsAt: '2026-10-08T02:00:00.000Z', available: true }],
    listBookings: () => [{ id: 'b1', serviceName: '諮詢', startsAt: '2026-10-08T02:00:00.000Z', status: 'pending_hold', kind: 'guest' }],
  };
  const html = renderPage({ config: { ...config, siteType: 'booking_blog', booking: { timeZone: 'Asia/Taipei' } }, path: '/book', booking });
  assert.match(html, /10\/8（週四）.{0,4}10:00/);
  assert.match(html, /data-time-zone="Asia\/Taipei"/);
  const admin = renderPage({ config: { ...config, booking: { timeZone: 'Asia/Taipei' } }, path: '/admin', actor: { role: 'admin' }, booking, commerce: { listProducts: () => [], listOrders: () => [{ id: 'o1', paymentStatus: 'paid', fulfillmentStatus: 'shipped' }] } });
  assert.match(admin, /已付款 · 已出貨/);
  assert.match(admin, /等待商家確認/);
});
