// Tạo và render thử mẫu, không gửi thư. Có thể tạo mẫu trên portal thay cho ví dụ này.
import { randomUUID } from 'node:crypto';
import { createClient, run } from './_shared.js';
run(async () => {
  const client = createClient(), id = randomUUID();
  const template = await client.saveTemplate(id, { name: 'Mẫu tích hợp', subject: 'Xin chào {{name}}', text: 'Thông báo cho {{name}}', version: 0 });
  console.log(`Đã tạo mẫu ${template.id}, phiên bản ${template.version}.`);
  console.log(await client.previewTemplate(template.id, { name: 'Khách mẫu' }));
});
