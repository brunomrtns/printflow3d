# =============================================================================
# PrintFlow3D — all-in-one production image
#
# Single container serving:
#   - the compiled React frontend (Vite build → /app/static)
#   - the FastAPI backend under /api/* (uvicorn, port 8080)
#
# The app is designed to run behind trivestia-nginx under the /3dpanel
# subpath. nginx strips the prefix before requests reach the container, and
# ROOT_PATH tells FastAPI how to regenerate public URLs (url_for, OpenAPI).
#
# Build args:
#   VITE_BASE_PATH — base path baked into the frontend bundle (default /3dpanel/)
#   VITE_API_URL   — public API base without /api suffix (default /3dpanel)
# =============================================================================

# --- Stage 1: frontend build ---
FROM node:22-alpine AS frontend-build

WORKDIR /fe

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ .

ARG VITE_BASE_PATH=/3dpanel/
ARG VITE_API_URL=/3dpanel
ENV VITE_BASE_PATH=$VITE_BASE_PATH \
    VITE_API_URL=$VITE_API_URL

RUN npm run build


# --- Stage 2: runtime ---
FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=frontend-build /fe/dist ./static

ENV FILE_STORAGE=/app/uploads \
    DB_PATH=/app/data/data.db \
    STATIC_DIR=/app/static

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health', timeout=3)" || exit 1

# --proxy-headers: trust X-Forwarded-Proto from the nginx front proxy so
# request.url_for (thumbnail URLs, redirects) emits https:// not http://.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
