import { readFileSync } from 'node:fs';
import { MAX_BODY_BYTES } from '../src/index.js';

// Đo byte UTF-8 trước khi gửi, không dùng số ký tự vì tiếng Việt/emoji chiếm nhiều byte.
// Ví dụ chỉ đọc file cục bộ (nếu truyền đường dẫn), không cần credential và không gửi email.
const content = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : 'ế'.repeat(333333) + 'x';
const bytes = Buffer.byteLength(content, 'utf8');
console.log({ bytes, maxBytes: MAX_BODY_BYTES, valid: bytes <= MAX_BODY_BYTES });
if (bytes > MAX_BODY_BYTES) process.exitCode = 1;

// html và text được kiểm tra riêng. Khi gửi lô, phải đo cả JSON đã serialize:
// Buffer.byteLength(JSON.stringify({ items }), 'utf8') <= 10 * 1024 * 1024.
// Chia nhỏ lô theo kích thước này, kể cả khi số mục vẫn dưới 50.
