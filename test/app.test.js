import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app/server.js';
import { VisnamApiError } from '../src/index.js';

/** Khởi động app trên cổng ngẫu nhiên với client giả, trả về base URL và hàm đóng. */
async function startApp(client) {
  const server = createApp(client).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('app chuyển nguyên Idempotency-Key của trình duyệt lên Visnam, để bấm Gửi lại không tạo thư trùng', async () => {
  const sent = [];
  const app = await startApp({ sendEmail: async (payload, options) => { sent.push({ payload, options }); return { messageId: 'm1' }; } });
  try {
    const response = await fetch(`${app.url}/api/emails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'web:1', senderId: 's1', to: 'a@example.com', subject: 'Hi', html: '<p>x</p>', text: '', attachmentIds: [] }),
    });
    assert.equal(response.status, 202);
    assert.equal(sent[0].options.idempotencyKey, 'web:1');
    // Trường rỗng từ form không được gửi lên, tránh server báo lỗi độ dài tối thiểu.
    assert.equal(sent[0].payload.text, undefined);
    assert.equal('attachmentIds' in sent[0].payload, false);
  } finally { await app.close(); }
});

test('lỗi Visnam được trả về trình duyệt theo code, giữ Retry-After; lỗi mạng tới Visnam thành 502', async () => {
  const errors = [
    new VisnamApiError({ status: 429, code: 'API_RATE_LIMITED', retryAfterSeconds: 1 }),
    new VisnamApiError({ status: 0, code: 'NETWORK_ERROR', message: 'fetch failed' }),
  ];
  const app = await startApp({ getEmail: async () => { throw errors.shift(); } });
  try {
    const limited = await fetch(`${app.url}/api/emails/x`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal((await limited.json()).code, 'API_RATE_LIMITED');

    const offline = await fetch(`${app.url}/api/emails/x`);
    assert.equal(offline.status, 502);
    assert.equal((await offline.json()).code, 'NETWORK_ERROR');
  } finally { await app.close(); }
});

test('upload qua app yêu cầu Idempotency-Key và chuyển đúng tên, loại, nội dung file', async () => {
  const uploads = [];
  const app = await startApp({
    uploadFile: async (file, options) => { uploads.push({ file, options }); return { file: { id: 'f1', state: 'ready' }, pending: false }; },
  });
  try {
    const body = new FormData();
    body.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'a.pdf');
    const missingKey = await fetch(`${app.url}/api/files`, { method: 'POST', body });
    assert.equal(missingKey.status, 400);

    const ok = await fetch(`${app.url}/api/files`, { method: 'POST', headers: { 'Idempotency-Key': 'web-upload:1' }, body });
    assert.equal(ok.status, 201);
    assert.equal(uploads[0].options.idempotencyKey, 'web-upload:1');
    assert.equal(uploads[0].file.filename, 'a.pdf');
    assert.equal(uploads[0].file.contentType, 'application/pdf');
    assert.equal(uploads[0].file.data.toString(), '%PDF-1.4');
  } finally { await app.close(); }
});

test('App mẫu chuyển nguyên nội dung 1 MB/trường qua parser JSON, chặn tổng request quá 10 MiB', async () => {
  let handled = 0;
  const content = 'ế'.repeat(333333) + 'x';
  const app = await startApp({ sendEmail: async payload => {
    handled++; assert.equal(payload.html, content); assert.equal(payload.text, content); return { messageId: 'large-content' };
  } });
  try {
    const send = body => fetch(`${app.url}/api/emails`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await send({ idempotencyKey: 'large-web:1', senderId: 's1', to: 'a@example.com', subject: 'Thử', html: content, text: content });
    assert.equal(ok.status, 202); await ok.json(); assert.equal(handled, 1);
    const tooLarge = await send({ html: 'a'.repeat(10 * 1024 * 1024 + 1) });
    assert.equal(tooLarge.status, 413); await tooLarge.json(); assert.equal(handled, 1);
  } finally { await app.close(); }
});
