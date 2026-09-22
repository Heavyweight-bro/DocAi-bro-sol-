# Розгортання Doc.AI

Підключення Supabase, обробка файлів у пам’яті й Vercel-entrypoint уже є в коді. SQLite не використовується.

У застосунку поки немає авторизації користувачів. Віддалений тестовий екземпляр потрібно закрити корпоративним шлюзом входу або VPN, включно з `/api/*`, та обмежити прямий доступ до Express. CORS не замінює перевірку прав.

## Конфігурація

Сервер читає змінні процесу, `.env.local`, потім `.env`, не перезаписуючи вже заданих значень. Зразок — [.env.example](.env.example).

| Змінна | Призначення |
|---|---|
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Серверні ключі провайдерів |
| `AI_PROVIDER` | `openai`, `gemini` або `anthropic` |
| `OPENAI_MODEL`, `GEMINI_MODEL`, `ANTHROPIC_MODEL` | Моделі відповідних провайдерів |
| `COMPANY_NAME` | Назва робочого простору |
| `SUPABASE_URL`, `SUPABASE_KEY` | URL Supabase та серверний ключ із доступом до БД |
| `NODE_ENV` | `production` для зібраного застосунку |
| `PORT` | Порт, типово `3000` |
| `HOST` | Типово `127.0.0.1` у розробці, `0.0.0.0` у production |
| `APP_ORIGIN` | Зовнішня адреса, наприклад `https://docs.company.example`, без кінцевого `/` |
| `LOCAL_DATA_PATH` | Типово `.data/docai.json`, лише для локального режиму |
| `LOCAL_SETTINGS_DIR` | Типово `.data/settings`, локальні налаштування й ключі |

Без локальних налаштувань провайдер береться з `AI_PROVIDER`, інакше — перший налаштований у порядку OpenAI → Gemini → Anthropic. Без ключів початковий вибір — Gemini. Після збереження в UI використовуються збережені назва, провайдер і моделі. Ключі середовища завжди мають пріоритет. Для сумісності `GEMINI_API_KEY1` також читається й має пріоритет над `GEMINI_API_KEY`.

У production/на Vercel локальні налаштування не завантажуються; редагування та перевірка ключів у UI вимкнені. Перенесіть параметри в середовище розгортання. Секрети не повинні потрапляти в Git або змінні з префіксом `VITE_`.

## Supabase

Створіть окремий проєкт у погодженому регіоні. SQL нижче створює таблиці та додає поля до ранньої схеми. Перед застосуванням до існуючої БД зробіть резервну копію і звірте структуру. Команди зміни прав призначені для таблиць цього застосунку з доступом лише через сервер.

```sql
create table if not exists public.document_types (
  id bigint generated always as identity primary key,
  name text not null,
  slug text unique not null,
  prompt text not null,
  created_at timestamptz default now()
);
create table if not exists public.documents (
  id bigint generated always as identity primary key,
  filename text,
  original_name text,
  mime_type text,
  extracted_data jsonb,
  type_slug text,
  created_at timestamptz default now()
);
alter table public.documents
  add column if not exists status text default 'success',
  add column if not exists error_message text,
  add column if not exists ai_model text,
  add column if not exists prompt_tokens bigint default 0,
  add column if not exists completion_tokens bigint default 0;

alter table public.document_types enable row level security;
alter table public.documents enable row level security;
revoke all on table public.document_types, public.documents from anon, authenticated;
grant select, insert, update, delete on table public.document_types, public.documents to service_role;
grant usage, select on sequence public.document_types_id_seq, public.documents_id_seq to service_role;

insert into public.document_types (name, slug, prompt)
values ('Рахунок', 'invoice', 'Витягни номер, дату, постачальника, валюту та суму. Поверни JSON-об’єкт. Відсутні значення — null.')
on conflict (slug) do nothing;
```

Задайте `SUPABASE_URL` і серверний `SUPABASE_KEY` із правами `service_role`; `anon` за цією схемою доступу не має. Сервісний ключ обходить RLS, тому доступ до Express API захищають окремо. Схема не реалізує ізоляцію компаній. [Документація RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

Локальна історія не переноситься автоматично. Оригінали документів не зберігаються; для архіву потрібно додати приватне файлове сховище та логіку завантаження.

## Постійний Node.js-сервер

Після налаштування середовища та Supabase, у папці репозиторію:

```sh
npm ci
npm run build
NODE_ENV=production HOST=127.0.0.1 npm start
```

`npm start` використовує `tsx` із devDependencies: не застосовуйте `npm ci --omit=dev` без зміни складання backend. Для постійної роботи адміністратор налаштовує менеджер процесів, наприклад systemd.

Перед Express потрібен HTTPS reverse proxy. Задайте `APP_ORIGIN` для зовнішньої HTTPS-адреси, інакше перевірка Origin може відхилити запити запису через proxy. Ліміт proxy має вміщати файл до 10 MiB разом із multipart-формою; тайм-аут — до 120 секунд очікування AI плюс обробка й запис у БД.

Після розгортання перевіряють `/api/health`, шаблони, тестову обробку й читання результату за ID. Health показує наявність реквізитів, а не фактичну доступність AI/БД.

Без Supabase у production локальний режим вимкнений: історія не працює, а успішний parse може повернути незбережений результат. Налаштуйте БД перед використанням.

## Vercel

Є `api/index.ts` з експортом Express і `vercel.json` із API-rewrites та `maxDuration: 60`. Для приватного тестового розгортання імпортуйте потрібну гілку GitHub, використайте `npm run build`, каталог `dist`, Node.js 22+ та серверні змінні з таблиці. Задайте `APP_ORIGIN` для адреси розгортання.

- Ліміт тіла запиту Vercel Functions — 4.5 MB, менший за локальні 10 MiB; multipart теж займає місце. [Обмеження Vercel](https://vercel.com/docs/functions/limitations).
- Налаштовані 60 секунд функції менші за 120-секундний тайм-аут AI. Тривала обробка може перерватися раніше.
- Локальні файли не є production-сховищем. Потрібні Supabase та серверні секрети.
- Прямі завантаження у сховище, серверна черга й worker ще не реалізовані. Vercel-деплой цієї версії не перевірений.

## Резервні копії

Локально зупиніть процес перед копіюванням `.data/docai.json` і `.data/settings/`. Для відновлення ключів потрібні разом зашифрований файл та `master.key`; захищайте копію як секрет. Утрата ключа шифрування потребує повторного введення API-ключів.

Для Supabase налаштуйте доступний вашому плану спосіб резервування, термін зберігання та відновлення в окремому проєкті. Копія БД не містить самих об’єктів файлового сховища — архів резервують окремо. [Резервні копії Supabase](https://supabase.com/docs/guides/platform/backups).

Після відновлення перевіряють історію, шаблони, доступ і тестову обробку. Наступний етап — користувачі, ролі, серверна черга й журнал дій: [пояснення для компанії](docs/COMPANY_GUIDE.uk.md), [впровадження для розробника](docs/IMPLEMENTATION.uk.md).
