import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import mammoth from "mammoth";
import * as xlsx from "xlsx";

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const isSupabaseConfigured = supabaseUrl && !supabaseUrl.includes("placeholder");

const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co", 
  supabaseKey || "placeholder"
);

// Use memory storage for Vercel Serverless compatibility
const upload = multer({ storage: multer.memoryStorage() });

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- API Routes ---

app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    supabaseConfigured: !!isSupabaseConfigured,
    env: process.env.NODE_ENV,
    isVercel: !!process.env.VERCEL
  });
});

app.get("/api/types", async (req, res, next) => {
  try {
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
    if (!isSupabaseConfigured) throw new Error("Supabase not configured");
    const { name, slug, prompt } = req.body;
    if (!name || !slug || !prompt) return res.status(400).json({ error: "Всі поля обов'язкові" });
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
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
    if (!isSupabaseConfigured) throw new Error("Supabase not configured");
    const { name, slug, prompt } = req.body;
    if (!name || !slug || !prompt) return res.status(400).json({ error: "Всі поля обов'язкові" });
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
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

app.post(["/api/parse", "/api/parse/:slug"], upload.single("document"), async (req, res, next) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      return res.status(500).json({ error: "GEMINI_API_KEY не налаштовано." });
    }
    const ai = new GoogleGenAI({ apiKey });

    if (!req.file) return res.status(400).json({ error: "Файл не надано" });

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

    const mimeType = file.mimetype;
    let extractedText = "";
    let isMultimodal = false;
    let inlineData: any = null;

    if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || mimeType === "application/msword") {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      extractedText = result.value;
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimeType === "application/vnd.ms-excel") {
      const workbook = xlsx.read(file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      extractedText = xlsx.utils.sheet_to_csv(sheet);
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
    const contents: any = { parts: [] };

    if (isMultimodal && inlineData) {
      contents.parts.push({ inlineData });
    } else {
      contents.parts.push({ text: `Вміст документа:\n${extractedText}\n\n` });
    }
    contents.parts.push({ text: defaultPrompt });

    let extractedDataStr = "{}";
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: contents,
        config: { responseMimeType: "application/json" }
      });
      extractedDataStr = response.text || "{}";
    } catch (geminiError) {
      console.error("Gemini API failed, falling back to OpenAI:", geminiError);
      
      const openAiKey = process.env.OPENAI_API_KEY;
      if (!openAiKey) {
        throw new Error("Gemini API failed and OPENAI_API_KEY is not configured.");
      }
      
      const openai = new OpenAI({ apiKey: openAiKey });
      
      let openAiMessages: any[] = [
        { role: "system", content: "You are a document extraction assistant. Return ONLY valid JSON." }
      ];
      
      if (isMultimodal && inlineData) {
        openAiMessages.push({
          role: "user",
          content: [
            { type: "text", text: defaultPrompt },
            { type: "image_url", image_url: { url: `data:${inlineData.mimeType};base64,${inlineData.data}` } }
          ]
        });
      } else {
        openAiMessages.push({
          role: "user",
          content: `Вміст документа:\n${extractedText}\n\n${defaultPrompt}`
        });
      }
      
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: openAiMessages,
        response_format: { type: "json_object" }
      });
      
      extractedDataStr = completion.choices[0].message.content || "{}";
    }

    let extractedData = {};
    try {
      extractedData = JSON.parse(extractedDataStr);
    } catch (e) {
      console.error("Failed to parse Gemini response as JSON", e);
    }

    if (isSupabaseConfigured) {
      const { data: insertedDoc, error: insertError } = await supabase.from("documents").insert([{
        filename: file.originalname,
        original_name: file.originalname,
        mime_type: mimeType,
        extracted_data: extractedData,
        type_slug: slug || 'custom'
      }]).select().single();

      if (insertError) throw insertError;

      res.json({
        id: insertedDoc.id,
        originalName: insertedDoc.original_name,
        typeSlug: insertedDoc.type_slug,
        extractedData: insertedDoc.extracted_data
      });
    } else {
      res.json({
        id: Date.now(),
        originalName: file.originalname,
        typeSlug: slug || 'custom',
        extractedData
      });
    }

  } catch (error: any) {
    console.error("Parsing error:", error);
    next(error);
  }
});

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
  res.status(err.status || 500).json({ 
    error: err.message || 'Внутрішня помилка сервера',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// --- Start ---
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

export default app;
