# =====================================================================
#  SaaS-воркер: обёртка для Планировщика Windows.
#  Читает active cabinets из PG, расшифровывает api_creds, гоняет сборщики
#  per-cabinet в subprocess. Ежедневный прогон (07:00) + можно вручную.
#
#  Лог: C:\AgentsDB\logs\SaaS_Worker_<date>.txt (заканчивается EXIT_CODE=N).
#  env: Machine-level (POSTGRES_PASSWORD, SAAS_APP_DB_PASSWORD, SAAS_CRED_MASTER_KEY).
# =====================================================================
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$proj = $PSScriptRoot
$pyCandidates = @(
    'C:\Program Files\Python312\python.exe',
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
)
$py = ($pyCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
if (-not $py) { throw "Python 3.12 не найден" }

# Тянем секреты из Machine env (S4U не видит user-env).
$env:POSTGRES_PASSWORD       = [Environment]::GetEnvironmentVariable('POSTGRES_PASSWORD','Machine')
$env:SAAS_APP_DB_PASSWORD    = [Environment]::GetEnvironmentVariable('SAAS_APP_DB_PASSWORD','Machine')
$env:SAAS_CRED_MASTER_KEY    = [Environment]::GetEnvironmentVariable('SAAS_CRED_MASTER_KEY','Machine')
$env:SAAS_DB_HOST            = 'localhost'
$env:SAAS_DB_PORT            = '5432'
$env:SAAS_DB                 = 'saas'

$logdir = 'C:\AgentsDB\logs'
if (-not (Test-Path $logdir)) { New-Item -ItemType Directory -Path $logdir | Out-Null }
$log = Join-Path $logdir ('SaaS_Worker_{0}.txt' -f (Get-Date -Format 'yyyy-MM-dd'))
function Log($msg) { ('{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg) | Out-File -Append -Encoding utf8 $log }

Log "=== SaaS-воркер daily запуск ==="
Set-Location $proj
& $py -m worker.orchestrator --all *>> $log
$code = $LASTEXITCODE
Log "воркер завершился, exit=$code"
Log "EXIT_CODE=$code"
