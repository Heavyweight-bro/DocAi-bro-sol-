import "./server/config";
import { localStore, persistLocal } from "./server/local-store";
import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { connection, publicSettings, updateSettings, canEditSettings, isProvider } from "./server/settings";
import { extractDocument, checkConnection } from "./server/providers";
import mammoth from "mammoth";
import * as xlsx from "xlsx";

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const isSupabaseConfigured = !!(supabaseUrl && supabaseKey && !supabaseUrl.includes("placeholder"));
const isLocalMode = !isSupabaseConfigured && !process.env.VERCEL && process.env.NODE_ENV !== "production";

const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseKey || "placeholder"
);

// Use memory storage for Vercel Serverless compatibility
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

const app = express();

// --- Middleware ---
app.use(cors({ origin: process.env.APP_ORIGIN || false }));
app.use(express.json({ limit: '32kb' }));
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== process.env.APP_ORIGIN) return res.status(403).json({ error: 'Запит з іншого сайту відхилено' });
  next();
});

// --- API Routes ---

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    supabaseConfigured: !!isSupabaseConfigured,
    aiConfigured: !!connection().key,
    provider: connection().provider,
    storage: isSupabaseConfigured ? "supabase" : isLocalMode ? "local" : "none",
    maxUploadBytes: 10 * 1024 * 1024,
    env: process.env.NODE_ENV,
    isVercel: !!process.env.VERCEL
  });
});

app.get('/api/settings', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ...publicSettings(), editable: canEditSettings(req) });
});
app.use('/api/settings', (req, res, next) => {
  if (!canEditSettings(req) || req.get('x-docai-settings') !== '1' || !req.is('application/json')) return res.status(403).json({ error: 'Зміна ключів доступна лише локально. На сервері використайте змінні середовища.' });
  next();
});
app.put('/api/settings', (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(updateSettings(req.body)); }
  catch (error: any) { res.status(400).json({ error: error.message }); }
});
app.post('/api/settings/test', async (req, res) => {
  if (!isProvider(req.body.provider)) return res.status(400).json({ error: 'Невідомий AI-провайдер' });
  try { res.json(await checkConnection(req.body.provider)); }
  catch (error: any) { res.status(400).json({ error: error.name === 'TimeoutError' ? 'Перевірка перевищила 15 секунд.' : error.message }); }
});

app.get("/api/types", async (req, res, next) => {
  try {
    if (isLocalMode) return res.json(localStore.types);
    if (!isSupabaseConfigured) {
      throw new Error("Supabase is not configured. Please add SUPABASE_URL and SUPABASE_KEY to environment variables.");
    }
    const { data, error } = await supabase.from("document_types").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data.map(t => ({ ...t, createdAt: t.created_at })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/types", async (req, res, next) => {
  try {
    const { name, slug, prompt } = req.body;
    if (![name, slug, prompt].every(v => typeof v === "string" && v.trim())) return res.status(400).json({ error: "Всі поля обов'язкові" });
    const safeSlug = slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(safeSlug) || safeSlug === 'custom') return res.status(400).json({ error: 'Slug: латинські літери, цифри та дефіси; custom зарезервовано.' });
    if (isLocalMode) {
      const id = Date.now();
      if (localStore.types.some(t => t.slug === safeSlug && t.id !== id)) return res.status(409).json({ error: 'Такий slug вже існує' });
      const record = { id, name: name.trim(), slug: safeSlug, prompt: prompt.trim() };
      localStore.types.unshift(record);
      persistLocal();
      return res.json(record);
    }
    if (!isSupabaseConfigured) throw new Error("Supabase not configured");

    const { data, error } = await supabase.from("document_types").insert([{ name, slug: safeSlug, prompt }]).select().single();
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: "Тип з таким ідентифікатором (slug) вже існує" });
      throw error;
    }
    res.json({ ...data, createdAt: data.created_at });
  } catch (error) {
    next(error);
  }
});

app.put("/api/types/:id", async (req, res, next) => {
  try {
    const { name, slug, prompt } = req.body;
    if (![name, slug, prompt].every(v => typeof v === "string" && v.trim())) return res.status(400).json({ error: "Всі поля обов'язкові" });
    const safeSlug = slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(safeSlug) || safeSlug === 'custom') return res.status(400).json({ error: 'Slug: латинські літери, цифри та дефіси; custom зарезервовано.' });
    if (isLocalMode) {
      const id = Number(req.params.id);
      if (localStore.types.some(t => t.slug === safeSlug && t.id !== id)) return res.status(409).json({ error: 'Такий slug вже існує' });
      const record = { id, name: name.trim(), slug: safeSlug, prompt: prompt.trim() };
      const index = localStore.types.findIndex(t => t.id === id);
      if (index < 0) return res.status(404).json({ error: 'Шаблон не знайдено' });
      localStore.types[index] = record;
      persistLocal();
      return res.json(record);
    }
    if (!isSupabaseConfigured) throw new Error("Supabase not configured");

    const { data, error } = await supabase.from("document_types").update({ name, slug: safeSlug, prompt }).eq("id", req.params.id).select().single();
    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: "Тип з таким ідентифікатором (slug) вже існує" });
      throw error;
    }
    if (!data) return res.status(404).json({ error: "Тип документа не знайдено" });
    res.json({ ...data, createdAt: data.created_at });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/types/:id", async (req, res, next) => {
  try {
    if (isLocalMode) {
      localStore.types = localStore.types.filter(t => t.id !== Number(req.params.id));
      persistLocal();
      return res.json({ success: true });
    }
    if (!isSupabaseConfigured) throw new Error("Supabase not configured");
    const { error } = await supabase.from("document_types").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/documents", async (req, res, next) => {
  try {
    if (isLocalMode) return res.json(localStore.documents);
    if (!isSupabaseConfigured) throw new Error("Supabase not configured");
    const { data, error } = await supabase.from("documents").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data.map(d => ({
      ...d,
      createdAt: d.created_at,
      originalName: d.original_name,
      mimeType: d.mime_type,
      typeSlug: d.type_slug,
      extractedData: typeof d.extracted_data === 'string' ? JSON.parse(d.extracted_data) : d.extracted_data
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id', async (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
    if (isLocalMode) {
      const document = localStore.documents.find(d => String(d.id) === req.params.id);
      return document ? res.json(document) : res.status(404).json({ error: 'Документ не знайдено' });
    }
    if (!isSupabaseConfigured) return res.status(503).json({ error: 'Сховище не налаштовано' });
    const { data: d, error } = await supabase.from('documents').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!d) return res.status(404).json({ error: 'Документ не знайдено' });
    return res.json({ ...d, originalName: d.original_name, mimeType: d.mime_type, typeSlug: d.type_slug, createdAt: d.created_at, extractedData: typeof d.extracted_data === 'string' ? JSON.parse(d.extracted_data) : d.extracted_data });
  } catch (error) { next(error); }
});

app.post(["/api/parse", "/api/parse/:slug"], upload.single("document"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Файл не надано" });
    if (!/\.(pdf|docx|xlsx|xls|csv|json|txt|png|jpe?g|webp)$/i.test(req.file.originalname)) return res.status(415).json({ error: 'Формат не підтримується. Використайте PDF, DOCX, Excel, CSV, JSON, TXT або зображення.' });
    const provider = req.body.provider || connection().provider;
    if (!isProvider(provider)) return res.status(400).json({ error: 'Невідомий AI-провайдер' });
    if (!connection(provider).key) return res.status(503).json({ error: 'Підключіть обраного AI-провайдера у налаштуваннях.' });

    const file = req.file;
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

    const slug = req.params.slug || req.body.slug;
    let prompt = req.body.prompt;

    if (slug && slug !== 'custom' && isSupabaseConfigured) {
      const { data: docType } = await supabase.from("document_types").select("prompt").eq("slug", slug).single();
      if (docType) {
        prompt = docType.prompt;
      } else if (!prompt) {
        return res.status(404).json({ error: `Тип документа '${slug}' не знайдено` });
      }
    }

    if (slug && slug !== 'custom' && isLocalMode) {
      const template = localStore.types.find(t => t.slug === slug);
      if (!template) return res.status(404).json({ error: 'Шаблон не знайдено' });
      prompt = template.prompt;
    }
    const extension = path.extname(file.originalname).toLowerCase();
    const mimeByExtension: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.json': 'application/json' };
    const mimeType = mimeByExtension[extension] || file.mimetype;
    let extractedData = {};
    let parseStatus = 'success';
    let errorMessage = '';
    let aiModelUsed = '';
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      let extractedText = "";
      let isMultimodal = false;
      let inlineData: any = null;

      if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || mimeType === "application/msword") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        extractedText = result.value;
      } else if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimeType === "application/vnd.ms-excel" || mimeType === "application/json") {
        if (mimeType === "application/json") {
          extractedText = file.buffer.toString("utf-8");
        } else {
          const workbook = xlsx.read(file.buffer, { type: "buffer" });
          const jsonData = Object.fromEntries(workbook.SheetNames.map(name => [name, xlsx.utils.sheet_to_json(workbook.Sheets[name])]));
          extractedText = JSON.stringify(jsonData);
        }
      } else if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
        isMultimodal = true;
        inlineData = {
          data: file.buffer.toString("base64"),
          mimeType: mimeType,
        };
      } else {
        extractedText = file.buffer.toString("utf-8");
      }

      const defaultPrompt = prompt || "Витягни всю ключову інформацію з цього документа та структуруй її у JSON об'єкт.";
      const result = await extractDocument(provider, { text: extractedText, prompt: defaultPrompt, filename: file.originalname, inlineData: inlineData || undefined });
      extractedData = result.data;
      aiModelUsed = result.model;
      promptTokens = result.inputTokens;
      completionTokens = result.outputTokens;
    } catch (processError: any) {
      console.error("Document processing failed:", provider);
      parseStatus = 'failed';
      errorMessage = processError.message || String(processError);
      extractedData = { error: errorMessage, status: 'failed' };
    }

    if (isSupabaseConfigured) {
      const insertData = {
        filename: file.originalname,
        original_name: file.originalname,
        mime_type: mimeType,
        extracted_data: extractedData,
        type_slug: slug || 'custom',
        status: parseStatus,
        error_message: errorMessage,
        ai_model: aiModelUsed,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens
      };

      let { data: insertedDoc, error: insertError } = await supabase.from("documents").insert([insertData]).select().single();

      // Fallback if status/error_message columns don't exist yet
      if (insertError && insertError.code === '42703') {
        const fallbackData = {
          filename: file.originalname,
          original_name: file.originalname,
          mime_type: mimeType,
          extracted_data: {
            ...extractedData,
            _status: parseStatus,
            _error: errorMessage,
            _ai_model: aiModelUsed,
            _prompt_tokens: promptTokens,
            _completion_tokens: completionTokens
          },
          type_slug: slug || 'custom'
        };
        const fallbackResult = await supabase.from("documents").insert([fallbackData]).select().single();
        insertedDoc = fallbackResult.data;
        insertError = fallbackResult.error;
      }

      if (insertError) throw insertError;

      if (parseStatus === 'failed') {
        return res.status(500).json({ error: errorMessage, id: insertedDoc.id });
      }

      res.json({
        id: insertedDoc.id,
        originalName: insertedDoc.original_name,
        typeSlug: insertedDoc.type_slug,
        extractedData: insertedDoc.extracted_data
      });
    } else {
      if (parseStatus === 'failed') {
        return res.status(500).json({ error: errorMessage, id: Date.now() });
      }
      const record = { aiModel: aiModelUsed, promptTokens, completionTokens, id: Date.now(), originalName: file.originalname, mimeType, typeSlug: slug || 'custom', extractedData, createdAt: new Date().toISOString() };
      if (isLocalMode) { localStore.documents.unshift(record); persistLocal(); }
      res.json(record);
    }

  } catch (error: any) {
    console.error("Parsing error:", error);
    next(error);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API-адресу не знайдено' }));

// --- Static Files & Vite ---

const setupStaticAndVite = async () => {
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.error("Vite setup failed:", e);
    }
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distPath, "index.html"), (err) => {
        if (err) res.status(404).send("Frontend missing");
      });
    });
  }
};

setupStaticAndVite();

// --- Error Handling ---
app.use('/api', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('API Error:', err);
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500).json({
    error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл перевищує ліміт 10 MB' : err.message || 'Внутрішня помилка сервера',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// --- Start ---
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"), () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

export default app;
