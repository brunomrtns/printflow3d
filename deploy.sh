#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy do PrintFlow3D para a VPS
#
# Uso:  ./deploy.sh [--no-build]
#
# O que faz:
#   0. Verifica pré-requisitos (my-vps, conexão, sintaxe Python local)
#   1. Sincroniza o código para /opt/printflow3d na VPS (via my-vps --rsync)
#   2. Builda a imagem Docker na VPS (frontend + backend, all-in-one)
#   3. Sobe a stack com docker compose (rede trivestia-net, sem portas no host)
#   4. Injeta o location block /3dpanel no nginx do trivestia-nginx
#      (com backup do nginx.conf e rollback automático se nginx -t falhar)
#   5. Testa sintaxe e recarrega nginx (reload, sem derrubar conexões)
#   6. Health check do container + smoke tests públicos
#   7. Verifica que os apps vizinhos (/gpcg, /gapi, /) continuam respondendo
#
# NOTA: o build acontece na VPS via Docker multi-stage (o ambiente local não
# possui toolchain Node/Docker). Isso é intencional e segue o padrão dos
# demais projetos da infra (ex: GPCG).
#
# Pré-requisitos:
#   - my-vps instalado e configurado
#   - Docker + Docker Compose na VPS
#   - trivestia-nginx rodando na VPS (reverse proxy principal)
#   - rede Docker trivestia-net existente
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
cd "$PROJECT_ROOT"

VPS_PATH="/opt/printflow3d"
PUBLIC_BASE="https://brunointegrations.com/3dpanel"
NGINX_CONTAINER="trivestia-nginx"
NGINX_CONF="/opt/trivestia/nginx/nginx.conf"

# ── Verificar my-vps ─────────────────────────────────────────────────────────
if ! command -v my-vps &>/dev/null; then
  echo -e "\033[1;31m  ✗\033[0m 'my-vps' não encontrado. Instale my-vps antes de fazer deploy." >&2
  exit 1
fi

vps() {
  my-vps --no-lock "$@"
}

log() { echo -e "\033[1;34m[deploy]\033[0m $*"; }
ok()  { echo -e "\033[1;32m  ✓\033[0m $*"; }
warn() { echo -e "\033[1;33m  ⚠\033[0m $*"; }
err() { echo -e "\033[1;31m  ✗\033[0m $*" >&2; }

# ── Argumentos ───────────────────────────────────────────────────────────────
NO_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) NO_BUILD=1; shift ;;
    -h|--help)
      echo "Uso: ./deploy.sh [--no-build]"
      exit 0
      ;;
    *) echo "Argumento desconhecido: $1"; exit 1 ;;
  esac
done

# ── Step 0: Pré-requisitos ───────────────────────────────────────────────────
log "Verificando pré-requisitos..."

# Syntax check rápido do backend (fail fast antes de tocar a VPS)
if command -v python3 &>/dev/null; then
  python3 -m py_compile backend/app.py && ok "backend/app.py compila" || {
    err "backend/app.py tem erro de sintaxe — deploy abortado"
    exit 1
  }
fi

if ! vps "echo ok" &>/dev/null; then
  err "Não foi possível conectar à VPS via my-vps"
  exit 1
fi
ok "Conexão com VPS OK (via my-vps)"

# ── Step 1: Sincronizar código ───────────────────────────────────────────────
log "Step 1/6: Sincronizando código para VPS ($VPS_PATH)..."

vps "mkdir -p $VPS_PATH"

RSYNC_EXCLUDES="--exclude=node_modules --exclude=.venv --exclude=__pycache__ --exclude=.git --exclude=data --exclude=.env --exclude=*.pyc --exclude=.pytest_cache --exclude=.devin --exclude=.claude --exclude='*.log' --exclude=frontend/dist --exclude=frontend/node_modules"

my-vps --no-lock --rsync "$PROJECT_ROOT/" "$VPS_PATH/" --rsync-args "$RSYNC_EXCLUDES" 2>&1 || {
  err "rsync falhou"
  exit 1
}
ok "Código sincronizado"

# ── Step 2: Build da imagem na VPS ──────────────────────────────────────────
if [[ "$NO_BUILD" -eq 0 ]]; then
  log "Step 2/6: Buildando imagem printflow3d na VPS (docker compose build)..."

  BUILD_LOG=$(mktemp)
  BUILD_EXIT=0
  vps "cd $VPS_PATH && docker compose -f docker-compose.prod.yml build 2>&1; echo \"EXIT_CODE=\$?\"" > "$BUILD_LOG" 2>&1 || BUILD_EXIT=$?
  BUILD_REMOTE_EXIT=$(grep -oP 'EXIT_CODE=\K[0-9]+' "$BUILD_LOG" | tail -1)
  tail -25 "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  if [[ "$BUILD_EXIT" -ne 0 || "$BUILD_REMOTE_EXIT" != "0" ]]; then
    err "docker compose build FALHOU (exit: ${BUILD_REMOTE_EXIT:-$BUILD_EXIT})"
    err "Rode manualmente para ver o log completo:"
    err "  my-vps \"cd $VPS_PATH && docker compose -f docker-compose.prod.yml build\""
    exit 1
  fi
  vps "docker image prune -f 2>/dev/null" || true
  ok "Imagem printflow3d:latest buildada"
else
  log "Step 2/6: Build pulado (--no-build)"
fi

# ── Step 3: Subir a stack ────────────────────────────────────────────────────
log "Step 3/6: Subindo stack com docker compose..."
COMPOSE_LOG=$(mktemp)
COMPOSE_EXIT=0
vps "cd $VPS_PATH && docker compose -f docker-compose.prod.yml up -d 2>&1; echo \"EXIT_CODE=\$?\"" > "$COMPOSE_LOG" 2>&1 || COMPOSE_EXIT=$?
COMPOSE_REMOTE_EXIT=$(grep -oP 'EXIT_CODE=\K[0-9]+' "$COMPOSE_LOG" | tail -1)
tail -20 "$COMPOSE_LOG"
rm -f "$COMPOSE_LOG"
if [[ "$COMPOSE_EXIT" -ne 0 || "$COMPOSE_REMOTE_EXIT" != "0" ]]; then
  err "docker compose up FALHOU (exit: ${COMPOSE_REMOTE_EXIT:-$COMPOSE_EXIT})"
  exit 1
fi
ok "Stack iniciada"

# Aguardar container ficar healthy (até 90s — primeiro boot cria o DB)
HEALTH_WAIT=0
HEALTH="starting"
while [[ "$HEALTH" != "healthy" && $HEALTH_WAIT -lt 90 ]]; do
  sleep 5
  HEALTH_WAIT=$((HEALTH_WAIT + 5))
  HEALTH=$(vps "docker inspect --format='{{.State.Health.Status}}' printflow3d 2>/dev/null || echo 'missing'")
  log "  Container health: $HEALTH (${HEALTH_WAIT}s)"
done
if [[ "$HEALTH" != "healthy" ]]; then
  err "Container printflow3d não ficou healthy em ${HEALTH_WAIT}s"
  err "Logs: my-vps \"docker logs printflow3d --tail=100\""
  exit 1
fi
ok "Container healthy"

# ── Step 4: Atualizar nginx do trivestia-nginx ───────────────────────────────
log "Step 4/6: Atualizando nginx com a rota /3dpanel..."

# O bloco abaixo usa resolver 127.0.0.11 (DNS interno do Docker) + variável em
# proxy_pass em vez de um upstream estático. Motivo: nginx resolve hostnames de
# upstream no carregamento da config — se o container printflow3d estiver fora
# do ar durante um reload (ex: deploy de outro app), o nginx INTEIRO falharia.
# Com variável, a resolução ocorre por request: no pior caso só /3dpanel dá 502.
vps 'python3 << "PYEOF"
import re, sys, shutil, time

CONF_PATH = "/opt/trivestia/nginx/nginx.conf"
with open(CONF_PATH) as f:
    content = f.read()

location_block = """    # ── PrintFlow3D (3D printing studio panel) ─────────────────────────
    # Redirect bare /3dpanel to the trailing-slash SPA root
    location = /3dpanel {
        return 301 /3dpanel/;
    }
    # PrintFlow3D app — API (/3dpanel/api/*) + compiled SPA in one container.
    # resolver + variable: backend hostname resolved at request time, so a
    # stopped printflow3d container never breaks nginx reloads for other apps.
    location /3dpanel/ {
        limit_req zone=web_limit burst=60 nodelay;
        resolver 127.0.0.11 valid=10s;
        set $pf3d_backend http://printflow3d:8080;
        rewrite ^/3dpanel/(.*)$ /$1 break;
        proxy_pass         $pf3d_backend;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 500m;
    }
"""

# Idempotente: remove qualquer configuração /3dpanel existente e reinsere
# o bloco fresco antes do "location = /" (root do portfolio).
# 1) Remove o span completo: do comentário marcador até o fecha-chaves do
#    "location /3dpanel/" — inclui TODOS os comentários intermediários.
content = re.sub(
    r"    # ── PrintFlow3D.*?location /3dpanel/ \{.*?\n    \}\n?",
    "",
    content,
    flags=re.DOTALL,
)
# 2) Fallback: remove location blocks /3dpanel órfãos (sem marcador) e
#    comentários que mencionem o app.
content = re.sub(
    r"    location (?:= )?/3dpanel/? \{.*?\n    \}\n?",
    "",
    content,
    flags=re.DOTALL,
)
content = re.sub(
    r"^[ \t]*#[^\n]*(?:printflow3d|3dpanel)[^\n]*\n?",
    "",
    content,
    flags=re.MULTILINE | re.IGNORECASE,
)
content = re.sub(r"\n{3,}", "\n\n", content)

anchor = "    location = / {"
if anchor not in content:
    print("ERRO: anchor 'location = / {' não encontrado no nginx.conf", file=sys.stderr)
    sys.exit(1)
content = content.replace(anchor, location_block + "\n" + anchor, 1)

if content == open(CONF_PATH).read():
    print("nginx config já está atualizada (nenhuma mudança)")
    sys.exit(0)

backup = f"{CONF_PATH}.bak-printflow3d-{int(time.time())}"
shutil.copy2(CONF_PATH, backup)
with open(CONF_PATH, "w") as f:
    f.write(content)
print(f"nginx config atualizado (backup: {backup})")
PYEOF
' || {
  err "Falha ao atualizar nginx.conf"
  exit 1
}
ok "Nginx config atualizado"

# ── Step 5: Testar e recarregar nginx (com rollback se falhar) ───────────────
log "Step 5/6: Testando sintaxe e recarregando nginx..."
if vps "docker exec $NGINX_CONTAINER nginx -t" 2>&1; then
  vps "docker exec $NGINX_CONTAINER nginx -s reload"
  ok "Nginx recarregado (sem downtime)"
else
  err "nginx -t FALHOU — restaurando backup mais recente do nginx.conf"
  LATEST_BAK=$(vps "ls -t ${NGINX_CONF}.bak-printflow3d-* 2>/dev/null | head -1" | tr -d '[:space:]')
  if [[ -n "$LATEST_BAK" ]]; then
    vps "cp '$LATEST_BAK' $NGINX_CONF"
    vps "docker exec $NGINX_CONTAINER nginx -t" && ok "Backup restaurado, nginx intacto"
  fi
  err "Deploy abortado — nginx NÃO foi recarregado, apps vizinhos intactos"
  exit 1
fi

# ── Step 6: Smoke tests ──────────────────────────────────────────────────────
log "Step 6/6: Smoke tests..."

SMOKE_OK=1

# API health através do proxy público
SMOKE_WAIT=0
API_OK=0
while [[ $SMOKE_WAIT -lt 30 ]]; do
  API_RESP=$(curl -sf --max-time 10 "$PUBLIC_BASE/api/health" 2>&1 || echo "FAIL")
  if [[ "$API_RESP" != "FAIL" ]]; then
    ok "API pública: $API_RESP"
    API_OK=1
    break
  fi
  sleep 5
  SMOKE_WAIT=$((SMOKE_WAIT + 5))
done
if [[ "$API_OK" -eq 0 ]]; then
  err "API pública não respondeu em $PUBLIC_BASE/api/health"
  SMOKE_OK=0
fi

# SPA HTML
SPA_RESP=$(curl -sf --max-time 10 "$PUBLIC_BASE/" 2>/dev/null | head -c 8000 || echo "FAIL")
if echo "$SPA_RESP" | grep -qi "PrintFlow3D\|<div id=\"root\""; then
  ok "SPA servida em $PUBLIC_BASE/"
else
  err "SPA não respondeu corretamente em $PUBLIC_BASE/"
  echo "$SPA_RESP" | head -5
  SMOKE_OK=0
fi

# Redirect /3dpanel → /3dpanel/
REDIR=$(curl -sf -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 10 "https://brunointegrations.com/3dpanel" 2>/dev/null || echo "FAIL")
if [[ "$REDIR" == *"/3dpanel/"* ]]; then
  ok "Redirect /3dpanel → /3dpanel/ ($REDIR)"
else
  warn "Redirect /3dpanel inesperado: $REDIR"
fi

# Apps vizinhos — garantia de que nada foi afetado
log "  Verificando apps vizinhos..."
for route in "/nginx-health" "/gpcg/api/health" "/gapi/health" "/"; do
  CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "https://brunointegrations.com$route" 2>/dev/null || echo "000")
  if [[ "$CODE" =~ ^(200|301|302|304|401|403)$ ]]; then
    ok "  $route → HTTP $CODE"
  else
    warn "  $route → HTTP $CODE (verifique se já estava assim antes do deploy)"
  fi
done

# ── Resumo final ─────────────────────────────────────────────────────────────
echo ""
log "═══════════════════════════════════════════════════════════════"
if [[ "$SMOKE_OK" -eq 1 ]]; then
  log "  Deploy concluído!"
  log "  App: $PUBLIC_BASE/"
  log "  API: $PUBLIC_BASE/api/health"
else
  warn "  Deploy concluído com warnings — verifique os smoke tests acima"
  warn "  Logs: my-vps \"docker logs printflow3d --tail=100\""
fi
log "═══════════════════════════════════════════════════════════════"

[[ "$SMOKE_OK" -eq 1 ]]
