import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import cors from "cors";
import path from "path";
import Database from "better-sqlite3";
import { GoogleGenAI } from "@google/genai";
import mammoth from "mammoth";
import * as xlsx from "xlsx";
import fs from "fs";

// Initialize Database
const db = new Database("documents.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS document_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    prompt TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    originalName TEXT,
    mimeType TEXT,
    extractedData TEXT,
    typeSlug TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: Add typeSlug to existing documents table if it doesn't exist
try {
  const columns = db.prepare("PRAGMA table_info(documents)").all() as any[];
  const hasTypeSlug = columns.some(col => col.name === 'typeSlug');
  if (!hasTypeSlug) {
    db.exec("ALTER TABLE documents ADD COLUMN typeSlug TEXT DEFAULT 'custom'");
  }
} catch (e) {
  console.error("Migration error:", e);
}

// Insert default type if empty
const typeCount = db.prepare("SELECT COUNT(*) as count FROM document_types").get() as { count: number };
if (typeCount.count === 0) {
  db.prepare(`INSERT INTO document_types (name, slug, prompt) VALUES (?, ?, ?)`).run(
    "Інвойс", 
    "invoice", 
    "Витягни номер інвойсу, дату, загальну суму, валюту та список товарів (назва, кількість, ціна). Поверни виключно у форматі JSON."
  );
}

const upload = multer({ dest: "uploads/" });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // --- API Routes ---

  // Get all document types
  app.get("/api/types", (req, res) => {
    try {
      const types = db.prepare("SELECT * FROM document_types ORDER BY createdAt DESC").all();
      res.json(types);
    } catch (error) {
      res.status(500).json({ error: "Не вдалося отримати типи документів" });
    }
  });

  // Create a new document type
  app.post("/api/types", (req, res) => {
    try {
      const { name, slug, prompt } = req.body;
      if (!name || !slug || !prompt) {
        return res.status(400).json({ error: "Всі поля обов'язкові" });
      }
      // Basic slug validation
      const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      
      const stmt = db.prepare("INSERT INTO document_types (name, slug, prompt) VALUES (?, ?, ?)");
      const result = stmt.run(name, safeSlug, prompt);
      res.json({ id: result.lastInsertRowid, name, slug: safeSlug, prompt });
    } catch (error: any) {
      if (error.message.includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "Тип з таким ідентифікатором (slug) вже існує" });
      }
      res.status(500).json({ error: "Не вдалося створити тип документа" });
    }
  });

  // Update a document type
  app.put("/api/types/:id", (req, res) => {
    try {
      const { name, slug, prompt } = req.body;
      if (!name || !slug || !prompt) {
        return res.status(400).json({ error: "Всі поля обов'язкові" });
      }
      const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      
      const stmt = db.prepare("UPDATE document_types SET name = ?, slug = ?, prompt = ? WHERE id = ?");
      const result = stmt.run(name, safeSlug, prompt, req.params.id);
      
      if (result.changes === 0) {
        return res.status(404).json({ error: "Тип документа не знайдено" });
      }
      res.json({ id: req.params.id, name, slug: safeSlug, prompt });
    } catch (error: any) {
      if (error.message.includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "Тип з таким ідентифікатором (slug) вже існує" });
      }
      res.status(500).json({ error: "Не вдалося оновити тип документа" });
    }
  });

  // Delete a document type
  app.delete("/api/types/:id", (req, res) => {
    try {
      db.prepare("DELETE FROM document_types WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Не вдалося видалити тип документа" });
    }
  });

  // Get all parsed documents
  app.get("/api/documents", (req, res) => {
    try {
      const docs = db.prepare("SELECT * FROM documents ORDER BY createdAt DESC").all();
      res.json(docs.map((doc: any) => ({
        ...doc,
        extractedData: JSON.parse(doc.extractedData || "{}")
      })));
    } catch (error) {
      res.status(500).json({ error: "Не вдалося отримати документи" });
    }
  });

  // Parse document (supports optional slug in URL or body)
  app.post(["/api/parse", "/api/parse/:slug"], upload.single("document"), async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
        return res.status(500).json({ error: "GEMINI_API_KEY1 не налаштовано. Будь ласка, додайте ваш ключ API в налаштуваннях (Secrets panel)." });
      }
      const ai = new GoogleGenAI({ apiKey });

      if (!req.file) {
        return res.status(400).json({ error: "Файл не надано" });
      }

      const slug = req.params.slug || req.body.slug;
      let prompt = req.body.prompt;

      // If a slug is provided, fetch the predefined prompt
      if (slug && slug !== 'custom') {
        const docType: any = db.prepare("SELECT prompt FROM document_types WHERE slug = ?").get(slug);
        if (docType) {
          prompt = docType.prompt;
        } else if (!prompt) {
          return res.status(404).json({ error: `Тип документа '${slug}' не знайдено` });
        }
      }

      const file = req.file;
      // Виправлення проблеми з кодуванням кириличних назв файлів у Multer
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const mimeType = file.mimetype;
      let extractedText = "";
      let isMultimodal = false;
      let inlineData: any = null;

      // Extract content based on file type
      if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || mimeType === "application/msword") {
        const result = await mammoth.extractRawText({ path: file.path });
        extractedText = result.value;
      } else if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimeType === "application/vnd.ms-excel") {
        const fileBuffer = fs.readFileSync(file.path);
        const workbook = xlsx.read(fileBuffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        extractedText = xlsx.utils.sheet_to_csv(sheet);
      } else if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
        isMultimodal = true;
        const fileData = fs.readFileSync(file.path);
        inlineData = {
          data: fileData.toString("base64"),
          mimeType: mimeType,
        };
      } else {
        extractedText = fs.readFileSync(file.path, "utf-8");
      }

      const defaultPrompt = prompt || "Витягни всю ключову інформацію з цього документа та структуруй її у JSON об'єкт.";
      const contents: any = { parts: [] };

      if (isMultimodal && inlineData) {
        contents.parts.push({ inlineData });
      } else {
        contents.parts.push({ text: `Вміст документа:\n${extractedText}\n\n` });
      }
      contents.parts.push({ text: defaultPrompt });

      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: contents,
        config: {
          responseMimeType: "application/json",
        }
      });

      const extractedDataStr = response.text || "{}";
      let extractedData = {};
      try {
        extractedData = JSON.parse(extractedDataStr);
      } catch (e) {
        console.error("Failed to parse Gemini response as JSON", e);
      }

      // Save to database
      const stmt = db.prepare(`
        INSERT INTO documents (filename, originalName, mimeType, extractedData, typeSlug)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(file.filename, file.originalname, mimeType, JSON.stringify(extractedData), slug || 'custom');

      // Clean up uploaded file
      fs.unlinkSync(file.path);

      res.json({
        id: result.lastInsertRowid,
        originalName: file.originalname,
        typeSlug: slug || 'custom',
        extractedData
      });

    } catch (error: any) {
      console.error("Parsing error:", error);
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({ error: error.message || "Помилка при обробці документа" });
    }
  });

  // Global error handler for API routes
  app.use('/api', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('API Error:', err);
    res.status(500).json({ error: err.message || 'Внутрішня помилка сервера' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
