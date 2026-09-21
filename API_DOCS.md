# API Doc.AI

Локальна адреса — `http://localhost:3000`. У розгортанні замініть її на свій домен. Входу користувачів, інтеграційних API-ключів і перевірки належності документа компанії поки немає; віддалений доступ потребує зовнішнього захисту.

## Маршрути

| Метод | Шлях | Призначення |
|---|---|---|
| GET | `/api/health` | Наявність конфігурації та ліміт файлу |
| GET | `/api/settings` | Налаштування без секретів |
| PUT | `/api/settings` | Зміна локальних налаштувань |
| POST | `/api/settings/test` | Перевірка збереженого ключа |
| GET / POST | `/api/types` | Список / створення шаблону |
| PUT / DELETE | `/api/types/:id` | Оновлення / видалення шаблону |
| POST | `/api/parse` | Обробка з власною інструкцією |
| POST | `/api/parse/:slug` | Обробка за шаблоном |
| GET | `/api/documents` | Історія без серверної пагінації |
| GET | `/api/documents/:id` | Збережений результат за ID |

## Обробка

Тіло — `multipart/form-data`. Поле `document` обов’язкове, один файл на запит. Необов’язкові поля: `provider` (`openai`, `gemini`, `anthropic`), `prompt`, `slug`. Типово використовується провайдер із налаштувань. Slug у URL має пріоритет над полем форми; знайдений шаблон замінює переданий prompt своєю інструкцією. `custom` означає обробку без шаблону.

```sh
curl --fail-with-body http://localhost:3000/api/parse/invoice \
  -F 'document=@/absolute/path/invoice.pdf' \
  -F 'provider=openai'

curl --fail-with-body http://localhost:3000/api/parse \
  -F 'document=@/absolute/path/contract.docx' \
  -F 'provider=anthropic' \
  --form-string 'prompt=Поверни JSON: parties, signed_at, amount, currency. Дати YYYY-MM-DD, суми числами, відсутні значення null.'
```

Без prompt і шаблону застосовується загальна інструкція витягти ключову інформацію. Невідомий шаблон локально повертає 404; у Supabase-обробнику за наявності явного prompt можливе продовження без знайденого шаблону.

Ключі AI беруться із сервера. Помилка провайдера не запускає іншого автоматично. PDF, DOCX, XLSX/XLS, CSV, JSON, TXT, PNG, JPG/JPEG, WebP — до `10485760` байтів на файл. Хостинг може мати менший ліміт. Повної перевірки сигнатури вмісту ще немає; підтримка PDF/зображень залежить від моделі.

Обробка синхронна: відповідь надходить після AI та запису результату. Маршрутів `/jobs`, відповіді `202 + jobId` і webhooks немає.

Основні поля відповіді `200` (ілюстрація):

```json
{
  "id": 123,
  "originalName": "invoice.pdf",
  "typeSlug": "invoice",
  "extractedData": {"invoice_number": "INV-42", "currency": "EUR", "total": 250}
}
```

Локальна відповідь додатково містить `mimeType`, `createdAt`, `aiModel`, `promptTokens`, `completionTokens`. У Supabase відповідь parse містить основні поля; метадані доступні в історії. Поля `extractedData` залежать від промпту: перевіряється JSON-об’єкт, але не бізнес-схема.

## Шаблони

POST та PUT очікують непорожні рядки `name`, `slug`, `prompt`. Slug нормалізується до нижнього регістру, дозволені латинські літери, цифри й одиночні дефіси між частинами; `custom` зарезервовано.

```sh
curl --fail-with-body http://localhost:3000/api/types \
  -H 'Content-Type: application/json' \
  -d '{"name":"Договір оренди","slug":"rent-agreement","prompt":"Поверни JSON: landlord, tenant, monthly_amount. Відсутні дані — null."}'
```

Відповідь `200` — об’єкт з `id`, `name`, `slug`, `prompt`. Для оновлення надішліть такий самий JSON методом `PUT /api/types/:id`. Видалення повертає `{"success":true}` і не видаляє історію оброблених документів. GET повертає масив шаблонів.

## Збережені результати

```sh
curl --fail-with-body http://localhost:3000/api/documents
curl --fail-with-body http://localhost:3000/api/documents/123
```

Другий запит повертає один об’єкт, ID — додатне ціле число. AI повторно не викликається, оригінальний файл не повертається.

Спільні поля: `id`, `originalName`, `mimeType`, `typeSlug`, `extractedData`, `createdAt`. Локальні метадані AI: `aiModel`, `promptTokens`, `completionTokens`; у Supabase — `ai_model`, `prompt_tokens`, `completion_tokens`, `status`, `error_message`. Supabase-відповіді також залишають початкові поля snake_case.

Локально зберігаються лише успішні обробки. У Supabase збої обробки записуються, якщо БД доступна, після чого повертається `500` з `error` та `id`. ID у локальній помилці не означає наявності збереженого запису.

## Налаштування

GET повертає `companyName`, `provider`, `editable`, масив `providers` з полями `id`, `model`, `configured`, `source`. Джерело ключа: `environment`, `local` або `none`. Секрети не повертаються; заголовок відповіді — `Cache-Control: no-store`.

PUT і POST test доступні лише локально в development: loopback-з’єднання, локальний Host, сумісний Origin, `Content-Type: application/json` та `X-DocAI-Settings: 1`. У production/Vercel — `403`.

```sh
curl --fail-with-body -X PUT http://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -H 'X-DocAI-Settings: 1' \
  -d '{"companyName":"Компанія","provider":"openai"}'

curl --fail-with-body http://localhost:3000/api/settings/test \
  -H 'Content-Type: application/json' \
  -H 'X-DocAI-Settings: 1' \
  -d '{"provider":"openai"}'
```

Для збереження підключення PUT приймає `{"connection":{"provider":"openai","key":"YOUR_API_KEY_HERE","model":"gpt-4o-mini"}}`. Це приклад структури, ключ — заповнювач. Справжній ключ краще вводити в UI, щоб не залишати його в історії команд.

Порожнє/відсутнє `key` зберігає поточний ключ; `connection.removeKey: true` видаляє локальний. Ключ середовища через API змінити чи видалити не можна. Збереження повертає публічні налаштування.

Test запитує список моделей із тайм-аутом 15 секунд, повертає `success`, `models`, `message`. Список може бути неповним; баланс, inference і сумісність вибраної моделі з документом не перевіряються.

## Health і помилки

Health повертає `status`, `supabaseConfigured`, `aiConfigured`, `provider`, `storage`, `maxUploadBytes`, `isVercel` та `env`, якщо задано `NODE_ENV`. `storage` — `local`, `supabase` або `none`. Це наявність налаштувань, а не перевірка доступності зовнішніх сервісів.

Помилка зазвичай має JSON-поле `error`, іноді `id`; у development загальний обробник може додати `details` зі стеком.

| HTTP | Випадки |
|---|---|
| 400 | Некоректні поля/provider/ID, помилка перевірки ключа; дубль slug у Supabase |
| 403 | Заборонені налаштування або браузерний запис з іншого Origin |
| 404 | Невідомий маршрут, відсутній документ або шаблон у відповідних обробниках |
| 409 | Дубль slug локально |
| 413 | Файл понад 10 MiB або JSON-тіло понад 32 KiB |
| 415 | Непідтримуване розширення файлу |
| 500 | Збій обробки/парсера/БД; статус AI-помилки не передається напряму |
| 503 | Відсутній ключ AI; немає сховища при читанні документа за ID |

Без Supabase у production інші операції зі сховищем можуть повертати `500`, а успішний parse не гарантує збереження. [Налаштуйте БД](DEPLOYMENT_GUIDE.md) перед інтеграцією.
