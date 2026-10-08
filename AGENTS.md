# AGENTS.md — PrintFlow3D

Painel de gerenciamento para estúdios de impressão 3D. Fork adaptado de
`moddroid94/STLVault`. Serve sob `https://brunointegrations.com/3dpanel`.

## Build & Run Commands

- **Dev backend:** `cd backend && pip install -r requirements.txt && uvicorn app:app --reload --port 8080`
- **Dev frontend:** `cd frontend && npm install && npm run dev` (vite :5173, proxy `/api` → :8080)
- **Dev via Docker:** `docker compose up`
- **Build prod (local, se houver docker):** `docker build .` (multi-stage all-in-one)
- **Deploy:** `./deploy.sh` — ÚNICA forma permitida de alterar a VPS
- **Typecheck frontend:** `cd frontend && npx tsc --noEmit` (não há script dedicado)
- **Sintaxe backend:** `python3 -m py_compile backend/app.py`

## Infraestrutura da VPS (produção)

- VPS acessível APENAS via `my-vps "cmd"` (nunca edite arquivos manualmente lá)
- App em `/opt/printflow3d`, container `printflow3d` na rede `trivestia-net`
- Reverse proxy: container `trivestia-nginx`, config em
  `/opt/trivestia/nginx/nginx.conf` — o deploy.sh injeta o location `/3dpanel`
- **REGRA CRÍTICA:** a VPS hospeda apps em produção (/gpcg, /portfolio, /id,
  /gapi...). Toda mutação na VPS acontece só via `deploy.sh`. O nginx NUNCA
  pode ser restartado — só `nginx -t` + `nginx -s reload`.
- O location block usa `resolver 127.0.0.11` + variável em `proxy_pass` (não
  upstream estático) para que um container parado nunca derrube o nginx.

## Subpath /3dpanel — como as peças se encaixam

- `VITE_BASE_PATH=/3dpanel/` → assets do bundle com prefixo correto
- `VITE_API_URL=/3dpanel` → `services/api.ts` chama `/3dpanel/api/*`
- nginx `rewrite ^/3dpanel/(.*)$ /$1 break` → backend recebe `/api/*` limpo
- `ROOT_PATH=/3dpanel` no FastAPI → `url_for`/OpenAPI geram URLs públicas certas
- `VITE_API_URL` vazio (dev) → API em same-origin `/api` via proxy do vite

## Estrutura

- `backend/app.py` — FastAPI monolítico (~1090 linhas): folders, models,
  model_groups, thumbnails, manuals, storage-stats, importers, /api/health,
  SPA static mount + fallback 404 no final do arquivo
- `backend/importers/` — printables, makerworld
- `frontend/` — React SPA sem router (página única, estado interno)
- `Dockerfile` (raiz) — imagem prod all-in-one (frontend build + python runtime)
- `docker-compose.prod.yml` — stack de produção
- `docker-compose.yml` — stack de dev
- `deploy.sh` — pipeline completo de deploy

## Roadmap planejado

- Módulo de Precificação (volume via trimesh no backend)
- Kanban de Produção (fila de máquinas) — o SPA fallback 404 já suporta
  futuras rotas client-side

## Convenções

- Backend: sem ORM, sqlite3 direto, `init_db()` com migrations aditivas
  (`ALTER TABLE` em try/except) — seguir esse padrão
- Frontend: fetch via `services/api.ts`, MUI + Tailwind, localStorage keys
  prefixadas `printflow3d-`
- Não commitar `.env` nem `data/`
