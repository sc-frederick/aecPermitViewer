#!/usr/bin/env bash
set -euo pipefail
target="${1:-/mnt/c/Users/${WINDOWS_USER:-$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')}/dev/aecPermitViewer}"
mkdir -p "$target"
rsync -a --delete \
  --exclude node_modules/ --exclude dist/ --exclude out/ --exclude .git/ \
  --exclude vendor/playwright-browsers/ \
  ./ "$target/"
echo "Synced to $target"
echo "First time, in PowerShell:  cd \"$(wslpath -w "$target")\"; npm ci --allow-git=all; npm run browser:stage"
echo "Then:                       \$env:TYPESAFE_API_KEY = \"<key>\"; npm run dev"
