import {
  ArrowRight,
  BookOpen,
  Check,
  Download,
  FileCheck2,
  FileText,
  Languages,
  Mail,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import './landing.css';

type Props = { onEnter: () => void };

const FEATURES = [
  {
    icon: FileCheck2,
    title: 'Formatting preserved',
    copy: 'The original Word package is edited in place, so fonts, headings, tables, images, headers and page setup stay exactly where they were.',
  },
  {
    icon: Languages,
    title: 'English ↔ हिन्दी',
    copy: 'A dedicated English–Hindi engine, not a generic translator. Meaning, tone and sentence structure are handled for both directions.',
  },
  {
    icon: Download,
    title: 'DOCX and ODT export',
    copy: 'Download a translated file that opens in Word, LibreOffice or Google Docs — not a plain-text dump of your document.',
  },
  {
    icon: ShieldCheck,
    title: 'Originals stay untouched',
    copy: 'Every translation is written to a new file. Your uploaded document is never modified, and outputs are validated before download.',
  },
];

const STEPS = [
  { number: '01', title: 'Upload', copy: 'Drop a DOCX or PDF up to 20 MB. The file signature is checked before anything else runs.' },
  { number: '02', title: 'Translate', copy: 'Text is read in place, translated, then laid back into the original structure — stage by stage, with live progress.' },
  { number: '03', title: 'Review & download', copy: 'Read the translated text, check the format notes, then download the DOCX or ODT.' },
];

const TOOLS = [
  {
    icon: FileText,
    title: 'Document translation',
    copy: 'Upload a document and get a translated file back with its layout intact.',
  },
  {
    icon: Languages,
    title: 'Translation Studio',
    copy: 'Compare original and translation side by side, edit both, apply your glossary, then confirm the review.',
  },
  {
    icon: WandSparkles,
    title: 'AI Writing Assistant',
    copy: 'Proofread, simplify, formalise or summarise a passage, and see exactly what changed before accepting it.',
  },
  {
    icon: Mail,
    title: 'Email Workspace',
    copy: 'Polish a draft for tone and length, translate it, then review every change before it leaves your desk.',
  },
  {
    icon: BookOpen,
    title: 'Glossary',
    copy: 'Keep terminology consistent across documents by pinning your preferred translations.',
  },
  {
    icon: ShieldCheck,
    title: 'Checked, not guessed',
    copy: 'Numbers, links and e-mail addresses are verified after every operation, so a figure never silently changes.',
  },
];

export default function Landing({ onEnter }: Props) {
  return (
    <div className="lp">
      <header className="lp-nav">
        <a className="lp-brand" href="#top" aria-label="LangChang home">
          <span className="lp-logo" aria-hidden="true"><i /><i /><i /></span>
          <span>LangChang</span>
        </a>
        <nav className="lp-links" aria-label="Landing sections">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#tools">Workspace</a>
          <a href="#about">About</a>
        </nav>
        <button className="lp-cta lp-cta-sm" onClick={onEnter}>
          Start translating <ArrowRight size={15} />
        </button>
      </header>

      <main id="top">
        <section className="lp-hero">
          <div className="lp-aura lp-aura-one" aria-hidden="true" />
          <div className="lp-aura lp-aura-two" aria-hidden="true" />
          <div className="lp-grid" aria-hidden="true" />

          <p className="lp-eyebrow"><Sparkles size={13} /> Document translation, rebuilt</p>
          <h1>
            Translate the words.<br />
            <span className="lp-gradient">Keep the document.</span>
          </h1>
          <p className="lp-lede">
            LangChang translates DOCX and PDF files between English and Hindi while preserving the
            fonts, tables, images and page setup that make them yours.
          </p>

          <div className="lp-hero-actions">
            <button className="lp-cta" onClick={onEnter}>
              Start translating <ArrowRight size={16} />
            </button>
            <a className="lp-ghost" href="#how">See how it works</a>
          </div>

          <ul className="lp-chips">
            <li>DOCX · PDF</li>
            <li>English ↔ हिन्दी</li>
            <li>DOCX · ODT out</li>
            <li>Original never modified</li>
          </ul>

          <div className="lp-stage" aria-hidden="true">
            <article className="lp-sheet lp-sheet-source">
              <div className="lp-sheet-top">
                <span className="lp-sheet-icon"><FileText size={14} /></span>
                <span className="lp-sheet-name">strategy-brief.docx</span>
              </div>
              <div className="lp-sheet-body">
                <span className="lp-h" />
                <span /><span /><span className="lp-short" />
                <span className="lp-table" />
                <span /><span className="lp-short" />
              </div>
              <div className="lp-sheet-foot"><span>English</span><span>Original</span></div>
            </article>

            <div className="lp-ribbon">
              <span className="lp-ribbon-line" />
              <span className="lp-ribbon-glow" />
              <span className="lp-ribbon-pulse" />
            </div>

            <article className="lp-sheet lp-sheet-target">
              <div className="lp-sheet-top">
                <span className="lp-sheet-icon lp-sheet-icon-alt"><Languages size={14} /></span>
                <span className="lp-sheet-name">strategy-brief-hindi.docx</span>
              </div>
              <div className="lp-sheet-body lp-sheet-body-hi">
                <span className="lp-h" />
                <span /><span /><span className="lp-short" />
                <span className="lp-table" />
                <span /><span className="lp-short" />
              </div>
              <div className="lp-sheet-foot"><span>हिन्दी</span><span>Translated · formatting kept</span></div>
            </article>

            <span className="lp-spark lp-spark-a" />
            <span className="lp-spark lp-spark-b" />
            <span className="lp-spark lp-spark-c" />
          </div>
        </section>

        <section className="lp-featurebar" id="features" aria-label="Core capabilities">
          {FEATURES.map(({ icon: Icon, title, copy }) => (
            <article className="lp-feature" key={title}>
              <span className="lp-feature-icon"><Icon size={17} /></span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </section>

        <section className="lp-section" id="how">
          <div className="lp-section-head">
            <p className="lp-eyebrow"><Sparkles size={13} /> How it works</p>
            <h2>Three steps. One intact document.</h2>
            <p>Every stage is real and visible — nothing is simulated, and you can stop at any point.</p>
          </div>
          <div className="lp-steps">
            {STEPS.map((step) => (
              <article className="lp-step" key={step.number}>
                <span className="lp-step-number">{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </article>
            ))}
          </div>
          <div className="lp-stages">
            <span>Validate</span>
            <i />
            <span>Read text</span>
            <i />
            <span>Translate</span>
            <i />
            <span>Rebuild layout</span>
            <i />
            <span>Check formatting</span>
          </div>
        </section>

        <section className="lp-section" id="tools">
          <div className="lp-section-head">
            <p className="lp-eyebrow"><Sparkles size={13} /> Inside the workspace</p>
            <h2>More than a converter.</h2>
            <p>Everything you need around a translation: review, terminology, writing help and email polish.</p>
          </div>
          <div className="lp-tools">
            {TOOLS.map(({ icon: Icon, title, copy }) => (
              <article className="lp-tool" key={title}>
                <span className="lp-tool-icon"><Icon size={17} /></span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-about" id="about">
          <div className="lp-about-copy">
            <p className="lp-eyebrow"><Sparkles size={13} /> Why LangChang</p>
            <h2>Language should not cost you your formatting.</h2>
            <p>
              Most translation tools flatten a document into plain text and hand back something you have to
              rebuild by hand. LangChang starts from the opposite end: the document is the source of truth.
              Text is translated inside the file, and the layout is checked before you download it.
            </p>
            <p>
              It is built for the work that actually matters — a district report, a policy note, a proposal
              that has to read correctly in both languages and still look like it was made in Word.
            </p>
            <ul className="lp-checks">
              <li><Check size={14} /> English and Hindi, both directions</li>
              <li><Check size={14} /> Text-based and scanned PDFs handled where reading is possible</li>
              <li><Check size={14} /> Clear format notes instead of silent layout damage</li>
            </ul>
          </div>
          <aside className="lp-about-card">
            <span className="lp-about-badge"><ShieldCheck size={14} /> Built around trust</span>
            <dl>
              <div><dt>Original file</dt><dd>Never written to</dd></div>
              <div><dt>Output</dt><dd>Validated before download</dd></div>
              <div><dt>Numbers &amp; links</dt><dd>Checked after translation</dd></div>
              <div><dt>Languages today</dt><dd>English ↔ हिन्दी</dd></div>
            </dl>
            <p className="lp-about-note">
              Language pairs are deliberately limited to the engine that has been verified, rather than
              offering coverage that has not been tested.
            </p>
          </aside>
        </section>

        <section className="lp-final">
          <div className="lp-final-glow" aria-hidden="true" />
          <h2>Your document, in another language — still your document.</h2>
          <p>Open the workspace and translate your first file. No setup, no formatting to redo.</p>
          <button className="lp-cta" onClick={onEnter}>
            Start translating <ArrowRight size={16} />
          </button>
          <span className="lp-final-note">DOCX or PDF · up to 20 MB · English ↔ हिन्दी</span>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-footer-brand">
          <span className="lp-logo" aria-hidden="true"><i /><i /><i /></span>
          <span>
            <b>LangChang</b>
            <small>Document translation workspace</small>
          </span>
        </div>
        <nav className="lp-footer-links" aria-label="Footer">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#tools">Workspace</a>
          <a href="#about">About</a>
        </nav>
        <p className="lp-footer-note">Made for documents that must stay intact.</p>
      </footer>
    </div>
  );
}
