# Visnam Email Marketing – Ví dụ tích hợp Node.js

Repo mẫu minh họa cách hệ thống của bạn gửi email qua **Tenant API Email Marketing** của Visnam Center:

- một SDK nhỏ, không phụ thuộc thư viện ngoài (`src/`), dùng `fetch` có sẵn trong Node 18+;
- các script CLI chạy được ngay (`examples/`);
- một app Express mẫu (`app/`) có form gửi email, upload file đính kèm và bảng trạng thái.

> Repo này gọi **server thật**. Mỗi email được SES nhận sẽ tiêu 1 lượt gửi đã mua; mỗi file upload tiêu dung lượng đính kèm đã mua.

## Luồng hoạt động

```
Hệ thống của bạn ──POST /emails (202)──▶ Visnam Tenant API ──hàng đợi──▶ Amazon SES ──▶ Người nhận
        │                                      ▲
        └──────── GET /emails/:id (poll) ──────┘
```

1. `POST /emails` giữ 1 lượt và xếp thư vào hàng đợi, trả **202** ngay với `messageId`.
2. Worker của Visnam gửi thư qua Amazon SES.
3. Bạn **nhận webhook** đã đăng ký để biết kết quả, hoặc **tra cứu lại** (`GET /emails/:id`) để đối soát. Hướng dẫn nhận và xác minh webhook ở phần tích hợp mở rộng bên dưới.

## Điều kiện trước khi chạy

- Đã mua gói Email Marketing trên Store của Visnam, và tenant đã được duyệt (`active`).
- Có ít nhất một **sender** `active` thuộc domain đã xác minh DKIM.
- Có **API key** tenant dạng `vem_...`, tạo trong portal Email Marketing hoặc do nhân viên Visnam cấp. Key chỉ hiển thị một lần.
- Muốn đính kèm file: tenant phải có thêm gói dung lượng đính kèm.

Scope cần cho từng phần:

| Scope | Dùng cho |
|---|---|
| `emails:send` | Gửi email |
| `emails:read` | Tra cứu email |
| `usage:read` | Xem ví lượt gửi và hạn mức |
| `senders:read` | Liệt kê sender |
| `identities:read` | Liệt kê domain và bản ghi DNS |
| `files:write` | Upload và xóa file |
| `files:read` | Tra cứu file |

Nên cấp **đúng scope cần dùng** cho mỗi hệ thống. Ví dụ hệ thống chỉ gửi thư thì không cần `files:write`.

## Cài đặt

Yêu cầu Node.js 18.17 trở lên.

```bash
npm install
cp .env.example .env      # rồi điền VISNAM_BASE_URL, VISNAM_API_KEY, DEMO_RECIPIENT
npm run example:account   # kiểm tra key, xem ví, lấy senderId → điền VISNAM_SENDER_ID
```

| Lệnh | Làm gì |
|---|---|
| `npm run example:account` | Xem ví lượt gửi, sender, domain và bản ghi DNS cần thêm |
| `npm run example:send -- [người-nhận]` | Gửi một email, có retry an toàn, rồi chờ kết quả |
| `npm run example:attachment -- [file] [người-nhận]` | Upload file (mặc định tự tạo PDF mẫu) rồi gửi email kèm file |
| `npm run example:list -- [state] [referenceId]` | Liệt kê email 7 ngày gần nhất, tự chuyển trang |
| `npm run example:idempotency` | Chứng minh gửi lại cùng key không tạo thư trùng (tiêu 1 lượt) |
| `npm run app` | Chạy app Express mẫu tại `http://localhost:3000` |
| `npm test` | Chạy kiểm thử, không gọi server thật |

## Dùng SDK

```js
import { VisnamEmailClient, newIdempotencyKey, withRetry } from './src/index.js';

const client = new VisnamEmailClient({
  baseUrl: process.env.VISNAM_BASE_URL,
  apiKey: process.env.VISNAM_API_KEY,
});

// Tạo key MỘT lần cho thư này, rồi dùng lại đúng key đó trong mọi lần retry.
const idempotencyKey = newIdempotencyKey('welcome');
const message = await withRetry(() => client.sendEmail({
  senderId: process.env.VISNAM_SENDER_ID,
  to: 'khach@example.com',
  subject: 'Chào mừng bạn',
  html: '<p>Cảm ơn bạn đã đăng ký.</p>',
  referenceId: 'user-1001',
}, { idempotencyKey }));

const { message: latest, settled } = await client.waitForEmail(message.messageId);
```

## Endpoint của Tenant API

Tất cả nằm dưới `{VISNAM_BASE_URL}/api/v1/email-marketing` và cần header `Authorization: Bearer vem_...`.

| Method | Path | Scope | Thành công | Ghi chú |
|---|---|---|---|---|
| `POST` | `/emails` | `emails:send` | 202 | Bắt buộc header `Idempotency-Key` |
| `GET` | `/emails` | `emails:read` | 200 | Lọc `state`, `referenceId`, `from`, `to`; `page`, `pageSize` ≤ 100; **không có `total`** |
| `GET` | `/emails/:id` | `emails:read` | 200 | Có thêm `attachments[]` nếu thư có đính kèm |
| `GET` | `/usage` | `usage:read` | 200 | Ví lượt gửi, hạn mức ngày, dung lượng đính kèm |
| `GET` | `/senders` | `senders:read` | 200 | Chỉ sender `active` mới dùng được |
| `GET` | `/identities` | `identities:read` | 200 | Domain và bản ghi DKIM |
| `POST` | `/files` | `files:write` | 201 hoặc 202 | Multipart, đúng một trường `file`; bắt buộc `Idempotency-Key` |
| `GET` | `/files` | `files:read` | 200 | Có `total` |
| `GET` | `/files/:id` | `files:read` | 200 | |
| `DELETE` | `/files/:id` | `files:write` | 200 | Không hoàn dung lượng đã tiêu |

### Body của `POST /emails`

Body chỉ được chứa các trường dưới đây; trường lạ sẽ bị từ chối.

| Trường | Kiểu | Bắt buộc | Giới hạn |
|---|---|---|---|
| `senderId` | UUID | Có | Lấy từ `GET /senders` |
| `to` | string | Có | **Một** địa chỉ email, tối đa 320 ký tự |
| `subject` | string | Có | 1–998 ký tự, không chứa xuống dòng |
| `html` | string | Cần `html` hoặc `text` | Tối đa 60.000 byte UTF-8 |
| `text` | string | Cần `html` hoặc `text` | Tối đa 60.000 byte UTF-8 |
| `referenceId` | string | Không | Tối đa 128 ký tự; mã của hệ thống bạn để tra cứu lại |
| `attachmentIds` | UUID[] | Không | Tối đa 3 file `ready`, không lặp, tổng tối đa 20 MiB |

Gửi cho nhiều người thì gọi nhiều lần, mỗi lần một người nhận và một Idempotency-Key riêng.

## Idempotency-Key: chống gửi trùng

Header `Idempotency-Key` bắt buộc với `POST /emails` và `POST /files`. Key gồm 1–128 ký tự `A–Z a–z 0–9 . _ : -`.

| Tình huống | Kết quả |
|---|---|
| Cùng key, cùng nội dung | Trả lại **đúng message cũ**: không gửi thư mới, không trừ thêm lượt |
| Cùng key, nội dung khác | `409 IDEMPOTENCY_CONFLICT` |
| Key mới | Một thư mới |

Cách dùng đúng:

- Tạo key **một lần cho mỗi thư** và lưu cùng bản ghi nghiệp vụ, ví dụ bảng outbox. Có thể dùng `idempotencyKeyFrom('order-1001:confirmation')` để dẫn xuất key cố định từ định danh có sẵn.
- Khi lỗi mạng, timeout, 429, 502, 503 hoặc 504: **gửi lại với cùng key**. Bạn không biết lần trước server đã nhận hay chưa; cùng key bảo đảm chỉ có một thư.
- **Không** sinh key mới để "thử lại". Làm vậy có thể khiến khách nhận hai thư và bạn mất hai lượt.

## Trạng thái của một email

| Trường | Giá trị | Ý nghĩa |
|---|---|---|
| `state` | `queued` → `sending` → `accepted` | SES đã nhận thư. Chưa chắc thư đã vào hộp thư. |
| | `failed` | SES từ chối thư; lượt được hoàn lại |
| | `suppressed` | Người nhận đã hủy đăng ký hoặc từng bounce/complaint |
| | `uncertain` | Gọi SES không rõ kết quả. **Không gửi lại bằng key mới**, vì khách có thể đã nhận thư. |
| | `manual_review` | `uncertain` quá 24 giờ; Visnam sẽ đối soát |
| `creditState` | `reserved` | Lượt đang được giữ khi thư chờ gửi |
| | `consumed` | Lượt đã bị tiêu vì SES nhận thư |
| | `released` | Lượt được hoàn lại vì thư không gửi được |
| `deliveryState` | `pending`, `delivered`, `bounced`, `complained`, `failed` | Kết quả giao thư theo sự kiện từ SES |

`waitForEmail(id)` dừng khi thư `accepted`, `failed`, `suppressed` hoặc `manual_review`. Truyền `{ untilDelivery: true }` để chờ thêm tới khi `deliveryState` khác `pending`.

## Đính kèm file

1. Gọi `uploadFile({ filename, data }, { idempotencyKey })`. Chỉ nhận PDF, JPG hoặc PNG thật, tối đa 10 MiB. Đuôi tên file, Content-Type và nội dung phải khớp nhau.
2. Xử lý kết quả:
   - **201** (`state: 'ready'`): dùng được ngay.
   - **202** (`state: 'upload_pending'`): gọi `waitForFile(id)` trước khi dùng.
3. Truyền `attachmentIds: [file.id]` khi gửi. Mỗi file chỉ gắn được vào **một** email.

Lưu ý:

- Visnam **không đính kèm MIME**. Server chèn link tải (hiệu lực 30 ngày) vào cuối thư.
- File chưa gửi hết hạn sau 30 ngày kể từ lúc upload.
- Dung lượng đã upload không được hoàn lại, kể cả khi xóa file.

## Giới hạn

- **20 request/giây cho mỗi tenant**, tính chung cho mọi endpoint. Vượt mức sẽ nhận `429` kèm `Retry-After`.
- Mỗi tenant có thêm hạn mức gửi theo ngày và theo giây (xem `GET /usage`). Thư vượt hạn mức sẽ chờ trong hàng đợi, không bị lỗi.
- Đừng poll quá dày. 2–5 giây một lần cho mỗi thư là đủ; nếu có nhiều thư, hãy dùng `GET /emails?state=...` thay vì gọi từng thư.

## Mã lỗi thường gặp

Body lỗi có dạng `{ "code": "..." }`. Riêng `VALIDATION_FAILED` có thêm `message` và `issues[]`. Hãy rẽ nhánh theo `code`.

| HTTP | `code` | Cách xử lý | Retry? |
|---|---|---|---|
| 401 | `API_KEY_INVALID` | Key sai, hết hạn hoặc đã thu hồi | Không |
| 403 | `TENANT_OR_SCOPE_FORBIDDEN`, `TENANT_NOT_ACTIVE` | Key thiếu scope, hoặc tenant chưa được duyệt hay đang tạm dừng | Không |
| 403 | `ATTACHMENT_PLAN_REQUIRED` | Chưa có gói dung lượng đính kèm | Không |
| 404 | `MESSAGE_NOT_FOUND`, `ATTACHMENT_NOT_FOUND` | Sai ID hoặc ID thuộc tenant khác | Không |
| 409 | `INSUFFICIENT_CREDITS` | Hết lượt gửi; mua thêm gói | Không |
| 409 | `ATTACHMENT_STORAGE_INSUFFICIENT` | Hết dung lượng đính kèm | Không |
| 409 | `IDEMPOTENCY_CONFLICT` | Cùng key nhưng nội dung khác; thao tác mới phải dùng key mới | Không |
| 410 / 422 | `ATTACHMENT_EXPIRED`, `ATTACHMENT_NOT_AVAILABLE` | File đã hết hạn, đã xóa hoặc đã dùng cho email khác | Không |
| 413 | `ATTACHMENT_TOO_LARGE` | File lớn hơn 10 MiB | Không |
| 422 | `VALIDATION_FAILED` | Sửa dữ liệu theo `issues[]` | Không |
| 422 | `IDEMPOTENCY_KEY_REQUIRED` | Thiếu header hoặc key sai định dạng | Không |
| 422 | `SENDER_NOT_AVAILABLE` | Sender không thuộc tenant, chưa active, hoặc domain chưa xác minh | Không |
| 422 | `RECIPIENT_SUPPRESSED` | Người nhận nằm trong danh sách chặn. Không tìm cách gửi tiếp. | Không |
| 422 | `ATTACHMENT_TYPE_INVALID`, `ATTACHMENT_TOTAL_TOO_LARGE` | Sai định dạng file, hoặc tổng file đính kèm vượt 20 MiB | Không |
| 429 | `API_RATE_LIMITED` | Chờ `Retry-After` giây | **Có**, cùng key |
| 503 | `EMAIL_SERVICE_UNAVAILABLE`, `ATTACHMENT_SERVICE_UNAVAILABLE`, ... | Dịch vụ tạm thời không sẵn sàng | **Có**, cùng key |
| — | `NETWORK_ERROR` (do SDK đặt) | Không nhận được response | **Có**, cùng key |

`isRetryable(error)` và `withRetry()` trong SDK đã cài sẵn quy tắc này.

## Bảo mật

- API key cho phép tiêu lượt đã trả tiền. Chỉ dùng ở **phía server**; không đưa vào trình duyệt, app di động hay repo. App mẫu cho thấy cách trình duyệt gọi qua server của bạn.
- Không commit file `.env`; `.gitignore` đã loại trừ nó.
- Mỗi hệ thống dùng một key riêng với scope tối thiểu, đặt ngày hết hạn và thu hồi ngay khi nghi lộ.
- Nội dung `html` do bạn gửi được chuyển nguyên cho người nhận. Hãy escape dữ liệu người dùng trước khi chèn vào template.

## Chưa hỗ trợ

- Chiến dịch hoặc danh bạ trên hệ thống khách. API đã hỗ trợ lô tối đa 50 email độc lập.
- Thống kê mở thư và click.

## Tích hợp mở rộng: webhook → cảnh báo/báo cáo → thử tích hợp → mẫu và lô

Backend Visnam cần được nâng cấp trước khi dùng các API này. API key cũ không tự được cấp scope mới; chỉ cấp các scope cần dùng:

| Chức năng | Scope |
|---|---|
| Xem/cấu hình, đổi secret, replay webhook | `webhooks:read`, `webhooks:write` |
| Cảnh báo/báo cáo, sửa ngưỡng | `reports:read`, `alerts:write` |
| Mô phỏng webhook không gửi mail | `sandbox:write` |
| Xem/soạn mẫu | `templates:read`, `templates:write` |
| Gửi mẫu hoặc lô | `emails:send` |

### 1. Receiver webhook

1. Chạy app mẫu sau reverse proxy HTTPS công khai cổng 443, URL nhận là `https://app.example.com/webhooks/visnam`. Không dùng localhost/IP riêng; Visnam yêu cầu DNS có A record công khai, không theo redirect và chưa hỗ trợ đích chỉ IPv6.
2. Cấu hình trong portal hoặc gọi `client.saveWebhook({url,events,enabled:true})`. Mỗi tenant có một endpoint. Sự kiện gồm `email.accepted`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `email.unsubscribed`, `account.alert`, `integration.test`.
3. Lưu `signingSecret` vào `VISNAM_WEBHOOK_SECRET` và restart app nhận. Secret chỉ được trả khi tạo lần đầu hoặc đổi secret. Không log secret hoặc đưa vào frontend. API key không dùng để xác minh webhook.
4. App đọc raw body trước middleware JSON, xác minh HMAC và timestamp 5 phút bằng `verifyVisnamWebhook`, lưu inbox trước 200; lỗi lưu trả 503 để Visnam retry. `app/webhook-inbox.js` ghi file hoàn chỉnh vào `.local/webhook-events` và chống trùng theo `eventId`; thư mục này không được commit. Production nhiều máy dùng bảng inbox có UNIQUE(event_id), cùng transaction xử lý nghiệp vụ hoặc worker inbox.
5. Không dùng `test=true` cập nhật trạng thái đơn/thư thật. Inbox mẫu chỉ lưu sự kiện, bạn bổ sung xử lý nghiệp vụ riêng. Bảo vệ file inbox vì payload có thể chứa email người nhận; tự đặt thời hạn giữ dữ liệu phù hợp.

Chữ ký: header `X-Visnam-Signature` bằng `v1=` + HMAC-SHA256 hex của `X-Visnam-Timestamp + '.' + rawBody`, ký bằng signing secret. Payload gồm `eventId`, `type`, `occurredAt` (lúc tạo thông báo), `test`, `data` chứa messageId/referenceId/to/state/deliveryState/errorCode. Cảnh báo có thêm data.alert. Webhook không chứa nội dung thư.

Thông báo có thể trùng và khác thứ tự; xác minh chữ ký không thay thế chống trùng theo eventId. Dùng `getEmail` đối soát khi cần, không lấy sự kiện đến cuối làm kết quả cuối một cách máy móc. Delivered nghĩa máy chủ nhận đã tiếp nhận, không bảo đảm inbox hoặc người nhận đã đọc.

Tối đa 8 lần tự giao: lần đầu rồi chờ 5 giây, 30 giây, 2 phút, 10 phút, 1 giờ, 6 giờ, 12 giờ sau mỗi lỗi. Non-2xx, redirect hoặc timeout 10 giây đều thất bại. Dùng `listWebhookDeliveries()`/`getWebhookAttempts(id)` xem lịch sử; `replayWebhook(id)` chỉ xếp giao lại thông báo failed/succeeded với cùng eventId, không gửi lại email/trừ lượt. Tắt endpoint giữ backlog, đổi URL áp dụng cả backlog. `rotateWebhookSecret()` thay secret cho lần giao tiếp theo, request đang bay có thể còn dùng secret cũ; mất response thì đổi lại và cập nhật receiver.

### 2. Cảnh báo và báo cáo

`getAlerts()` trả `{policy,alerts,windowHours:24}`. `saveAlertPolicy()` nhận đủ sáu trường:

```js
await client.saveAlertPolicy({
  lowCredits: 100, lowStorageBytes: 104857600, queueAgeMinutes: 30,
  bouncePercent: 5, complaintPercent: 0.1, minimumSample: 100,
});
const report = await client.getReport({
  from: '2026-10-28T00:00:00Z', to: '2026-10-29T23:59:59Z',
});
```

Các ngưỡng là mặc định Visnam, không phải giới hạn AWS. LOW_CREDITS/LOW_STORAGE khi khả dụng ≤ ngưỡng; QUEUE_DELAYED khi thư queued quá ngưỡng; WEBHOOK_FAILURES khi có thông báo hết số lần thử trong 24 giờ; HIGH_BOUNCE_RATE/HIGH_COMPLAINT_RATE dùng cohort accepted 24 giờ và tối thiểu minimumSample. Đăng ký account.alert để nhận chủ động: kiểm tra theo lô 20 tenant/phút, mỗi mã tối đa một thông báo/giờ.

Báo cáo nhận from/to UTC kết thúc Z bắt buộc, khoảng tối đa 90 ngày và tùy chọn senderId. Nhóm theo ngày tạo thư, kết quả giao phản ánh hiện tại. Cột accepted/delivered/bounced/complained có thể chồng nhau, không cộng thành total. Portal có nút xuất CSV; API `GET /reports.csv` dùng cùng bộ lọc và trả CSV UTF-8 BOM.

### 3. Thử webhook không gửi email thật

```js
await client.simulateEvent({ type: 'email.bounced', referenceId: 'integration-test-001' });
```

Cần endpoint đang bật; mọi sự kiện thử có test=true, messageId/to=null, không SES/S3, không trừ ví, không xuất hiện trong báo cáo thật. Loại thử không cần nằm trong danh sách events đã đăng ký. Không phải môi trường gửi email sandbox riêng; đây là mô phỏng thông báo webhook. `npm test` kiểm tra chữ ký, body bị sửa, hết hạn timestamp và lỗi lưu inbox bằng HTTP local/giả, không gọi AWS.

### 4. Mẫu có phiên bản và gửi theo lô

```js
const templateId = crypto.randomUUID(); // Hoặc import randomUUID từ node:crypto; lưu ID để sửa/retry.
const template = await client.saveTemplate(templateId, {
  name: 'Xác nhận đơn', subject: 'Đơn {{orderId}}', text: 'Xin chào {{name}}', version: 0,
});
await client.previewTemplate(template.id, { name: 'Khách mẫu', orderId: 'DH-001' });
// Gửi thật, cần emails:send và lượt khả dụng:
await client.sendTemplate(template.id, {
  senderId, to, version: template.version, variables: { name: 'Khách mẫu', orderId: 'DH-001' },
  referenceId: 'DH-001',
}, { idempotencyKey: idempotencyKeyFrom('DH-001:confirmation') });
```

`version=0` khi tạo, dùng version hiện tại khi sửa; 409 TEMPLATE_VERSION_CONFLICT khi mẫu đã đổi. Lưu nội dung bất biến của từng phiên bản; thư đã nhận giữ snapshot riêng. Biến dạng `{{name}}`, tên bắt đầu bằng chữ, chỉ chữ/số/gạch dưới, tối đa 64 ký tự; tối đa 50 biến, mỗi giá trị ≤10000 ký tự. Biến HTML được escape. Không đặt dữ liệu không tin cậy vào URL/style/script. Thiếu biến/sai cú pháp/nội dung render quá 60 KB/subject sai trả 422. Preview không gửi thư.

Gửi từ mẫu dùng nội dung bất biến của version đã chọn, kể cả mẫu hiện tại đã đổi. Retry giữ nguyên key, version và biến. Preview nhận version tùy chọn: `previewTemplate(id, variables, {version: 1})`; bỏ version thì render bản hiện tại. Phiên bản không tồn tại trả 404 TEMPLATE_NOT_FOUND.

```js
const result = await client.sendBatch([
  { idempotencyKey: idempotencyKeyFrom('DH-001:confirmation'), message: firstPayload },
  { idempotencyKey: idempotencyKeyFrom('DH-002:confirmation'), message: secondPayload },
]);
for (const item of result.data) console.log(item.index, item.status, item.body);
```

Lô có 1–50 mục, không lặp key. HTTP 200 của lô không có nghĩa mọi thư đã nhận; đọc status từng mục, 202 nghĩa đã nhận. Mỗi mục có transaction và hạn mức API riêng; không rollback cả lô. Retry đúng key/nội dung của từng mục, kể cả khi timeout cả lô. Dùng `newIdempotencyKey` một lần và lưu lại hoặc dẫn xuất từ mã nghiệp vụ ổn định; không sinh key mới mỗi lần retry.

Ví dụ mới: `npm run example:webhook` (đọc cấu hình và phát một sự kiện thử), `npm run example:report` (chỉ đọc), `npm run example:template` (soạn/render, không gửi), `npm run example:batch` (chỉ gửi thật nếu DEMO_SEND_REAL=true và DEMO_BATCH_REFERENCE đã được đặt cố định). Các trường, giới hạn và mã lỗi đầy đủ nằm trong HTML hướng dẫn Visnam bàn giao cùng sample.

## Giấy phép

[MIT](LICENSE)
