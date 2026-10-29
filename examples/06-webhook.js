// Đọc cấu hình và phát một thông báo thử; không gửi email hoặc trừ lượt.
import { createClient, run } from './_shared.js';
run(async () => {
  const client = createClient(), config = await client.getWebhook();
  console.log(config ? `Webhook ${config.enabled ? 'đang bật' : 'đang tắt'}.` : 'Chưa cấu hình webhook; tạo trên portal và lưu signing secret ở receiver trước.');
  if (!config?.enabled) return;
  const result = await client.simulateEvent({ type: 'email.delivered', referenceId: 'integration-demo' });
  console.log(`Đã xếp thông báo thử: ${result.deliveryId}. Không gửi email thật.`);
});
