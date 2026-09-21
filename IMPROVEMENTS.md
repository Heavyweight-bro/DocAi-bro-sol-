# Review and improvements

## Implemented

- Replaced hardcoded Vercel API calls with same-origin requests, avoiding accidental uploads from local development to an unrelated live deployment.
- Added a responsive workspace with service status, actual document/template/session counts, upload guidance and explicit missing-AI-key state.
- Added local development storage for templates/history and sample extraction templates. No fake AI responses or invented document history.
- Load `.env.local`/`.env` on the server; remove AI key substitutions from Vite's browser build configuration.
- Validate template slugs and upload extensions/size, reject empty client files, deduplicate queue uploads, allow individual removal and retry.
- Keep active previews synchronized with queue status; protect the active queue from clearing and configuration changes; prevent duplicate processing effects.
- Add JSON downloads, history JSON copy, search and refresh; show API failures instead of silently ignoring them.
- Preserve every Excel worksheet, including names; defer the spreadsheet library download until needed.
- Use `node --import tsx` for startup to avoid an unnecessary CLI IPC dependency.

## Highest-priority follow-up work

1. Authentication and authorization: APIs currently have no user access control. Before a shared/public deployment, introduce sign-in, ownership checks, tenant isolation and Supabase RLS; restrict CORS to intended origins.
2. Durable background jobs: processing is synchronous and the browser queue is lost on refresh. Add a persisted queue, job IDs, cancellation, backoff and resumable uploads. Use object storage for uploads that exceed serverless request limits.
3. Extraction quality: define JSON schemas per template, validate model output, show missing fields and provide human review before downstream posting. Validate against a representative document corpus.
4. Observability and pagination: add request IDs, timing/cost metrics and bounded/paginated history queries. Avoid logging document data/provider error details in production.
5. Parser hardening: MIME/content verification, decompression limits and spreadsheet dependency review. Extension and upload-size checks alone do not protect against malformed documents.
6. AI provider configuration: make models configurable and validate the selected models against the actual account. The inherited Gemini model and OpenAI fallback have not been verified with live credentials; scanned PDF fallback currently depends on text extraction.
7. Maintainability/accessibility: split the large App component into queue, templates, history and preview modules; complete modal focus trapping and keyboard/screen-reader testing.

## Scope and known limitations

- Local file storage is for development only; it is not transactional or suitable for multiple server instances. Original uploads are held in memory during processing and are not retained in the local history.
- Legacy `.doc` is not supported by the existing DOCX parser; the UI now offers `.docx` rather than promising unsupported `.doc` parsing.
- The API continues to preserve its existing response shape. Excel uploads converted to JSON may be recorded with a `.json` suffix in server-side history.
- AI extraction still requires a Gemini key; OpenAI is a fallback, not an independently selectable primary provider.
- Production deployment, authentication and real AI inference are outside this local verification.

## Verification

- TypeScript (`npm run lint`) and production build pass.
- API smoke checks pass: health, template creation/update/deletion, duplicate/invalid slugs, oversized uploads.
- Headless Chromium checks pass at desktop and 390px mobile widths: file selection, missing-key state, preview/Escape, navigation, history search, no horizontal overflow, no page exceptions.
- Desktop and mobile screenshots were visually reviewed; see docs/screenshots/.
- Real AI inference and Supabase integration were not exercised because credentials were not configured.
