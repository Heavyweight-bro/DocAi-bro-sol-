# Шаблон користувача як головна інструкція

## Зміна

Раніше системний промпт завжди вимагав JSON, тож задачі на кшталт «Переклади українською» все одно повертали об’єкт.

Тепер:

1. **Головна інструкція** — текст шаблону / власного промпту (`USER TASK`).
2. **Системний шар** — лише безпека (документ ≠ інструкції) і правила формату *за типом задачі*.
3. **JSON** вмикається, якщо в промпті є вимога JSON / витяг полів.
4. **Текст** (переклад, summary) — якщо промпт про переклад/резюме без слова JSON; зберігається як `{ "format": "text", "content": "..." }`.
5. UI показує текст або JSON; експорт — `.txt` або `.json`.
6. У `PromptGuide` — розширений набір заготовок: рахунки, акти, ТТН, договори, виписки, платіжки, payslip, ПН, CV, листи, переклади, summary, чеклісти.
7. Багатосторінкові PDF: текст знімається з **кожної** сторінки з маркерами `Page N of M`, передається моделі разом із файлом; збільшено ліміт відповіді; при обрізанні — зрозуміла помилка.

Файли: `server/providers.ts`, `src/App.tsx`, `src/components/PromptGuide.tsx`.

---

# P0: бойова готовність обліку

## Огляд

1. **Схеми** (`server/schemas.ts`) — після parse для `invoice` / `act` перевіряються обов’язкові поля (дата, сума, валюта ISO, рядки). Невірна схема → статус `invalid`, HTTP **422**, запис зберігається з `validationErrors`.
2. **Статуси** — `pending_review` → людина підтверджує або відхиляє (`POST /api/documents/:id/review` → `approved` / `rejected`). Шаблони без схеми → `completed`.
3. **Інтеграційний ключ** — `DOCAI_INTEGRATION_KEY(S)` + `Authorization: Bearer` / `X-DocAI-Key`; UI з того ж origin без ключа; rate limit і журнал `.data/settings/integration-access.jsonl`.
4. **Архів файлів** — локально `.data/files`; у Supabase — приватний Storage (`SUPABASE_STORAGE_BUCKET`), шлях у `storage_path`.
5. **UI** — бейджі статусів у черзі/історії, помилки схеми, кнопки Підтвердити / Відхилити.

Файли: `server/schemas.ts`, `server/integration.ts`, `server/files.ts`, `app.ts`, `src/App.tsx`, `.env.example`, `API_DOCS.md`, `DEPLOYMENT_GUIDE.md`.

---

# Azure OpenAI та Azure Claude

У налаштуваннях додано провайдери **Azure · OpenAI** і **Azure · Claude** (AI Foundry).

- Azure OpenAI: `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` + ім’я **deployment** як модель (+ опційно `AZURE_OPENAI_API_VERSION`).
- Azure Claude: `AZURE_CLAUDE_API_KEY` + `AZURE_CLAUDE_ENDPOINT` (`https://….services.ai.azure.com`) + model id; виклик через Anthropic-сумісний `/anthropic/v1/messages` з заголовком `api-key`.

Файли: `server/models.ts`, `server/settings.ts`, `server/providers.ts`, `src/components/Settings.tsx`.

---

# Черга, API v1, webhook, аудит

## Огляд

1. **Серверна черга** — `POST /api/v1/parse` зберігає файл і повертає **202 + jobId**. In-process worker (`.data/jobs.json`) обробляє завдання з повторами при збої AI. UI опитує `GET /api/v1/jobs/:id`. Sync `POST /api/parse` лишається для сумісності.
2. **Контракт v1** — маршрути під `/api/v1/*` (`parse`, `jobs`, `documents`, `review`, `audit`, `health`). Заголовки: `Idempotency-Key`, `X-DocAI-Actor`, `X-DocAI-External-Ref`.
3. **Webhook** — `DOCAI_WEBHOOK_URL` + `DOCAI_WEBHOOK_SECRET`; події `document.pending_review` / `approved` / `rejected` / `failed` / `invalid`, `job.completed` / `job.failed`; підпис `X-DocAI-Signature: sha256=…`.
4. **Аудит і вартість** — `.data/settings/audit.jsonl` + `GET /api/v1/audit` (актор, провайдер, модель, токени, `durationMs`, `estimatedCostUsd`).

Файли: `server/jobs.ts`, `server/worker.ts`, `server/process-document.ts`, `server/v1.ts`, `server/webhooks.ts`, `server/audit.ts`, `server/cost.ts`, `app.ts`, `src/App.tsx`.

---

# Вхід, екран перевірки, черга в Postgres, аналітика

Коротко (детально — [IMPROVEMENTS.md](IMPROVEMENTS.md), [API_DOCS.md](API_DOCS.md), [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)):

1. **Доступ** — `server/auth.ts`: користувачі й ролі, сесійна cookie; `Origin` більше не дає доступу. Права на шаблони/налаштування/аудит — admin.
2. **Перевірка** — `src/components/ReviewPanel.tsx`: оригінал + поля, `PATCH /api/v1/documents/:id`, заморожування підтверджених.
3. **Схеми** — `server/schemas.ts`: перевірки обліку (суми, ПДВ, ЄДРПОУ/РНОКПП, IBAN) і власні поля шаблону (`SchemaBuilder`).
4. **Черга** — `server/jobs.ts`: файлова або Postgres (`db/schema.sql`, `docai_claim_job`), lease, окремий `npm run worker`, `/api/internal/worker-tick`.
5. **Webhook outbox** — `server/webhooks.ts`; **аудит** — `server/audit.ts`; **статистика** — `server/stats.ts` + `Analytics.tsx`.
6. **Ескалація моделі** — `*_ESCALATION_MODEL` у `server/process-document.ts`.
