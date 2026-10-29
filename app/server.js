// App Express mẫu: trình duyệt gọi app này, app gọi Visnam bằng API key giữ ở server.
// Chạy: npm run app  →  mở http://localhost:3000
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VisnamEmailClient, VisnamApiError, MAX_FILE_BYTES, assertIdempotencyKey } from '../src/index.js';
import { verifyVisnamWebhook } from '../src/webhook.js';
import { storeWebhookEvent } from './webhook-inbox.js';

/**
 * Tạo app với một client đã cấu hình sẵn. Tách khỏi phần khởi động để kiểm thử
 * có thể truyền client giả mà không cần key thật.
 * @param {VisnamEmailClient} client
 */
export function createApp(client, { webhookSecret = process.env.VISNAM_WEBHOOK_SECRET, storeEvent = storeWebhookEvent } = {}) {
  const app = express();
  // Giữ file trong bộ nhớ rồi chuyển thẳng lên Visnam; giới hạn trùng với giới hạn phía server
  // để file quá lớn bị chặn ngay tại đây, không tốn băng thông gửi đi.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

  // Raw body phải được đọc trước express.json; ký lại JSON đã parse sẽ không còn khớp chữ ký.
  app.post('/webhooks/visnam', express.text({ type: 'application/json', limit: '64kb' }), async (req, res) => {
    if (!webhookSecret) return res.status(503).json({ code: 'WEBHOOK_SECRET_NOT_CONFIGURED' });
    let event;
    try { event = verifyVisnamWebhook(req.body, { signature: req.get('X-Visnam-Signature'), timestamp: req.get('X-Visnam-Timestamp') }, webhookSecret); }
    catch { return res.status(400).json({ code: 'WEBHOOK_INVALID' }); }
    try { await storeEvent(event); return res.status(200).json({ acknowledged: true }); }
    catch { return res.status(503).json({ code: 'WEBHOOK_INBOX_UNAVAILABLE' }); }
  });
  // Tổng JSON request tối đa 10 MiB như API Visnam; html và text có giới hạn riêng 1 MB/trường.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

  app.get('/api/account', async (req, res, next) => {
    try {
      const [usage, senders] = await Promise.all([client.getUsage(), client.listSenders()]);
      res.json({ usage, senders });
    } catch (error) { next(error); }
  });

  /**
   * Trình duyệt tạo Idempotency-Key một lần cho mỗi lần bấm "Gửi" và giữ nguyên khi bấm lại
   * sau lỗi mạng. App chuyển nguyên key đó lên Visnam, nên bấm gửi lại không tạo thư trùng.
   */
  app.post('/api/emails', async (req, res, next) => {
    try {
      const { idempotencyKey, senderId, to, subject, html, text, referenceId, attachmentIds } = req.body || {};
      const payload = { senderId, to, subject, html: html || undefined, text: text || undefined, referenceId: referenceId || undefined };
      if (Array.isArray(attachmentIds) && attachmentIds.length) payload.attachmentIds = attachmentIds;
      res.status(202).json(await client.sendEmail(payload, { idempotencyKey }));
    } catch (error) { next(error); }
  });

  app.get('/api/emails', async (req, res, next) => {
    try {
      const { state, referenceId, page, pageSize } = req.query;
      res.json(await client.listEmails({ state, referenceId, page, pageSize }));
    } catch (error) { next(error); }
  });

  app.get('/api/emails/:id', async (req, res, next) => {
    try { res.json(await client.getEmail(req.params.id)); } catch (error) { next(error); }
  });

  // Key upload đến từ header để tách khỏi phần multipart (server Visnam chỉ nhận đúng một trường `file`).
  app.post('/api/files', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw new TypeError('Chưa chọn file');
      const idempotencyKey = assertIdempotencyKey(req.get('Idempotency-Key'));
      const result = await client.uploadFile(
        { filename: req.file.originalname, contentType: req.file.mimetype, data: req.file.buffer },
        { idempotencyKey },
      );
      res.status(result.pending ? 202 : 201).json(result.file);
    } catch (error) { next(error); }
  });

  app.use(errorHandler);
  return app;
}

/**
 * Chuyển lỗi về JSON `{ code, message, issues }` cho trình duyệt.
 * Lỗi mạng tới Visnam (status 0) trả 502 để trình duyệt biết có thể bấm gửi lại với cùng key.
 * Không bao giờ đưa API key hay stack trace vào response.
 */
function errorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  // Lỗi parser xảy ra trước route/SDK: trả đúng 413 để workflow không nhầm là lỗi server cần retry.
  if (error.type === 'entity.too.large' && error.limit === 10 * 1024 * 1024) return res.status(413).json({ code: 'REQUEST_TOO_LARGE', message: 'Tổng JSON request vượt giới hạn 10 MiB.' });
  if (error instanceof VisnamApiError) {
    if (error.retryAfterSeconds != null) res.set('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status || 502).json({ code: error.code, message: error.message, issues: error.issues });
  }
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ code: tooLarge ? 'ATTACHMENT_TOO_LARGE' : 'BAD_UPLOAD', message: error.message });
  }
  if (error instanceof TypeError) return res.status(400).json({ code: 'BAD_REQUEST', message: error.message });
  console.error(error);
  return res.status(500).json({ code: 'INTERNAL_ERROR' });
}

// Chỉ khởi động server khi chạy trực tiếp file này (không khởi động khi bị import trong test).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const client = new VisnamEmailClient({ baseUrl: process.env.VISNAM_BASE_URL, apiKey: process.env.VISNAM_API_KEY });
  const port = Number(process.env.PORT) || 3000;
  createApp(client).listen(port, () => console.log(`App mẫu chạy tại http://localhost:${port}`));
}
