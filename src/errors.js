/**
 * Lỗi trả về từ Tenant API Email Marketing của Visnam Center.
 *
 * Server luôn trả body JSON dạng `{ code }`. Riêng lỗi validation thì trả
 * `{ code: 'VALIDATION_FAILED', message, issues: [{ path, message }] }`.
 * Hãy rẽ nhánh theo `code`, không theo `message`, vì message có thể thay đổi
 * mà không báo trước.
 */
export class VisnamApiError extends Error {
  /**
   * @param {object} init
   * @param {number} init.status Mã HTTP. Bằng 0 nếu request không tới được server (lỗi mạng hoặc timeout).
   * @param {string} init.code Mã lỗi nghiệp vụ, ví dụ `INSUFFICIENT_CREDITS`.
   * @param {string} [init.message]
   * @param {Array<{path: Array<string|number>, message: string}>} [init.issues]
   * @param {number|null} [init.retryAfterSeconds] Lấy từ header `Retry-After` của response 429.
   * @param {unknown} [init.cause]
   */
  constructor({ status, code, message, issues = [], retryAfterSeconds = null, cause }) {
    super(message || code, cause ? { cause } : undefined);
    this.name = 'VisnamApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Mã lỗi khi request không nhận được response: lỗi mạng, DNS hoặc hết thời gian chờ. */
export const NETWORK_ERROR = 'NETWORK_ERROR';

/**
 * Cho biết có nên gửi lại **cùng request với cùng Idempotency-Key** hay không.
 *
 * Được retry:
 * - Lỗi mạng hoặc timeout (status 0): ta không biết server đã nhận request hay chưa.
 *   Gửi lại cùng key là an toàn. Nếu server đã nhận thì sẽ trả lại đúng message cũ,
 *   không tạo thư mới và không trừ thêm lượt.
 * - 429 `API_RATE_LIMITED`: chờ theo `Retry-After` rồi gửi lại.
 * - 503: dịch vụ tạm thời không sẵn sàng.
 * - 502/504: lỗi từ proxy đứng trước server. Giống lỗi mạng, ta không biết request đã
 *   được xử lý hay chưa, nên chỉ được gửi lại với cùng key.
 *
 * Không retry: 4xx còn lại (401, 403, 404, 409, 413, 422). Gửi lại nguyên request
 * vẫn sẽ lỗi y hệt, cần sửa dữ liệu, cấu hình hoặc mua thêm lượt trước.
 * Lỗi dữ liệu do SDK chặn tại máy là `TypeError`, không phải `VisnamApiError`,
 * nên cũng không bao giờ được retry.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  if (!(error instanceof VisnamApiError)) return false;
  return [0, 429, 502, 503, 504].includes(error.status);
}
