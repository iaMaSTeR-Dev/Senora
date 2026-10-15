# Convenience script to start the Senora Go backend server on Windows PowerShell
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    if (Test-Path "C:\go\bin\go.exe") {
        $env:PATH = "C:\go\bin;$env:PATH"
    } elseif (Test-Path "C:\go126root\go\bin\go.exe") {
        $env:PATH = "C:\go126root\go\bin;$env:PATH"
    }
}

Write-Host "Starting Senora Go Backend Server on http://localhost:8080..." -ForegroundColor Cyan
Set-Location -Path (Join-Path $PSScriptRoot "..\apps\server")
go run ./cmd/server
