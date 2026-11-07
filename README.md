# ztr.info — 7EN Labs affiliate tracking hub (Rio-style)

Cloudflare Worker `ztr-tracker` on `ztr.info`: redirect + click log + sub_id
cho Shopee/Lazada. Mọi link affiliate trên các site của đội đi qua đây.

## Endpoints

| Route | Mô tả |
|---|---|
| `GET /g/<code>` | Short link, redirect 302, ghi click, gắn affiliate + sub_id |
| `GET /goto/?url=...&s=<site>&ref=<placement>` | Redirect 302 tới Shopee/Lazada, chỉ nhận host Shopee/Lazada |
| `GET /b?s=..&d=..` | Beacon (sendBeacon), ghi log, trả 204 |
| `GET /admin` | Thống kê + short link + cài đặt affiliate (cần mật khẩu) |
| `GET /` | Trang giới thiệu |

## Cài đặt affiliate (mục 4b — theo từng trang aff tham gia)

Mỗi sàn là 1 mục cấu hình trong `/admin` → **Cài đặt affiliate**:

- `affiliate_id`: mã affiliate của đội trên sàn đó
- `aff_param`: khóa mang affiliate_id (`af_id` cho Shopee, `sub_aff_id` cho Lazada)
- `sub_key`: khóa mang sub_id (`sub_id` cho Shopee, `sub_id1` cho Lazada)
- `sub_template`: mẫu sub_id, hỗ trợ `{click_id}`, `{site}`, `{placement}`
  - mặc định Shopee: `{site}_{placement}_{click_id}`
  - mặc định Lazada: `{site}_{click_id}`

Mã nguồn site (`s=vegialai`, `s=socbeauty`...) được đưa vào sub_id để đối
soát site nào sinh đơn. Thêm 1 sàn mới chỉ cần thêm 1 dòng cấu hình,
không sửa code. Cấu hình lưu trong Durable Object, sửa trên `/admin`
có hiệu lực ngay, không cần deploy lại. Chỉ admin mới xem/sửa được.

## Lưu trữ

1 Durable Object SQLite duy nhất (`TrackerStore`): bảng `links` (short
link), `clicks` (log click), `counters` (thống kê theo ngày), `config`
(cấu hình sàn). Ban đầu plan dùng KV, nhưng API token hiện tại không có
quyền KV (401) nên đổi sang Durable Object — vẫn free tier (100k
request/ngày, 0 đồng). Nếu sau này token có quyền KV thì có thể chuyển
lại, code Worker không phụ thuộc vào store (mọi thao tác qua DO).

## Deploy (bằng Cloudflare API, không dùng wrangler vì không có API token thô)

```bash
# 1. Upload Worker (lần đầu cần migrations, lần sau bỏ migrations)
#    metadata: main_module=worker.js, bindings: STORE (durable_object_namespace, class TrackerStore)
#    Content-Type của part worker.js phải là application/javascript+module
# 2. Đặt secret mật khẩu admin
#    PUT /accounts/<id>/workers/scripts/ztr-tracker/secrets {"name":"ADMIN_PASSWORD","text":"...","type":"secret_text"}
# 3. Bật workers.dev (để test)
#    POST /accounts/<id>/workers/scripts/ztr-tracker/subdomain {"enabled":true}
# 4. Gắn ztr.info (CẦN QUYỀN Workers Routes:Edit trên token — xem dưới)
#    POST /zones/<zone_id>/workers/routes {"pattern":"ztr.info/*","script":"ztr-tracker"}
```

## Trạng thái (07/11/2026)

- Worker đã deploy, chạy tốt trên
  `https://ztr-tracker.noibonet.workers.dev` (đã kiểm chứng end-to-end:
  /g/ + /goto/ redirect 302 đúng, đủ affiliate_id + sub_id, click ghi
  log + hiện trên /admin, beacon 204, lọc bot, chặn domain lạ).
- **CHƯA gắn được `ztr.info/*`**: API token hiện tại thiếu quyền
  Zone Workers Routes:Edit (tạo route trả 403), và endpoint Custom
  Domain không chấp nhận API token (405). Cần thêm quyền vào token
  trong dashboard Cloudflare (My Profile → API Tokens → token
  `4b1cf992...` → thêm `Zone: Workers Routes: Edit`) rồi chạy bước 4,
  hoặc gắn route bằng tay trong dashboard (Workers & Pages →
  ztr-tracker → Settings → Domains & Routes → Add route
  `ztr.info/*`).
- **Tham số affiliate đang là placeholder `REPLACE_ME`**: backup tracker
  PHP cũ không có config/DB nên không có giá trị thật. Zen cần cấp
  `affiliate_id` Shopee + Lazada thật, nhập vào `/admin` → Cài đặt
  affiliate. Khi chưa có giá trị thật, Worker vẫn redirect + ghi log +
  gắn sub_id, chỉ không gắn mã affiliate (không gửi mã giả lên sàn).

## Mật khẩu admin

Lưu trong Worker secret `ADMIN_PASSWORD` (không commit). Đăng nhập
`/admin?pw=...` một lần, cookie giữ 7 ngày.
