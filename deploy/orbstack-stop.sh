#!/usr/bin/env bash
# 停止 OrbStack 虚拟机中的表格汇总助手服务。
set -euo pipefail
VM="${HUIYI_VM:-ubuntu}"
orb -m "${VM}" sh -c 'if [ -f /tmp/huiyi-app.pid ]; then kill $(cat /tmp/huiyi-app.pid) 2>/dev/null || true; rm -f /tmp/huiyi-app.pid; echo stopped; else echo "not running"; fi'
