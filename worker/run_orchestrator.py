#!/usr/bin/env python3
"""Wrapper: load env then run orchestrator."""
import os, sys, subprocess

# Load env files
for envfile in ['/etc/saas-worker.env', '/etc/collectors.env']:
    with open(envfile) as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                os.environ[k] = v

os.environ['SAAS_DB_HOST'] = 'localhost'
os.environ['SAAS_DB_PORT'] = '5432'
os.environ['SAAS_DB'] = 'saas'
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['NO_PROXY'] = '*'

# Run orchestrator
PY = '/opt/agents/data-presenter-agent/.venv/bin/python'
result = subprocess.run(
    [PY, '-m', 'worker.orchestrator', '--all'],
    cwd='/opt/agents/saas',
    env=os.environ,
    capture_output=False,
)
sys.exit(result.returncode)
