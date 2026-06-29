#requires -RunAsAdministrator

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

function Write-Header {
    Clear-Host
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "   MikroTik MAC Spoofer - النظام المتكامل" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "   Dashboard: http://localhost:3003" -ForegroundColor White
    Write-Host "   Proxy:     http://127.0.0.1:8080" -ForegroundColor White
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""
}

try {
    Write-Header

    Write-Host "[*] التحقق من Node.js..." -ForegroundColor Yellow
    $nodeVersion = node --version
    Write-Host "[✓] Node.js $nodeVersion" -ForegroundColor Green

    $pkgManager = "pnpm"
    if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
        $pkgManager = "npm"
    }
    Write-Host "[*] مدير الحزم: $pkgManager" -ForegroundColor Yellow

    if (-not (Test-Path "node_modules")) {
        Write-Host "[*] جاري تثبيت الحزم..." -ForegroundColor Yellow
        & $pkgManager install
        if ($LASTEXITCODE -ne 0) { throw "فشل تثبيت الحزم" }
        Write-Host "[✓] تم تثبيت الحزم" -ForegroundColor Green
    }

    Write-Host "[*] إيقاف أي عملية قديمة على port 3003..." -ForegroundColor Yellow
    Get-NetTCPConnection -LocalPort 3003 -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "       جاري تشغيل السيرفر..." -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""

    & $pkgManager start
}
catch {
    Write-Host ""
    Write-Host "[خطأ] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Read-Host "اضغط Enter للخروج"
}
