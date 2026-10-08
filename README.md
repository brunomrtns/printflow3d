# PrintFlow3D

**PrintFlow3D** é um painel de gerenciamento para estúdios de impressão 3D — biblioteca de modelos (STL/STEP/3MF), organização em pastas, grupos de impressão, visualização 3D no navegador e importação direta do Printables/MakerWorld.

Este projeto usa o open-source [STLVault](https://github.com/moddroid94/STLVault) como fundação, adaptado para a infraestrutura `brunointegrations.com` e preparado para receber os módulos de precificação e produção (ver Roadmap).

## Stack

| Camada    | Tecnologia                                              |
| --------- | ------------------------------------------------------- |
| Frontend  | React 19 + Vite + Tailwind + MUI + react-three-fiber    |
| Backend   | Python 3.12 + FastAPI + SQLite                          |
| Deploy    | Docker all-in-one atrás do `trivestia-nginx` em `/3dpanel` |

## Arquitetura

```
browser
  └─ https://brunointegrations.com/3dpanel
       └─ trivestia-nginx  (strip do prefixo /3dpanel, resolver dinâmico)
            └─ container printflow3d :8080  (rede trivestia-net)
                 ├─ /api/*   → FastAPI (SQLite em /app/data, uploads em /app/uploads)
                 └─ /*       → SPA estática (Vite dist, html=True + fallback 404)
```

- **Subpath:** o app roda sob `/3dpanel`. O frontend é compilado com
  `base=/3dpanel/` (`VITE_BASE_PATH`) e chama a API em `/3dpanel/api/*`
  (`VITE_API_URL`). O nginx remove o prefixo antes do proxy e o FastAPI usa
  `ROOT_PATH=/3dpanel` apenas para gerar URLs públicas corretas (ex: thumbnails
  via `url_for`).
- **Sem portas expostas no host:** o container só existe na rede Docker
  `trivestia-net`, alcançável pelo nginx como `printflow3d:8080`.
- **Resiliência do nginx:** o location block usa `resolver 127.0.0.11` +
  variável em `proxy_pass`, então o nginx nunca falha num reload se o container
  estiver parado — protege os outros apps hospedados na VPS.

## Desenvolvimento local

Requisitos: Python 3.12+ e Node 22+ (ou apenas Docker).

```bash
# Backend (http://localhost:8080)
cd backend
pip install -r requirements.txt
uvicorn app:app --reload --port 8080

# Frontend (http://localhost:5173 — proxy /api → :8080 automático)
cd frontend
npm install
npm run dev
```

Ou via Docker Compose (stack dev com hot reload):

```bash
docker compose up
```

## Deploy (produção)

Todo deploy é feito exclusivamente pelo script — nenhuma alteração manual na VPS:

```bash
./deploy.sh              # sync + build na VPS + nginx + smoke tests
./deploy.sh --no-build   # reaproveita a imagem existente (só restart + nginx)
```

O script sincroniza o código para `/opt/printflow3d`, builda a imagem
`printflow3d:latest`, sobe o container, injeta/atualiza o location block
`/3dpanel` no `trivestia-nginx` (com backup e rollback automático se
`nginx -t` falhar), recarrega o nginx sem downtime e roda smoke tests
incluindo verificação dos apps vizinhos.

## Variáveis de ambiente

Ver [.env.example](.env.example). As principais de produção são
`ROOT_PATH=/3dpanel`, `STATIC_DIR=/app/static` e `ALLOWED_ORIGINS`.

## Roadmap Futuro

- [ ] Módulo de Precificação (Volume via Trimesh)
- [ ] Kanban de Produção (Fila de Máquinas)

## Créditos

Fork adaptado de [moddroid94/STLVault](https://github.com/moddroid94/STLVault)
(Licença MIT — ver [LICENSE.md](LICENSE.md)).
