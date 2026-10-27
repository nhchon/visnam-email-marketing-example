// Tra cứu danh sách email theo bộ lọc, tự chuyển trang.
// Chạy: npm run example:list -- [state] [referenceId]
// Ví dụ: npm run example:list -- failed
import { createClient, run } from './_shared.js';

run(async () => {
  const client = createClient();
  const [state, referenceId] = process.argv.slice(2);
  // Chỉ lấy 7 ngày gần nhất. Thời điểm phải ở dạng ISO UTC.
  const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  let count = 0;
  for await (const message of client.iterateEmails({ state, referenceId, from, pageSize: 50 })) {
    count += 1;
    console.log(`${message.createdAt}  ${message.messageId}  ${message.to}  ${message.state}/${message.deliveryState}  ${message.referenceId ?? ''}`);
    if (count >= 500) {
      console.log('Dừng ở 500 dòng để ví dụ không chạy quá lâu.');
      break;
    }
  }
  console.log(`Tổng cộng: ${count} email`);
});
