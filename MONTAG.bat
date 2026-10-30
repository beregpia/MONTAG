@echo off
chcp 65001 >nul
setlocal
title MONTAG - расстановка фоли

rem ============ Запуск MONTAG: надёжный вариант ============
rem Открывает montag-standalone.html браузером по умолчанию.
rem Файл должен лежать рядом с этим .bat. Node и интернет не нужны.
rem
rem Хотите окно без адресной строки и вкладок - запустите MONTAG-okno.bat

set "APP=%~dp0montag-standalone.html"
set "LOG=%~dp0MONTAG-запуск.log"

if not exist "%APP%" goto nofile

rem --- диагностика: что за браузер и найдены ли установленные ---
call :log "файл найден: %APP%"
for %%F in ("%APP%") do call :log "размер приложения: %%~zF байт"

rem браузер по умолчанию из реестра
for /f "tokens=2*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice" /v ProgId 2^>nul ^| find "ProgId"') do call :log "браузер по умолчанию: %%B"

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" call :log "найден: Chrome"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" call :log "найден: Chrome (x86)"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" call :log "найден: Edge"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" call :log "найден: Edge (x86)"
if exist "%LOCALAPPDATA%\Programs\Opera GX\launcher.exe" call :log "найден: Opera GX"
if exist "%ProgramFiles%\Opera GX\launcher.exe" call :log "найден: Opera GX (Program Files)"
if exist "%LOCALAPPDATA%\Programs\Opera\launcher.exe" call :log "найден: Opera"
if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" call :log "найден: Firefox"
if exist "%ProgramFiles%\Yandex\YandexBrowser\Application\browser.exe" call :log "найден: Yandex"
if exist "%ProgramFiles%\Vivaldi\Application\vivaldi.exe" call :log "найден: Vivaldi"
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" call :log "найден: Brave"

call :log "открываю браузером по умолчанию"
start "" "%APP%"
call :log "команда запуска выполнена"
call :log "если страница белая или сцена показана шахматкой - нажмите F12, вкладка Console"
exit /b 0

rem --- запись строки в лог рядом с .bat ---
:log
echo [%date% %time%] %~1>> "%LOG%" 2>nul
exit /b 0

:nofile
echo.
echo   Рядом с этим файлом нет montag-standalone.html
echo   Положите оба файла в одну папку и запустите снова.
echo.
pause
exit /b 1
