# Doc.AI

A Ukrainian-language document extraction workspace built with React, Vite and Express. Upload PDF, DOCX, Excel, CSV, JSON, TXT or images; extract structured JSON with Gemini; manage extraction templates and browse/export results.

## Local development

Requires Node.js 22+.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Frontend and API run on the same origin; no requests are sent to a hardcoded deployment.

Without API credentials, file selection, previews and template management work, but AI extraction is explicitly disabled. Add `GEMINI_API_KEY` to `.env.local` and restart to enable it. `OPENAI_API_KEY` optionally enables the existing fallback.

Without Supabase credentials in development, templates and extraction history persist in `.data/docai.json`, excluded from git. This is a single-user local store, not a production database. Production/Vercel should use `SUPABASE_URL` and `SUPABASE_KEY` with the tables described in DEPLOYMENT_GUIDE.md. Local data is not automatically migrated to Supabase.

Uploads are limited to 10 MB per file by this server. Hosting providers may enforce a smaller request limit (particularly serverless deployments). Excel extraction preserves all worksheets; spreadsheet support is loaded only when needed.

## Checks

```sh
npm run lint
npm run build
npx playwright install chromium
npm run test:smoke
```

The smoke test starts an isolated development server on port 3100 with a temporary local database. It tests API template CRUD, validation, upload limits, navigation, queue UI and responsive layout. It does not invoke a real AI provider. Run it without real provider/database credentials.

## Deployment and next steps

See [IMPROVEMENTS.md](IMPROVEMENTS.md) for changes, limitations and a prioritized roadmap. Existing [API_DOCS.md](API_DOCS.md) and [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) contain the original API/schema reference. In API examples, use your deployment origin.
