import os
import csv
import json
import re
import threading
import time
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal
from dotenv import load_dotenv
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from document_pipeline import DocumentError, translate_document
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
from IndicTransToolkit import IndicProcessor

load_dotenv()    

DICTIONARY_PATH = (
    Path(__file__).resolve().parent.parent
    / "data"
    / "english-hindi-dictionary.csv"
)

def normalize_term(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def load_dictionary() -> dict[str, str]:
    candidates: dict[str, set[str]] = {}

    if not DICTIONARY_PATH.exists():
        print(f"[Dictionary] CSV not found: {DICTIONARY_PATH}")
        return {}

    with DICTIONARY_PATH.open(
        "r", encoding="utf-8-sig", newline=""
    ) as file:
        reader = csv.DictReader(file)

        for row in reader:
            source = re.sub(r"\s+", " ", row.get("eword") or "").strip()
            target = re.sub(r"\s+", " ", row.get("hword") or "").strip()
            grammar = (row.get("egrammar") or "").strip().casefold()

            if not source or not target:
                continue

            # Skip very long expressions and idioms for the first version.
            if len(source) > 80 or len(source.split()) < 2:
                continue

            if grammar == "idioms":
                continue

            if not re.search(r"[a-zA-Z]", source):
                continue

            candidates.setdefault(normalize_term(source), set()).add(target)

    # Automatically use only terms with one distinct Hindi translation.
    return {
        source: next(iter(targets))
        for source, targets in candidates.items()
        if len(targets) == 1
    }


DICTIONARY = load_dictionary()
print(f"[Dictionary] Loaded {len(DICTIONARY)} unambiguous phrases")

MODEL_IDS = {
    ("English", "Hindi"): os.getenv("INDICTRANS_EN_INDIC_MODEL", "ai4bharat/indictrans2-en-indic-dist-200M"),
    ("Hindi", "English"): os.getenv("INDICTRANS_INDIC_EN_MODEL", "ai4bharat/indictrans2-indic-en-dist-200M"),
}
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
BATCH_SIZE = int(os.getenv("MODEL_BATCH_SIZE", "8"))

HF_TOKEN = os.getenv("HF_TOKEN")

models = {}
tokenizers = {}
processor = None

LANGUAGE_CODES = {
    ("English", "Hindi"): ("eng_Latn", "hin_Deva"),
    ("Hindi", "English"): ("hin_Deva", "eng_Latn"),
}

class Segment(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    text: str = Field(max_length=4200)

class GlossaryItem(BaseModel):
    source: str = Field(min_length=1, max_length=150)
    target: str = Field(min_length=1, max_length=150)

class TranslateRequest(BaseModel):
    source: Literal["English", "Hindi"]
    target: Literal["English", "Hindi"]
    segments: list[Segment] = Field(min_length=1, max_length=64)
    glossary: list[GlossaryItem] = Field(default_factory=list, max_length=300)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global processor
    for direction, model_id in MODEL_IDS.items():
        tokenizers[direction] = AutoTokenizer.from_pretrained(
            model_id,
            trust_remote_code=True,
            token=HF_TOKEN,
        )

        models[direction] = AutoModelForSeq2SeqLM.from_pretrained(
            model_id,
            trust_remote_code=True,
            token=HF_TOKEN,
        ).to(DEVICE)
        models[direction].eval()
        print(f"Loaded {model_id} for {direction[0]} -> {direction[1]} on {DEVICE}")
    processor = IndicProcessor(inference=True)
    yield

app = FastAPI(title="ChangLang IndicTrans2 Service", version="1.0.0", lifespan=lifespan)

@app.get("/health")
def health():
    return {
        "ok": len(models) == 2,
        # Tuple keys must be strings for JSON serialization.
        "models": {f"{source}->{target}": model_id for (source, target), model_id in MODEL_IDS.items()},
        "device": DEVICE,
    }

MODEL_LOCK = threading.Lock()
JOBS: dict[str, dict] = {}


def translate_texts(source: str, target: str, texts: list[str], glossary=None) -> list[str]:
    """Translate a list of passages with the loaded IndicTrans2 models."""
    if source == target:
        raise HTTPException(status_code=400, detail="Source and target languages must differ.")
    direction = (source, target)
    if direction not in LANGUAGE_CODES:
        raise HTTPException(status_code=400, detail="This language pair is not configured yet.")
    if direction not in models or direction not in tokenizers or processor is None:
        raise HTTPException(status_code=503, detail="Models are loading.")

    glossary = glossary or []
    model = models[direction]
    tokenizer = tokenizers[direction]
    src_lang, tgt_lang = LANGUAGE_CODES[direction]
    output: list[str] = []

    for start in range(0, len(texts), BATCH_SIZE):
        batch = texts[start:start + BATCH_SIZE]
        protected_texts = []
        restorations = []
        for text in batch:
            current = text
            local_restorations = []
            for index, item in enumerate(sorted(glossary, key=lambda x: len(x.source), reverse=True)):
                if item.source.casefold() not in current.casefold():
                    continue
                pattern = re.compile(re.escape(item.source), re.IGNORECASE)
                placeholder = f"ZXQTERM{index:04d}QXZ"
                current, count = pattern.subn(placeholder, current)
                if count:
                    local_restorations.append((placeholder, item.target))
            protected_texts.append(current)
            restorations.append(local_restorations)

        prepared = processor.preprocess_batch(protected_texts, src_lang=src_lang, tgt_lang=tgt_lang)
        with MODEL_LOCK:
            inputs = tokenizer(
                prepared,
                truncation=True,
                padding="longest",
                return_tensors="pt",
                return_attention_mask=True,
            ).to(DEVICE)
            with torch.inference_mode():
                generated = model.generate(
                    **inputs,
                    use_cache=True,
                    min_length=1,
                    max_length=2048,
                    num_beams=4,
                    num_return_sequences=1,
                )
        decoded = tokenizer.batch_decode(
            generated, skip_special_tokens=True, clean_up_tokenization_spaces=True
        )
        decoded = processor.postprocess_batch(decoded, lang=tgt_lang)

        for position, (text, mapping) in enumerate(zip(decoded, restorations)):
            for placeholder, target_term in mapping:
                if placeholder not in text:
                    raise ValueError(
                        f"Glossary placeholder was lost for passage {position}. "
                        "Retry without applying a potentially incorrect translation."
                    )
                text = text.replace(placeholder, target_term)
            output.append(text.strip())
    return output


@app.post("/translate")
def translate(request: TranslateRequest):
    try:
        translations = translate_texts(
            request.source,
            request.target,
            [segment.text for segment in request.segments],
            request.glossary,
        )
        return {
            "segments": [
                {"id": segment.id, "translation": text}
                for segment, text in zip(request.segments, translations)
            ]
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Translation failed: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=500,
            detail="Translation failed. Check the translation service logs.",
        ) from exc


# --------------------------------------------------------------------------- #
# Document translation (DOCX / PDF -> DOCX / ODT)
# --------------------------------------------------------------------------- #


def _report_progress(job_id: str, stage: str, percent: int, message: str) -> None:
    if not job_id:
        return
    if len(JOBS) > 200:
        cutoff = time.time() - 7200
        for key in [key for key, value in JOBS.items() if value.get("updated", 0) < cutoff]:
            JOBS.pop(key, None)
    JOBS[job_id] = {
        "stage": stage,
        "progress": max(0, min(100, percent)),
        "message": message,
        "updated": time.time(),
    }


@app.get("/document/jobs/{job_id}")
def document_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown or expired document job.")
    return job


@app.post("/document/translate")
async def document_translate(request: Request):
    job_id = request.query_params.get("job_id", "")
    filename = request.headers.get("x-filename", "document.docx")
    output_format = request.headers.get("x-output-format", "docx")
    source = request.headers.get("x-source", "Auto")
    target = request.headers.get("x-target", "Hindi")
    work_dir = request.headers.get("x-work-dir", "")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="The uploaded document was empty.")

    if source not in ("Auto", "English", "Hindi"):
        raise HTTPException(status_code=400, detail="Unsupported source language.")
    if target not in ("English", "Hindi"):
        raise HTTPException(status_code=400, detail="Unsupported target language.")

    directory = Path(work_dir).resolve() if work_dir else None
    if directory is None or not directory.is_dir():
        raise HTTPException(status_code=400, detail="Invalid document workspace.")

    def do_translate(source_code: str, target_code: str, texts: list[str]) -> list[str]:
        return translate_texts(source_code, target_code, texts)

    def report(stage: str, percent: int, message: str) -> None:
        _report_progress(job_id, stage, percent, message)

    try:
        output, meta, warnings = await run_in_threadpool(
            translate_document,
            data=body,
            original_name=filename,
            output_format=output_format,
            source=source,
            target=target,
            translate=do_translate,
            progress=report,
        )
    except DocumentError as exc:
        _report_progress(job_id, "failed", 100, exc.message)
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    except HTTPException as exc:
        _report_progress(job_id, "failed", 100, str(exc.detail))
        raise
    except Exception as exc:
        print(f"Document translation failed: {type(exc).__name__}: {exc}")
        _report_progress(job_id, "failed", 100, "Document translation failed.")
        raise HTTPException(
            status_code=500,
            detail="Document translation failed. Check the translation service logs.",
        ) from exc

    suffix = output_format.lower().lstrip(".")
    output_name = f"translated.{suffix}"
    (directory / output_name).write_bytes(output)

    payload = {"output": output_name, "meta": meta, "warnings": warnings}
    (directory / "meta.json").write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
    _report_progress(job_id, "completed", 100, "Translation complete")
    return payload
