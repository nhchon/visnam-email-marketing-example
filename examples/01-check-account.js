// Bước đầu tiên khi tích hợp: kiểm tra key, ví lượt gửi, sender và domain.
// Chạy: npm run example:account
import { createClient, run } from './_shared.js';

run(async () => {
  const client = createClient();

  const usage = await client.getUsage();
  console.log('Ví lượt gửi');
  console.log(`  còn dùng được: ${usage.available}, đang giữ: ${usage.reserved}, đã tiêu: ${usage.consumed}`);
  console.log(`  đã gửi 24h qua: ${usage.sentLast24Hours}/${usage.dailyLimit}, tốc độ tối đa: ${usage.rateLimit} thư/giây`);
  if (usage.attachmentStorage) {
    console.log(`  dung lượng đính kèm còn: ${usage.attachmentStorage.available} byte`);
  }

  const senders = await client.listSenders();
  console.log('\nSender (dùng senderId cho VISNAM_SENDER_ID)');
  for (const sender of senders) {
    console.log(`  ${sender.senderId}  ${sender.displayName} <${sender.email}>  [${sender.status}]`);
  }
  if (!senders.some((sender) => sender.status === 'active')) {
    console.log('  Chưa có sender active. Liên hệ Visnam để được cấp sender.');
  }

  const identities = await client.listIdentities();
  console.log('\nDomain gửi thư');
  for (const identity of identities) {
    console.log(`  ${identity.domain}  [${identity.status}]`);
    // Domain chưa xác minh thì cần thêm các bản ghi DKIM này vào DNS.
    if (identity.status !== 'verified') {
      for (const record of identity.dnsRecords || []) console.log(`    ${record.type} ${record.name} → ${record.value}`);
    }
  }
});
