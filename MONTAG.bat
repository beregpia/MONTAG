@echo off
chcp 65001 >nul
setlocal
title MONTAG - расстановка фоли

rem ============ Запуск MONTAG: надёжный вариант ============
rem Открывает montag-standalone.html браузером по умолчанию.
rem Файл должен лежать рядом с этим .bat. Node и интернет не нужны.
rem
rem Хотите окно без адресной строки и вкладок — запустите MONTAG-окно.bat

set "APP=%~dp0montag-standalone.html"
set "LOG=%~dp0MONTAG-запуск.log"

if not exist "%APP%" goto nofile

echo [%date% %time%] файл найден: "%APP%" > "%LOG%" 2>nul
echo [%date% %time%] открываю браузером по умолчанию >> "%LOG%" 2>nul
start "" "%APP%"
echo [%date% %time%] команда запуска выполнена >> "%LOG%" 2>nul
exit /b 0

:nofile
echo.
echo   Рядом с этим файлом нет montag-standalone.html
echo   Положите оба файла в одну папку и запустите снова.
echo.
pause
exit /b 1
