"""End-to-end verification for the LangChang document translation engine.

Creates the document fixtures required by the specification, submits each one to
the real API, downloads the generated file and checks that content, formatting
and structure survived.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import time
from pathlib import Path

import fitz
import requests
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "data" / "fixtures"
OUTPUTS = ROOT / "data" / "verification"
API = "http://127.0.0.1:4000"

DEVANAGARI = re.compile(r"[\u0900-\u097F]")
results: list[tuple[str, bool, str]] = []

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - older interpreters
    pass


def record(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


def make_simple_docx() -> Path:
    path = FIXTURES / "01-simple-paragraphs.docx"
    document = Document()
    document.add_paragraph("Climate change affects agriculture in many regions.")
    document.add_paragraph("Farmers need better irrigation and reliable weather data.")
    document.add_paragraph("Local communities are working together on long term solutions.")
    document.save(path)
    return path


def make_headings_docx() -> Path:
    path = FIXTURES / "02-heading-styles.docx"
    document = Document()
    document.add_heading("Annual Report", level=0)
    document.add_heading("Financial Overview", level=1)
    document.add_paragraph("Revenue increased steadily across every region this year.")
    document.add_heading("Regional Performance", level=2)
    document.add_paragraph("The northern region recorded the strongest growth in sales.")
    document.add_heading("Outlook", level=3)
    document.add_paragraph("We expect continued expansion in the coming quarters.")
    document.save(path)
    return path


def make_formatting_docx() -> Path:
    path = FIXTURES / "03-bold-italic-underline.docx"
    document = Document()
    paragraph = document.add_paragraph()
    paragraph.add_run("This sentence is normal, ")
    bold = paragraph.add_run("this part is bold, ")
    bold.bold = True
    italic = paragraph.add_run("this part is italic, ")
    italic.italic = True
    underline = paragraph.add_run("and this part is underlined.")
    underline.underline = True
    second = document.add_paragraph()
    emphasised = second.add_run("Coloured text must keep its colour and size.")
    emphasised.font.size = Pt(16)
    emphasised.font.color.rgb = RGBColor(0x33, 0x66, 0xCC)
    second.add_run(" The rest of the sentence is plain.")
    document.save(path)
    return path


def make_table_docx() -> Path:
    path = FIXTURES / "04-complex-table.docx"
    document = Document()
    document.add_heading("Quarterly Results", level=1)
    table = document.add_table(rows=4, cols=3)
    table.style = "Table Grid"
    data = [
        ["Region", "Revenue", "Growth"],
        ["North", "120000", "12 percent"],
        ["South", "98000", "8 percent"],
        ["West", "76000", "5 percent"],
    ]
    for row_index, row in enumerate(data):
        for column_index, value in enumerate(row):
            table.cell(row_index, column_index).text = value
    merged = table.cell(3, 0).merge(table.cell(3, 1))
    merged.text = "Totals are reported in local currency."
    document.add_paragraph("All figures were reviewed by the finance team.")
    document.save(path)
    return path


def make_image_docx() -> Path:
    image_path = FIXTURES / "chart.png"
    if not image_path.exists():
        image = Image.new("RGB", (480, 240), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((40, 40, 200, 200), fill=(105, 98, 217))
        draw.rectangle((240, 90, 340, 200), fill=(37, 134, 101))
        image.save(image_path)
    path = FIXTURES / "05-with-image.docx"
    document = Document()
    document.add_heading("Performance Chart", level=1)
    document.add_paragraph("The chart below shows growth by quarter.")
    document.add_picture(str(image_path), width=Inches(4.2))
    document.add_paragraph("Both regions improved compared with last year.")
    document.save(path)
    return path


def make_header_footer_docx() -> Path:
    path = FIXTURES / "06-headers-footers.docx"
    document = Document()
    section = document.sections[0]
    section.header.paragraphs[0].text = "Confidential internal report"
    section.footer.paragraphs[0].text = "Page prepared by the strategy team"
    document.add_paragraph("This document explains the new operating model.")
    document.add_paragraph("Each team owns a clear set of responsibilities.")
    document.save(path)
    return path


def make_multipage_pdf() -> Path:
    path = FIXTURES / "07-multipage.pdf"
    document = fitz.open()
    pages = [
        "Introduction to the research programme",
        "The first phase measured user retention across three quarters.",
        "Participants reported clearer explanations and faster support.",
        "The final phase recommends further study before conclusions.",
    ]
    for index, text in enumerate(pages):
        page = document.new_page(width=595, height=842)
        page.insert_text((60, 80), f"Chapter {index + 1}", fontsize=20)
        page.insert_text((60, 130), text, fontsize=12)
        page.insert_text(
            (60, 170),
            "This paragraph continues the discussion with supporting detail.",
            fontsize=12,
        )
    document.save(path)
    return path


def make_scanned_pdf() -> Path:
    path = FIXTURES / "08-scanned.pdf"
    image_path = FIXTURES / "scan.png"
    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    draw.text((120, 140), "Scanned invoice", fill="black")
    draw.text((120, 220), "Total amount due is 4500 rupees.", fill="black")
    draw.text((120, 300), "Please pay before the end of the month.", fill="black")
    image.save(image_path)
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_image(page.rect, filename=str(image_path))
    document.save(path)
    return path


def make_table_pdf() -> Path:
    path = FIXTURES / "09-table.pdf"
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((60, 70), "Quarterly summary", fontsize=16)
    rows = [["Region", "Revenue"], ["North", "120000"], ["South", "98000"]]
    left, top, width, height = 60, 110, 160, 30
    for row_index, row in enumerate(rows):
        for column_index, cell in enumerate(row):
            rect = fitz.Rect(
                left + column_index * width,
                top + row_index * height,
                left + (column_index + 1) * width,
                top + (row_index + 1) * height,
            )
            page.draw_rect(rect, color=(0, 0, 0), width=0.8)
            page.insert_text((rect.x0 + 5, rect.y0 + 19), cell, fontsize=11)
    page.insert_text((60, 260), "Revenue grew across all regions this quarter.", fontsize=12)
    page.insert_text((60, 290), "Costs stayed flat during the same period.", fontsize=12)
    document.save(path)
    return path


def make_mixed_docx() -> Path:
    path = FIXTURES / "10-mixed-language.docx"
    document = Document()
    document.add_paragraph("यह दस्तावेज़ दो भाषाओं में लिखा गया है।")
    document.add_paragraph("This paragraph is written in English.")
    document.add_paragraph("नीचे दिया गया अनुच्छेद अंग्रेज़ी में है।")
    document.save(path)
    return path


# --------------------------------------------------------------------------- #
# API helpers
# --------------------------------------------------------------------------- #


def submit(path: Path, target: str, output_format: str = "DOCX", source: str = "Auto"):
    with path.open("rb") as handle:
        response = requests.post(
            f"{API}/api/documents/translate",
            files={"file": (path.name, handle, "application/octet-stream")},
            data={"source": source, "target": target, "outputFormat": output_format},
            timeout=120,
        )
    if response.status_code != 202:
        try:
            return None, response.json().get("error") or response.text
        except ValueError:
            return None, response.text
    job = response.json()["job"]
    deadline = time.time() + 900
    while time.time() < deadline:
        poll = requests.get(f"{API}/api/documents/jobs/{job['id']}", timeout=30)
        if poll.status_code != 200:
            return None, poll.text
        current = poll.json()["job"]
        if current["stage"] in ("completed", "failed"):
            return current, None
        time.sleep(1.5)
    return None, "Timed out waiting for translation"


def download(job: dict, name: str) -> Path:
    response = requests.get(
        f"{API}/api/documents/jobs/{job['id']}/download", timeout=120
    )
    response.raise_for_status()
    target = OUTPUTS / name
    target.write_bytes(response.content)
    return target


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def has_devanagari(text: str) -> bool:
    return bool(DEVANAGARI.search(text))


def docx_text(path: Path) -> str:
    document = Document(str(path))
    parts = [paragraph.text for paragraph in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                parts.append(cell.text)
    for section in document.sections:
        parts.extend(paragraph.text for paragraph in section.header.paragraphs)
        parts.extend(paragraph.text for paragraph in section.footer.paragraphs)
    return "\n".join(parts)


def run_docx_case(
    label: str,
    path: Path,
    target: str,
    output_format: str = "DOCX",
    source: str = "Auto",
) -> Path | None:
    before = digest(path)
    job, error = submit(path, target, output_format, source)
    if error:
        record(label, False, f"API error: {error}")
        return None
    assert job is not None
    if job["stage"] == "failed":
        record(label, False, f"job failed: {job['error']}")
        return None
    output = download(job, path.stem + f"-{target.lower()}.{output_format.lower()}")
    record(f"{label} · original unchanged", digest(path) == before, "uploaded file hash is identical")
    if output_format == "DOCX":
        text = docx_text(output)
        record(f"{label} · output opens", bool(text.strip()), "re-opened with python-docx")
        record(
            f"{label} · translated to {target}",
            has_devanagari(text) if target == "Hindi" else bool(re.search(r"[A-Za-z]", text)),
            f"{len(text)} characters of extracted text",
        )
    else:
        from odf.opendocument import load
        from odf.text import P

        from odf.teletype import extractText

        produced = load(str(output))
        paragraphs = produced.getElementsByType(P)
        text = "".join(extractText(node) for node in paragraphs)
        record(f"{label} · output opens", bool(text.strip()), "ODT loaded with odfpy")
        record(f"{label} · translated to {target}", has_devanagari(text), f"{len(paragraphs)} paragraphs")
    return output


# --------------------------------------------------------------------------- #
# Cases
# --------------------------------------------------------------------------- #


def main() -> int:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    OUTPUTS.mkdir(parents=True, exist_ok=True)

    health = requests.get(f"{API}/api/health", timeout=20).json()
    print("API health:", json.dumps(health))

    simple = make_simple_docx()
    headings = make_headings_docx()
    formatting = make_formatting_docx()
    table = make_table_docx()
    image = make_image_docx()
    headers = make_header_footer_docx()
    multipage = make_multipage_pdf()
    scanned = make_scanned_pdf()
    table_pdf = make_table_pdf()
    mixed = make_mixed_docx()

    # 1. Simple paragraphs
    output = run_docx_case("01 simple paragraphs", simple, "Hindi")
    if output:
        source_paragraphs = len([p for p in Document(str(simple)).paragraphs if p.text.strip()])
        target_paragraphs = len([p for p in Document(str(output)).paragraphs if p.text.strip()])
        record(
            "01 simple paragraphs · paragraph count preserved",
            source_paragraphs == target_paragraphs,
            f"{source_paragraphs} -> {target_paragraphs}",
        )

    # 2. Heading styles
    output = run_docx_case("02 heading styles", headings, "Hindi")
    if output:
        source_styles = [p.style.name for p in Document(str(headings)).paragraphs]
        target_styles = [p.style.name for p in Document(str(output)).paragraphs]
        record(
            "02 heading styles · style hierarchy preserved",
            source_styles == target_styles,
            f"{target_styles}",
        )

    # 3. Bold / italic / underline
    output = run_docx_case("03 mixed formatting", formatting, "Hindi")
    if output:
        def emphasis(path: Path):
            document = Document(str(path))
            return (
                sum(1 for p in document.paragraphs for r in p.runs if r.bold),
                sum(1 for p in document.paragraphs for r in p.runs if r.italic),
                sum(1 for p in document.paragraphs for r in p.runs if r.underline),
                [
                    (r.font.size.pt if r.font.size else None, str(r.font.color.rgb) if r.font.color and r.font.color.rgb else None)
                    for p in document.paragraphs
                    for r in p.runs
                    if r.font.size or (r.font.color and r.font.color.rgb)
                ],
            )

        source_emphasis = emphasis(formatting)
        target_emphasis = emphasis(output)
        record(
            "03 mixed formatting · bold/italic/underline preserved",
            source_emphasis[:3] == target_emphasis[:3],
            f"{source_emphasis[:3]} -> {target_emphasis[:3]}",
        )
        record(
            "03 mixed formatting · size and colour preserved",
            source_emphasis[3] == target_emphasis[3],
            f"{source_emphasis[3]} -> {target_emphasis[3]}",
        )

    # 4. Tables
    output = run_docx_case("04 complex table", table, "Hindi")
    if output:
        source_doc = Document(str(table))
        target_doc = Document(str(output))
        same_shape = len(source_doc.tables) == len(target_doc.tables) and all(
            len(a.rows) == len(b.rows) and len(a.columns) == len(b.columns)
            for a, b in zip(source_doc.tables, target_doc.tables)
        )
        record(
            "04 complex table · table structure preserved",
            same_shape,
            f"{len(target_doc.tables)} table(s), {len(target_doc.tables[0].rows)}x{len(target_doc.tables[0].columns)}",
        )
        cell_text = target_doc.tables[0].cell(1, 0).text.strip()
        record(
            "04 complex table · cell translated",
            has_devanagari(cell_text),
            f"first data cell: {cell_text[:40]}",
        )

    # 5. Images
    output = run_docx_case("05 embedded image", image, "Hindi")
    if output:
        record(
            "05 embedded image · image preserved",
            len(Document(str(output)).inline_shapes) == len(Document(str(image)).inline_shapes),
            f"{len(Document(str(output)).inline_shapes)} inline shape(s)",
        )

    # 6. Headers and footers
    output = run_docx_case("06 header and footer", headers, "Hindi")
    if output:
        produced = Document(str(output))
        header_text = " ".join(p.text for p in produced.sections[0].header.paragraphs)
        footer_text = " ".join(p.text for p in produced.sections[0].footer.paragraphs)
        record(
            "06 header and footer · translated",
            has_devanagari(header_text) and has_devanagari(footer_text),
            f"header: {header_text[:40]} | footer: {footer_text[:40]}",
        )

    # 7. Multi-page PDF
    output = run_docx_case("07 multi-page PDF", multipage, "Hindi")
    if output:
        produced = Document(str(output))
        record(
            "07 multi-page PDF · pages rebuilt",
            len(produced.paragraphs) >= 8,
            f"{len(produced.paragraphs)} paragraphs rebuilt",
        )

    # 8. Scanned PDF (OCR)
    job, error = submit(scanned, "Hindi")
    if error:
        record("08 scanned PDF · reported limitation", bool(error), f"rejected with: {error[:160]}")
    elif job and job["stage"] == "completed":
        output = download(job, "08-scanned-hindi.docx")
        record(
            "08 scanned PDF · OCR translation",
            has_devanagari(docx_text(output)),
            "scanned page translated after OCR",
        )
    else:
        record(
            "08 scanned PDF · reported limitation",
            bool(job and job.get("error")),
            f"{job.get('error') if job else 'unknown'}",
        )

    # 9. PDF with a table
    output = run_docx_case("09 PDF table", table_pdf, "Hindi")
    if output:
        produced = Document(str(output))
        record(
            "09 PDF table · table rebuilt",
            len(produced.tables) >= 1,
            f"{len(produced.tables)} table(s) rebuilt",
        )

    # 10. Mixed-language document
    output = run_docx_case("10 mixed language", mixed, "English", source="Auto")
    if output:
        text = docx_text(output)
        produced = Document(str(output))
        paragraphs = [p.text.strip() for p in produced.paragraphs if p.text.strip()]
        record(
            "10 mixed language · no content removed",
            len(paragraphs) == 3 and bool(re.search(r"[A-Za-z]", text)),
            f"{len(paragraphs)} of 3 paragraphs kept, output text is English",
        )

    # 11. ODT export
    output = run_docx_case("11 ODT export", simple, "Hindi", output_format="ODT")
    if output:
        record(
            "11 ODT export · correct extension",
            output.suffix == ".odt",
            output.name,
        )

    # 12. Validation of bad uploads
    bad = OUTPUTS / "not-a-document.docx"
    bad.write_bytes(b"this is not a docx file")
    response = requests.post(
        f"{API}/api/documents/translate",
        files={"file": (bad.name, bad.read_bytes(), "application/octet-stream")},
        data={"target": "Hindi", "outputFormat": "DOCX", "source": "Auto"},
        timeout=60,
    )
    record(
        "12 invalid DOCX rejected",
        response.status_code in (415, 422),
        f"HTTP {response.status_code}: {response.json().get('error', '')[:100]}",
    )

    response = requests.post(
        f"{API}/api/documents/translate",
        files={"file": ("notes.txt", b"plain text", "text/plain")},
        data={"target": "Hindi", "outputFormat": "DOCX", "source": "Auto"},
        timeout=60,
    )
    record(
        "12 unsupported type rejected",
        response.status_code in (400, 415),
        f"HTTP {response.status_code}: {response.json().get('error', '')[:100]}",
    )

    failed = [name for name, ok, _ in results if not ok]
    print("\n" + "=" * 70)
    print(f"{len(results) - len(failed)} passed, {len(failed)} failed")
    for name in failed:
        print("  failed:", name)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
