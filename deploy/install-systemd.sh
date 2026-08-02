#!/bin/bash
# install-systemd.sh — установка systemd-юнитов SAAS из репозитория.
# Источник истины: deploy/systemd/. Скрипт только копирует и перечитывает
# конфигурацию; enable/disable таймеров НЕ трогает (текущее состояние хоста
# сохраняется — например, saas-references.timer сознательно/исторически не enabled).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/systemd" && pwd)"
cp -v "$SRC"/*.service "$SRC"/*.timer /etc/systemd/system/
systemctl daemon-reload
echo "OK. Таймеры: systemctl list-timers 'saas-*' --all"
