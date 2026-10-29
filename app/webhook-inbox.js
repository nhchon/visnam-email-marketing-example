import { mkdir, open, link, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Inbox mẫu bền vững trên một máy: ghi file theo eventId bằng cờ wx để chống ghi trùng.
 * Production nhiều máy nên dùng bảng inbox có UNIQUE(event_id), xử lý nghiệp vụ bằng worker riêng.
 * Không dùng test=true để cập nhật đơn hàng hoặc trạng thái gửi thật.
 */
export async function storeWebhookEvent(event) {
  if (!/^[0-9a-f-]{36}$/i.test(event.eventId)) throw new TypeError('eventId không hợp lệ');
  const directory = resolve('.local/webhook-events');
  await mkdir(directory, { recursive: true });
  const temporary = resolve(directory, `${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(event)); await handle.sync(); } finally { await handle.close(); }
    // Công bố file hoàn chỉnh bằng hard link độc quyền. Crash lúc ghi chỉ để lại .tmp,
    // không khiến lần retry nhầm một file JSON dở dang là sự kiện đã tiếp nhận.
    try { await link(temporary, resolve(directory, `${event.eventId}.json`)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
}
