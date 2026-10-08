# PrintFlow3D Backend (FastAPI)

API do PrintFlow3D — biblioteca de modelos 3D, pastas, grupos de impressão,
thumbnails, manuais e importadores (Printables/MakerWorld).

## Rodando

```bash
pip install -r requirements.txt
uvicorn app:app --reload --port 8080
```

## Endpoints (resumo)

- `GET /api/health` — health check
- `/api/folders`, `/api/models`, `/api/model-groups` — CRUD da biblioteca
- `/api/models/{id}/download|thumbnail|manual` — arquivos dos modelos
- `/api/storage-stats` — uso de disco
- `/api/import/*`, `/api/printables/*` — importação externa
- `/api/settings/makerworld-token` — token MakerWorld

## Variáveis de ambiente

| Var | Default | Descrição |
| --- | --- | --- |
| `FILE_STORAGE` | `./app/uploads` | Diretório dos arquivos de modelos |
| `DB_PATH` | `data.db` | Arquivo SQLite |
| `MANUAL_STORAGE` | `FILE_STORAGE/manuals` | Diretório de manuais .md |
| `WEBUI_URL` | `http://localhost:5173` | Origem do frontend (CORS default) |
| `ALLOWED_ORIGINS` | `[WEBUI_URL]` | Origens CORS extras (vírgula) |
| `ROOT_PATH` | `""` | Prefixo público atrás de proxy (prod: `/3dpanel`) |
| `STATIC_DIR` | unset | Se apontar para um build do Vite, a API serve o SPA |
| `MAKERWORLD_BAMBU_TOKEN` | unset | Token semeado em `settings` |
