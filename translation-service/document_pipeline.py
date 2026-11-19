"""Document translation pipeline for LangChang.

DOCX handling edits the text nodes of the original OOXML package in place, so
styles, tables, images, headers, footers, hyperlinks and relationships survive
untouched. PDF handling parses each page into a layout model (text blocks with
coordinates, tables, images) and reconstructs a fresh DOCX from it, which can
then be exported to ODT.

The translation model itself is injected as a callable so this module stays
independent from the IndicTrans2 service wiring.
"""

from __future__ import annotations

import io
import os
import posixpath
import re
import time
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = "{%s}" % W_NS
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

TranslateFn = Callable[[str, str, list[str]], list[str]]
ProgressFn = Callable[[str, int, str], None]

WORD_PART_RE = re.compile(
    r"^word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$"
)

URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>\"')\]]+", re.IGNORECASE)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
KEEP_TOKEN = "ZXQKEEP{:04d}QXZ"
KEEP_PATTERN = re.compile(r"Z\s*X\s*Q\s*K\s*E\s*E\s*P\s*(\d+)\s*Q\s*X\s*Z", re.IGNORECASE)

DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")
LATIN_RE = re.compile(r"[A-Za-z]")

ID_RE = re.compile(r"^[A-Za-z]{0,8}[-_/#]?\d[\w./#-]*$")
ALLCAPS_ID_RE = re.compile(r"^[A-Z0-9][A-Z0-9_\-/.#]{3,}$")
PUNCT_ONLY_RE = re.compile(r"^[\W\d_]+$")
CODE_HINT_RE = re.compile(
    r"(\{|\}|=>|\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(|</?[A-Za-z][\w-]*>|"
    r"\$\{|\bimport\s+\w+|\bconsole\.|\w+\([^)]*\)\s*;)"
)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?।])\s+")

MAX_MODEL_CHARS = 900
OCR_LANGS = ("eng", "eng+hin")


class DocumentError(Exception):
    """A user-facing document error with an HTTP status hint."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #


def detect_language(text: str) -> str | None:
    devanagari = len(DEVANAGARI_RE.findall(text))
    latin = len(LATIN_RE.findall(text))
    if devanagari == 0 and latin == 0:
        return None
    return "Hindi" if devanagari >= latin * 0.6 and devanagari > 0 else "English"


def is_translatable(text: str) -> bool:
    """True only for human-readable prose we should send to the model."""
    value = text.strip()
    if not value:
        return False
    if not re.search(r"[A-Za-z\u0900-\u097F]", value):
        return False
    if URL_RE.fullmatch(value) or EMAIL_RE.fullmatch(value):
        return False
    if PUNCT_ONLY_RE.fullmatch(value):
        return False
    if re.search(r"\d", value) and ID_RE.fullmatch(value):
        return False
    if re.search(r"\d", value) and ALLCAPS_ID_RE.fullmatch(value):
        return False
    if CODE_HINT_RE.search(value) and not re.search(r"[.!?।]\s*$", value):
        return False
    return True


def protect_inline(text: str) -> tuple[str, list[str]]:
    """Replace URLs and e-mail addresses with tokens the model should copy."""
    kept: list[str] = []

    def replace(match: re.Match[str]) -> str:
        kept.append(match.group(0))
        return KEEP_TOKEN.format(len(kept) - 1)

    protected = URL_RE.sub(replace, text)
    protected = EMAIL_RE.sub(replace, protected)
    return protected, kept


def restore_inline(text: str, kept: list[str]) -> tuple[str, list[str]]:
    """Put protected spans back; report spans the model dropped."""
    missing: list[str] = []
    for index, original in enumerate(kept):
        pattern = re.compile(
            rf"Z\s*X\s*Q\s*K\s*E\s*E\s*P\s*{index}\s*Q\s*X\s*Z", re.IGNORECASE
        )
        if pattern.search(text):
            text = pattern.sub(lambda _m, value=original: value, text)
        else:
            missing.append(original)
    return text, missing


def split_for_model(text: str, limit: int = MAX_MODEL_CHARS) -> list[str]:
    """Split long passages into sentences so no text is silently truncated."""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    current = ""
    for sentence in SENTENCE_SPLIT_RE.split(text):
        if current and len(current) + 1 + len(sentence) > limit:
            parts.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip() if current else sentence
    if current:
        parts.append(current)
    pieces: list[str] = []
    for part in parts:
        while len(part) > limit:
            cut = part.rfind(" ", 0, limit)
            if cut <= 0:
                cut = limit
            pieces.append(part[:cut])
            part = part[cut:].lstrip()
        if part:
            pieces.append(part)
    return pieces or [text]


def _clean(value: str) -> str:
    return "".join(ch for ch in value if ch in "\t\n\r" or ord(ch) >= 32)


def _translate_blocks(
    blocks: list[dict[str, Any]],
    source: str,
    target: str,
    translate: TranslateFn,
    progress: ProgressFn,
    start_pct: int = 22,
    end_pct: int = 82,
) -> tuple[dict[str, str], list[str]]:
    """Translate every block, batching them and keeping output aligned by id."""
    pending = [block for block in blocks if block["protected"].strip()]
    if not pending:
        return {}, []

    pieces: list[tuple[str, int, str]] = []
    for block in pending:
        for index, piece in enumerate(split_for_model(block["protected"])):
            pieces.append((block["id"], index, piece))

    results: dict[str, str] = {}
    warnings: list[str] = []
    batch = 8
    done = 0
    total = len(pieces)
    collected: dict[str, dict[int, str]] = defaultdict(dict)

    for start in range(0, total, batch):
        chunk = pieces[start : start + batch]
        translations = translate(source, target, [piece for _, _, piece in chunk])
        if len(translations) != len(chunk):
            raise DocumentError(
                "The translation engine returned an unexpected number of results.",
                502,
            )
        for (block_id, index, _piece), translation in zip(chunk, translations):
            collected[block_id][index] = (translation or "").strip()
        done += len(chunk)
        percent = start_pct + int((end_pct - start_pct) * done / max(1, total))
        progress("translating", percent, f"Translated {done} of {total} text passages")

    for block in pending:
        ordered = collected.get(block["id"], {})
        text = " ".join(ordered[index] for index in sorted(ordered) if ordered[index])
        if not text.strip():
            warnings.append(
                f"A passage could not be translated and was kept in the source language: "
                f"{block['original'][:60].strip()}..."
            )
            results[block["id"]] = block["original"]
        else:
            results[block["id"]] = text
    return results, warnings


# --------------------------------------------------------------------------- #
# File signature validation
# --------------------------------------------------------------------------- #

OLE_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def validate_docx_bytes(data: bytes) -> None:
    if data[:8] == OLE_SIGNATURE:
        raise DocumentError(
            "This DOCX is encrypted or password-protected. Remove the password in "
            "Word and upload it again.",
            422,
        )
    if not data[:4].startswith(b"PK"):
        raise DocumentError(
            "This file does not contain a valid DOCX package signature.", 415
        )
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            names = set(package.namelist())
            if package.testzip() is not None:
                raise DocumentError(
                    "The DOCX package is corrupted. Re-save it in Word and try again.",
                    422,
                )
    except zipfile.BadZipFile as exc:
        raise DocumentError(
            "The DOCX file is corrupted or incomplete. Re-save it and try again.", 422
        ) from exc
    if "[Content_Types].xml" not in names:
        raise DocumentError("This file is not a valid Office Open XML document.", 415)
    if "word/document.xml" not in names:
        raise DocumentError(
            "This file is not a Word document: no document body was found.", 415
        )


def validate_pdf_bytes(data: bytes) -> None:
    head = data[:1024]
    if b"%PDF-" not in head:
        raise DocumentError(
            "This file does not contain a valid PDF signature.", 415
        )
    if b"%%EOF" not in data[-2048:]:
        raise DocumentError(
            "The PDF is truncated or incomplete; the end-of-file marker is missing.",
            422,
        )


# --------------------------------------------------------------------------- #
# DOCX: OOXML text surgery
# --------------------------------------------------------------------------- #


def _paragraph_text_nodes(root: etree._Element) -> dict[etree._Element, list[etree._Element]]:
    """Group translatable ``w:t`` nodes by their own paragraph.

    Text inside hyperlinks, fields, deleted revisions and nested text boxes is
    deliberately skipped: URLs and field results are not prose.
    """
    grouped: dict[etree._Element, list[etree._Element]] = {}
    for node in root.iter(W + "t"):
        skip = False
        owner: etree._Element | None = None
        ancestor = node.getparent()
        while ancestor is not None:
            tag = ancestor.tag
            if tag in (
                W + "hyperlink",
                W + "fldSimple",
                W + "del",
                W + "delText",
                W + "moveFrom",
            ):
                skip = True
                break
            if tag == W + "p":
                owner = ancestor
                break
            ancestor = ancestor.getparent()
        if skip or owner is None:
            continue
        grouped.setdefault(owner, []).append(node)
    return grouped


def _collect_docx_blocks(
    parts: dict[str, bytes],
) -> tuple[dict[str, etree._Element], list[dict[str, Any]]]:
    roots: dict[str, etree._Element] = {}
    blocks: list[dict[str, Any]] = []
    counter = 0
    for name, payload in parts.items():
        if not WORD_PART_RE.match(name):
            continue
        try:
            root = etree.fromstring(payload)
        except etree.XMLSyntaxError:
            continue
        roots[name] = root
        for paragraph, nodes in _paragraph_text_nodes(root).items():
            texts = [node.text or "" for node in nodes]
            original = "".join(texts)
            if not original.strip() or not is_translatable(original):
                continue
            protected, kept = protect_inline(original)
            counter += 1
            blocks.append(
                {
                    "id": f"b{counter}",
                    "part": name,
                    "nodes": nodes,
                    "lengths": [len(text) for text in texts],
                    "original": original,
                    "protected": protected,
                    "kept": kept,
                }
            )
    return roots, blocks


def _distribute(nodes: list[etree._Element], lengths: list[int], translation: str) -> None:
    """Split the translated paragraph across the original runs.

    Run-level formatting (bold/italic/colour/size) stays attached to its own
    ``w:r``; only the text is redistributed proportionally to the original run
    lengths, snapped to word boundaries so words are not cut in half.
    """
    total = sum(lengths)
    if total <= 0:
        nodes[0].text = translation
        for node in nodes[1:]:
            node.text = ""
        return

    pieces: list[str] = []
    cursor = 0
    cumulative = 0
    for index, length in enumerate(lengths):
        cumulative += length
        if index == len(lengths) - 1:
            end = len(translation)
        else:
            end = round(len(translation) * cumulative / total)
            end = max(end, cursor)
            if 0 < end < len(translation):
                space = translation.find(" ", end)
                if 0 < space <= end + 24:
                    end = space + 1
                else:
                    back = translation.rfind(" ", cursor, end)
                    if back > cursor:
                        end = back + 1
        pieces.append(translation[cursor:end])
        cursor = end

    for node, piece in zip(nodes, pieces):
        node.text = _clean(piece)
        if piece[:1].isspace() or piece[-1:].isspace():
            node.set(XML_SPACE, "preserve")


def _rewrite_package(data: bytes, replacements: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                payload = replacements.get(info.filename, source.read(info.filename))
                clone = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                clone.compress_type = info.compress_type
                clone.external_attr = info.external_attr
                clone.internal_attr = info.internal_attr
                clone.create_system = info.create_system
                target.writestr(clone, payload)
    return buffer.getvalue()


def translate_docx(
    data: bytes,
    source: str,
    target: str,
    translate: TranslateFn,
    progress: ProgressFn,
) -> tuple[bytes, dict[str, Any]]:
    validate_docx_bytes(data)
    progress("extracting", 15, "Reading the DOCX package")
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        parts = {name: package.read(name) for name in package.namelist() if WORD_PART_RE.match(name)}

    roots, blocks = _collect_docx_blocks(parts)
    if not blocks:
        raise DocumentError(
            "No translatable text was found in this DOCX. It may contain only "
            "images, or all of its text is in hyperlinks and fields.",
            422,
        )

    detected = source
    if source == "Auto":
        sample = " ".join(block["original"] for block in blocks)[:4000]
        detected = detect_language(sample) or "English"
    if detected == target:
        raise DocumentError(
            f"This document already appears to be in {target}. Choose a different "
            "target language.",
            422,
        )

    translations, warnings = _translate_blocks(
        blocks, detected, target, translate, progress
    )

    progress("reconstructing", 86, "Writing translated text back into the original package")
    replacements: dict[str, bytes] = {}
    for block in blocks:
        translated = translations.get(block["id"], block["original"])
        translated, missing = restore_inline(translated, block["kept"])
        if missing:
            warnings.append(
                "A link or e-mail address could not be kept in one passage; that "
                "passage was left in its original language to avoid corrupting it."
            )
            translated = block["original"]
        _distribute(block["nodes"], block["lengths"], translated)

    for name, root in roots.items():
        replacements[name] = etree.tostring(
            root, xml_declaration=True, encoding="UTF-8", standalone=True
        )

    output = _rewrite_package(data, replacements)
    stats = _docx_stats(data)
    stats["translated_blocks"] = len(blocks)
    stats["detected_source"] = detected
    return output, {"stats": stats, "warnings": warnings}


def _docx_stats(data: bytes) -> dict[str, int]:
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        root = etree.fromstring(package.read("word/document.xml"))
        return {
            "paragraphs": len(list(root.iter(W + "p"))),
            "tables": len(list(root.iter(W + "tbl"))),
            "images": len(list(root.iter(W + "drawing"))),
            "characters": sum(
                len(node.text or "") for node in root.iter(W + "t")
            ),
        }


# --------------------------------------------------------------------------- #
# PDF: layout extraction
# --------------------------------------------------------------------------- #


def _join_lines(lines: list[str]) -> str:
    text = ""
    for line in lines:
        value = line.strip()
        if not value:
            continue
        if not text:
            text = value
        elif text.endswith("-") and value[:1].islower():
            text = text[:-1] + value
        else:
            text = f"{text} {value}"
    return text


def _rect_inside(inner: tuple[float, float, float, float], outer: tuple[float, float, float, float]) -> bool:
    cx = (inner[0] + inner[2]) / 2
    cy = (inner[1] + inner[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def _ocr_blocks(page: Any) -> list[dict[str, Any]]:
    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise DocumentError(
            "This PDF appears to be scanned, and OCR support is not installed on "
            "the translation service. Install pytesseract, Pillow and the Tesseract "
            "engine, or upload a text-based PDF.",
            422,
        ) from exc

    import shutil

    command = os.environ.get("TESSERACT_CMD", "tesseract")
    if shutil.which(command) is None and not Path(command).exists():
        raise DocumentError(
            "This PDF appears to be scanned. OCR requires the Tesseract engine, "
            "which is not installed on this machine. Install Tesseract (UB Mannheim "
            "build) and set TESSERACT_CMD, or upload a text-based PDF.",
            422,
        )

    pixmap = page.get_pixmap(dpi=200)
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    data: dict[str, Any] | None = None
    for languages in OCR_LANGS:
        try:
            data = pytesseract.image_to_data(
                image, output_type=pytesseract.Output.DICT, lang=languages
            )
            break
        except Exception:  # missing language data for a pack
            continue
    if data is None:
        raise DocumentError("OCR failed: the Tesseract language data is unavailable.", 502)

    scale = 72.0 / 200.0
    grouped: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    for index, raw in enumerate(data["text"]):
        word = (raw or "").strip()
        try:
            confidence = float(data["conf"][index])
        except (TypeError, ValueError):
            confidence = 0.0
        if not word or confidence < 30:
            continue
        grouped[(int(data["block_num"][index]), int(data["par_num"][index]))].append(
            {
                "text": word,
                "x0": float(data["left"][index]) * scale,
                "y0": float(data["top"][index]) * scale,
                "x1": (float(data["left"][index]) + float(data["width"][index])) * scale,
                "y1": (float(data["top"][index]) + float(data["height"][index])) * scale,
                "height": float(data["height"][index]) * scale,
            }
        )

    blocks: list[dict[str, Any]] = []
    for words in grouped.values():
        words.sort(key=lambda item: (item["y0"], item["x0"]))
        rows: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for word in words:
            rows[round(word["y0"] / 4)].append(word)
        lines = [
            " ".join(word["text"] for word in sorted(row, key=lambda w: w["x0"]))
            for _, row in sorted(rows.items())
        ]
        blocks.append(
            {
                "kind": "text",
                "text": _join_lines(lines),
                "x0": min(word["x0"] for word in words),
                "y0": min(word["y0"] for word in words),
                "x1": max(word["x1"] for word in words),
                "y1": max(word["y1"] for word in words),
                "size": max(8.0, round(max(word["height"] for word in words) * 0.95, 1)),
                "font": None,
                "bold": False,
                "italic": False,
                "ocr": True,
            }
        )
    return blocks


def _page_blocks(page: Any, number: int) -> tuple[list[dict[str, Any]], bool]:
    blocks: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []

    try:
        finder = page.find_tables()
        for table in finder.tables:
            rows = table.extract()
            if not rows:
                continue
            tables.append({"kind": "table", "rows": rows, "bbox": tuple(table.bbox)})
    except Exception:  # table detection is best-effort
        tables = []

    table_boxes = [table["bbox"] for table in tables]
    payload = page.get_text("dict")
    for raw in payload.get("blocks", []):
        if raw.get("type") != 0:
            continue
        lines: list[str] = []
        sizes: list[float] = []
        fonts: list[str] = []
        bold_votes = italic_votes = 0
        spans = 0
        for line in raw.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if text.strip():
                lines.append(text)
            for span in line.get("spans", []):
                spans += 1
                sizes.append(float(span.get("size", 10)))
                if span.get("font"):
                    fonts.append(str(span["font"]))
                flags = int(span.get("flags", 0))
                bold_votes += 1 if flags & 16 else 0
                italic_votes += 1 if flags & 2 else 0
        text = _join_lines(lines)
        if not text.strip():
            continue
        bbox = tuple(raw.get("bbox", (0, 0, 0, 0)))
        if any(_rect_inside(bbox, box) for box in table_boxes):
            continue
        blocks.append(
            {
                "kind": "text",
                "text": text,
                "x0": bbox[0],
                "y0": bbox[1],
                "x1": bbox[2],
                "y1": bbox[3],
                "size": round(max(sizes), 1) if sizes else 10.0,
                "font": _font_family(fonts[0]) if fonts else None,
                "bold": bold_votes * 2 >= max(1, spans),
                "italic": italic_votes * 2 >= max(1, spans),
                "ocr": False,
            }
        )

    blocks.extend(tables)

    has_text = any(block["kind"] == "text" and block["text"].strip() for block in blocks)
    if not has_text:
        try:
            ocr = _ocr_blocks(page)
        except DocumentError:
            if tables:
                return blocks, False
            raise
        blocks.extend(ocr)

    for block in blocks:
        block["page"] = number
    return blocks, any(block.get("ocr") for block in blocks)


def _font_family(name: str | None) -> str | None:
    if not name:
        return None
    cleaned = re.sub(r"^[A-Z]{6}\+", "", name)
    cleaned = cleaned.split(",")[0].strip()
    cleaned = re.sub(r"[-\s]*(Bold|Italic|Oblique|Regular|Light|Medium|Black|Semibold)+$", "", cleaned, flags=re.I)
    return cleaned or None


def _page_images(document: Any, page: Any) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for raw in page.get_images(full=True):
        xref = raw[0]
        try:
            payload = document.extract_image(xref)
        except Exception:
            continue
        if not payload or not payload.get("image"):
            continue
        try:
            rects = page.get_image_rects(xref)
        except Exception:
            rects = []
        for rect in rects:
            width = float(rect.width)
            height = float(rect.height)
            if width < 8 or height < 8:
                continue
            images.append(
                {
                    "kind": "image",
                    "bytes": payload["image"],
                    "x0": float(rect.x0),
                    "y0": float(rect.y0),
                    "x1": float(rect.x1),
                    "y1": float(rect.y1),
                    "width": width,
                    "height": height,
                }
            )
    return images


# --------------------------------------------------------------------------- #
# PDF: reconstruction into DOCX
# --------------------------------------------------------------------------- #


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def reconstruct_docx(layout: list[dict[str, Any]]) -> tuple[bytes, dict[str, Any]]:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt

    document = Document()
    warnings: list[str] = []
    images_added = 0
    tables_added = 0

    for page in layout:
        width_pt = float(page["width"])
        height_pt = float(page["height"])
        blocks = page["blocks"]
        if not blocks:
            continue

        section = document.sections[-1]
        section.page_width = Inches(width_pt / 72)
        section.page_height = Inches(height_pt / 72)
        section.orientation = 1 if width_pt > height_pt else 0
        section.page_width = Inches(width_pt / 72)
        section.page_height = Inches(height_pt / 72)

        xs0 = [block["x0"] for block in blocks if "x0" in block]
        left_margin = _clamp(min(xs0) / 72 if xs0 else 0.75, 0.25, 1.5)
        section.left_margin = Inches(left_margin)
        section.right_margin = Inches(left_margin)
        section.top_margin = Inches(0.6)
        section.bottom_margin = Inches(0.6)

        usable = (width_pt - left_margin * 144) / 72
        ordered = sorted(blocks, key=lambda item: (round(item.get("y0", 0), 1), item.get("x0", 0)))
        previous_bottom = 0.0
        for index, block in enumerate(ordered):
            if block["kind"] == "table":
                rows = [
                    [(_clean(cell or "")).strip() for cell in row]
                    for row in block["rows"]
                    if row
                ]
                if not rows:
                    continue
                columns = max(len(row) for row in rows)
                table = document.add_table(rows=len(rows), cols=columns)
                try:
                    table.style = "Table Grid"
                except Exception:
                    pass
                for row_index, row in enumerate(rows):
                    for column_index, cell in enumerate(row):
                        table.cell(row_index, column_index).text = cell
                tables_added += 1
                continue

            if block["kind"] == "image":
                image_width = min(block["width"] / 72, usable)
                try:
                    document.add_picture(
                        io.BytesIO(block["bytes"]), width=Inches(max(0.2, image_width))
                    )
                    images_added += 1
                except Exception:
                    warnings.append(
                        "An embedded image could not be inserted into the rebuilt document."
                    )
                continue

            paragraph = document.add_paragraph()
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
            gap = max(0.0, block["y0"] - previous_bottom)
            paragraph.paragraph_format.space_before = Pt(_clamp(gap * 0.7, 0, 18))
            paragraph.paragraph_format.space_after = Pt(0)
            indent = (block["x0"] - left_margin * 72) / 72
            if indent > 0.05:
                paragraph.paragraph_format.left_indent = Inches(min(indent, usable))
            run = paragraph.add_run(block["translated"] or block["text"])
            run.font.size = Pt(_clamp(float(block.get("size") or 10.5), 6, 48))
            run.bold = bool(block.get("bold"))
            run.italic = bool(block.get("italic"))
            family = block.get("font")
            if family:
                run.font.name = family
                rpr = run._element.get_or_add_rPr()
                rfonts = rpr.find(qn("w:rFonts"))
                if rfonts is None:
                    rfonts = rpr.makeelement(qn("w:rFonts"), {})
                    rpr.append(rfonts)
                rfonts.set(qn("w:cs"), family)
                rfonts.set(qn("w:eastAsia"), family)
            previous_bottom = block.get("y1", previous_bottom)

        if page is not layout[-1]:
            document.add_page_break()

    buffer = io.BytesIO()
    document.save(buffer)
    stats = {
        "paragraphs": len(document.paragraphs),
        "tables": tables_added,
        "images": images_added,
    }
    return buffer.getvalue(), {"stats": stats, "warnings": warnings}


# --------------------------------------------------------------------------- #
# ODT export
# --------------------------------------------------------------------------- #


def _heading_level(style_name: str | None) -> int | None:
    if not style_name:
        return None
    match = re.match(r"^(?:Heading|heading)\s*(\d)$", style_name.strip())
    if match:
        return int(match.group(1))
    if style_name.strip().lower() in ("title",):
        return 1
    return None


def docx_to_odt(docx_bytes: bytes, target_path: Path) -> None:
    from docx import Document
    from docx.oxml.ns import qn
    from odf.draw import Frame, Image
    from odf.opendocument import OpenDocumentText
    from odf.style import (
        MasterPage,
        PageLayout,
        PageLayoutProperties,
        ParagraphProperties,
        Style,
        TextProperties,
        Header,
        Footer,
    )
    from odf.table import Table, TableCell, TableRow
    from odf.text import H, LineBreak, P, Span

    source = Document(io.BytesIO(docx_bytes))
    target = OpenDocumentText()

    def text_style(name: str, **properties: Any) -> Any:
        style = Style(name=f"LC {name}", family="text")
        style.addElement(TextProperties(**properties))
        target.styles.addElement(style)
        return style

    bold = text_style("Bold", fontweight="bold")
    italic = text_style("Italic", fontstyle="italic")
    underline = text_style("Underline", textunderlinestyle="solid")
    bold_italic = text_style("BoldItalic", fontweight="bold", fontstyle="italic")

    paragraph_styles: dict[tuple[int, int, str], Any] = {}

    def paragraph_style(space_before: int, space_after: int, alignment: str) -> Any:
        key = (space_before, space_after, alignment)
        if key in paragraph_styles:
            return paragraph_styles[key]
        style = Style(name=f"LC P {space_before} {space_after} {alignment}", family="paragraph")
        properties: dict[str, Any] = {}
        if space_before:
            properties["margintop"] = f"{space_before / 20:.2f}pt"
        if space_after:
            properties["marginbottom"] = f"{space_after / 20:.2f}pt"
        if alignment:
            properties["textalign"] = alignment
        style.addElement(ParagraphProperties(**properties))
        target.styles.addElement(style)
        paragraph_styles[key] = style
        return style

    def run_styles(run: Any, parent: Any) -> None:
        pointers: list[Any] = []
        if run.bold:
            pointers.append(bold)
        if run.italic:
            pointers.append(bold_italic if run.bold else italic)
        if run.underline:
            pointers.append(underline)
        span = Span(stylename=pointers) if pointers else Span()
        if run.text:
            span.addText(_clean(run.text))
        for child in run._element:
            if child.tag == qn("w:br") or child.tag == qn("w:tab"):
                span.addElement(LineBreak())
        if len(span.childNodes) or run.text:
            parent.addElement(span)

    def add_paragraph(container: Any, paragraph: Any) -> None:
        heading = _heading_level(paragraph.style.name if paragraph.style else None)
        alignment_map = {1: "center", 2: "right", 3: "justify"}
        alignment = alignment_map.get(int(paragraph.alignment or 0), "")
        before = int((paragraph.paragraph_format.space_before.pt if paragraph.paragraph_format.space_before else 0) * 20)
        after = int((paragraph.paragraph_format.space_after.pt if paragraph.paragraph_format.space_after else 0) * 20)

        if heading:
            element = H(outlinelevel=heading)
        else:
            element = P(stylename=paragraph_style(min(before, 400), min(after, 400), alignment))

        for blip in paragraph._p.findall(".//" + qn("a:blip")):
            rid = blip.get(qn("r:embed"))
            if not rid:
                continue
            part = paragraph.part.related_parts.get(rid)
            if part is None:
                continue
            try:
                href = target.addPicture(part.blob)
                frame = Frame(
                    width=f"{(part.image.width or 0) / 914400:.2f}in",
                    height=f"{(part.image.height or 0) / 914400:.2f}in",
                )
                frame.addElement(Image(href=href))
                container.addElement(frame)
            except Exception:
                pass

        for run in paragraph.runs:
            run_styles(run, element)
        if not element.childNodes:
            element.addText("")
        container.addElement(element)

    def add_table(container: Any, table: Any) -> None:
        element = Table(name="LangChang table")
        for row in table.rows:
            table_row = TableRow()
            for cell in row.cells:
                attributes = {}
                span = getattr(cell, "grid_span", 1)
                if span and span > 1:
                    attributes["numbercolumnsspanned"] = span
                table_cell = TableCell(**attributes)
                if not cell.paragraphs:
                    table_cell.addElement(P())
                for paragraph in cell.paragraphs:
                    add_paragraph(table_cell, paragraph)
                table_row.addElement(table_cell)
            element.addElement(table_row)
        container.addElement(element)

    body = source.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            from docx.text.paragraph import Paragraph

            add_paragraph(target.text, Paragraph(child, source))
        elif child.tag == qn("w:tbl"):
            from docx.table import Table as DocxTable

            add_table(target.text, DocxTable(child, source))

    try:
        page_layout = PageLayout(name="LangChang page")
        width = source.sections[0].page_width
        height = source.sections[0].page_height
        if width and height:
            page_layout.addElement(
                PageLayoutProperties(
                    pagewidth=f"{width / 914400:.2f}in",
                    pageheight=f"{height / 914400:.2f}in",
                    margintop="0.79in",
                    marginbottom="0.79in",
                    marginleft="0.79in",
                    marginright="0.79in",
                )
            )
        master = MasterPage(name="Standard", pagelayoutname=page_layout)
        target.masterstyles.addElement(page_layout)

        header_lines: list[str] = []
        footer_lines: list[str] = []
        for section in source.sections:
            header_lines.extend(
                paragraph.text for paragraph in section.header.paragraphs if paragraph.text.strip()
            )
            footer_lines.extend(
                paragraph.text for paragraph in section.footer.paragraphs if paragraph.text.strip()
            )
        if header_lines:
            header = Header()
            for line in header_lines:
                header.addElement(P(text=line))
            master.addElement(header)
        if footer_lines:
            footer_element = Footer()
            for line in footer_lines:
                footer_element.addElement(P(text=line))
            master.addElement(footer_element)
        target.masterstyles.addElement(master)
    except Exception:
        pass

    target.save(str(target_path))


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #


def validate_output(
    data: bytes,
    output_format: str,
    *,
    source_images: int,
    source_tables: int,
    source_blocks: int,
    target_path: Path | None = None,
) -> dict[str, Any]:
    """Re-open the generated document and confirm nothing essential was lost."""
    report: dict[str, Any] = {"format": output_format.upper(), "checks": []}

    if output_format == "docx":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                if package.testzip() is not None:
                    raise DocumentError(
                        "The generated DOCX failed its integrity check. Please try again.",
                        500,
                    )
                names = set(package.namelist())
                root = etree.fromstring(package.read("word/document.xml"))
                text_nodes = [node for node in root.iter(W + "t") if (node.text or "").strip()]
                tables = len(list(root.iter(W + "tbl")))
                images = len(list(root.iter(W + "drawing")))
                rels_name = "word/_rels/document.xml.rels"
                missing_relations = 0
                if rels_name in names:
                    rels = etree.fromstring(package.read(rels_name))
                    for relation in rels:
                        if (relation.get("TargetMode") or "") == "External":
                            continue
                        target = relation.get("Target") or ""
                        if not target:
                            continue
                        resolved = (
                            target.lstrip("/")
                            if target.startswith("/")
                            else posixpath.normpath(posixpath.join("word", target))
                        )
                        if resolved not in names:
                            missing_relations += 1
        except (zipfile.BadZipFile, etree.XMLSyntaxError, KeyError) as exc:
            raise DocumentError(
                "The generated DOCX could not be opened for validation.", 500
            ) from exc

        report["checks"].append("Package integrity verified")
        report["checks"].append("Document body and relationships resolve")
        report["paragraphs_with_text"] = len(text_nodes)
        report["tables"] = tables
        report["images"] = images

        if not text_nodes:
            raise DocumentError("The generated DOCX contains no text.", 500)
        if missing_relations:
            raise DocumentError(
                "The generated DOCX is missing embedded parts referenced by the "
                "document. Export was stopped to protect your file.",
                500,
            )
        if source_images and images == 0:
            raise DocumentError(
                "Images were lost while rebuilding the document, so the export was "
                "stopped. Please try a different PDF or report this document.",
                500,
            )
        if source_tables and tables == 0:
            raise DocumentError(
                "Tables were lost while rebuilding the document, so the export was "
                "stopped. Please try a different document.",
                500,
            )
        if source_blocks and len(text_nodes) < max(1, source_blocks // 4):
            raise DocumentError(
                "Most of the translated text is missing from the generated document; "
                "the export was stopped instead of returning a damaged file.",
                500,
            )
        return report

    if output_format == "odt":
        from odf.opendocument import load
        from odf.teletype import extractText
        from odf.text import P as OdfParagraph

        if target_path is None:
            raise DocumentError("ODT validation requires an output file.", 500)
        try:
            produced = load(str(target_path))
        except Exception as exc:
            raise DocumentError(
                "The generated ODT could not be opened for validation.", 500
            ) from exc
        paragraphs = produced.getElementsByType(OdfParagraph)
        text = "".join(extractText(node) for node in paragraphs).strip()
        report["paragraphs_with_text"] = len(
            [node for node in paragraphs if extractText(node).strip()]
        )
        report["checks"].append("OpenDocument package loaded successfully")
        if not text:
            raise DocumentError("The generated ODT contains no text.", 500)
        if source_blocks and len(paragraphs) < max(1, source_blocks // 4):
            raise DocumentError(
                "Most paragraphs are missing from the generated ODT; the export was "
                "stopped instead of returning a damaged file.",
                500,
            )
        return report

    raise DocumentError(f"Unsupported output format: {output_format}", 400)


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #


def translate_document(
    *,
    data: bytes,
    original_name: str,
    output_format: str,
    source: str,
    target: str,
    translate: TranslateFn,
    progress: ProgressFn,
) -> tuple[bytes, dict[str, Any], list[str]]:
    started = time.time()
    suffix = Path(original_name).suffix.lower()
    output_format = output_format.lower().lstrip(".")
    if output_format not in ("docx", "odt"):
        raise DocumentError("Choose DOCX or ODT as the output format.", 400)
    if target not in ("English", "Hindi"):
        raise DocumentError("The selected target language is not supported.", 400)

    progress("validating", 8, "Validating the uploaded document")
    if suffix == ".docx":
        kind = "docx"
        validate_docx_bytes(data)
    elif suffix == ".pdf":
        kind = "pdf"
        validate_pdf_bytes(data)
    else:
        raise DocumentError("Only DOCX and PDF documents can be translated.", 415)

    warnings: list[str] = []
    stats: dict[str, Any] = {}
    preview = ""

    if kind == "docx":
        output, detail = translate_docx(data, source, target, translate, progress)
        stats = detail["stats"]
        warnings.extend(detail["warnings"])
        detected = stats["detected_source"]
        source_images = stats["images"]
        source_tables = stats["tables"]
        source_blocks = stats["translated_blocks"]
        preview = _docx_preview(output)
    else:
        progress("extracting", 14, "Opening the PDF")
        try:
            import fitz  # PyMuPDF
        except ImportError as exc:  # pragma: no cover
            raise DocumentError(
                "PDF support requires PyMuPDF on the translation service.", 500
            ) from exc

        try:
            document = fitz.open(stream=data, filetype="pdf")
        except Exception as exc:
            raise DocumentError(
                "This PDF could not be opened. It may be corrupted.", 422
            ) from exc
        if document.needs_pass:
            raise DocumentError(
                "This PDF is password-protected. Remove the password and upload it again.",
                422,
            )

        layout: list[dict[str, Any]] = []
        blocks: list[dict[str, Any]] = []
        used_ocr = False
        image_count = 0
        table_count = 0
        try:
            for number in range(document.page_count):
                page = document.load_page(number)
                page_blocks, ocr_used = _page_blocks(page, number)
                images = _page_images(document, page)
                page_blocks.extend(images)
                image_count += len(images)
                table_count += sum(1 for block in page_blocks if block["kind"] == "table")
                used_ocr = used_ocr or ocr_used
                layout.append(
                    {
                        "width": float(page.rect.width),
                        "height": float(page.rect.height),
                        "blocks": page_blocks,
                    }
                )
                progress(
                    "extracting",
                    14 + int(8 * (number + 1) / max(1, document.page_count)),
                    f"Read page {number + 1} of {document.page_count}",
                )
        finally:
            document.close()

        if used_ocr:
            warnings.append(
                "This PDF contains scanned pages. Text was recovered with OCR, so "
                "character accuracy depends on the scan quality."
            )

        for page_index, page in enumerate(layout):
            for block in page["blocks"]:
                if block["kind"] != "text":
                    continue
                if not is_translatable(block["text"]):
                    block["translated"] = block["text"]
                    continue
                protected, kept = protect_inline(block["text"])
                blocks.append(
                    {
                        "id": f"p{page_index}-{len(blocks)}",
                        "protected": protected,
                        "kept": kept,
                        "original": block["text"],
                    }
                )
                block["block_id"] = blocks[-1]["id"]

        if not blocks:
            raise DocumentError(
                "No translatable text was found in this PDF. It may contain only images.",
                422,
            )

        detected = source
        if source == "Auto":
            sample = " ".join(block["original"] for block in blocks)[:4000]
            detected = detect_language(sample) or "English"
        if detected == target:
            raise DocumentError(
                f"This document already appears to be in {target}. Choose a different "
                "target language.",
                422,
            )

        translations, block_warnings = _translate_blocks(
            blocks, detected, target, translate, progress
        )
        warnings.extend(block_warnings)

        for page in layout:
            for block in page["blocks"]:
                if block["kind"] == "text":
                    block["translated"] = translations.get(
                        block.get("block_id"), block["text"]
                    )

        progress("reconstructing", 86, "Rebuilding the document with the original layout")
        output, detail = reconstruct_docx(layout)
        stats = detail["stats"]
        warnings.extend(detail["warnings"])
        stats["pages"] = len(layout)
        stats["translated_blocks"] = len(blocks)
        stats["detected_source"] = detected
        stats["tables"] = max(stats.get("tables", 0), table_count)
        stats["images"] = max(stats.get("images", 0), image_count)
        source_images = image_count
        source_tables = table_count
        source_blocks = len(blocks)
        warnings.append(
            "PDF layouts are rebuilt from text coordinates, so exact positions, "
            "columns and multi-column flow may be approximated. Review the exported "
            "document before sharing it."
        )

    if output_format == "odt":
        progress("reconstructing", 90, "Building the OpenDocument (.odt) file")
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            odt_path = Path(directory) / "translated.odt"
            docx_to_odt(output, odt_path)
            output = odt_path.read_bytes()
            progress("validating", 95, "Validating the generated document")
            report = validate_output(
                output,
                "odt",
                source_images=source_images,
                source_tables=source_tables,
                source_blocks=source_blocks,
                target_path=odt_path,
            )
    else:
        progress("validating", 95, "Validating the generated document")
        report = validate_output(
            output,
            "docx",
            source_images=source_images,
            source_tables=source_tables,
            source_blocks=source_blocks,
        )

    if kind == "pdf":
        preview = _docx_preview(output) if output_format == "docx" else ""

    stats["validation"] = report
    stats["duration_ms"] = int((time.time() - started) * 1000)
    stats["output_format"] = output_format.upper()
    stats["input_format"] = kind.upper()
    stats["output_bytes"] = len(output)
    return output, {"stats": stats, "warnings": warnings, "preview": preview}, warnings


def _docx_preview(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            root = etree.fromstring(package.read("word/document.xml"))
        paragraphs = []
        for paragraph in root.iter(W + "p"):
            text = "".join(node.text or "" for node in paragraph.iter(W + "t")).strip()
            if text:
                paragraphs.append(text)
            if sum(len(item) for item in paragraphs) > 3000:
                break
        return "\n".join(paragraphs)[:4000]
    except Exception:
        return ""

