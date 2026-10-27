import { VisnamApiError, NETWORK_ERROR, isRetryable } from './errors.js';
import { assertIdempotencyKey } from './idempotency.js';

/** Tiền tố chung của Tenant API. */
export const API_PREFIX = '/api/v1/email-marketing';

/** API key tenant: `vem_` + 43 ký tự base64url. Server chỉ lưu bản băm nên key chỉ hiện một lần khi tạo. */
const API_KEY_PATTERN = /^vem_[A-Za-z0-9_-]{43}$/;

/** Giới hạn khớp với validation phía server (`email-marketing.schemas.ts`). */
const MAX_BODY_BYTES = 60000;
const MAX_SUBJECT_LENGTH = 998;
const MAX_ATTACHMENTS = 3;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Loại file server nhận. Server kiểm tra cả đuôi tên file, Content-Type và chữ ký byte thật. */
const FILE_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

/**
 * Các `state` mà message sẽ không tự đổi tiếp nữa (trừ khi nhân viên Visnam đối soát thủ công).
 * - `failed`: SES từ chối rõ ràng, lượt đã giữ được hoàn lại (`creditState = released`).
 * - `suppressed`: người nhận nằm trong danh sách chặn tại thời điểm gửi.
 * - `manual_review`: kết quả gọi SES không rõ quá 24 giờ, chờ Visnam đối soát.
 * Riêng `accepted` được xử lý tách biệt trong `waitForEmail` vì còn chờ sự kiện giao thư.
 */
const SETTLED_STATES = new Set(['failed', 'suppressed', 'manual_review']);

/**
 * Client tối giản cho Tenant API Email Marketing của Visnam Center.
 *
 * Không dùng thư viện ngoài, chỉ cần `fetch`, `FormData` và `Blob` có sẵn từ Node 18.
 * Mọi request đều gửi `Authorization: Bearer <apiKey>`; mỗi endpoint cần một scope riêng
 * (ghi trong JSDoc của từng phương thức). Thiếu scope hoặc tenant chưa active thì nhận 403.
 *
 * API key cho phép gửi thư và tiêu lượt đã trả tiền. Chỉ dùng client này ở phía server,
 * không bao giờ nhúng key vào trình duyệt hay ứng dụng di động.
 */
export class VisnamEmailClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl Ví dụ `https://center.example.com` (không gồm `/api/...`).
   * @param {string} options.apiKey API key tenant dạng `vem_...`.
   * @param {typeof fetch} [options.fetchImpl] Truyền fetch giả khi kiểm thử.
   * @param {number} [options.timeoutMs] Thời gian chờ tối đa cho mỗi request.
   * @param {(ms: number) => Promise<void>} [options.sleep] Truyền hàm giả để test polling không phải chờ thật.
   */
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000, sleep = defaultSleep }) {
    if (!baseUrl) throw new TypeError('Thiếu baseUrl');
    if (!API_KEY_PATTERN.test(apiKey || '')) throw new TypeError('apiKey phải có dạng vem_ + 43 ký tự base64url');
    if (typeof fetchImpl !== 'function') throw new TypeError('Môi trường không có fetch, cần Node 18 trở lên');
    this.baseUrl = new URL(baseUrl).origin;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  // ---------------------------------------------------------------------------
  // Tài khoản
  // ---------------------------------------------------------------------------

  /**
   * Xem ví lượt gửi, hạn mức và dung lượng đính kèm. Scope `usage:read`.
   *
   * - `available`: lượt còn dùng được.
   * - `reserved`: lượt đang tạm giữ cho thư chưa có kết quả từ SES.
   * - `consumed`: lượt đã tiêu khi SES nhận thư.
   * - `attachmentStorage`: số **byte upload trả trước** (không phải dung lượng đang lưu).
   */
  getUsage() {
    return this.#json('GET', '/usage');
  }

  /**
   * Danh sách sender được cấp cho tenant. Scope `senders:read`.
   * Chỉ sender có `status = 'active'` mới dùng được để gửi; `senderId` là giá trị truyền vào `sendEmail`.
   * @returns {Promise<Array<{senderId: string, email: string, displayName: string, replyTo: string|null, status: string}>>}
   */
  listSenders() {
    return this.#json('GET', '/senders');
  }

  /**
   * Domain gửi thư và bản ghi DNS (DKIM) cần cấu hình. Scope `identities:read`.
   * Domain phải ở trạng thái đã xác minh thì sender thuộc domain đó mới gửi được.
   */
  listIdentities() {
    return this.#json('GET', '/identities');
  }

  // ---------------------------------------------------------------------------
  // Gửi và tra cứu email
  // ---------------------------------------------------------------------------

  /**
   * Gửi **một** email tới **một** người nhận. Scope `emails:send`.
   *
   * Server trả 202 ngay sau khi giữ 1 lượt và xếp thư vào hàng đợi; việc gọi SES diễn ra sau đó.
   * Muốn biết kết quả thì poll bằng `getEmail` hoặc `waitForEmail`, vì hệ thống không gọi
   * webhook về phía bạn.
   *
   * `idempotencyKey` là bắt buộc:
   * - Gửi lại cùng key và cùng nội dung: nhận lại đúng message cũ, không gửi trùng, không trừ thêm lượt.
   * - Cùng key nhưng nội dung khác: 409 `IDEMPOTENCY_CONFLICT`.
   * Vì vậy hãy tạo key **một lần cho mỗi thư** và giữ nguyên khi retry (xem `withRetry`).
   *
   * @param {object} payload
   * @param {string} payload.senderId UUID lấy từ `listSenders()`.
   * @param {string} payload.to Một địa chỉ người nhận.
   * @param {string} payload.subject 1–998 ký tự, không chứa xuống dòng.
   * @param {string} [payload.html] Cần `html` hoặc `text`; mỗi trường tối đa 60.000 byte UTF-8.
   * @param {string} [payload.text]
   * @param {string} [payload.referenceId] Mã của hệ thống bạn (tối đa 128 ký tự), dùng để lọc lại sau này.
   * @param {string[]} [payload.attachmentIds] Tối đa 3 file `ready` lấy từ `uploadFile`. Server không đính kèm
   *   MIME mà chèn link tải (hiệu lực 30 ngày) vào cuối thư.
   * @param {object} options
   * @param {string} options.idempotencyKey
   * @returns {Promise<EmailMessage>}
   */
  sendEmail(payload, { idempotencyKey } = {}) {
    assertIdempotencyKey(idempotencyKey);
    validateSendPayload(payload);
    return this.#json('POST', '/emails', { json: payload, idempotencyKey });
  }

  /**
   * Trạng thái mới nhất của một email. Scope `emails:read`.
   * Nếu thư có đính kèm, response có thêm `attachments[]`. ID không thuộc tenant trả 404 `MESSAGE_NOT_FOUND`.
   * @param {string} messageId
   * @returns {Promise<EmailMessage>}
   */
  getEmail(messageId) {
    return this.#json('GET', `/emails/${encodeURIComponent(messageId)}`);
  }

  /**
   * Một trang danh sách email. Scope `emails:read`. Response **không có `total`**.
   * @param {object} [filter]
   * @param {'queued'|'sending'|'accepted'|'failed'|'uncertain'|'manual_review'|'suppressed'} [filter.state]
   * @param {string} [filter.referenceId]
   * @param {string} [filter.from] Thời điểm ISO UTC, ví dụ `2026-10-01T00:00:00Z`.
   * @param {string} [filter.to]
   * @param {number} [filter.page] Từ 1, mặc định 1.
   * @param {number} [filter.pageSize] 1–100, mặc định 25.
   * @returns {Promise<{data: EmailMessage[], page: number, pageSize: number}>}
   */
  listEmails(filter = {}) {
    return this.#json('GET', '/emails', { query: filter });
  }

  /**
   * Duyệt qua mọi email khớp bộ lọc, tự chuyển trang.
   * Vì API không trả `total`, vòng lặp dừng khi một trang trả về ít hơn `pageSize` dòng.
   * @param {Parameters<VisnamEmailClient['listEmails']>[0]} [filter]
   * @returns {AsyncGenerator<EmailMessage>}
   */
  async *iterateEmails(filter = {}) {
    const pageSize = filter.pageSize || 100;
    for (let page = filter.page || 1; ; page += 1) {
      const result = await this.listEmails({ ...filter, page, pageSize });
      yield* result.data;
      if (result.data.length < pageSize) return;
    }
  }

  /**
   * Poll `getEmail` cho tới khi thư có kết quả rõ ràng hoặc hết thời gian chờ.
   *
   * Điều kiện dừng:
   * - `state` là `failed`, `suppressed` hoặc `manual_review`.
   * - `state = 'accepted'` (SES đã nhận thư, lượt đã bị tiêu). Nếu `untilDelivery = true` thì
   *   chờ thêm tới khi `deliveryState` khác `pending` (delivered, bounced, complained hoặc failed).
   *   Lưu ý `accepted` chỉ nghĩa là SES đã nhận, chưa chắc thư đã vào hộp thư.
   *
   * Thư ở trạng thái `uncertain` (gọi SES không rõ kết quả) **không được gửi lại bằng key mới**,
   * vì có thể người nhận đã nhận thư. Hàm này chỉ tiếp tục chờ; Visnam sẽ đối soát.
   *
   * @param {string} messageId
   * @param {object} [options]
   * @param {number} [options.intervalMs] Khoảng cách giữa hai lần poll. Đừng đặt quá dày vì mỗi tenant
   *   chỉ được 20 request/giây cho mọi endpoint cộng lại.
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.untilDelivery]
   * @returns {Promise<{message: EmailMessage, settled: boolean}>} `settled = false` khi hết thời gian chờ.
   */
  async waitForEmail(messageId, { intervalMs = 3000, timeoutMs = 120000, untilDelivery = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await this.getEmail(messageId);
      if (isEmailSettled(message, untilDelivery)) return { message, settled: true };
      if (Date.now() + intervalMs > deadline) return { message, settled: false };
      await this.sleep(intervalMs);
    }
  }

  // ---------------------------------------------------------------------------
  // File đính kèm
  // ---------------------------------------------------------------------------

  /**
   * Upload một file PDF/JPG/PNG (tối đa 10 MiB) để đính kèm khi gửi. Scope `files:write`.
   *
   * Tenant phải có gói dung lượng (chưa có: 403 `ATTACHMENT_PLAN_REQUIRED`; thiếu byte:
   * 409 `ATTACHMENT_STORAGE_INSUFFICIENT`). Byte đã upload bị trừ ngay cả khi sau đó xóa file.
   *
   * Server trả 201 khi file đã sẵn sàng (`state = 'ready'`), hoặc 202 khi đang đối soát
   * (`state = 'upload_pending'`). Với 202, gọi `waitForFile` trước khi dùng `id` để gửi.
   * Cũng như gửi thư, `idempotencyKey` cho phép retry upload mà không bị trừ dung lượng hai lần.
   * File chưa được gửi sẽ hết hạn sau 30 ngày; mỗi file chỉ gắn được vào một email.
   *
   * @param {object} file
   * @param {string} file.filename Tên có đuôi `.pdf`, `.jpg`, `.jpeg` hoặc `.png`.
   * @param {Uint8Array|Blob} file.data
   * @param {string} [file.contentType] Bỏ trống thì suy ra từ đuôi tên file.
   * @param {object} options
   * @param {string} options.idempotencyKey
   * @returns {Promise<{file: EmailFile, pending: boolean}>}
   */
  async uploadFile({ filename, data, contentType }, { idempotencyKey } = {}) {
    assertIdempotencyKey(idempotencyKey);
    const type = contentType || FILE_TYPES[String(filename).split('.').pop().toLowerCase()];
    if (!filename || !type || !Object.values(FILE_TYPES).includes(type)) throw new TypeError('Chỉ nhận file .pdf, .jpg, .jpeg hoặc .png');
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    if (blob.size === 0 || blob.size > MAX_FILE_BYTES) throw new TypeError('File phải lớn hơn 0 và tối đa 10 MiB');
    // Server yêu cầu đúng một trường multipart tên `file`, không kèm trường nào khác.
    const form = new FormData();
    form.append('file', new Blob([blob], { type }), filename);
    const { status, body } = await this.#request('POST', '/files', { form, idempotencyKey });
    return { file: body, pending: status === 202 };
  }

  /** Metadata của một file. Scope `files:read`. */
  getFile(fileId) {
    return this.#json('GET', `/files/${encodeURIComponent(fileId)}`);
  }

  /**
   * Danh sách file. Scope `files:read`. Khác danh sách email, response này **có `total`**.
   * @param {{state?: string, page?: number, pageSize?: number}} [filter]
   * @returns {Promise<{data: EmailFile[], total: number, page: number, pageSize: number}>}
   */
  listFiles(filter = {}) {
    return this.#json('GET', '/files', { query: filter });
  }

  /**
   * Thu hồi file: link tải mới bị chặn ngay, object trên S3 được xóa sau. Scope `files:write`.
   * Dung lượng đã tiêu không được hoàn lại.
   */
  deleteFile(fileId) {
    return this.#json('DELETE', `/files/${encodeURIComponent(fileId)}`);
  }

  /**
   * Chờ file rời trạng thái `upload_pending`. Kết quả thường là `ready`; nếu là `upload_failed`
   * thì cần upload lại với Idempotency-Key mới.
   * @returns {Promise<{file: EmailFile, settled: boolean}>}
   */
  async waitForFile(fileId, { intervalMs = 2000, timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const file = await this.getFile(fileId);
      if (file.state !== 'upload_pending') return { file, settled: true };
      if (Date.now() + intervalMs > deadline) return { file, settled: false };
      await this.sleep(intervalMs);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  async #json(method, path, options) {
    return (await this.#request(method, path, options)).body;
  }

  /**
   * Gửi một request và chuẩn hóa mọi lỗi về `VisnamApiError`.
   * Không tự retry ở đây: việc retry phải do nơi gọi quyết định để chắc chắn dùng lại cùng
   * Idempotency-Key (xem `withRetry`).
   */
  async #request(method, path, { query, json, form, idempotencyKey } = {}) {
    const url = new URL(API_PREFIX + path, this.baseUrl);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      // Không tự đặt Content-Type: fetch sẽ tạo `multipart/form-data` kèm boundary.
      body = form;
    }

    let response;
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      // Không có response nghĩa là không biết server đã xử lý hay chưa (status 0 → được retry cùng key).
      throw new VisnamApiError({ status: 0, code: NETWORK_ERROR, message: `Không gọi được ${method} ${url.pathname}: ${cause.message}`, cause });
    }

    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* Proxy có thể trả trang HTML khi lỗi 502/504. */ }
    if (response.ok) return { status: response.status, body: parsed };
    throw new VisnamApiError({
      status: response.status,
      code: parsed?.code || `HTTP_${response.status}`,
      message: parsed?.message,
      issues: parsed?.issues,
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    });
  }
}

/**
 * Chạy lại `operation` khi gặp lỗi tạm thời (`isRetryable`), có backoff tăng dần.
 *
 * Quan trọng: tạo Idempotency-Key **bên ngoài** `operation` để mọi lần thử dùng chung một key:
 *
 * ```js
 * const key = newIdempotencyKey('welcome');
 * const message = await withRetry(() => client.sendEmail(payload, { idempotencyKey: key }));
 * ```
 *
 * Nếu lần thử đầu đã tới server nhưng mất response, lần thử sau nhận lại đúng message đó.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.retries] Số lần thử lại tối đa (không tính lần đầu).
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(info: {attempt: number, delayMs: number, error: unknown}) => void} [options.onRetry]
 * @returns {Promise<T>}
 */
export async function withRetry(operation, { retries = 4, baseDelayMs = 500, maxDelayMs = 10000, sleep = defaultSleep, onRetry } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      // 429 có Retry-After thì tôn trọng giá trị server; còn lại dùng backoff lũy thừa có jitter
      // để nhiều tiến trình không cùng lúc dồn request trở lại.
      const delayMs = error.retryAfterSeconds != null
        ? error.retryAfterSeconds * 1000
        : Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + Math.random() / 2);
      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}

/**
 * Thư đã có kết quả cuối cùng chưa (xem điều kiện trong `waitForEmail`).
 * @param {EmailMessage} message
 * @param {boolean} [untilDelivery]
 */
export function isEmailSettled(message, untilDelivery = false) {
  if (SETTLED_STATES.has(message.state)) return true;
  if (message.state !== 'accepted') return false;
  return !untilDelivery || message.deliveryState !== 'pending';
}

/** Kiểm tra sớm các lỗi phổ biến; server vẫn là nơi validate cuối cùng. */
function validateSendPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new TypeError('payload phải là object');
  const { senderId, to, subject, html, text, attachmentIds } = payload;
  if (!senderId) throw new TypeError('Thiếu senderId');
  if (!to || typeof to !== 'string' || to.includes(',')) throw new TypeError('`to` phải là đúng một địa chỉ email');
  if (typeof subject !== 'string' || !subject.trim() || subject.length > MAX_SUBJECT_LENGTH) throw new TypeError('subject phải có 1–998 ký tự');
  // Chặn CR/LF/NUL để không thể chèn thêm header vào email.
  if (/[\r\n\0]/.test(subject)) throw new TypeError('subject không được chứa ký tự xuống dòng');
  if (!html && !text) throw new TypeError('Cần html hoặc text');
  for (const [name, value] of [['html', html], ['text', text]]) {
    if (value !== undefined && Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES) throw new TypeError(`${name} vượt quá 60.000 byte`);
  }
  if (attachmentIds !== undefined) {
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS) throw new TypeError('attachmentIds tối đa 3 phần tử');
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new TypeError('attachmentIds không được lặp');
  }
}

/** `Retry-After` có thể là số giây hoặc một mốc thời gian HTTP. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {object} EmailMessage
 * @property {string} messageId
 * @property {string|null} referenceId
 * @property {string} to
 * @property {'queued'|'sending'|'accepted'|'failed'|'uncertain'|'manual_review'|'suppressed'} state
 *   Vòng đời xử lý: queued → sending → accepted | failed. `uncertain`: gọi SES không rõ kết quả;
 *   sau 24 giờ chưa rõ thì chuyển `manual_review`.
 * @property {'reserved'|'consumed'|'released'} creditState
 *   Lượt bị giữ khi nhận yêu cầu, chỉ bị tiêu khi SES nhận thư, và được hoàn nếu thư không gửi được.
 * @property {'pending'|'delivered'|'bounced'|'complained'|'failed'} deliveryState
 * @property {string} createdAt
 * @property {string|null} acceptedAt
 * @property {string|null} deliveredAt
 * @property {string|null} bouncedAt
 * @property {string|null} complainedAt
 * @property {string|null} errorCode
 * @property {Array<object>} [attachments] Chỉ có ở `getEmail` khi thư có đính kèm.
 */

/**
 * @typedef {object} EmailFile
 * @property {string} id
 * @property {string} tenantId
 * @property {string} filename
 * @property {string} contentType
 * @property {number} sizeBytes
 * @property {'upload_pending'|'ready'|'delete_pending'|'deleted'|'upload_failed'} state
 * @property {string} creditState
 * @property {string|null} messageId Email đã dùng file này, `null` nếu chưa gửi.
 * @property {string|null} firstSentAt
 * @property {string} expiresAt
 * @property {string} createdAt
 * @property {string|null} errorCode
 */
