# ============================================================
# Budget-Pal Backend Dockerfile
# Multi-stage: builder → runtime
# Python 3.11-slim + system OCR deps
# ============================================================

# ── Stage 1: Build dependencies ───────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# System build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    libpq-dev \
    libffi-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps into /build/wheels
COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip wheel --no-cache-dir --wheel-dir /build/wheels -r requirements.txt

# ── Stage 2: Runtime ──────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# System runtime deps
# tesseract-ocr + poppler-utils for PDF/OCR pipeline
# libgomp1 for numpy/scipy OpenMP support
# curl for health check
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-deu \
    tesseract-ocr-fra \
    poppler-utils \
    libpq5 \
    libgomp1 \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    libgl1-mesa-glx \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy wheels from builder and install
COPY --from=builder /build/wheels /wheels
COPY --from=builder /build/requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt && \
    rm -rf /wheels

# Create non-root user for security
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app/data/uploads /app/data/ocr_cache && \
    chown -R appuser:appuser /app

# Copy application code
COPY --chown=appuser:appuser app/ ./app/
COPY --chown=appuser:appuser alembic/ ./alembic/ 2>/dev/null || true
COPY --chown=appuser:appuser alembic.ini ./alembic.ini 2>/dev/null || true

USER appuser

# Pre-download sentence-transformers model at build time to avoid cold start
# Comment out if you want to reduce image size and download on first run
RUN python -c "\
from sentence_transformers import SentenceTransformer; \
model = SentenceTransformer('all-MiniLM-L6-v2'); \
print('Model cached successfully')" || \
    echo "Warning: sentence-transformers model pre-download failed. Will download on first run."

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
