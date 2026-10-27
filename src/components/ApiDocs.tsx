import React from 'react';

const Code = ({ children }: { children: string }) => <pre className="bg-gray-900 text-gray-100 p-4 rounded-md text-sm font-mono overflow-x-auto">{children}</pre>;
const C = ({ children }: { children: React.ReactNode }) => <code className="text-xs bg-gray-100 px-1 rounded">{children}</code>;

export default function ApiDocs() {
  const origin = window.location.origin;
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-semibold mb-1">API та інтеграції</h2>
        <p className="text-gray-500 text-sm">Інструкція для підключення CRM, облікових систем і скриптів.</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-6">
        <div>
          <h3 className="text-lg font-medium mb-2">Базовий URL</h3>
          <code className="block bg-gray-50 p-3 rounded-md border border-gray-100 text-sm font-mono text-gray-800">{origin}</code>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-2">Доступ</h3>
          <p className="text-sm text-gray-600 mb-3">
            Люди входять через email і пароль (ролі: перегляд, оператор, адміністратор). Сервіси використовують інтеграційний ключ
            {' '}<C>DOCAI_INTEGRATION_KEY</C> (або кілька через кому в <C>DOCAI_INTEGRATION_KEYS</C>) з правами оператора:
            обробка, редагування й підтвердження документів. Шаблони, налаштування й аудит — лише адміністратор.
          </p>
          <Code>{`Authorization: Bearer dok_••••
# або
X-DocAI-Key: dok_••••
# хто саме в CRM ініціював дію (потрапляє в аудит як integration:<значення>)
X-DocAI-Actor: crm@company`}</Code>
          <p className="text-sm text-gray-600 mt-2">Ліміт: <C>DOCAI_RATE_LIMIT_PER_MIN</C> (типово 60). Журнал звернень: <C>.data/settings/integration-access.jsonl</C>.</p>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-2">Обробка через чергу (рекомендовано)</h3>
          <p className="text-sm text-gray-600 mb-3">Сервер одразу відповідає <C>202</C> і <C>jobId</C>; воркер обробляє файл незалежно від браузера. Повтор із тим самим <C>Idempotency-Key</C> повертає те саме завдання.</p>
          <Code>{`curl -X POST ${origin}/api/v1/parse/invoice \\
  -H "Authorization: Bearer dok_YOUR_KEY" \\
  -H "Idempotency-Key: crm-order-42" \\
  -H "X-DocAI-External-Ref: order-42" \\
  -F "document=@/path/to/file.pdf"

# → 202 { "jobId":"job_…", "status":"queued", "statusUrl":"…/api/v1/jobs/job_…" }
curl ${origin}/api/v1/jobs/JOB_ID -H "Authorization: Bearer dok_YOUR_KEY"
# → { "status":"completed", "documentId":123, "documentStatus":"pending_review", "estimatedCostUsd":0.0004 }`}</Code>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-2">Документ: читання, виправлення, рішення</h3>
          <Code>{`GET   ${origin}/api/v1/documents/123
GET   ${origin}/api/documents/123/file        # оригінал файлу
PATCH ${origin}/api/v1/documents/123          # {"extractedData":{…}} → повторна перевірка схеми
POST  ${origin}/api/v1/documents/123/review   # {"action":"approve"|"reject","note":"…"}`}</Code>
          <ul className="text-sm text-gray-600 list-disc pl-5 space-y-1 mt-3">
            <li><code>pending_review</code> — схема пройдена, потрібне підтвердження людини</li>
            <li><code>invalid</code> — схема чи перевірки обліку не пройдені (сума рядків, ЄДРПОУ, IBAN…); виправте через PATCH</li>
            <li><code>approved</code> / <code>rejected</code> — рішення; підтверджений документ змінити не можна (409)</li>
            <li><code>completed</code> — шаблон без схеми (переклад, summary); <code>failed</code> — помилка AI</li>
          </ul>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-2">Webhook</h3>
          <p className="text-sm text-gray-600 mb-3">
            <C>DOCAI_WEBHOOK_URL</C> + <C>DOCAI_WEBHOOK_SECRET</C>. Події зберігаються в outbox і повторюються при збоях (1 хв, 5 хв, 30 хв, 2 год, 6 год, 24 год).
            Одна й та сама подія має незмінний <C>X-DocAI-Delivery</C> — використовуйте його для дедуплікації.
          </p>
          <Code>{`X-DocAI-Event: document.pending_review | document.approved | document.rejected | document.invalid
               document.failed | document.updated | job.completed | job.failed
X-DocAI-Timestamp: 1790630000
X-DocAI-Signature-256: t=1790630000,v1=<hex HMAC-SHA256("<t>.<body>")>   # відхиляйте t старше 5 хв
X-DocAI-Signature: sha256=<hex HMAC-SHA256(body)>                        # сумісність`}</Code>
          <p className="text-sm text-gray-600 mt-2">Журнал доставок і повторна відправка (адміністратор): <C>GET /api/v1/webhooks</C>, <C>POST /api/v1/webhooks/:id/redeliver</C>.</p>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-2">Аудит, витрати, статистика (адміністратор)</h3>
          <Code>{`GET ${origin}/api/v1/audit?limit=100
GET ${origin}/api/v1/stats?days=30`}</Code>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-2">Синхронна обробка (сумісність)</h3>
          <p className="text-sm text-gray-600 mb-3"><C>POST /api/parse/:slug</C> чекає на AI і відповідає 200 / 422 (схема) / 500. Для нових інтеграцій використовуйте чергу.</p>
          <Code>{`curl -X POST ${origin}/api/parse \\
  -H "Authorization: Bearer dok_YOUR_KEY" \\
  -F "document=@/path/to/your/file.pdf" \\
  -F "prompt=Витягни ім'я та суму у форматі JSON"`}</Code>
        </div>

        <div>
          <h3 className="text-lg font-medium mb-2">Фонова обробка без постійного сервера</h3>
          <p className="text-sm text-gray-600">На Vercel воркер у процесі вимкнено. Викликайте <C>/api/internal/worker-tick</C> за розкладом із <C>Authorization: Bearer $DOCAI_CRON_SECRET</C> (Vercel Cron передає <C>CRON_SECRET</C> сам) або запустіть <C>npm run worker</C> на окремій машині.</p>
        </div>
      </div>
    </div>
  );
}
