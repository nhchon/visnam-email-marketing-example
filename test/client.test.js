import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VisnamEmailClient, VisnamApiError, withRetry, isRetryable, isEmailSettled,
  newIdempotencyKey, idempotencyKeyFrom, IDEMPOTENCY_KEY_PATTERN,
} from '../src/index.js';

const API_KEY = `vem_${'a'.repeat(43)}`;
const SENDER_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE = {
  messageId: '22222222-2222-4222-8222-222222222222', referenceId: null, to: 'khach@example.com',
  state: 'queued', creditState: 'reserved', deliveryState: 'pending', createdAt: '2026-10-27T00:00:00Z',
  acceptedAt: null, deliveredAt: null, bouncedAt: null, complainedAt: null, errorCode: null,
};

/** fetch giả: ghi lại mọi request và trả lần lượt các response đã chuẩn bị. */
function fakeFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), ...init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body, headers = {} } = next;
    return new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { fetchImpl, calls };
}

function createClient(fetchImpl) {
  return new VisnamEmailClient({ baseUrl: 'https://center.example.com/', apiKey: API_KEY, fetchImpl, sleep: async () => {} });
}

const payload = { senderId: SENDER_ID, to: 'khach@example.com', subject: 'Chào', text: 'Nội dung' };

test('từ chối API key sai định dạng ngay khi khởi tạo, tránh gửi request chắc chắn bị 401', () => {
  assert.throws(() => new VisnamEmailClient({ baseUrl: 'https://center.example.com', apiKey: 'sk_123' }), TypeError);
});

test('gửi email: kèm Bearer key, Idempotency-Key và JSON đúng đường dẫn Tenant API, nhận DTO 202', async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 202, body: MESSAGE });
  const result = await createClient(fetchImpl).sendEmail(payload, { idempotencyKey: 'order-1:confirm' });

  assert.deepEqual(result, MESSAGE);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.href, 'https://center.example.com/api/v1/email-marketing/emails');
  assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(call.headers['Idempotency-Key'], 'order-1:confirm');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.body), payload);
});

test('gửi email bắt buộc có Idempotency-Key hợp lệ, không để server trả 422 IDEMPOTENCY_KEY_REQUIRED', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const client = createClient(fetchImpl);
  assert.throws(() => client.sendEmail(payload), TypeError);
  assert.throws(() => client.sendEmail(payload, { idempotencyKey: 'có dấu cách' }), TypeError);
  assert.equal(calls.length, 0);
});

test('chặn tại máy subject có xuống dòng (chèn header), thiếu nội dung và quá 3 file đính kèm', () => {
  const client = createClient(fakeFetch().fetchImpl);
  const options = { idempotencyKey: 'k1' };
  assert.throws(() => client.sendEmail({ ...payload, subject: 'A\r\nBcc: x@example.com' }, options), /xuống dòng/);
  assert.throws(() => client.sendEmail({ ...payload, text: undefined }, options), /html hoặc text/);
  assert.throws(() => client.sendEmail({ ...payload, attachmentIds: ['a', 'b', 'c', 'd'] }, options), /tối đa 3/);
  assert.throws(() => client.sendEmail({ ...payload, attachmentIds: ['a', 'a'] }, options), /lặp/);
});

test('lỗi server được chuẩn hóa theo code: 409 IDEMPOTENCY_CONFLICT không được retry', async () => {
  const { fetchImpl } = fakeFetch({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
  const error = await createClient(fetchImpl).sendEmail(payload, { idempotencyKey: 'k1' }).catch((e) => e);
  assert.ok(error instanceof VisnamApiError);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(isRetryable(error), false);
});

test('422 VALIDATION_FAILED giữ nguyên danh sách issues để hiển thị cho người dùng', async () => {
  const issues = [{ path: ['to'], message: 'Invalid email' }];
  const { fetchImpl } = fakeFetch({ status: 422, body: { code: 'VALIDATION_FAILED', message: 'Dữ liệu không hợp lệ', issues } });
  const error = await createClient(fetchImpl).getUsage().catch((e) => e);
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.deepEqual(error.issues, issues);
});

test('429 đọc Retry-After; proxy trả HTML 502 vẫn ra lỗi có code; mất mạng ra status 0', async () => {
  const { fetchImpl } = fakeFetch(
    { status: 429, body: { code: 'API_RATE_LIMITED' }, headers: { 'Retry-After': '1' } },
    { status: 502, body: '<html>Bad Gateway</html>' },
    new TypeError('fetch failed'),
  );
  const client = createClient(fetchImpl);
  const limited = await client.getUsage().catch((e) => e);
  assert.equal(limited.retryAfterSeconds, 1);
  const gateway = await client.getUsage().catch((e) => e);
  assert.equal(gateway.code, 'HTTP_502');
  const offline = await client.getUsage().catch((e) => e);
  assert.equal(offline.status, 0);
  assert.equal(offline.code, 'NETWORK_ERROR');
  assert.ok([limited, gateway, offline].every(isRetryable));
});

test('withRetry gửi lại với CÙNG Idempotency-Key sau lỗi mạng và 429, để server không tạo thư trùng', async () => {
  const { fetchImpl, calls } = fakeFetch(
    new TypeError('socket hang up'),
    { status: 429, body: { code: 'API_RATE_LIMITED' }, headers: { 'Retry-After': '1' } },
    { status: 202, body: MESSAGE },
  );
  const client = createClient(fetchImpl);
  const delays = [];
  const key = newIdempotencyKey('test');
  const result = await withRetry(() => client.sendEmail(payload, { idempotencyKey: key }), {
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(result.messageId, MESSAGE.messageId);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.headers['Idempotency-Key']), [key, key, key]);
  assert.equal(delays[1], 1000, 'lần chờ sau 429 phải theo Retry-After');
});

test('withRetry dừng ngay với lỗi không tạm thời như hết lượt', async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 409, body: { code: 'INSUFFICIENT_CREDITS' } });
  const client = createClient(fetchImpl);
  await assert.rejects(withRetry(() => client.sendEmail(payload, { idempotencyKey: 'k1' }), { sleep: async () => {} }), { code: 'INSUFFICIENT_CREDITS' });
  assert.equal(calls.length, 1);
});

test('danh sách email không có total: duyệt trang dừng khi trang trả ít hơn pageSize', async () => {
  const page = (count) => ({ status: 200, body: { data: Array.from({ length: count }, (_, i) => ({ ...MESSAGE, messageId: String(i) })), page: 1, pageSize: 2 } });
  const { fetchImpl, calls } = fakeFetch(page(2), page(2), page(1));
  const items = [];
  for await (const item of createClient(fetchImpl).iterateEmails({ state: 'failed', pageSize: 2 })) items.push(item);

  assert.equal(items.length, 5);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.url.searchParams.get('page')), ['1', '2', '3']);
  assert.equal(calls[0].url.searchParams.get('state'), 'failed');
});

test('waitForEmail poll tới khi SES nhận thư; uncertain không được coi là kết thúc', async () => {
  const { fetchImpl, calls } = fakeFetch(
    { body: { ...MESSAGE, state: 'sending' } },
    { body: { ...MESSAGE, state: 'uncertain' } },
    { body: { ...MESSAGE, state: 'accepted', creditState: 'consumed' } },
  );
  const { message, settled } = await createClient(fetchImpl).waitForEmail(MESSAGE.messageId, { intervalMs: 1 });
  assert.equal(settled, true);
  assert.equal(message.state, 'accepted');
  assert.equal(calls.length, 3);
});

test('isEmailSettled: chờ giao thư thì accepted + pending chưa xong; failed/suppressed/manual_review là kết thúc', () => {
  assert.equal(isEmailSettled({ state: 'accepted', deliveryState: 'pending' }), true);
  assert.equal(isEmailSettled({ state: 'accepted', deliveryState: 'pending' }, true), false);
  assert.equal(isEmailSettled({ state: 'accepted', deliveryState: 'delivered' }, true), true);
  for (const state of ['failed', 'suppressed', 'manual_review']) assert.equal(isEmailSettled({ state }), true);
  for (const state of ['queued', 'sending', 'uncertain']) assert.equal(isEmailSettled({ state }), false);
});

test('upload file gửi multipart chỉ có một trường "file" kèm Idempotency-Key; 202 nghĩa là upload_pending', async () => {
  const file = { id: '33333333-3333-4333-8333-333333333333', state: 'upload_pending' };
  const { fetchImpl, calls } = fakeFetch({ status: 202, body: file });
  const result = await createClient(fetchImpl).uploadFile({ filename: 'bao-gia.pdf', data: Buffer.from('%PDF-1.4') }, { idempotencyKey: 'upload:1' });

  assert.deepEqual(result, { file, pending: true });
  const [call] = calls;
  assert.equal(call.url.pathname, '/api/v1/email-marketing/files');
  assert.equal(call.headers['Idempotency-Key'], 'upload:1');
  assert.equal(call.headers['Content-Type'], undefined, 'phải để fetch tự đặt boundary multipart');
  assert.deepEqual([...call.body.keys()], ['file']);
  const sent = call.body.get('file');
  assert.equal(sent.name, 'bao-gia.pdf');
  assert.equal(sent.type, 'application/pdf');
});

test('upload chặn tại máy định dạng không hỗ trợ và file rỗng', async () => {
  const client = createClient(fakeFetch().fetchImpl);
  await assert.rejects(client.uploadFile({ filename: 'a.docx', data: Buffer.from('x') }, { idempotencyKey: 'u1' }), TypeError);
  await assert.rejects(client.uploadFile({ filename: 'a.pdf', data: Buffer.alloc(0) }, { idempotencyKey: 'u1' }), TypeError);
});

test('key dẫn xuất từ định danh nghiệp vụ ổn định giữa các lần chạy và hợp lệ với server', () => {
  const first = idempotencyKeyFrom('order-1001:confirmation');
  assert.equal(first, idempotencyKeyFrom('order-1001:confirmation'));
  assert.notEqual(first, idempotencyKeyFrom('order-1002:confirmation'));
  assert.match(first, IDEMPOTENCY_KEY_PATTERN);
  assert.match(newIdempotencyKey(), IDEMPOTENCY_KEY_PATTERN);
});
