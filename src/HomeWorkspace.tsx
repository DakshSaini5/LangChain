import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Eye,
  FileCheck2,
  FileText,
  FileUp,
  Languages,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';

type Stage =
  | 'queued'
  | 'validating'
  | 'extracting'
  | 'translating'
  | 'reconstructing'
  | 'validating_output'
  | 'completed'
  | 'failed';

type Job = {
  id: string;
  originalName: string;
  translatedName: string | null;
  inputType: 'DOCX' | 'PDF';
  outputFormat: 'DOCX' | 'ODT';
  size: number;
  source: string;
  target: string;
  detectedSource: string | null;
  stage: Stage;
  progress: number;
  message: string;
  warnings: string[];
  error: string | null;
  preview: string | null;
  stats: Record<string, unknown> | null;
};

type Props = { notify: (message: string) => void };

const MAX_MB = 20;
const STEPS: { stage: Stage; label: string }[] = [
  { stage: 'validating', label: 'Validate document' },
  { stage: 'extracting', label: 'Read original text' },
  { stage: 'translating', label: 'Translate content' },
  { stage: 'reconstructing', label: 'Rebuild original layout' },
  { stage: 'validating_output', label: 'Check formatting' },
];

const STAGE_ORDER: Stage[] = [
  'queued',
  'validating',
  'extracting',
  'translating',
  'reconstructing',
  'validating_output',
  'completed',
];

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stepIndex(stage: Stage) {
  if (stage === 'failed') return -1;
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? 0 : index;
}

export default function HomeWorkspace({ notify }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState('Auto');
  const [target, setTarget] = useState('Hindi');
  const [format, setFormat] = useState<'DOCX' | 'ODT'>('DOCX');
  const [uploadPercent, setUploadPercent] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setJob(null);
    setError('');
    setUploadPercent(0);
    setShowPreview(false);
    if (input.current) input.current.value = '';
  };

  const accept = (incoming: FileList | null) => {
    const candidate = incoming?.[0];
    if (!candidate) return;
    const extension = candidate.name.split('.').pop()?.toLowerCase() || '';
    if (extension !== 'docx' && extension !== 'pdf') {
      setError(`${candidate.name} is not supported. Upload a DOCX or PDF document.`);
      return;
    }
    if (candidate.size > MAX_MB * 1024 * 1024) {
      setError(`${candidate.name} is ${formatSize(candidate.size)}. The limit is ${MAX_MB} MB.`);
      return;
    }
    if (candidate.size === 0) {
      setError('That file is empty. Choose a document with content.');
      return;
    }
    setFile(candidate);
    setJob(null);
    setError('');
    setUploadPercent(0);
    setShowPreview(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    accept(event.dataTransfer.files);
  };

  const translateDocument = () => {
    if (!file || busy) return;
    if (source !== 'Auto' && source === target) {
      setError('Choose a different source and target language.');
      return;
    }
    setBusy(true);
    setError('');
    setJob(null);
    setUploadPercent(0);

    const form = new FormData();
    form.append('file', file);
    form.append('source', source);
    form.append('target', target);
    form.append('outputFormat', format);

    const request = new XMLHttpRequest();
    request.open('POST', '/api/documents/translate');
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadPercent(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      const payload = request.response as { job?: Job; error?: string } | null;
      if (request.status === 202 && payload?.job) {
        setUploadPercent(100);
        setJob(payload.job);
      } else {
        setError(payload?.error || 'The document could not be uploaded.');
      }
      setBusy(false);
    };
    request.onerror = () => {
      setError('The translation server could not be reached. Check that it is running.');
      setBusy(false);
    };
    request.send(form);
  };

  const jobId = job?.id;
  const finished = job?.stage === 'completed' || job?.stage === 'failed';

  useEffect(() => {
    if (!jobId || finished) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/documents/jobs/${jobId}`);
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(payload?.error || 'This translation job is no longer available.');
          return;
        }
        if (payload?.job) {
          setJob(payload.job as Job);
          if (payload.job.stage === 'completed') notify('Translation complete. Your original is unchanged.');
        }
      } catch {
        // A transient poll failure is retried on the next tick.
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, finished, notify]);

  const activeStep = job ? stepIndex(job.stage) : -1;
  const progress = job ? Math.max(job.progress, uploadPercent === 100 ? 8 : uploadPercent) : 0;
  const fileType = file?.name.split('.').pop()?.toUpperCase() || '';

  return (
    <>
      <section className="dt-head">
        <div>
          <div className="eyebrow">
            <span className="live-dot" /> DOCUMENT TRANSLATION ENGINE
          </div>
          <h1>Translate the words. Keep the document.</h1>
          <p>
            Upload a DOCX or PDF and receive a translated file that keeps its fonts, styles,
            tables, images, headers and page setup.
          </p>
        </div>
        <div className="dt-head-tags">
          <span>
            <ShieldCheck size={13} /> Original never modified
          </span>
          <span>
            <Languages size={13} /> English ↔ हिन्दी
          </span>
        </div>
      </section>

      <div className="dt-layout">
        <section className="dt-card">
          <div className="dt-card-head">
            <div>
              <h2>1. Add your document</h2>
              <p>DOCX and PDF up to {MAX_MB} MB. The original file is never overwritten.</p>
            </div>
          </div>

          {!file ? (
            <div
              className={`dt-drop ${dragging ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => input.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  input.current?.click();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragging(true);
              }}
              onDragLeave={(event) => {
                event.stopPropagation();
                setDragging(false);
              }}
              onDrop={onDrop}
            >
              <span className="dt-drop-icon">
                <FileUp size={22} />
              </span>
              <b>Drag &amp; drop your document</b>
              <span className="dt-drop-hint">or click to browse your files</span>
              <span className="format-tags">
                <i>DOCX</i>
                <i>PDF</i>
              </span>
            </div>
          ) : (
            <div className="dt-file">
              <span className={`dt-file-icon ${fileType === 'PDF' ? 'rose' : 'blue'}`}>
                <FileText size={19} />
              </span>
              <div className="dt-file-copy">
                <b title={file.name}>{file.name}</b>
                <small>
                  {formatSize(file.size)} · {fileType} document
                </small>
              </div>
              <button className="icon-button small" onClick={reset} aria-label="Remove file">
                <X size={16} />
              </button>
            </div>
          )}
          <input
            ref={input}
            type="file"
            accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden
            onChange={(event) => {
              accept(event.target.files);
              event.target.value = '';
            }}
          />

          <div className="dt-section">
            <h2>2. Choose languages</h2>
            <div className="dt-options">
              <label className="dt-field">
                <span>SOURCE LANGUAGE</span>
                <select value={source} onChange={(event) => setSource(event.target.value)}>
                  <option value="Auto">Auto-detect</option>
                  <option value="English">English</option>
                  <option value="Hindi">Hindi</option>
                </select>
                <small>
                  {job?.detectedSource
                    ? `Detected: ${job.detectedSource}`
                    : 'We detect the language from the document text.'}
                </small>
              </label>
              <label className="dt-field">
                <span>TARGET LANGUAGE</span>
                <select value={target} onChange={(event) => setTarget(event.target.value)}>
                  <option value="Hindi">Hindi</option>
                  <option value="English">English</option>
                </select>
                <small>Selected language will replace the document text.</small>
              </label>
            </div>
          </div>

          <div className="dt-section">
            <h2>3. Output format</h2>
            <div className="dt-formats">
              {(['DOCX', 'ODT'] as const).map((option) => (
                <button
                  key={option}
                  className={`dt-format ${format === option ? 'selected' : ''}`}
                  onClick={() => setFormat(option)}
                  aria-pressed={format === option}
                >
                  <span className="dt-format-radio">{format === option && <Check size={11} />}</span>
                  <b>{option}</b>
                  <small>
                    {option === 'DOCX'
                      ? 'Word document · original styling preserved'
                      : 'OpenDocument text · opens in LibreOffice and Google Docs'}
                  </small>
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="translation-error" role="alert">
              <AlertTriangle size={15} />
              <span>{error}</span>
              <button onClick={() => setError('')}>Dismiss</button>
            </div>
          )}

          <div className="dt-actions">
            <button
              className="primary-button"
              onClick={translateDocument}
              disabled={!file || busy || (job ? !finished : false)}
            >
              {busy ? (
                <>
                  <LoaderCircle size={16} className="spin" /> Uploading…
                </>
              ) : (
                <>
                  <Languages size={16} /> Translate document
                </>
              )}
            </button>
            {file && !busy && (
              <button className="secondary-button" onClick={reset}>
                <RotateCcw size={15} /> Start over
              </button>
            )}
            <span className="dt-note">
              {format === 'DOCX'
                ? 'Your translated file keeps the original Word package and styles.'
                : 'ODT export preserves text styles, tables and images as closely as possible.'}
            </span>
          </div>
        </section>

        <aside className="dt-card dt-status">
          <div className="dt-card-head">
            <div>
              <h2>Processing</h2>
              <p>Every stage is verified before the file is offered for download.</p>
            </div>
          </div>

          {!file && !job && (
            <div className="dt-idle">
              <span className="dt-idle-icon">
                <FileCheck2 size={22} />
              </span>
              <b>Ready when you are</b>
              <p>Add a document to see upload progress, processing stages and the translated file.</p>
            </div>
          )}

          {file && !job && (
            <div className="dt-idle">
              <span className="dt-idle-icon">
                <FileText size={22} />
              </span>
              <b>{file.name}</b>
              <p>
                {formatSize(file.size)} · {fileType} · {source === 'Auto' ? 'auto-detect' : source} → {target}
              </p>
              {uploadPercent > 0 && uploadPercent < 100 && (
                <div className="dt-bar">
                  <span style={{ width: `${uploadPercent}%` }} />
                </div>
              )}
            </div>
          )}

          {job && (
            <div className="dt-progress" aria-live="polite">
              <div className="dt-progress-head">
                <b>{job.stage === 'completed' ? 'Translation complete' : job.stage === 'failed' ? 'Translation stopped' : job.message}</b>
                <span>{job.stage === 'failed' ? '' : `${progress}%`}</span>
              </div>
              <div className={`dt-bar ${job.stage === 'failed' ? 'failed' : ''}`}>
                <span style={{ width: `${job.stage === 'failed' ? 100 : progress}%` }} />
              </div>

              <ol className="dt-steps">
                {STEPS.map((step, index) => {
                  const done = job.stage === 'completed' || (activeStep > index && job.stage !== 'failed');
                  const current = !done && job.stage !== 'failed' && activeStep === index;
                  return (
                    <li key={step.stage} className={done ? 'done' : current ? 'current' : ''}>
                      <span className="dt-step-dot">
                        {done ? <Check size={11} /> : current ? <LoaderCircle size={11} className="spin" /> : null}
                      </span>
                      {step.label}
                    </li>
                  );
                })}
              </ol>

              {job.stage === 'failed' && job.error && (
                <div className="translation-error" role="alert">
                  <AlertTriangle size={15} />
                  <span>{job.error}</span>
                </div>
              )}

              {job.warnings.length > 0 && job.stage !== 'failed' && (
                <div className="dt-warnings">
                  <b>
                    <AlertTriangle size={13} /> Format notes
                  </b>
                  <ul>
                    {job.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              {job.stage === 'completed' && (
                <div className="dt-result">
                  <div className="dt-result-head">
                    <CheckCircle2 size={17} />
                    <b>Document translated</b>
                  </div>
                  <div className="dt-result-files">
                    <div>
                      <small>ORIGINAL · UNCHANGED</small>
                      <b title={job.originalName}>{job.originalName}</b>
                      <span>{formatSize(job.size)} · {job.inputType}</span>
                    </div>
                    <div>
                      <small>TRANSLATED · {job.outputFormat}</small>
                      <b title={job.translatedName || ''}>{job.translatedName}</b>
                      <span>
                        {job.detectedSource ? `${job.detectedSource} → ${job.target}` : `${job.source} → ${job.target}`}
                        {job.stats?.translated_blocks ? ` · ${job.stats.translated_blocks} text blocks` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="dt-result-actions">
                    <a
                      className="primary-button"
                      href={`/api/documents/jobs/${job.id}/download`}
                      download={job.translatedName || undefined}
                    >
                      <Download size={15} /> Download {job.outputFormat}
                    </a>
                    {job.preview && (
                      <button className="secondary-button" onClick={() => setShowPreview((value) => !value)}>
                        <Eye size={15} /> {showPreview ? 'Hide preview' : 'Preview text'}
                      </button>
                    )}
                  </div>
                  {showPreview && job.preview && (
                    <pre className="dt-preview">{job.preview.slice(0, 2500)}</pre>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="dt-guarantees">
            <span>
              <ShieldCheck size={13} /> Validated before download
            </span>
            <span>
              <FileCheck2 size={13} /> Originals kept on disk, untouched
            </span>
          </div>
        </aside>
      </div>
    </>
  );
}
