# Полный backfill cabinet 1 (владелец): WB + Ozon с 2026-05-01.
# Запускается в фоне с правильным env (Machine-level секретами).
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$env:POSTGRES_PASSWORD     = [Environment]::GetEnvironmentVariable('POSTGRES_PASSWORD','Machine')
$env:SAAS_APP_DB_PASSWORD  = [Environment]::GetEnvironmentVariable('SAAS_APP_DB_PASSWORD','Machine')
$env:SAAS_CRED_MASTER_KEY  = [Environment]::GetEnvironmentVariable('SAAS_CRED_MASTER_KEY','Machine')
$env:SAAS_DB_HOST = 'localhost'
$env:SAAS_DB_PORT = '5432'
$env:SAAS_DB = 'saas'

$py = 'C:\Program Files\Python312\python.exe'
Set-Location 'C:\Agents\saas'

Write-Host '=== WB backfill (finance + order_costs + metrics + prices + stocks) ===' -NoNewline
& $py -m worker.orchestrator --cabinet 1 --collectors wb_finance,wb_order_costs,wb_metrics,wb_prices,wb_stocks --date-from 2026-05-01 --date-to 2026-07-10
Write-Host "WB exit=$LASTEXITCODE"

Write-Host '=== Ozon backfill (все 8 сборщиков) ==='
& $py -m worker.orchestrator --cabinet 1 --collectors ozon_catalog,ozon_orders,ozon_sales,ozon_finance,ozon_order_costs,ozon_metrics,ozon_stocks,ozon_efficiency --date-from 2026-05-01 --date-to 2026-07-10
Write-Host "Ozon exit=$LASTEXITCODE"

Write-Host '=== BACKFILL COMPLETE ==='
