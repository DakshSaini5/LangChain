import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  Languages,
  LoaderCircle,
  Mail,
  Send,
  ShieldCheck,
  WandSparkles,
  X,
} from 'lucide-react';
import { DiffText } from './textDiff';

type Tone = 'professional' | 'friendly' | 'concise' | 'apologetic' | 'persuasive';
type Length = 'shorter' | 'same' | 'longer';

type Polished = { subject: string; body: string; warnings: string[] };

type Draft = {
  to: string;
  subject: string;
  body: string;
  tone: Tone;
  length: Length;
  source: 'English' | 'Hindi';
  target: 'English' | 'Hindi';
};

type Props = { notify: (message: string) => void };

const MAX_CHARS = 30000;
const DRAFT_KEY = 'langchain.email-draft.v1';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const TONES: { value: Tone; label: string }[] = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'concise', label: 'Concise' },
  { value: 'apologetic', label: 'Apologetic' },
  { value: 'persuasive', label: 'Persuasive' },
];

const LENGTHS: { value: Length; label: string }[] = [
  { value: 'shorter', label: 'Shorter' },
  { value: 'same', label: 'Same length' },
  { value: 'longer', label: 'Longer' },
];

function loadDraft(): Partial<Draft> {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function wordCount(text: string) {
  const words = text.trim().match(/[^\s]+/g);
  return words ? words.length : 0;
}

function isSetupError(message: string) {
  return message.includes('GEMINI_API_KEY') || message.includes('not configured');
}

export default function EmailWorkspace({ notify }: Props) {
  const [draft] = useState(loadDraft);
  const [to, setTo] = useState(draft.to ?? '');
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body ?? '');
  const [tone, setTone] = useState<Tone>(draft.tone ?? 'professional');
  const [length, setLength] = useState<Length>(draft.length ?? 'same');
  const [source, setSource] = useState<'English' | 'Hindi'>(draft.source ?? 'English');
  const [target, setTarget] = useState<'English' | 'Hindi'>(draft.target ?? 'Hindi');

  const [preview, setPreview] = useState<Polished | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setupNeeded, setSetupNeeded] = useState(false);

  const [translation, setTranslation] = useState('');
  const [translatedFrom, setTranslatedFrom] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState('');

  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ to, subject, body, tone, length, source, target }));
      setSaved(true);
      const timer = window.setTimeout(() => setSaved(false), 1500);
      return () => window.clearTimeout(timer);
    } catch {
      setSaved(false);
      return undefined;
    }
  }, [to, subject, body, tone, length, source, target]);

  const bodyCharacters = body.trim().length;

  const validate = () => {
    if (!body.trim()) {
      setError('Write the message before polishing it.');
      return false;
    }
    if (body.trim().length > MAX_CHARS) {
      setError(`That message is ${body.trim().length.toLocaleString()} characters. The limit is ${MAX_CHARS.toLocaleString()}.`);
      return false;
    }
    if (to.trim() && !EMAIL_PATTERN.test(to.trim())) {
      setError('Enter a valid recipient e-mail address, or leave the To field empty.');
      return false;
    }
    return true;
  };

  const polish = async () => {
    if (busy) return;
    setError('');
    setSetupNeeded(false);
    if (!validate()) return;
    setBusy(true);
    setPreview(null);
    setShowChanges(false);
    try {
      const response = await fetch('/api/email/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim(), tone, length }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Email polishing unavailable');
      if (
        !data.polished
        || typeof data.polished.subject !== 'string'
        || typeof data.polished.body !== 'string'
        || !data.polished.body.trim()
      ) {
        throw new Error('The assistant returned an incomplete email. Your draft is unchanged.');
      }
      setPreview({
        subject: data.polished.subject,
        body: data.polished.body,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      });
      notify('Polished email ready for review');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Email polishing unavailable';
      setSetupNeeded(isSetupError(message));
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const translateDraft = async () => {
    if (translating) return;
    setTranslateError('');
    const text = (preview ? preview.body : body).trim();
    if (!text) {
      setTranslateError('Write a message before translating it.');
      return;
    }
    if (source === target) {
      setTranslateError('Choose a different source and target language.');
      return;
    }
    setTranslating(true);
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source, target, mode: 'email' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Email translation unavailable');
      if (typeof data.translation !== 'string' || !data.translation.trim()) {
        throw new Error('The translation was empty. Your draft is unchanged; please retry.');
      }
      setTranslation(data.translation);
      setTranslatedFrom(preview ? 'polished draft' : 'draft');
      notify(`Draft translated from ${source} to ${target}`);
    } catch (caught) {
      setTranslateError(caught instanceof Error ? caught.message : 'Email translation unavailable');
    } finally {
      setTranslating(false);
    }
  };

  const usePolished = () => {
    if (!preview) return;
    setSubject(preview.subject);
    setBody(preview.body);
    setPreview(null);
    setTranslation('');
    setError('');
    notify('Reviewed email applied to your draft');
  };

  const copyEmail = async (emailSubject: string, emailBody: string) => {
    const text = `${to.trim() ? `To: ${to.trim()}\n` : ''}${emailSubject ? `Subject: ${emailSubject}\n` : ''}\n${emailBody}`;
    try {
      await navigator.clipboard.writeText(text);
      notify('Email copied to clipboard');
    } catch {
      notify('Clipboard access is unavailable');
    }
  };

  const openEmailApp = () => {
    if (!preview) return;
    if (!to.trim()) {
      setError('Add a recipient before opening this message in your email app.');
      return;
    }
    if (!EMAIL_PATTERN.test(to.trim())) {
      setError('Enter a valid recipient e-mail address before opening your email app.');
      return;
    }
    const params = new URLSearchParams({ subject: preview.subject, body: preview.body });
    window.location.href = `mailto:${encodeURIComponent(to.trim())}?${params.toString()}`;
  };

  const clearDraft = () => {
    setTo('');
    setSubject('');
    setBody('');
    setPreview(null);
    setTranslation('');
    setError('');
    setTranslateError('');
    notify('Draft cleared');
  };

  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">EMAIL WORKSPACE</div>
          <h1>Say it just right.</h1>
          <p>Polish grammar, tone and length, translate, then review every change before you send.</p>
        </div>
        <span className="draft-only"><ShieldCheck size={14} /> Local draft · nothing sends automatically</span>
      </section>

      <div className="email-layout">
        <div className="compose-card">
          <div className="compose-top">
            <span className="quick-icon sky"><Mail size={18} /></span>
            <div>
              <b>New email draft</b>
              <small>Your original stays unchanged until you accept the reviewed version.</small>
            </div>
          </div>

          <label className="field-label">
            TO
            <input
              type="email"
              placeholder="name@example.com"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setError('');
              }}
            />
          </label>

          <label className="field-label">
            SUBJECT
            <input
              placeholder="A quick note about…"
              maxLength={300}
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                setError('');
              }}
            />
          </label>

          <label className="field-label">
            YOUR MESSAGE
            <textarea
              placeholder="Start writing in English or हिन्दी…"
              rows={10}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setPreview(null);
                setError('');
              }}
            />
          </label>

          <div className={`counter-line ${bodyCharacters > MAX_CHARS ? 'over' : ''}`}>
            <span>{wordCount(body)} words · {bodyCharacters.toLocaleString()}/{MAX_CHARS.toLocaleString()} characters</span>
            <span className="draft-status">{saved ? 'Draft saved on this device' : 'Saved automatically'}</span>
          </div>

          <div className="tone-row">
            <span>TONE</span>
            {TONES.map((item) => (
              <button
                key={item.value}
                className={`tone-chip ${tone === item.value ? 'active' : ''}`}
                onClick={() => setTone(item.value)}
                aria-pressed={tone === item.value}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="tone-row">
            <span>LENGTH</span>
            {LENGTHS.map((item) => (
              <button
                key={item.value}
                className={`tone-chip ${length === item.value ? 'active' : ''}`}
                onClick={() => setLength(item.value)}
                aria-pressed={length === item.value}
              >
                {item.label}
              </button>
            ))}
          </div>

          {error && (
            <div className="assistant-error" role="alert">
              <X size={15} />
              <span>{error}</span>
              {!setupNeeded && <button onClick={polish} disabled={busy}>Retry</button>}
            </div>
          )}

          {setupNeeded && (
            <div className="setup-note" role="status">
              <AlertTriangle size={14} />
              <span>
                Email polishing needs an AI provider key. Add <code>GEMINI_API_KEY</code> to the server's
                <code>.env</code> file and restart the API. Translating the draft works without a key.
              </span>
            </div>
          )}

          <div className="compose-bottom">
            <div className="language-controls">
              <select value={source} onChange={(event) => setSource(event.target.value as 'English' | 'Hindi')}>
                <option>English</option>
                <option>Hindi</option>
              </select>
              <ArrowRight size={13} />
              <select value={target} onChange={(event) => setTarget(event.target.value as 'English' | 'Hindi')}>
                <option>Hindi</option>
                <option>English</option>
              </select>
              <span className="email-translation-note">Translate is separate from polishing.</span>
            </div>

            <div className="compose-buttons">
              <button className="primary-button" onClick={polish} disabled={busy}>
                {busy ? (
                  <>
                    <LoaderCircle size={15} className="spin" /> Polishing…
                  </>
                ) : (
                  <>
                    <WandSparkles size={15} /> Polish email
                  </>
                )}
              </button>
              <button className="secondary-button" onClick={translateDraft} disabled={translating}>
                {translating ? (
                  <>
                    <LoaderCircle size={15} className="spin" /> Translating…
                  </>
                ) : (
                  <>
                    <Languages size={15} /> Translate draft
                  </>
                )}
              </button>
            </div>
          </div>

          <p className="email-note">
            Polishing keeps names, dates, figures and links exactly as written. Translation uses the local
            English↔Hindi engine and translates {preview ? 'the reviewed message above' : 'your current draft'}.
          </p>
        </div>

        <div className="email-side">
          {preview ? (
            <div className="email-review-card">
              <div className="panel-title">
                <div>
                  <h3>Review polished email</h3>
                  <p>Edit the suggested subject or message before using it.</p>
                </div>
                <span className="review-badge"><Check size={12} /> REVIEW</span>
              </div>

              {preview.warnings.length > 0 && (
                <ul className="warning-list">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>
                      <AlertTriangle size={12} /> <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}

              <label className="field-label">
                SUBJECT
                <input
                  value={preview.subject}
                  onChange={(event) => setPreview({ ...preview, subject: event.target.value })}
                />
              </label>

              <label className="field-label">
                MESSAGE
                <textarea
                  rows={8}
                  value={preview.body}
                  onChange={(event) => setPreview({ ...preview, body: event.target.value })}
                />
              </label>

              <div className="review-actions">
                <button className="secondary-button" onClick={() => setShowChanges((value) => !value)}>
                  {showChanges ? 'Hide changes' : 'Show changes'}
                </button>
              </div>

              {showChanges && <DiffText before={body} after={preview.body} />}

              <div className="review-actions">
                <button className="secondary-button" onClick={usePolished}>
                  <Check size={14} /> Use this draft
                </button>
                <button className="secondary-button" onClick={() => copyEmail(preview.subject, preview.body)}>
                  <Copy size={14} /> Copy email
                </button>
                <button className="primary-button" onClick={openEmailApp}>
                  <Send size={14} /> Open to send
                </button>
              </div>
              <small className="send-explainer">
                Opens a prepared message in your default email app. It is not sent by LangChain.
              </small>
            </div>
          ) : (
            <div className="email-result">
              <div className="panel-title">
                <div>
                  <h3>Ready for review</h3>
                  <p>Your polished version will appear here before you use it.</p>
                </div>
              </div>
              <div className="draft-placeholder">
                <WandSparkles size={20} />
                <span>Write an email, choose a tone, then select “Polish email”.</span>
              </div>
              <button className="text-action" onClick={clearDraft}>Clear draft</button>
            </div>
          )}

          {(translation || translateError) && (
            <div className="translation-card">
              <div className="panel-title">
                <div>
                  <h3>{source} → {target}</h3>
                  <p>{translatedFrom ? `Translation of your ${translatedFrom}.` : 'Translated draft.'}</p>
                </div>
              </div>
              {translateError && (
                <div className="assistant-error" role="alert">
                  <X size={15} />
                  <span>{translateError}</span>
                </div>
              )}
              {translation && (
                <>
                  <pre>{translation}</pre>
                  <button
                    className="text-action"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(translation);
                        notify('Translation copied to clipboard');
                      } catch {
                        notify('Clipboard access is unavailable');
                      }
                    }}
                  >
                    <Copy size={14} /> Copy translation
                  </button>
                </>
              )}
            </div>
          )}

          {!preview && !translation && !translateError && (
            <div className="integration-card">
              <span className="quick-icon lavender"><Mail size={18} /></span>
              <h3>Review, then send</h3>
              <p>Copy the reviewed draft, or open it in your email app. You make the final send decision there.</p>
              <small>No account connected · local draft only</small>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
