import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  DocumentUploadError,
  documentContentType,
  getJob,
  jobFile,
  refreshJob,
  removeJob,
  startDocumentJob,
  type OutputFormat,
} from '../services/document-translate.js';

const requestSchema = z.object({
  source: z.enum(['Auto', 'English', 'Hindi']).default('Auto'),
  target: z.enum(['English', 'Hindi']).default('Hindi'),
  outputFormat: z.enum(['DOCX', 'ODT']).default('DOCX'),
});

const idSchema = z.string().uuid();

export function createDocumentRouter(maxMb: number) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
  });

  router.post('/translate', upload.single('file'), async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Choose a DOCX or PDF document to translate.' });
        return;
      }
      const rawSource = String(req.body?.source ?? 'Auto');
      const rawTarget = String(req.body?.target ?? 'Hindi');
      if (!['Auto', 'English', 'Hindi'].includes(rawSource) || !['English', 'Hindi'].includes(rawTarget)) {
        res.status(400).json({
          error: 'LangChang currently translates between English and Hindi only.',
        });
        return;
      }
      const input = requestSchema.parse({
        source: req.body?.source ?? 'Auto',
        target: req.body?.target ?? 'Hindi',
        outputFormat: String(req.body?.outputFormat ?? 'DOCX').toUpperCase(),
      });
      if (input.source !== 'Auto' && input.source === input.target) {
        res.status(400).json({ error: 'Choose a different source and target language.' });
        return;
      }
      const job = await startDocumentJob({
        buffer: file.buffer,
        originalName: file.originalname,
        source: input.source,
        target: input.target,
        outputFormat: input.outputFormat as OutputFormat,
      });
      res.status(202).json({ job });
    } catch (error) {
      next(error);
    }
  });

  router.get('/jobs/:id', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const job = await refreshJob(id);
      if (!job) {
        res.status(404).json({ error: 'This translation job has expired. Upload the document again.' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ job });
    } catch (error) {
      next(error);
    }
  });

  router.get('/jobs/:id/preview', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const job = await refreshJob(id);
      if (!job) {
        res.status(404).json({ error: 'This translation job has expired. Upload the document again.' });
        return;
      }
      if (!job.preview) {
        res.status(404).json({ error: 'A text preview is not available for this document.' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ preview: job.preview, translatedName: job.translatedName });
    } catch (error) {
      next(error);
    }
  });

  router.get('/jobs/:id/download', (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const stored = jobFile(id);
      if (!stored) {
        const job = getJob(id);
        res.status(409).json({
          error: job
            ? 'This document is not ready yet or failed validation.'
            : 'This translation job has expired. Upload the document again.',
        });
        return;
      }
      res.setHeader('Content-Type', documentContentType(stored.type));
      res.setHeader('Cache-Control', 'no-store');
      res.download(stored.path, stored.name, (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/jobs/:id', async (req, res, next) => {
    try {
      const id = idSchema.parse(req.params.id);
      const removed = await removeJob(id);
      res.status(removed ? 200 : 404).json({ ok: removed });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function isDocumentUploadError(error: unknown): error is DocumentUploadError {
  return error instanceof DocumentUploadError;
}
