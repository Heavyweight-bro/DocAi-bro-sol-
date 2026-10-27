import path from 'node:path';
import { readFileSync } from 'node:fs';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import { connection, isProvider } from './settings';
import { extractDocument } from './providers';
import { schemaForSlug, validateAgainstSchema } from './schemas';
import { saveLocalFile, saveSupabaseFile } from './files';
import { estimateCostUsd } from './cost';
import type { Provider } from './models';
import { localStore, nextLocalId, persistLocal } from './local-store';
import { storageMode, type StorageMode } from './storage';
import { getTemplateBySlug } from './templates';

export type ProcessInput = {
  buffer: Buffer;
  originalName: string;
  mimeType?: string;
  slug?: string;
  prompt?: string;
  provider?: string;
  docId?: number;
  actor?: string;
  /** false → a failed AI attempt is not stored (the worker will retry). Default true. */
  persistFailure?: boolean;
};

export type ProcessResult = {
  document: any;
  reviewStatus: string;
  parseStatus: string;
  validationErrors: { path: string; message: string }[];
  errorMessage: string;
  aiModel: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  provider: Provider;
  storagePath?: string;
  /** Set when the default model failed the schema and the escalation model produced the kept result. */
  escalatedFrom?: string;
};

/** OPENAI_ESCALATION_MODEL / GEMINI_ESCALATION_MODEL / ANTHROPIC_ESCALATION_MODEL (empty = no escalation). */
export function escalationModelFor(provider: Provider) {
  return (process.env[`${provider.toUpperCase()}_ESCALATION_MODEL`] || '').trim() || undefined;
}

const mimeByExtension: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
};

/** Template prompt + schema for a slug; a custom prompt is used only when no template is requested. */
export async function resolveTemplate(slug: string | undefined, prompt: string | undefined, modes: StorageMode = storageMode()) {
  if (!slug || slug === 'custom') return { prompt, schema: undefined as unknown };
  if (!modes.isLocalMode && !modes.isSupabaseConfigured) return { prompt, schema: undefined as unknown };
  const template = await getTemplateBySlug(slug, modes);
  // Same contract in both stores: an unknown template is an error, never a silent fallback to a custom prompt.
  if (!template) throw Object.assign(new Error(`Шаблон '${slug}' не знайдено`), { status: 404 });
  return { prompt: template.prompt, schema: template.schema };
}

export async function resolvePrompt(slug: string | undefined, prompt: string | undefined, modes: StorageMode = storageMode()) {
  return (await resolveTemplate(slug, prompt, modes)).prompt;
}

export async function processDocumentBuffer(input: ProcessInput): Promise<ProcessResult> {
  const started = Date.now();
  const modes = storageMode();
  const providerRaw = input.provider || connection().provider;
  if (!isProvider(providerRaw)) throw Object.assign(new Error('Невідомий AI-провайдер'), { status: 400 });
  if (!connection(providerRaw).configured) throw Object.assign(new Error('Підключіть обраного AI-провайдера у налаштуваннях.'), { status: 503 });

  const originalName = input.originalName;
  const extension = path.extname(originalName).toLowerCase();
  const mimeType = input.mimeType || mimeByExtension[extension] || 'application/octet-stream';
  const slug = input.slug;
  const template = await resolveTemplate(typeof slug === 'string' ? slug : undefined, input.prompt, modes);
  const prompt = template.prompt;

  // ---- 1. Turn the file into model input (text and/or inline binary) ----
  let extractedText = '';
  let inlineData: { data: string; mimeType: string } | undefined;
  let preparationError = '';
  try {
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mimeType === 'application/msword') {
      const result = await mammoth.extractRawText({ buffer: input.buffer });
      extractedText = result.value;
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/json') {
      if (mimeType === 'application/json') extractedText = input.buffer.toString('utf-8');
      else {
        const workbook = xlsx.read(input.buffer, { type: 'buffer' });
        const jsonData = Object.fromEntries(workbook.SheetNames.map((name) => [name, xlsx.utils.sheet_to_json(workbook.Sheets[name])]));
        extractedText = JSON.stringify(jsonData);
      }
    } else if (mimeType === 'application/pdf' || mimeType.startsWith('image/')) {
      inlineData = { data: input.buffer.toString('base64'), mimeType };
    } else {
      extractedText = input.buffer.toString('utf-8');
    }
  } catch (e: any) {
    preparationError = `Не вдалося прочитати файл: ${e?.message || e}`;
  }

  const slugKey = typeof slug === 'string' ? slug : undefined;
  const schema = schemaForSlug(slugKey, template.schema);
  const defaultPrompt = prompt || "Витягни всю ключову інформацію з цього документа та структуруй її у JSON об'єкт. Поверни тільки JSON.";

  type Attempt = {
    extractedData: any; parseStatus: 'success' | 'invalid' | 'failed'; errorMessage: string; aiModel: string;
    promptTokens: number; completionTokens: number; costUsd: number; validationErrors: { path: string; message: string; severity?: string }[];
  };
  const runAttempt = async (model?: string): Promise<Attempt> => {
    try {
      if (preparationError) throw new Error(preparationError);
      const result = await extractDocument(providerRaw, { text: extractedText, prompt: defaultPrompt, filename: originalName, inlineData }, model);
      const base = {
        extractedData: result.data, aiModel: result.model, promptTokens: result.inputTokens, completionTokens: result.outputTokens,
        costUsd: estimateCostUsd(providerRaw, result.model, result.inputTokens, result.outputTokens),
      };
      if (!schema) return { ...base, parseStatus: 'success', errorMessage: '', validationErrors: [] };
      const check = validateAgainstSchema(result.data, slugKey, template.schema);
      return {
        ...base,
        parseStatus: check.ok ? 'success' : 'invalid',
        validationErrors: check.errors,
        errorMessage: check.ok ? '' : check.errors.filter((e) => e.severity !== 'warning').map((e) => `${e.path || 'document'}: ${e.message}`).join('; '),
      };
    } catch (processError: any) {
      console.error('Document processing failed:', providerRaw, processError?.message || processError);
      const message = processError?.message || String(processError);
      return { extractedData: { error: message, status: 'failed' }, parseStatus: 'failed', errorMessage: message, aiModel: model ? `${providerRaw}/${model}` : '', promptTokens: 0, completionTokens: 0, costUsd: 0, validationErrors: [] };
    }
  };

  // ---- 2. Extract with the default (usually cheaper) model; escalate once to a stronger model if needed ----
  let best = await runAttempt();
  let totalPrompt = best.promptTokens;
  let totalCompletion = best.completionTokens;
  let totalCost = best.costUsd;
  let escalatedFrom: string | undefined;
  const escalationModel = escalationModelFor(providerRaw);
  const nonRecoverable = /ключ відхилено|ліміт|кредит|Підключіть|прочитати файл/i.test(best.errorMessage);
  const needsEscalation = !!escalationModel && escalationModel !== connection(providerRaw).model && !nonRecoverable
    && (best.parseStatus === 'invalid' || best.parseStatus === 'failed');
  if (needsEscalation) {
    const second = await runAttempt(escalationModel);
    totalPrompt += second.promptTokens;
    totalCompletion += second.completionTokens;
    totalCost += second.costUsd;
    const score = (a: Attempt) => (a.parseStatus === 'success' ? 0 : a.parseStatus === 'invalid' ? 1 + a.validationErrors.filter((e) => e.severity !== 'warning').length / 1000 : 2);
    if (score(second) < score(best)) {
      escalatedFrom = best.aiModel || connection(providerRaw).model;
      best = second;
    }
  }

  const extractedData: any = best.extractedData;
  const parseStatus: string = best.parseStatus;
  const errorMessage = best.errorMessage;
  const aiModelUsed = best.aiModel;
  const promptTokens = totalPrompt;
  const completionTokens = totalCompletion;
  const validationErrors = best.validationErrors;
  const reviewStatus = parseStatus === 'failed' ? 'failed' : parseStatus === 'invalid' ? 'invalid' : schema ? 'pending_review' : 'completed';

  if (parseStatus === 'failed' && input.persistFailure === false) {
    return {
      document: { id: undefined, originalName, typeSlug: slug || 'custom', status: 'failed' },
      reviewStatus,
      parseStatus,
      validationErrors,
      errorMessage,
      aiModel: aiModelUsed,
      promptTokens,
      completionTokens,
      estimatedCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
      durationMs: Date.now() - started,
      provider: providerRaw,
      escalatedFrom,
    };
  }

  const docId = input.docId || (modes.isLocalMode ? nextLocalId() : Date.now());
  let storagePath = '';
  let filePath = '';
  try {
    if (modes.isLocalMode) {
      const saved = saveLocalFile(docId, originalName, input.buffer, mimeType);
      storagePath = saved.storagePath;
      filePath = saved.filePath;
    } else if (modes.isSupabaseConfigured) {
      const uploaded = await saveSupabaseFile(modes.supabase, docId, originalName, input.buffer, mimeType);
      if (uploaded) storagePath = uploaded.storagePath;
      else {
        const fallback = saveLocalFile(docId, originalName, input.buffer, mimeType);
        storagePath = fallback.storagePath;
        filePath = fallback.filePath;
      }
    }
  } catch (e) {
    console.error('file archive failed', e instanceof Error ? e.message : e);
  }

  const estimatedCostUsd = Math.round(totalCost * 1_000_000) / 1_000_000;
  const durationMs = Date.now() - started;

  let document: any;

  if (modes.isSupabaseConfigured) {
    const insertData: any = {
      filename: originalName,
      original_name: originalName,
      mime_type: mimeType,
      extracted_data: extractedData,
      type_slug: slug || 'custom',
      status: reviewStatus,
      error_message: errorMessage || null,
      ai_model: aiModelUsed,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      validation_errors: validationErrors,
      storage_path: storagePath || null,
    };
    let { data: insertedDoc, error: insertError } = await modes.supabase.from('documents').insert([{ ...insertData, created_by: input.actor || null }]).select().single();
    if (insertError && insertError.code === '42703') {
      // Schema from before the audit columns (created_by): keep status columns, drop only the new one.
      ({ data: insertedDoc, error: insertError } = await modes.supabase.from('documents').insert([insertData]).select().single());
    }
    if (insertError && insertError.code === '42703') {
      const fallbackData = {
        filename: originalName,
        original_name: originalName,
        mime_type: mimeType,
        extracted_data: {
          ...extractedData,
          _status: reviewStatus,
          _error: errorMessage,
          _validation_errors: validationErrors,
          _ai_model: aiModelUsed,
          _prompt_tokens: promptTokens,
          _completion_tokens: completionTokens,
          _storage_path: storagePath,
          _estimated_cost_usd: estimatedCostUsd,
          _duration_ms: durationMs,
        },
        type_slug: slug || 'custom',
      };
      const fallbackResult = await modes.supabase.from('documents').insert([fallbackData]).select().single();
      insertedDoc = fallbackResult.data;
      insertError = fallbackResult.error;
    }
    if (insertError) throw insertError;
    document = {
      id: insertedDoc.id,
      originalName: insertedDoc.original_name,
      mimeType: insertedDoc.mime_type,
      typeSlug: insertedDoc.type_slug,
      extractedData: typeof insertedDoc.extracted_data === 'string' ? JSON.parse(insertedDoc.extracted_data) : insertedDoc.extracted_data,
      createdAt: insertedDoc.created_at,
      status: reviewStatus,
      validationErrors,
      errorMessage: errorMessage || undefined,
      storagePath: storagePath || undefined,
      aiModel: aiModelUsed,
      promptTokens,
      completionTokens,
      estimatedCostUsd,
      durationMs,
      provider: providerRaw,
    };
  } else {
    document = {
      id: docId,
      originalName,
      mimeType,
      typeSlug: slug || 'custom',
      extractedData,
      createdAt: new Date().toISOString(),
      status: reviewStatus,
      validationErrors,
      errorMessage: errorMessage || undefined,
      storagePath: storagePath || undefined,
      filePath: filePath || undefined,
      createdBy: input.actor,
      escalatedFrom,
      aiModel: aiModelUsed,
      promptTokens,
      completionTokens,
      estimatedCostUsd,
      durationMs,
      provider: providerRaw,
    };
    if (modes.isLocalMode) {
      localStore.documents.unshift(document);
      persistLocal();
    }
  }

  return {
    document,
    reviewStatus,
    parseStatus,
    validationErrors,
    errorMessage,
    aiModel: aiModelUsed,
    promptTokens,
    completionTokens,
    estimatedCostUsd,
    durationMs,
    provider: providerRaw,
    storagePath,
    escalatedFrom,
  };
}

export function readJobFile(filePath: string) {
  return readFileSync(filePath);
}
