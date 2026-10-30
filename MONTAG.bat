@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title MONTAG - расстановка фоли

rem ============ Запуск приложения без установки ============
rem Открывает montag-standalone.html в окне без адресной строки и вкладок.
rem Файл должен лежать рядом с этим .bat. Node и интернет не нужны.

set "APP=%~dp0montag-standalone.html"
if not exist "!APP!" (
  echo.
  echo   Рядом с этим файлом нет montag-standalone.html
  echo   Положите оба файла в одну папку и запустите снова.
  echo.
  pause
  exit /b 1
)

set "APPURL=file:///!APP:\=/!"

where /q msedge.exe
if !errorlevel! == 0 (
  start "" msedge.exe --app="!APPURL!" --window-size=1560,960
  goto :done
)

where /q chrome.exe
if !errorlevel! == 0 (
  start "" chrome.exe --app="!APPURL!" --window-size=1560,960
  goto :done
)

rem Ни Edge, ни Chrome не нашлись — открываем браузером по умолчанию
start "" "!APP!"

:done
endlocal
