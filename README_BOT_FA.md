# Minecraft Bot توسعه‌یافته (bot.js)

## وضعیت پروژه
این نسخه روی `bot.js` شما توسعه داده شده و قابلیت‌های قبلی حفظ شده‌اند.

## قابلیت‌های تکمیل‌شده
- پنل مدیریت **تلگرام** (بدون پنل وب مدیریتی)
  - انتخاب زبان در `/start` (فارسی/English)
  - Reply Keyboard + Inline Keyboard
  - Telegram command list: `/start`, `/status`, `/panel`, `/commands`
- تنظیمات داینامیک از تلگرام:
  - `host:port`
  - `owner`
  - `prefix`
  - رمز پنل (`!auth` password)
  - رمز لاگین سرور (`/login` password)
  - دستور auto-TPA (`/tpaccept {player}`)
  - تنظیمات AI (base URL, model, API key)
- ذخیره امن تنظیمات در `bot_settings.json` با **AES-256-GCM** برای مقادیر حساس
- ذخیره state در `bot_runtime_state.json` (resume)
- 6b6t mode toggle
- no-password mode toggle
- require-auth toggle
- `!custom` برای تعریف command سفارشی
- `!mine <ore>` + `!mine stop`
- `!sortchest` (مرتب‌سازی چست/بارل)
- `!skills`
  - `scan`
  - `train agility|fighting|mining|foraging|farming|excavation|defense`
  - `stop`
  - `status`
- anti-stuck watchdog
- resume خودکار farm/mine/skills بعد reconnect
- رفتار اختصاصی `play.iccraft.ir`
  - تاخیر 5 ثانیه قبل `/login`
  - ارسال خودکار `/survival` پس از login
- `!ai <task>` در نقش Planner
  - retry روی 429 با تاخیر 10 ثانیه

## مسیرها/فایل‌های مهم
- فایل اصلی بات: `bot.js`
- تنظیمات رمزنگاری‌شده: `bot_settings.json`
- state runtime: `bot_runtime_state.json`

## لیست فرمان‌های Minecraft (Owner)
- `!auth <password>`
- `!go <x> <y> <z>` / `!go stop`
- `!sethome`
- `!inv`
- `!farm Smooth-Stone` / `!farm stop`
- `!mine <ore>` / `!mine stop`
- `!skills scan [player]`
- `!skills train <mode>`
- `!skills stop`
- `!skills status`
- `!sortchest`
- `!afk on|off`
- `!custom add|del|list`
- `!ai <task>`

## راهنمای اجرا روی VPS
## 1) پیش‌نیازها
- Node.js 20+
- npm
- PM2 (اختیاری ولی پیشنهاد می‌شود)

## 2) نصب پکیج‌ها
```bash
npm i dotenv mineflayer mineflayer-pathfinder vec3 node-telegram-bot-api
```

## 3) فایل `.env` نمونه
```env
MC_HOST=alt3.6b6t.org
MC_PORT=25565
MC_USERNAME=pvp_HSbot
MC_PASSWORD=your_mc_password
MC_VERSION=1.21.4

BOT_OWNER=pvp_HS
CHAT_PREFIX=!
BOT_AUTH_PASSWORD=change_me

TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456:ABC
TELEGRAM_ADMIN_IDS=123456789

AI_ENABLED=true
AI_BASE_URL=https://api.openai.com/v1/chat/completions
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-xxx
```

## 4) اجرا
```bash
node bot.js
```

> اگر پروژه‌ شما `type: module` داشته باشد و `require(...)` خطا بدهد، این بات را به صورت CommonJS اجرا کنید (مثلاً با فایل `.cjs` یا ریپوی مستقل بات).

## 5) اجرا با PM2
```bash
pm2 start bot.js --name mcbot
pm2 logs mcbot --nostream
pm2 save
```

## امنیت
- `.env` را commit نکنید.
- توکن‌های Telegram/AI را محرمانه نگه دارید.
- برای `BOT_AUTH_PASSWORD` رمز قوی بگذارید.
- در حالت `no password mode` فقط admin chat-idهای مورد اعتماد داشته باشید.

## موارد توسعه‌ی بعدی پیشنهادی
- حرفه‌ای‌تر کردن الگوریتم sort chest بر اساس template دلخواه
- افزودن presetهای آماده برای skill training route
- ثبت گزارش آماری فعالیت‌ها (JSON log)
