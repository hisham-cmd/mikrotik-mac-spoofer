@echo off
title MikroTik MAC Spoofer
cd /d "%~dp0"

:: Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo [^!] الصلاحيات غير كافية
    echo [^!] جاري إعادة التشغيل كمسؤول...
    echo.
    :: Relaunch as admin
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:admin
:: Disable QuickEdit mode (prevents console freezing on click)
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\disable-quickedit.ps1"

echo.
echo ============================================
echo    MikroTik MAC Spoofer - النظام المتكامل
echo ============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [خطأ] Node.js غير مثبت. قم بتثبيته من https://nodejs.org
    pause
    exit /b
)

:: Try pnpm, fallback to npm
set PKG_MANAGER=pnpm
where pnpm >nul 2>&1
if %errorLevel% neq 0 (
    set PKG_MANAGER=npm
)

echo [*] مدير الحزم: %PKG_MANAGER%
echo.

:: Install dependencies if needed
if not exist "node_modules\" (
    echo [*] جاري تثبيت الحزم...
    call %PKG_MANAGER% install
    if %errorLevel% neq 0 (
        echo [خطأ] فشل تثبيت الحزم
        pause
        exit /b
    )
    echo [تم] تثبيت الحزم بنجاح
    echo.
)

:: Kill any old process on port 3003
echo [*] جاري إيقاف أي عملية سابقة...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3003 "') do (
    if "%%a" neq "0" (
        taskkill /f /pid %%a >nul 2>&1
    )
)
timeout /t 2 /nobreak >nul

echo [*] جاري تشغيل السيرفر...
echo.
echo ============================================
echo    Dashboard: http://localhost:3003
echo    Proxy:     http://127.0.0.1:8080
echo ============================================
echo.

%PKG_MANAGER% start

echo.
echo [^!] تم إيقاف السيرفر
pause
