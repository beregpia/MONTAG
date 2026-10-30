@echo off
chcp 65001 >nul
setlocal
title MONTAG - окно без браузерных кнопок

rem ============ Запуск MONTAG: окно как у обычной программы ============
rem Открывает montag-standalone.html в режиме --app: без адресной строки,
rem без вкладок, без кнопок браузера.
rem
rem Если окно получится пустым — запустите MONTAG.bat (он открывает файл
rem обычным способом и работает всегда).

set "APP=%~dp0montag-standalone.html"
set "LOG=%~dp0MONTAG-запуск.log"

if not exist "%APP%" goto nofile
set "APPURL=file:///%APP%"
set "APPURL=%APPURL:\=/%"

echo [%date% %time%] файл найден: "%APP%" > "%LOG%" 2>nul
echo [%date% %time%] режим окна, url: %APPURL% >> "%LOG%" 2>nul

rem Проверяем точные пути установки. Вызывать несуществующий msedge.exe через
rem start нельзя: Windows открывает служебную страницу вместо приложения.
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  echo [%date% %time%] запускаю Edge в режиме окна >> "%LOG%" 2>nul
  start "" "%EDGE%" --app="%APPURL%" --window-size=1560,960
  goto done
)

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  echo [%date% %time%] запускаю Chrome в режиме окна >> "%LOG%" 2>nul
  start "" "%CHROME%" --app="%APPURL%" --window-size=1560,960
  goto done
)

set "OPERA=%LOCALAPPDATA%\Programs\Opera GX\opera.exe"
if not exist "%OPERA%" set "OPERA=%LOCALAPPDATA%\Programs\Opera\opera.exe"
if not exist "%OPERA%" set "OPERA=%ProgramFiles%\Opera GX\opera.exe"
if exist "%OPERA%" (
  echo [%date% %time%] запускаю Opera в режиме окна >> "%LOG%" 2>nul
  start "" "%OPERA%" --app="%APPURL%" --window-size=1560,960
  goto done
)

rem Ни одного подходящего браузера не нашли — открываем как обычно
echo [%date% %time%] Edge/Chrome/Opera не найдены, открываю браузером по умолчанию >> "%LOG%" 2>nul
start "" "%APP%"

:done
echo [%date% %time%] команда запуска выполнена >> "%LOG%" 2>nul
exit /b 0

:nofile
echo.
echo   Рядом с этим файлом нет montag-standalone.html
echo   Положите оба файла в одну папку и запустите снова.
echo.
pause
exit /b 1
