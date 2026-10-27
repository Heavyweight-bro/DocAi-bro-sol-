# Розгортання Doc.AI

Підключення Supabase, обробка файлів у пам’яті й Vercel-entrypoint уже є в коді. SQLite не використовується.

## Користувачі та доступ

У production вхід обов’язковий. Потрібні дві змінні:

1. `DOCAI_SESSION_SECRET` — щонайменше 32 випадкові символи (`openssl rand -hex 32`). Зміна секрету завершує всі сесії.
2. `DOCAI_USERS` — JSON-масив користувачів. Хеш пароля: `npm run user -- hash boss@company.ua admin` (пароль питається приховано):

```env
DOCAI_USERS=[{"email":"boss@company.ua","role":"admin","name":"Олена","passwordHash":"scrypt$…"},{"email":"acc@company.ua","role":"operator","passwordHash":"scrypt$…"}]
```

Ролі: `viewer` — перегляд; `operator` — обробка, виправлення, підтвердження; `admin` — ще й шаблони, налаштування, користувачі, аудит, аналітика. CRM і скрипти працюють з `DOCAI_INTEGRATION_KEY` (права оператора).

Cookie сесії — HttpOnly, SameSite=Strict і Secure (потрібен HTTPS). Лише для довіреної внутрішньої мережі без HTTPS: `DOCAI_COOKIE_SECURE=false`. Вхід обмежено 10 спробами за 15 хв з IP/email. За reverse proxy задайте `TRUST_PROXY=1`, інакше обмеження рахуються за адресою proxy.

Без користувачів production-сервер не пускає нікого в інтерфейс, а API працює лише з інтеграційним ключем. У розробці без користувачів доступ відкритий тільки з самого комп’ютера (loopback).

## Конфігурація

Сервер читає змінні процесу, `.env.local`, потім `.env`, не перезаписуючи вже заданих значень. Зразок — [.env.example](.env.example).

| Змінна | Призначення |
|---|---|
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Серверні ключі провайдерів |
| `AI_PROVIDER` | `openai`, `gemini`, `anthropic`, `azure_openai` або `azure_claude` |
| `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | Azure OpenAI |
| `AZURE_OPENAI_API_VERSION` | Типово `2024-08-01-preview` |
| `AZURE_CLAUDE_API_KEY`, `AZURE_CLAUDE_ENDPOINT`, `AZURE_CLAUDE_MODEL` | Claude через Azure AI Foundry |
| `OPENAI_MODEL`, `GEMINI_MODEL`, `ANTHROPIC_MODEL` | Моделі відповідних провайдерів |
| `COMPANY_NAME` | Назва робочого простору |
| `DOCAI_USERS` | Користувачі (JSON, див. вище) |
| `DOCAI_SESSION_SECRET` | Секрет підпису сесій, ≥ 32 символи (обов’язково в production) |
| `DOCAI_SESSION_TTL_MIN` | Тривалість сесії, хв (типово 720) |
| `DOCAI_COOKIE_SECURE` | `false` лише для внутрішньої мережі без HTTPS |
| `TRUST_PROXY` | `1`, якщо перед сервером reverse proxy |
| `DOCAI_INTEGRATION_KEY` / `DOCAI_INTEGRATION_KEYS` | Bearer-ключ(і) для CRM/скриптів (мін. 16 символів; кілька через кому) |
| `OPENAI_ESCALATION_MODEL`, `GEMINI_ESCALATION_MODEL`, `ANTHROPIC_ESCALATION_MODEL` | Сильніша модель для повторного читання, якщо схема не пройдена |
| `DOCAI_MODEL_PRICES` | Точні ціни моделей для оцінки витрат (JSON) |
| `DOCAI_QUEUE` | `file` — примусово файлова черга навіть із Supabase |
| `DOCAI_JOB_LEASE_MS` | Через скільки завислий `processing` повертається в чергу (типово 600000) |
| `DOCAI_CRON_SECRET` | Секрет для `/api/internal/worker-tick` (Vercel Cron: `CRON_SECRET`) |
| `DOCAI_WEBHOOK_RETRY_BASE_MS` | База розкладу повторів webhook (типово 60000) |
| `DOCAI_FILE_RETENTION_DAYS` | Видаляти архів оригіналів старше N днів (0 — зберігати) |
| `DOCAI_RATE_LIMIT_PER_MIN` | Ліміт запитів на хвилину (типово 60) |
| `DOCAI_WEBHOOK_URL` | URL приймача подій CRM |
| `DOCAI_WEBHOOK_SECRET` | Секрет HMAC для `X-DocAI-Signature` |
| `DOCAI_WORKSPACE_ID` | Ідентифікатор простору (типово `default`, для майбутнього форку) |
| `DOCAI_WORKER` | `0` — вимкнути in-process worker |
| `DOCAI_JOB_MAX_ATTEMPTS` | Повтори AI (типово 3) |
| `LOCAL_JOBS_PATH` | Файл черги (типово `.data/jobs.json`) |
| `SUPABASE_URL`, `SUPABASE_KEY` | URL Supabase та серверний ключ із доступом до БД |
| `SUPABASE_STORAGE_BUCKET` | Приватний bucket для оригіналів (типово `documents`) |
| `NODE_ENV` | `production` для зібраного застосунку |
| `PORT` | Порт, типово `3000` |
| `HOST` | Типово `127.0.0.1` у розробці, `0.0.0.0` у production |
| `APP_ORIGIN` | Зовнішня адреса, наприклад `https://docs.company.example`, без кінцевого `/` |
| `LOCAL_DATA_PATH` | Типово `.data/docai.json`, лише для локального режиму |
| `LOCAL_SETTINGS_DIR` | Типово `.data/settings`, локальні налаштування й ключі |
| `LOCAL_FILES_DIR` | Типово `.data/files`, архів оригіналів у локальному режимі |

Без локальних налаштувань провайдер береться з `AI_PROVIDER`, інакше — перший налаштований у порядку OpenAI → Gemini → Anthropic. Без ключів початковий вибір — Gemini. Після збереження в UI використовуються збережені назва, провайдер і моделі. Ключі середовища завжди мають пріоритет. Для сумісності `GEMINI_API_KEY1` також читається й має пріоритет над `GEMINI_API_KEY`.

У production/на Vercel локальні налаштування не завантажуються; редагування та перевірка ключів у UI вимкнені. Перенесіть параметри в середовище розгортання. Секрети не повинні потрапляти в Git або змінні з префіксом `VITE_`.

## Supabase

Створіть окремий проєкт у погодженому регіоні. SQL нижче створює таблиці та додає поля до ранньої схеми. Перед застосуванням до існуючої БД зробіть резервну копію і звірте структуру. Команди зміни прав призначені для таблиць цього застосунку з доступом лише через сервер.

Уся схема — у [`db/schema.sql`](db/schema.sql): таблиці шаблонів і документів, черга `docai_jobs` з функцією `docai_claim_job()` (FOR UPDATE SKIP LOCKED — кілька воркерів безпечно), `docai_webhook_deliveries` (outbox), `docai_audit`, індекси й права лише для `service_role`. Скрипт ідемпотентний: застосовуйте його і для нової БД, і після оновлення версії (SQL Editor у Supabase або `psql -f db/schema.sql`). Перед застосуванням до робочої БД зробіть резервну копію.

Тести перевіряють схему на PostgreSQL 17 + PostgREST (`npm run test:pg`); реальний проєкт Supabase не перевірявся.

Задайте `SUPABASE_URL` і серверний `SUPABASE_KEY` із правами `service_role`; `anon` за цією схемою доступу не має. Сервісний ключ обходить RLS, тому доступ до даних контролює сам сервер (вхід, ролі, інтеграційні ключі). Схема не реалізує ізоляцію компаній: одна БД = одна компанія. [Документація RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

Оригінали файлів: локально — `.data/files` (`LOCAL_FILES_DIR`); у production — приватний Storage bucket (`SUPABASE_STORAGE_BUCKET`, типово `documents`). Створіть bucket у панелі Supabase як **private**; сервер завантажує об’єкт після parse і зберігає шлях у `storage_path`. Якщо upload у Storage не вдався, є fallback у локальний каталог на тому ж вузлі.

Локальна історія не переноситься автоматично.

## Постійний Node.js-сервер

Після налаштування середовища та Supabase, у папці репозиторію:

```sh
npm ci
npm run build
NODE_ENV=production HOST=127.0.0.1 npm start
```

Воркер черги за замовчуванням працює в тому ж процесі. Щоб винести його окремо (або запустити кілька): на веб-сервері `DOCAI_WORKER=0`, поруч — `npm run worker` з тими самими змінними. Кілька воркерів безпечні лише з Supabase (черга в Postgres); файлова черга — для одного процесу.

`npm start` використовує `tsx` із devDependencies: не застосовуйте `npm ci --omit=dev` без зміни складання backend. Для постійної роботи адміністратор налаштовує менеджер процесів, наприклад systemd.

Перед Express потрібен HTTPS reverse proxy. Задайте `APP_ORIGIN` для зовнішньої HTTPS-адреси, інакше перевірка Origin може відхилити запити запису через proxy. Ліміт proxy має вміщати файл до 10 MiB разом із multipart-формою; тайм-аут — до 120 секунд очікування AI плюс обробка й запис у БД.

Після розгортання перевіряють `/api/health`, шаблони, тестову обробку й читання результату за ID. Health показує наявність реквізитів, а не фактичну доступність AI/БД.

Без Supabase у production локальний режим вимкнений: історія не працює, а успішний parse може повернути незбережений результат. Налаштуйте БД перед використанням.

## Vercel

Є `api/index.ts` з експортом Express і `vercel.json` із API-rewrites та `maxDuration: 60`. Для приватного тестового розгортання імпортуйте потрібну гілку GitHub, використайте `npm run build`, каталог `dist`, Node.js 22+ та серверні змінні з таблиці. Задайте `APP_ORIGIN` для адреси розгортання.

- Ліміт тіла запиту Vercel Functions — 4.5 MB, менший за локальні 10 MiB; multipart теж займає місце. [Обмеження Vercel](https://vercel.com/docs/functions/limitations).
- Налаштовані 60 секунд функції менші за 120-секундний тайм-аут AI. Тривала обробка може перерватися раніше.
- Локальні файли не є production-сховищем. Потрібні Supabase та серверні секрети.
- Воркер у процесі на Vercel вимкнено. З Supabase черга зберігає файли в БД, а обробку запускає `/api/internal/worker-tick` за розкладом: задайте `CRON_SECRET` і додайте cron у `vercel.json` (частота залежить від тарифу Vercel) або викликайте його зовнішнім планувальником. Альтернатива — `npm run worker` на окремій машині.
- Vercel-деплой цієї версії не перевірений.

## Резервні копії

Локально зупиніть процес перед копіюванням `.data/` (документи, черга, файли, а в `.data/settings/` — ключі AI, `users.json`, `session.key`, аудит і outbox webhook-ів). Для відновлення ключів потрібні разом зашифрований файл та `master.key`; захищайте копію як секрет. Утрата ключа шифрування потребує повторного введення API-ключів.

Для Supabase налаштуйте доступний вашому плану спосіб резервування, термін зберігання та відновлення в окремому проєкті. Копія БД не містить самих об’єктів файлового сховища — архів резервують окремо. [Резервні копії Supabase](https://supabase.com/docs/guides/platform/backups).

Після відновлення перевіряють вхід, історію, шаблони й тестову обробку. Подальші кроки описані в [плані розвитку](IMPROVEMENTS.md); [пояснення для компанії](docs/COMPANY_GUIDE.uk.md), [впровадження для розробника](docs/IMPLEMENTATION.uk.md).
