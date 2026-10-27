// Upload một file rồi gửi email đính kèm file đó.
// Chạy: npm run example:attachment -- [đường-dẫn-file.pdf|.jpg|.png] [người-nhận]
// Không truyền file thì ví dụ tự tạo một PDF nhỏ trong bộ nhớ.
//
// Lưu ý: Visnam không gắn file dạng MIME attachment. Server chèn link tải (hiệu lực 30 ngày)
// vào cuối thư. Upload bị trừ dung lượng trả trước kể cả khi chưa gửi hoặc đã xóa file.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { newIdempotencyKey, withRetry } from '../src/index.js';
import { createClient, requireEnv, run } from './_shared.js';
import { samplePdf } from './sample-pdf.js';

run(async () => {
  const client = createClient();
  const path = process.argv[2];
  const upload = path
    ? { filename: basename(path), data: await readFile(path) }
    : { filename: 'bao-gia-mau.pdf', data: samplePdf('Visnam demo') };

  // Upload cũng cần Idempotency-Key riêng: retry không bị trừ dung lượng hai lần.
  const uploadKey = newIdempotencyKey('upload');
  let { file, pending } = await withRetry(() => client.uploadFile(upload, { idempotencyKey: uploadKey }));
  console.log(`Đã upload: id=${file.id}, state=${file.state}, ${file.sizeBytes} byte`);

  // 202 upload_pending: server còn đối soát với S3, phải chờ ready mới dùng được.
  if (pending) {
    ({ file } = await client.waitForFile(file.id));
    console.log(`Sau khi chờ: state=${file.state}`);
  }
  if (file.state !== 'ready') throw new Error(`File chưa sẵn sàng (state=${file.state}, errorCode=${file.errorCode})`);

  const sendKey = newIdempotencyKey('demo-attachment');
  const message = await withRetry(() => client.sendEmail({
    senderId: requireEnv('VISNAM_SENDER_ID'),
    to: process.argv[3] || requireEnv('DEMO_RECIPIENT'),
    subject: 'Báo giá kèm tài liệu',
    html: '<p>Kính gửi Quý khách, tài liệu báo giá nằm ở link tải bên dưới.</p>',
    attachmentIds: [file.id],
  }, { idempotencyKey: sendKey }));
  console.log(`Đã xếp hàng: messageId=${message.messageId}`);

  const { message: latest } = await client.waitForEmail(message.messageId);
  console.log(`state=${latest.state}, deliveryState=${latest.deliveryState}`);
  console.log('Đính kèm:', JSON.stringify(latest.attachments ?? [], null, 2));
});
