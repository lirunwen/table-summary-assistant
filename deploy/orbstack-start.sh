#!/usr/bin/env bash
# 在 OrbStack 的 ubuntu 虚拟机中启动表格汇总助手（用于本地验证）。
set -euo pipefail

VM="${HUIYI_VM:-ubuntu}"
PORT="${HUIYI_PORT:-8765}"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! orb list 2>/dev/null | awk '{print $1, $2}' | grep -q "^${VM} running"; then
  echo "启动 OrbStack 虚拟机 ${VM}…"
  orb start "${VM}"
fi

VM_HOME="$(orb -m "${VM}" sh -c 'printf %s "$HOME"' 2>/dev/null || true)"
if [ -z "${VM_HOME}" ]; then
  echo "无法读取虚拟机 ${VM} 的用户目录。"
  exit 1
fi
VENV="${HUIYI_VENV:-${VM_HOME}/huiyi-venv}"

if ! orb -m "${VM}" test -x "${VENV}/bin/python"; then
  echo "创建虚拟机 Python 环境并安装依赖…"
  orb -m "${VM}" python3 -m venv "${VENV}"
  orb -m "${VM}" sh -c "cd '${PROJECT}' && '${VENV}/bin/pip' install -r requirements.txt"
fi

orb -m "${VM}" sh -c "if [ -f /tmp/huiyi-app.pid ]; then kill \$(cat /tmp/huiyi-app.pid) 2>/dev/null || true; fi; sleep 1"

echo "启动表格汇总助手…"
orb -m "${VM}" sh -c "cd '${PROJECT}' && HUIYI_DATA_DIR='${PROJECT}/data' PYTHONUNBUFFERED=1 nohup '${VENV}/bin/python' app.py --host 0.0.0.0 --port ${PORT} --no-browser > /tmp/huiyi-app.log 2>&1 & echo \$! > /tmp/huiyi-app.pid"
sleep 2

URL="http://${VM}.orb.local:${PORT}/"
if curl --noproxy '*' -fsS "${URL}api/health" >/dev/null; then
  echo "服务已启动：${URL}"
  echo "数据目录：${PROJECT}/data"
  echo "日志：/tmp/huiyi-app.log（虚拟机内）"
else
  echo "启动失败，请查看虚拟机日志：orb -m ${VM} tail -50 /tmp/huiyi-app.log"
  exit 1
fi
