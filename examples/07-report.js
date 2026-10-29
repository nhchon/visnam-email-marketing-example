// Chỉ đọc cảnh báo/báo cáo 7 ngày gần nhất theo UTC.
import { createClient, run } from './_shared.js';
run(async () => {
  const client = createClient(), to = new Date().toISOString(), from = new Date(Date.now() - 7 * 86400000).toISOString();
  console.log(await client.getAlerts());
  console.table((await client.getReport({ from, to })).data);
});
