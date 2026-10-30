import 'dotenv/config';
import { VisnamEmailClient, VisnamApiError } from '../src/index.js';

/**
 * Đọc biến môi trường bắt buộc. Thiếu thì dừng với hướng dẫn rõ ràng,
 * thay vì để request chạy rồi nhận 401/422 khó hiểu.
 */
export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || value.includes('REPLACE_WITH')) {
    console.error(`Thiếu biến môi trường ${name}. Sao chép .env.example thành .env rồi điền giá trị.`);
    process.exit(1);
  }
  return value;
}

/** Tạo client từ `.env`. API key chỉ đọc từ môi trường, không viết thẳng vào code. */
export function createClient() {
  return new VisnamEmailClient({ baseUrl: requireEnv('VISNAM_BASE_URL'), apiKey: requireEnv('VISNAM_API_KEY') });
}

/**
 * Chạy hàm chính của một example và in lỗi theo `code` để người đọc biết cách xử lý.
 * @param {() => Promise<void>} main
 */
export function run(main) {
  main().catch((error) => {
    if (error instanceof VisnamApiError) {
      console.error(`Lỗi API ${error.status} ${error.code}${error.message !== error.code ? `: ${error.message}` : ''}`);
      for (const issue of error.issues || []) console.error(`  - ${issue.path?.join('.') || '(body)'}: ${issue.message}`);
      const hint = HINTS[error.code];
      if (hint) console.error(`Gợi ý: ${hint}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}

/** Gợi ý xử lý cho các mã lỗi hay gặp khi mới tích hợp. */
const HINTS = {
  API_KEY_INVALID: 'Key sai, hết hạn hoặc đã bị thu hồi. Kiểm tra VISNAM_API_KEY.',
  TENANT_OR_SCOPE_FORBIDDEN: 'Key thiếu scope cho endpoint này, hoặc tenant chưa active.',
  TENANT_NOT_ACTIVE: 'Tenant chưa được Visnam duyệt hoặc đang tạm dừng.',
  SENDER_NOT_AVAILABLE: 'senderId không thuộc tenant hoặc không active. Chạy lại example 01 để lấy senderId.',
  RECIPIENT_SUPPRESSED: 'Người nhận đã hủy đăng ký hoặc từng bounce/complaint. Không gửi tiếp cho địa chỉ này.',
  INSUFFICIENT_CREDITS: 'Hết lượt gửi. Mua thêm gói trên Store.',
  IDEMPOTENCY_CONFLICT: 'Cùng Idempotency-Key nhưng nội dung khác. Thao tác mới phải dùng key mới.',
  API_RATE_LIMITED: 'Vượt 20 request/giây. Chờ Retry-After rồi gửi lại cùng key.',
  // Cấu hình được kiểm tra trước khi nhận file/giữ dung lượng; khách không cần cấp AWS credential.
  ATTACHMENT_SERVICE_NOT_CONFIGURED: 'Backend Visnam chưa cấu hình hợp lệ kho tài liệu. Người vận hành kiểm tra EMAIL_MARKETING_FILES_BUCKET, EMAIL_MARKETING_FILES_REGION (hoặc EMAIL_MARKETING_AWS_REGION), EMAIL_MARKETING_FILES_TOKEN_SECRET (ít nhất 32 ký tự) và EMAIL_MARKETING_BASE_URL (HTTPS), rồi restart API và worker Email Marketing. Không sửa VISNAM_WEBHOOK_SECRET hoặc thêm AWS key vào sample.',
  ATTACHMENT_PLAN_REQUIRED: 'Tenant chưa có gói dung lượng đính kèm.',
  ATTACHMENT_STORAGE_INSUFFICIENT: 'Không đủ dung lượng đính kèm. Mua thêm gói dung lượng.',
  ATTACHMENT_TYPE_INVALID: 'Chỉ nhận PDF/JPG/PNG thật, đuôi file và Content-Type phải khớp nội dung.',
  NETWORK_ERROR: 'Không kết nối được. Kiểm tra VISNAM_BASE_URL và mạng.',
};
