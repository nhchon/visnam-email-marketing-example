import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Xác minh raw body trước JSON.parse. Timestamp mỗi lần giao có hiệu lực 5 phút;
 * timestamp không thay thế chống trùng nghiệp vụ: lưu eventId bền vững trước khi trả 2xx.
 */
export function verifyVisnamWebhook(rawBody, { signature, timestamp }, secret, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > 65536 || typeof secret !== 'string' || !/^vwh_[A-Za-z0-9_-]{43}$/.test(secret) ||
    typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds || typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature)) {
    throw new TypeError('Chữ ký hoặc thời gian webhook không hợp lệ');
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) throw new TypeError('Chữ ký webhook không hợp lệ');
  const event = JSON.parse(rawBody);
  if (!event || typeof event !== 'object' || typeof event.eventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(event.eventId) || typeof event.type !== 'string' || typeof event.test !== 'boolean' || !event.data) throw new TypeError('Payload webhook không hợp lệ');
  return event;
}
