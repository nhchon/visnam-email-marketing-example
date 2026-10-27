import { createHash, randomUUID } from 'node:crypto';

/** Định dạng Idempotency-Key server chấp nhận: 1–128 ký tự chữ, số, `.`, `_`, `:`, `-`. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Tạo key ngẫu nhiên cho **một thao tác gửi mới**.
 *
 * Phải tạo key một lần, lưu lại cùng thao tác (ví dụ trong bảng outbox hoặc session),
 * rồi dùng lại đúng key đó mỗi khi retry. Nếu mỗi lần retry lại sinh key mới, server
 * sẽ coi đó là các thư khác nhau: người nhận nhận trùng và tài khoản bị trừ nhiều lượt.
 *
 * @param {string} [prefix] Tiền tố để dễ tra log, ví dụ `invoice`.
 * @returns {string}
 */
export function newIdempotencyKey(prefix = 'send') {
  return assertIdempotencyKey(`${prefix}:${randomUUID()}`);
}

/**
 * Dẫn xuất key cố định từ định danh nghiệp vụ, ví dụ `order-1001:invoice-email`.
 *
 * Phù hợp khi hệ thống của bạn đã có định danh duy nhất cho mỗi thư cần gửi: chạy lại
 * job cũng ra đúng key cũ, nên không cần lưu key riêng. Định danh được băm SHA-256
 * để key luôn hợp lệ và không làm lộ dữ liệu nghiệp vụ trong header.
 *
 * @param {string} businessId
 * @returns {string}
 */
export function idempotencyKeyFrom(businessId) {
  if (typeof businessId !== 'string' || !businessId.trim()) throw new TypeError('businessId phải là chuỗi khác rỗng');
  return `biz:${createHash('sha256').update(businessId.trim()).digest('hex')}`;
}

/**
 * Kiểm tra key trước khi gửi, để báo lỗi ngay tại máy thay vì nhận 422 từ server.
 * @param {string} key
 * @returns {string} Chính key đó nếu hợp lệ.
 */
export function assertIdempotencyKey(key) {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new TypeError('Idempotency-Key phải có 1–128 ký tự A–Z, a–z, 0–9, ".", "_", ":" hoặc "-"');
  }
  return key;
}
