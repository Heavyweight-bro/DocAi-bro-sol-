# API Doc.AI

Локальна адреса — `http://localhost:3000`. У розгортанні замініть її на свій домен.

Стабільний контракт для CRM: **`/api/v1/*`**. Старі маршрути `/api/parse` (sync) збережені для сумісності.

## Доступ

| Хто | Як | Роль |
|---|---|---|
| Людина в браузері | `POST /api/auth/login` → HttpOnly-cookie `docai_session` | з облікового запису: `viewer` / `operator` / `admin` |
| CRM, скрипт | `Authorization: Bearer <DOCAI_INTEGRATION_KEY>` або `X-DocAI-Key` | `operator` |
| Розробник локально | без користувачів, лише з цього комп’ютера (loopback) | `admin` |

Права: `viewer` — читання документів і шаблонів; `operator` — обробка, редагування, підтвердження; `admin` — шаблони, налаштування, користувачі, аудит, статистика, webhook-журнал.

Заголовок `Origin` **не** дає доступу — він лише відсікає міжсайтові запити (CSRF). `X-DocAI-Actor` уточнює, хто в CRM ініціював дію; в аудиті це `integration:<значення>`. Також: `X-DocAI-External-Ref` / поле `externalRef`, `Idempotency-Key` (у межах одного викликача).

Помилки: `{ "error": "…", "requestId": "…" }`. Для 5xx текст узагальнений, деталі — у логах сервера за `requestId`.

## Черга (рекомендовано)

| Метод | Шлях | Роль | Призначення |
|---|---|---|---|
| POST | `/api/v1/parse` / `/api/v1/parse/:slug` | operator | Поставити в чергу → **202** + `jobId` (повтор з тим самим `Idempotency-Key` → **200**, те саме завдання) |
| GET | `/api/v1/jobs/:id` | viewer | Статус завдання |
| GET | `/api/v1/jobs?limit=50` | viewer | Останні завдання |

```sh
curl -X POST http://localhost:3000/api/v1/parse/invoice \
  -H 'Authorization: Bearer dok_YOUR_KEY' \
  -H 'Idempotency-Key: order-42' \
  -H 'X-DocAI-Actor: crm@company' \
  -F 'document=@/path/invoice.pdf'
# 202 { "apiVersion":"v1", "jobId":"job_…", "status":"queued", "statusUrl":"…/api/v1/jobs/job_…", "created":true }
```

Статуси job: `queued` → `processing` → `completed` | `failed`. Після завершення є `documentId`, `documentStatus`, `aiModel`, `estimatedCostUsd`. Помилки AI повторюються з паузою (`DOCAI_JOB_MAX_ATTEMPTS`, типово 3); у історії лишається один документ. Завдання, перерване падінням воркера, повертається в чергу після `DOCAI_JOB_LEASE_MS`.

## Документи

| Метод | Шлях | Роль | Призначення |
|---|---|---|---|
| GET | `/api/v1/documents/:id` | viewer | Документ |
| GET | `/api/documents/:id/file` | viewer | Оригінал файлу (PDF/зображення/текст — inline, решта — завантаження; `?download=1`) |
| PATCH | `/api/v1/documents/:id` | operator | `{"extractedData":{…}}` — виправлення з повторною перевіркою схеми |
| POST | `/api/v1/documents/:id/review` | operator | `{"action":"approve"\|"reject","note":"…"}` |
| GET | `/api/documents` | viewer | Історія |

Статуси: `pending_review` (схема пройдена, чекає людину) · `invalid` (схема чи перевірки обліку не пройдені; підтвердити не можна) · `approved` / `rejected` · `completed` (шаблон без схеми) · `failed` (помилка AI).
Підтверджений документ не редагується (**409**) — спочатку відхиліть. `validationErrors[]` містить `path`, `message`, `severity` (`error` блокує, `warning` — ні).

Перевірки обліку для рахунку/акта: обов’язкові поля, дата `YYYY-MM-DD`, валюта ISO, суми-числа, **сума рядків (+ ПДВ) = підсумок**, `quantity × price = amount` (попередження), ставка ПДВ 20/14/7 % (попередження), **контрольні суми ЄДРПОУ/РНОКПП та IBAN**.

## Шаблони

| Метод | Шлях | Роль |
|---|---|---|
| GET | `/api/types`, `/api/schemas` (вбудовані схеми) | viewer |
| POST / PUT / DELETE | `/api/types`, `/api/types/:id` | admin |

Тіло: `name`, `slug`, `prompt`, опційно `schema`: `"invoice"` / `"act"` (вбудована) або `{"fields":[{"path":"payer.iban","type":"string","format":"iban","required":true,"label":"IBAN"}],"checks":["invoice-totals"]}`. Типи: `string`, `number`, `boolean`, `object`, `array`; формати: `date`, `money`, `currency`, `edrpou`, `iban`.

## Webhook

```env
DOCAI_WEBHOOK_URL=https://crm.example/hooks/docai
DOCAI_WEBHOOK_SECRET=whsec_…
```

Тіло: `{ "id":"evt_…", "apiVersion":"v1", "type":"document.pending_review", "createdAt":"…", "workspaceId":"default", "data":{ "documentId":123, "jobId":"job_…", "status":"pending_review", … } }`

Події: `document.pending_review`, `document.approved`, `document.rejected`, `document.failed`, `document.invalid`, `document.updated`, `job.completed`, `job.failed`.

Заголовки: `X-DocAI-Event`, `X-DocAI-Delivery` (незмінний при повторах — для дедуплікації), `X-DocAI-Attempt`, `X-DocAI-Timestamp`,
`X-DocAI-Signature-256: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` (перевіряйте й відхиляйте `t` старше 5 хв) та `X-DocAI-Signature: sha256=<hex HMAC-SHA256(secret, body)>` (сумісність).

Доставка через outbox: відповідь не-2xx або мережева помилка → повтор через 1 хв, 5 хв, 30 хв, 2 год, 6 год, 24 год; далі `failed`. Журнал і ручний повтор (admin): `GET /api/v1/webhooks`, `POST /api/v1/webhooks/:id/redeliver`.

## Аудит, витрати, статистика (admin)

- `GET /api/v1/audit?limit=100` — події: `actor`, `provider`, `model`, `promptTokens`, `completionTokens`, `durationMs`, `estimatedCostUsd`, `detail`.
- `GET /api/v1/stats?days=30` — підсумки, витрати й документи за днями, розріз за моделями й шаблонами, **точність з першого разу** (частка перевірених документів, підтверджених без виправлень), ескалації, повтори.

Вартість — оцінка за тарифами з `server/cost.ts` (можна перевизначити `DOCAI_MODEL_PRICES`), не рахунок провайдера.

## Фонова обробка без постійного процесу

`GET|POST /api/internal/worker-tick` з `Authorization: Bearer <DOCAI_CRON_SECRET або CRON_SECRET>` — обробляє чергу й повтори webhook-ів протягом `budgetMs` (типово 45 с). Для Vercel Cron або зовнішнього планувальника.

## Legacy sync

`POST /api/parse` / `/api/parse/:slug` (operator) — синхронна відповідь 200 / 422 (схема) / 500 (AI). Також пише аудит і webhook.

## Інші маршрути

| Метод | Шлях | Призначення |
|---|---|---|
| GET | `/api/health` | Без входу: лише `status`, `apiVersions`. З входом: конфігурація, сховище, черга |
| GET | `/api/auth/me` · POST `/api/auth/login` · POST `/api/auth/logout` | Сесія |
| GET / PUT / DELETE | `/api/users`, `/api/users/:email` | Користувачі (admin; змінювати — лише локально, на сервері `DOCAI_USERS`) |
| GET / PUT | `/api/settings` | Налаштування (зміна — admin і лише локально) |
