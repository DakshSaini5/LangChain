import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { DiffText } from './textDiff';
import { api } from './apiBase';

type Operation = 'clarity' | 'proofread' | 'formal' | 'simplify' | 'rewrite' | 'summary';

type Stats = {
  sourceWords: number;
  suggestionWords: number;
  sourceChars: number;
  suggestionChars: number;
};

type Suggestion = {
  suggestion: string;
  warnings: string[];
  stats?: Stats;
  language?: string;
};

type Props = { notify: (message: string) => void };

const MAX_CHARS = 30000;

const OPERATIONS: { value: Operation; label: string; hint: string }[] = [
  { value: 'clarity', label: 'Improve clarity', hint: 'Same meaning, easier to follow.' },
  { value: 'proofread', label: 'Proofread', hint: 'Grammar, spelling and punctuation only.' },
  { value: 'formal', label: 'Make formal', hint: 'Official register, no added claims.' },
  { value: 'simplify', label: 'Simplify', hint: 'Simpler sentences, key details kept.' },
  { value: 'rewrite', label: 'Rewrite', hint: 'Fresh wording, same facts.' },
  { value: 'summary', label: 'Summarize', hint: 'Only what the text already says.' },
];

function wordCount(text: string) {
  const words = text.trim().match(/[^\s]+/g);
  return words ? words.length : 0;
}

function detectLanguage(text: string) {
  if (!text.trim()) return 'English or हिन्दी';
  return /[\u0900-\u097F]/.test(text) ? 'Hindi' : 'English';
}

function isSetupError(message: string) {
  return message.includes('GEMINI_API_KEY') || message.includes('not configured');
}

export default function WritingAssistant({ notify }: Props) {
  const [input, setInput] = useState('');
  const [operation, setOperation] = useState<Operation>('clarity');
  const [result, setResult] = useState<Suggestion | null>(null);
  const [view, setView] = useState<'suggestion' | 'changes'>('suggestion');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setupNeeded, setSetupNeeded] = useState(false);

  const activeOperation = OPERATIONS.find((item) => item.value === operation) ?? OPERATIONS[0];
  const characters = input.trim().length;

  const suggest = async () => {
    if (busy) return;
    const text = input.trim();
    if (!text) {
      setError('Add some text first, then choose a writing operation.');
      return;
    }
    if (text.length > MAX_CHARS) {
      setError(`That text is ${text.length.toLocaleString()} characters. The limit is ${MAX_CHARS.toLocaleString()} characters — split it into smaller passages.`);
      return;
    }
    setBusy(true);
    setError('');
    setSetupNeeded(false);
    try {
      const response = await fetch(api('/api/assist'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, operation }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Writing assistant unavailable');
      if (typeof data.suggestion !== 'string' || !data.suggestion.trim()) {
        throw new Error('The assistant returned an empty suggestion. Your text is unchanged; please retry.');
      }
      setResult({
        suggestion: data.suggestion,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        stats: data.stats ?? undefined,
        language: data.language ?? undefined,
      });
      setView('suggestion');
      const warnings = Array.isArray(data.warnings) ? data.warnings.length : 0;
      notify(warnings ? 'Suggestion ready — check the flagged figures and links' : 'Suggestion ready for review');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Writing assistant unavailable';
      setSetupNeeded(isSetupError(message));
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (!result) return;
    setInput(result.suggestion);
    setResult(null);
    notify('Suggestion accepted into the editor. Review it before copying.');
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.suggestion);
      notify('Suggestion copied to clipboard');
    } catch {
      notify('Clipboard access is unavailable');
    }
  };

  const suggestionWords = result ? (result.stats?.suggestionWords ?? wordCount(result.suggestion)) : 0;
  const sourceWords = wordCount(input);

  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">WRITING ASSISTANT</div>
          <h1>Find the words you mean.</h1>
          <p>Bilingual English–Hindi editing with a review step. Nothing replaces your text until you accept it.</p>
        </div>
        <span className="draft-only"><Sparkles size={14} /> Suggestions need your review</span>
      </section>

      <div className="assistant-layout">
        <div className="assistant-card">
          <div className="assistant-mode">
            {OPERATIONS.map((item) => (
              <button
                key={item.value}
                className={operation === item.value ? 'active' : ''}
                onClick={() => {
                  setOperation(item.value);
                  setError('');
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="operation-hint">{activeOperation.hint}</p>

          <label className="field-label">
            YOUR TEXT
            <textarea
              rows={9}
              placeholder="Paste the passage you want help with — English or हिन्दी."
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setResult(null);
                setError('');
              }}
            />
          </label>

          <div className={`counter-line ${characters > MAX_CHARS ? 'over' : ''}`}>
            <span>{sourceWords} words · {characters.toLocaleString()}/{MAX_CHARS.toLocaleString()} characters</span>
            <span>Detected: {detectLanguage(input)}</span>
          </div>

          {error && (
            <div className="assistant-error" role="alert">
              <X size={15} />
              <span>{error}</span>
              {!setupNeeded && <button onClick={suggest} disabled={busy}>Retry</button>}
            </div>
          )}

          {setupNeeded && (
            <div className="setup-note" role="status">
              <AlertTriangle size={14} />
              <span>
                Generative editing needs an AI provider key. Add <code>GEMINI_API_KEY</code> to the server's
                <code>.env</code> file and restart the API (<code>npm run dev:api</code>). The key stays on the
                server and is never sent to the browser.
              </span>
            </div>
          )}

          <div className="assistant-submit">
            <span>
              Translation, proofreading and rewriting are separate tools. Every suggestion is checked for changed
              numbers, links and e-mail addresses before it reaches you.
            </span>
            <button className="primary-button" onClick={suggest} disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={15} className="spin" /> Working…
                </>
              ) : (
                <>
                  <Sparkles size={15} /> Get suggestion
                </>
              )}
            </button>
          </div>
        </div>

        <div className="suggestion-card">
          <div className="panel-title">
            <div>
              <h3>Suggestion</h3>
              <p>A proposed edit, ready for your review.</p>
            </div>
            {result && (
              <div className="view-chips">
                <button className={view === 'suggestion' ? 'active' : ''} onClick={() => setView('suggestion')}>
                  Suggestion
                </button>
                <button className={view === 'changes' ? 'active' : ''} onClick={() => setView('changes')}>
                  Changes
                </button>
              </div>
            )}
          </div>

          {result ? (
            <>
              <div className="suggestion-meta">
                <ShieldCheck size={12} /> {result.language ?? detectLanguage(input)} · {suggestionWords} words
                {result.stats ? ` (was ${result.stats.sourceWords})` : sourceWords ? ` (was ${sourceWords})` : ''}
              </div>

              {result.warnings.length > 0 && (
                <ul className="warning-list">
                  {result.warnings.map((warning) => (
                    <li key={warning}>
                      <AlertTriangle size={12} /> <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}

              {view === 'changes'
                ? <DiffText before={input} after={result.suggestion} />
                : <div className="suggestion-text">{result.suggestion}</div>}

              <div className="suggestion-buttons">
                <button className="primary-button" onClick={accept}>
                  <Check size={15} /> Accept suggestion
                </button>
                <button className="secondary-button" onClick={suggest} disabled={busy}>
                  <RotateCcw size={14} /> Regenerate
                </button>
                <button className="secondary-button" onClick={copy}>
                  <Copy size={14} /> Copy
                </button>
                <button className="secondary-button" onClick={() => setResult(null)}>
                  <X size={14} /> Reject
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Sparkles size={25} />
              <b>Your suggestion will show up here</b>
              <span>You stay in control of every change.</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
