#!/bin/bash
# SaaS Worker daily run — через Python wrapper (надёжно грузит env).
set -e
export PYTHONIOENCODING=utf-8
export NO_PROXY=*

mkdir -p /opt/agentsDB/logs
PY=/opt/agents/data-presenter-agent/.venv/bin/python

echo "=== SaaS Worker $(date) ===" >> /opt/agentsDB/logs/saas_worker.log
$PY /opt/agents/saas/worker/run_orchestrator.py >> /opt/agentsDB/logs/saas_worker.log 2>&1
echo "EXIT=$?" >> /opt/agentsDB/logs/saas_worker.log
