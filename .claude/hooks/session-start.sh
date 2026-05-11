#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

echo "[session-start] node $(node --version), npm $(npm --version)"

echo "[session-start] installing npm dependencies..."
npm install --no-audit --no-fund

echo "[session-start] building (tsc + copy-web + copy-scaffold)..."
npm run build

echo "[session-start] parse-checking served browser JS..."
for f in src/web/*.js; do
  node --check "$f"
done

echo "[session-start] done."
