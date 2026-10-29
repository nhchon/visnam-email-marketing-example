// Ví dụ gửi lô thật chỉ chạy khi người vận hành bật rõ. Mã lô phải ổn định để chạy lại không tạo email trùng.
import { idempotencyKeyFrom } from '../src/index.js';
import { createClient, requireEnv, run } from './_shared.js';
run(async () => {
  if (process.env.DEMO_SEND_REAL !== 'true') { console.log('Chưa gửi. Đặt DEMO_SEND_REAL=true và DEMO_BATCH_REFERENCE cố định để gửi hai email thật, tiêu tối đa hai lượt.'); return; }
  const client = createClient(), reference = requireEnv('DEMO_BATCH_REFERENCE');
  const items = [1, 2].map(index => ({ idempotencyKey: idempotencyKeyFrom(`${reference}:${index}`),
    message: { senderId: requireEnv('VISNAM_SENDER_ID'), to: requireEnv('DEMO_RECIPIENT'), subject: `Thông báo lô ${index}`, text: `Mục ${index}`, referenceId: `${reference}:${index}` } }));
  const result = await client.sendBatch(items);
  for (const item of result.data) console.log(`Mục ${item.index}: HTTP ${item.status}`, item.body);
});
