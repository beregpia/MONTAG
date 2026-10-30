@echo off
chcp 65001 >nul
setlocal
title MONTAG - окно без браузерных кнопок

rem ============ Запуск MONTAG: окно как у обычной программы ============
rem Открывает montag-standalone.html в режиме --app: без адресной строки,
rem без вкладок, без кнопок браузера.
rem
rem Если окно получится пустым или сцена показана шахматкой — запустите
rem MONTAG.bat: он открывает файл обычным способом и работает всегда.

set "APP=%~dp0montag-standalone.html"
set "LOG=%~dp0MONTAG-запуск.log"

if not exist "%APP%" goto nofile
set "APPURL=file:///%APP%"
set "APPURL=%APPURL:\=/%"

rem --- запись строки в лог рядом с .bat ---
rem (подпрограмма объявлена ниже, вызываем через call)
call :log "файл найден: %APP%"
for %%F in ("%APP%") do call :log "размер приложения: %%~zF байт"
call :log "режим окна, url: %APPURL%"

rem --- диагностика: что за браузер и что установлено ---
for /f "tokens=2*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice" /v ProgId 2^>nul ^| find "ProgId"') do call :log "браузер по умолчанию: %%B"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" call :log "найден: Edge"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" call :log "найден: Edge (x86)"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" call :log "найден: Chrome"
if exist "%LOCALAPPDATA%\Programs\Opera GX\launcher.exe" call :log "найден: Opera GX (launcher)"
if exist "%LOCALAPPDATA%\Programs\Opera GX\opera.exe" call :log "найден: Opera GX"
if exist "%LOCALAPPDATA%\Programs\Opera\launcher.exe" call :log "найден: Opera (launcher)"
if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" call :log "найден: Firefox"
if exist "%ProgramFiles%\Yandex\YandexBrowser\Application\browser.exe" call :log "найден: Yandex"

rem Проверяем точные пути установки. Вызывать несуществующий msedge.exe через
rem start нельзя: Windows открывает служебную страницу вместо приложения.
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  call :log "запускаю Edge в режиме окна"
  start "" "%EDGE%" --app="%APPURL%" --window-size=1560,960
  goto done
)

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  call :log "запускаю Chrome в режиме окна"
  start "" "%CHROME%" --app="%APPURL%" --window-size=1560,960
  goto done
)

set "OPERA=%LOCALAPPDATA%\Programs\Opera GX\launcher.exe"
if not exist "%OPERA%" set "OPERA=%LOCALAPPDATA%\Programs\Opera GX\opera.exe"
if not exist "%OPERA%" set "OPERA=%LOCALAPPDATA%\Programs\Opera\launcher.exe"
if not exist "%OPERA%" set "OPERA=%LOCALAPPDATA%\Programs\Opera\opera.exe"
if exist "%OPERA%" (
  call :log "запускаю Opera в режиме окна"
  start "" "%OPERA%" --app="%APPURL%" --window-size=1560,960
  goto done
)

rem Ни одного подходящего браузера не нашли — открываем как обычно
call :log "Edge/Chrome/Opera не найдены, открываю браузером по умолчанию"
start "" "%APP%"

:done
call :log "команда запуска выполнена"
call :log "если сцена показана шахматкой - нажмите F12, вкладка Console"
exit /b 0

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
