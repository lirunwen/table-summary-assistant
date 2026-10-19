#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ -x "runtime/bin/python3" ]; then
  exec runtime/bin/python3 app.py "$@"
elif [ -x ".venv/bin/python" ]; then
  exec .venv/bin/python app.py "$@"
elif command -v python3 >/dev/null 2>&1; then
  exec python3 app.py "$@"
else
  echo "未找到 Python 3，请先安装 Python 3.11 或更高版本。"
  exit 1
fi
