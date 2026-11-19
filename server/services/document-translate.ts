import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type OutputFormat = 'DOCX' | 'ODT';
export type InputType = 'DOCX' | 'PDF';
export type JobStage =
  | 'queued'
  | 'validating'
  | 'extracting'
  | 'translating'
  | 'reconstructing'
  | 'validating_output'
  | 'completed'
  | 'failed';

export type DocumentJob = {
  id: string;
  originalName: string;
  inputType: InputType;
  size: number;
  source: string;
  target: string;
  detectedSource?: string;
  outputFormat: OutputFormat;
  stage: JobStage;
  progress: number;
  message: string;
  warnings: string[];
  createdAt: number;
  expiresAt: number;
  originalPath: string;
  translatedPath?: string;
  translatedName?: string;
  error?: string;
  preview?: string;
  stats?: Record<string, unknown>;
};

export class DocumentUploadError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const jobs = new Map<string, DocumentJob>();
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function storageRoot() {
  return path.resolve(process.env.DOCUMENT_STORAGE_DIR || 'data/jobs');
}

function retentionMinutes() {
  const value = Number(process.env.DOCUMENT_RETENTION_MINUTES || 60);
  return Number.isFinite(value) && value > 0 ? value : 60;
}

function safeBaseName(name: string) {
  const base = path.basename(name).replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^\w\-. ]+/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'document';
}

/** Verify the extension and the real file signature before anything is stored. */
export function validateUpload(buffer: Buffer, filename: string): InputType {
  const ext = path.extname(filename).toLowerCase();
  if (ext !== '.docx' && ext !== '.pdf') {
    throw new DocumentUploadError(
      'Only DOCX and PDF documents can be translated. Convert the file and try again.',
      415,
    );
  }
  if (!buffer.length) throw new DocumentUploadError('The uploaded file is empty.', 400);

  if (ext === '.docx') {
    if (buffer.subarray(0, 8).equals(OLE_SIGNATURE)) {
      throw new DocumentUploadError(
        'This DOCX is password-protected or encrypted. Remove the password and upload it again.',
        422,
      );
    }
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new DocumentUploadError(
        'This file is named .docx but does not contain a valid Office package.',
        415,
      );
    }
    const directory = buffer.toString('latin1');
    if (!directory.includes('[Content_Types].xml') || !directory.includes('word/document.xml')) {
      throw new DocumentUploadError(
        'This DOCX is damaged or is not a Word document. Re-save it and try again.',
        422,
      );
    }
    return 'DOCX';
  }

  if (buffer.subarray(0, 1024).indexOf('%PDF-') === -1) {
    throw new DocumentUploadError('This file is named .pdf but has no valid PDF signature.', 415);
  }
  return 'PDF';
}

function engineUrl() {
  return new URL(process.env.TRANSLATION_SERVICE_URL || 'http://127.0.0.1:8001');
}

function requestEngine(job: DocumentJob, buffer: Buffer) {
  const url = engineUrl();
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `/document/translate?job_id=${encodeURIComponent(job.id)}`,
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': buffer.length,
          'x-filename': job.inputType === 'PDF' ? 'document.pdf' : 'document.docx',
          'x-output-format': job.outputFormat.toLowerCase(),
          'x-source': job.source,
          'x-target': job.target,
          'x-work-dir': path.dirname(job.originalPath),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode || 500, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on('error', reject);
    request.setTimeout(0);
    request.end(buffer);
  });
}

function readEngineProgress(id: string) {
  const url = engineUrl();
  return new Promise<{ stage?: string; progress?: number; message?: string } | null>((resolve) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `/document/jobs/${encodeURIComponent(id)}`,
        method: 'GET',
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if ((response.statusCode || 500) !== 200) return resolve(null);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('error', () => resolve(null));
    request.setTimeout(4000, () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });
}

function publicView(job: DocumentJob) {
  return {
    id: job.id,
    originalName: job.originalName,
    translatedName: job.translatedName || null,
    inputType: job.inputType,
    outputFormat: job.outputFormat,
    size: job.size,
    source: job.source,
    target: job.target,
    detectedSource: job.detectedSource || null,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    warnings: job.warnings,
    error: job.error || null,
    preview: job.preview || null,
    stats: job.stats || null,
    createdAt: job.createdAt,
  };
}

async function runJob(job: DocumentJob, buffer: Buffer) {
  try {
    job.stage = 'validating';
    job.progress = 6;
    job.message = 'Validating the uploaded document';

    const response = await requestEngine(job, buffer);
    if (response.status !== 200) {
      let detail = 'The translation service could not process this document.';
      try {
        const parsed = JSON.parse(response.body.toString('utf8'));
        if (typeof parsed.detail === 'string') detail = parsed.detail;
        else if (Array.isArray(parsed.detail)) detail = 'The request was rejected as invalid.';
      } catch {
        if (response.status === 413) detail = 'The document is larger than the configured limit.';
        else if (response.status >= 500) {
          detail = 'The translation service failed while processing this document.';
        }
      }
      throw new DocumentUploadError(detail, response.status);
    }

    const payload = JSON.parse(response.body.toString('utf8')) as {
      output?: string;
      meta?: {
        stats?: Record<string, unknown>;
        warnings?: string[];
        preview?: string;
      };
      warnings?: string[];
    };
    if (!payload.output || payload.output.includes('..') || path.isAbsolute(payload.output)) {
      throw new DocumentUploadError('The translation service returned an invalid output file.', 500);
    }

    const translatedPath = path.join(path.dirname(job.originalPath), path.basename(payload.output));
    await fsp.access(translatedPath);

    const stats = payload.meta?.stats || {};
    const warnings = [
      ...(payload.meta?.warnings || []),
      ...(payload.warnings || []),
    ].filter((value, index, list) => value && list.indexOf(value) === index);

    job.translatedPath = translatedPath;
    job.detectedSource =
      typeof stats.detected_source === 'string' ? stats.detected_source : job.source;
    job.stats = stats;
    job.warnings = warnings.slice(0, 12);
    job.preview = payload.meta?.preview || undefined;
    job.translatedName = `${safeBaseName(job.originalName)}-${job.target.toLowerCase()}.${job.outputFormat.toLowerCase()}`;
    job.stage = 'completed';
    job.progress = 100;
    job.message = 'Translation complete';
  } catch (error) {
    job.stage = 'failed';
    job.progress = 100;
    job.error =
      error instanceof DocumentUploadError
        ? error.message
        : error instanceof Error && error.message.includes('ECONNREFUSED')
          ? 'The translation service is not running. Start it and try again.'
          : 'The document could not be translated. Your original is unchanged.';
    job.message = job.error;
    console.warn(`Document job ${job.id} failed:`, job.error);
  }
}

export async function startDocumentJob(options: {
  buffer: Buffer;
  originalName: string;
  source: string;
  target: string;
  outputFormat: OutputFormat;
}) {
  const inputType = validateUpload(options.buffer, options.originalName);
  const id = randomUUID();
  const directory = path.join(storageRoot(), id);
  await fsp.mkdir(directory, { recursive: true });

  const extension = inputType === 'PDF' ? '.pdf' : '.docx';
  const originalPath = path.join(directory, `original${extension}`);
  await fsp.writeFile(originalPath, options.buffer);

  const now = Date.now();
  const job: DocumentJob = {
    id,
    originalName: path.basename(options.originalName),
    inputType,
    size: options.buffer.length,
    source: options.source,
    target: options.target,
    outputFormat: options.outputFormat,
    stage: 'queued',
    progress: 3,
    message: 'Queued for translation',
    warnings: [],
    createdAt: now,
    expiresAt: now + retentionMinutes() * 60_000,
    originalPath,
  };
  jobs.set(id, job);
  void runJob(job, options.buffer);
  return publicView(job);
}

export function getJob(id: string) {
  return jobs.get(id) || null;
}

export async function refreshJob(id: string) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.stage !== 'completed' && job.stage !== 'failed') {
    const progress = await readEngineProgress(id);
    if (progress && typeof progress.progress === 'number') {
      job.progress = Math.max(job.progress, Math.min(99, progress.progress));
      if (progress.message) job.message = progress.message;
      if (progress.stage === 'translating') job.stage = 'translating';
      else if (progress.stage === 'extracting') job.stage = 'extracting';
      else if (progress.stage === 'reconstructing') job.stage = 'reconstructing';
      else if (progress.stage === 'validating') job.stage = 'validating';
    }
  }
  return publicView(job);
}

export function jobFile(id: string) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.stage === 'completed' && job.translatedPath && fs.existsSync(job.translatedPath)) {
    return {
      path: job.translatedPath,
      name: job.translatedName || `translated.${job.outputFormat.toLowerCase()}`,
      type: job.outputFormat,
    };
  }
  return null;
}

export function documentContentType(format: OutputFormat) {
  return format === 'ODT'
    ? 'application/vnd.oasis.opendocument.text'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

export async function removeJob(id: string) {
  const job = jobs.get(id);
  if (!job) return false;
  jobs.delete(id);
  await fsp.rm(path.dirname(job.originalPath), { recursive: true, force: true }).catch(() => {});
  return true;
}

async function sweepExpiredJobs() {
  const root = storageRoot();
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionMinutes() * 60_000;
  for (const entry of entries) {
    const directory = path.join(root, entry);
    try {
      const info = await fsp.stat(directory);
      if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
      await fsp.rm(directory, { recursive: true, force: true });
      jobs.delete(entry);
    } catch {
      // A file that vanished mid-sweep is already clean.
    }
  }
}

export function startDocumentRetention() {
  void sweepExpiredJobs();
  const timer = setInterval(() => {
    void sweepExpiredJobs();
  }, 5 * 60_000);
  timer.unref();
}
