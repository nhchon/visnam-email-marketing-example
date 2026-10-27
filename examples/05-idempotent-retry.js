// Minh họa Idempotency-Key: gửi lại cùng key không tạo thư mới; đổi nội dung thì bị 409.
// Chạy: npm run example:idempotency
// Ví dụ này chỉ tạo MỘT thư thật (tiêu 1 lượt).
import { idempotencyKeyFrom, VisnamApiError } from '../src/index.js';
import { createClient, requireEnv, run } from './_shared.js';

run(async () => {
  const client = createClient();
  // Key dẫn xuất từ định danh nghiệp vụ: chạy lại job với cùng đơn hàng sẽ ra đúng key cũ.
  const orderId = `order-${Date.now()}`;
  const idempotencyKey = idempotencyKeyFrom(`${orderId}:order-confirmation`);
  const payload = {
    senderId: requireEnv('VISNAM_SENDER_ID'),
    to: requireEnv('DEMO_RECIPIENT'),
    subject: `Xác nhận đơn hàng ${orderId}`,
    text: 'Cảm ơn bạn đã đặt hàng.',
    referenceId: orderId,
  };

  const first = await client.sendEmail(payload, { idempotencyKey });
  console.log(`Lần 1: messageId=${first.messageId}`);

  // Giả lập trường hợp không chắc request đầu đã thành công nên gửi lại.
  const second = await client.sendEmail(payload, { idempotencyKey });
  console.log(`Lần 2 (cùng key, cùng nội dung): messageId=${second.messageId}`);
  console.log(first.messageId === second.messageId
    ? '→ Cùng một thư: không gửi trùng, không trừ thêm lượt.'
    : '→ Khác messageId: không như mong đợi!');

  try {
    await client.sendEmail({ ...payload, subject: 'Nội dung đã bị sửa' }, { idempotencyKey });
  } catch (error) {
    if (error instanceof VisnamApiError && error.code === 'IDEMPOTENCY_CONFLICT') {
      console.log('Lần 3 (cùng key, nội dung khác): 409 IDEMPOTENCY_CONFLICT như mong đợi.');
      return;
    }
    throw error;
  }
  console.log('Lần 3 không bị từ chối: không như mong đợi!');
});
