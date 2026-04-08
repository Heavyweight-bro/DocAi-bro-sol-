# Інструкція з розгортання на Vercel + Supabase

Перехід на Vercel та Supabase — це правильне рішення, оскільки Vercel використовує **Serverless (безсерверну)** архітектуру. 

У Serverless середовищі файлова система є тимчасовою. Це означає, що локальна база даних SQLite (`documents.db`) та локальне збереження файлів (`uploads/`) **не будуть працювати** на Vercel (вони будуть видалятися при кожному новому запиті).

Ось детальний план того, що потрібно зробити для успішного деплою.

---

## Крок 1: Налаштування бази даних Supabase

1. Зареєструйтесь на [Supabase](https://supabase.com/) та створіть новий проект.
2. Перейдіть у розділ **SQL Editor** і виконайте наступний SQL-скрипт для створення таблиць:

```sql
-- Створення таблиці для шаблонів
CREATE TABLE document_types (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Створення таблиці для збереження історії документів
CREATE TABLE documents (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  filename TEXT,
  original_name TEXT,
  mime_type TEXT,
  extracted_data JSONB,
  type_slug TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Додавання базового шаблону
INSERT INTO document_types (name, slug, prompt) 
VALUES ('Інвойс', 'invoice', 'Витягни номер інвойсу, дату, загальну суму, валюту та список товарів (назва, кількість, ціна). Поверни виключно у форматі JSON.');
```

3. Перейдіть у розділ **Project Settings -> API** та скопіюйте:
   - `Project URL` (це буде ваш `SUPABASE_URL`)
   - `Project API keys -> anon` або `service_role` (це буде ваш `SUPABASE_KEY`)

---

## Крок 2: Зміни в коді (Що потрібно переписати)

Щоб додаток працював на Vercel, нам потрібно внести три ключові зміни в код (я можу зробити це для вас, якщо ви скажете "Так, перепиши код"):

### 1. Заміна SQLite на Supabase
Нам потрібно встановити клієнт Supabase:
```bash
npm install @supabase/supabase-js
```
І замінити всі виклики `db.prepare(...).run()` на виклики API Supabase, наприклад:
```javascript
const { data, error } = await supabase.from('document_types').select('*');
```

### 2. Зміна способу завантаження файлів (Multer)
Зараз файли зберігаються на диск: `multer({ dest: "uploads/" })`.
На Vercel це викличе помилку. Нам потрібно зберігати файли в оперативній пам'яті (Buffer), поки вони обробляються Gemini:
```javascript
const upload = multer({ storage: multer.memoryStorage() });
```
І змінити логіку читання файлів (наприклад, `mammoth` та `xlsx` вміють читати напряму з буфера, без збереження на диск).

### 3. Адаптація Express для Vercel
Vercel очікує, що бекенд буде експортувати функцію (або додаток Express), а не запускати сервер через `app.listen(3000)`. 
Нам потрібно буде створити файл `vercel.json` для маршрутизації запитів:
```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index.js" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

---

## Крок 3: Розгортання на Vercel

1. Завантажте ваш проект на GitHub.
2. Зареєструйтесь на [Vercel](https://vercel.com/) та натисніть **"Add New..." -> "Project"**.
3. Імпортуйте ваш репозиторій з GitHub.
4. У розділі **Environment Variables** додайте наступні змінні:
   - `GEMINI_API_KEY` = ваш ключ Gemini
   - `SUPABASE_URL` = URL вашого проекту Supabase
   - `SUPABASE_KEY` = ваш ключ Supabase
5. Натисніть **Deploy**.

Vercel автоматично розпізнає, що це Vite-проект, збере фронтенд і налаштує бекенд.

---

## Що робити прямо зараз?

Якщо ви готові переходити на Supabase, **напишіть мені: "Адаптуй код для Supabase та Vercel"**. 

Я автоматично:
1. Видалю `better-sqlite3` та встановлю `@supabase/supabase-js`.
2. Перепишу всі маршрути `/api/*` для роботи з Supabase.
3. Перероблю завантаження файлів на `memoryStorage` (щоб працювало на Vercel).
4. Підготую конфігурацію `vercel.json`.

Після цього вам залишиться лише експортувати код (через меню AI Studio), залити на GitHub і підключити до Vercel!
