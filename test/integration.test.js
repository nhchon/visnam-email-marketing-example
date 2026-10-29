import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { VisnamEmailClient, verifyVisnamWebhook } from '../src/index.js';
import { createApp } from '../app/server.js';
const secret = 'vwh_' + 'A'.repeat(43), timestamp = String(Math.floor(Date.now() / 1000));
const payload = JSON.stringify({ eventId: '11111111-1111-4111-8111-111111111111', type: 'email.delivered', test: true, data: { messageId: null } });
const sign = body => 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
test('Xác minh chữ ký raw body, từ chối body bị sửa, secret sai và request quá hạn', () => {
  assert.equal(verifyVisnamWebhook(payload, { timestamp, signature: sign(payload) }, secret).test, true);
  assert.throws(() => verifyVisnamWebhook(payload + ' ', { timestamp, signature: sign(payload) }, secret));
  assert.throws(() => verifyVisnamWebhook(payload, { timestamp, signature: sign(payload) }, 'vwh_' + 'B'.repeat(43)));
  assert.throws(() => verifyVisnamWebhook(payload, { timestamp, signature: sign(payload) }, secret, { now: Date.now() + 601000 }));
});
test('SDK giữ đường dẫn, scope hợp đồng và key riêng cho từng mục của lô', async () => {
  const calls = [], client = new VisnamEmailClient({ baseUrl: 'https://center.example.com', apiKey: 'vem_' + 'A'.repeat(43), fetchImpl: async (url, options) => { calls.push({ path: String(url), ...options }); return new Response('{}', { status: 200 }); } });
  await client.saveWebhook({ url: 'https://app.example.com/webhooks/visnam', events: ['email.delivered'] });
  await client.simulateEvent({ type: 'email.bounced' });
  await client.getReport({ from: '2026-10-28T00:00:00Z', to: '2026-10-29T00:00:00Z' });
  await client.sendTemplate('sample', { version: 1, variables: { name: 'Bạn' } }, { idempotencyKey: 'stable' });
  await client.sendBatch([{ idempotencyKey: 'one', message: {} }, { idempotencyKey: 'two', message: {} }]);
  assert.equal(calls[0].method, 'PUT'); assert.match(calls[1].path, /sandbox\/events$/); assert.match(calls[2].path, /reports\?from=/);
  assert.equal(calls[3].headers['Idempotency-Key'], 'stable'); assert.deepEqual(JSON.parse(calls[4].body).items.map(row => row.idempotencyKey), ['one', 'two']);
});
test('Receiver lưu inbox trước 200; lỗi lưu trả 503 để Visnam retry, chữ ký sai không gọi inbox', async () => {
  let stored = 0, fail = false;
  const app = createApp({}, { webhookSecret: secret, storeEvent: async event => { assert.equal(event.test, true); if (fail) throw new Error('DB lỗi'); stored++; } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/webhooks/visnam`;
    const send = signature => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Visnam-Timestamp': timestamp, 'X-Visnam-Signature': signature }, body: payload });
    assert.equal((await send(sign(payload))).status, 200); assert.equal(stored, 1);
    assert.equal((await send('invalid')).status, 400); assert.equal(stored, 1);
    fail = true; assert.equal((await send(sign(payload))).status, 503); assert.equal(stored, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
