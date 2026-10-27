// Gửi một email rồi poll tới khi có kết quả.
// Chạy: npm run example:send -- [người-nhận]
// Mỗi lần chạy tạo một thư mới và tiêu 1 lượt thật khi SES nhận thư.
import { newIdempotencyKey, withRetry } from '../src/index.js';
import { createClient, requireEnv, run } from './_shared.js';

run(async () => {
  const client = createClient();
  const to = process.argv[2] || requireEnv('DEMO_RECIPIENT');
  const referenceId = `demo-${Date.now()}`;

  // Key được tạo MỘT lần cho thư này. withRetry gọi lại hàm bên dưới với cùng key, nên dù
  // response đầu bị mất giữa đường thì server vẫn chỉ tạo một thư.
  const idempotencyKey = newIdempotencyKey('demo');
  const accepted = await withRetry(
    () => client.sendEmail({
      senderId: requireEnv('VISNAM_SENDER_ID'),
      to,
      subject: 'Xin chào từ Visnam Email Marketing',
      html: '<p>Đây là thư thử nghiệm gửi qua <strong>Tenant API</strong>.</p>',
      text: 'Đây là thư thử nghiệm gửi qua Tenant API.',
      referenceId,
    }, { idempotencyKey }),
    { onRetry: ({ attempt, delayMs, error }) => console.log(`Thử lại lần ${attempt} sau ${Math.round(delayMs)}ms (${error.code})`) },
  );
  console.log(`Đã xếp hàng: messageId=${accepted.messageId}, state=${accepted.state}, creditState=${accepted.creditState}`);

  console.log('Đang chờ kết quả...');
  const { message, settled } = await client.waitForEmail(accepted.messageId, { untilDelivery: true, timeoutMs: 180000 });
  console.log(JSON.stringify(message, null, 2));
  if (!settled) {
    console.log('Hết thời gian chờ. Tra lại sau bằng GET /emails/:id; không gửi lại bằng key mới.');
  } else if (message.state === 'accepted') {
    console.log(`SES đã nhận thư, deliveryState=${message.deliveryState}.`);
  } else {
    console.log(`Thư không được gửi: state=${message.state}, errorCode=${message.errorCode}.`);
  }
});
