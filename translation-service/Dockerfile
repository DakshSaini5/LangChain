# Docker image for the LangChang translation engine (FastAPI + IndicTrans2).
#
# Build context is the contents of this folder, plus the shared dictionary:
#   <space>/app.py, document_pipeline.py, requirements.txt, data/english-hindi-dictionary.csv
#
# The service listens on $PORT (7860 by default) on 0.0.0.0 so a platform such
# as Hugging Face Spaces or Fly.io can route traffic to it.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf \
    PORT=7860

WORKDIR /app

# Tesseract is only used for scanned PDFs; the GL libraries are needed by PyMuPDF/Pillow.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu torch==2.4.1 \
 && pip install -r requirements.txt

COPY . .

# The service reads ../data/english-hindi-dictionary.csv relative to app.py.
COPY data/ /data/

EXPOSE 7860

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
