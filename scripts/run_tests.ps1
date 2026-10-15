# Convenience script to run all backend and frontend tests for Senora
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    if (Test-Path "C:\go\bin\go.exe") {
        $env:PATH = "C:\go\bin;$env:PATH"
    } elseif (Test-Path "C:\go126root\go\bin\go.exe") {
        $env:PATH = "C:\go126root\go\bin;$env:PATH"
    }
}

Write-Host "=== 1. Running Go Backend Test Suite ===" -ForegroundColor Cyan
Set-Location -Path (Join-Path $PSScriptRoot "..\apps\server")
go test -v -count=1 ./...
if ($LASTEXITCODE -ne 0) {
    Write-Host "Backend tests failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "`n=== 2. Running Frontend Vitest Cryptographic Suite ===" -ForegroundColor Cyan
Set-Location -Path (Join-Path $PSScriptRoot "..\apps\web")
npx vitest run
if ($LASTEXITCODE -ne 0) {
    Write-Host "Frontend tests failed!" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "`nAll Senora tests passed successfully!" -ForegroundColor Green
