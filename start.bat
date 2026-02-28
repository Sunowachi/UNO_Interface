@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ========== НАСТРОЙКИ ==========
set "LIB_DIR=lib"
set "BUILD_DIR=classes"
set "MAIN_CLASS=Web"
set "LOG_FILE=start.log"
set "SOURCES_LIST=sources.tmp"

if exist "%LOG_FILE%" del "%LOG_FILE%"

echo ==================================================== >> "%LOG_FILE%"
echo Запуск скрипта %date% %time% >> "%LOG_FILE%"
echo ==================================================== >> "%LOG_FILE%"

goto :main

:log
echo %* >> "%LOG_FILE%"
echo %*
exit /b 0

:main
call :log "Начало выполнения скрипта"

:: ========== ПРОВЕРКА JAVA ==========
call :log "Проверка наличия java (для запуска)..."
where java >nul 2>>"%LOG_FILE%"
if errorlevel 1 (
    call :log "ОШИБКА: java не найдена в PATH."
    call :log "Установите JDK (версии 11 или выше) и добавьте папку bin в переменную PATH."
    pause
    exit /b 1
)
call :log "java найдена. Версия:"
java -version >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :log "Не удалось выполнить java -version, но java присутствует."
) else (
    call :log "Вывод java -version:"
    type "%LOG_FILE%" | findstr /c:"java version" /c:"openjdk version" >> con 2>nul
)

:: ========== ПРОВЕРКА JAVAC ==========
call :log "Проверка наличия javac (компилятора)..."
where javac >nul 2>>"%LOG_FILE%"
if errorlevel 1 (
    call :log "ОШИБКА: javac не найден в PATH."
    call :log "Для компиляции необходим JDK, а не только JRE."
    call :log "Скачайте JDK с https://adoptium.net/ или https://www.oracle.com/ "
    call :log "После установки добавьте папку bin в переменную PATH."
    pause
    exit /b 1
)
call :log "javac найден. Версия:"
javac -version >> "%LOG_FILE%" 2>&1

:: ========== ПРОВЕРКА ПАПКИ LIB ==========
call :log "Проверка папки %LIB_DIR%..."
set "CP=%BUILD_DIR%"
if exist "%LIB_DIR%" (
    for %%i in ("%LIB_DIR%\*.jar") do (
        set "CP=!CP!;%%i"
        call :log "  Добавлен JAR: %%i"
    )
) else (
    call :log "  Папка %LIB_DIR% не существует. Будет использован только classpath %BUILD_DIR%."
)

:: ========== СБОР ИСХОДНИКОВ ==========
call :log "Сбор списка исходных файлов Java..."
dir /s /b *.java > "%SOURCES_LIST%" 2>>"%LOG_FILE%"
if not exist "%SOURCES_LIST%" (
    call :log "ОШИБКА: Не найдены исходные файлы Java (*.java) в текущем каталоге."
    pause
    exit /b 1
)

call :log "Найдены исходные файлы (первые 5):"
set count=0
for /f "usebackq delims=" %%a in ("%SOURCES_LIST%") do (
    set "line=%%a"
    call :log "!line!"
    set /a count+=1
    if !count! geq 5 goto :break
)
:break

:: ========== КОМПИЛЯЦИЯ ==========
call :log "Компиляция Java файлов..."
if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%" 2>>"%LOG_FILE%"

javac -d "%BUILD_DIR%" -cp "%CP%" @"%SOURCES_LIST%" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :log "ОШИБКА компиляции. Подробности в файле %LOG_FILE%"
    call :log "Возможно, не хватает зависимостей (драйвер PostgreSQL) или ошибка в коде."
    pause
    exit /b 1
)
call :log "Компиляция успешно завершена."

del "%SOURCES_LIST%" 2>>"%LOG_FILE%"

:: ========== ЗАПУСК ПРИЛОЖЕНИЯ ==========
call :log "Запуск приложения (main class: %MAIN_CLASS%)..."
call :log "Classpath: %CP%"
echo ==================================================== >> "%LOG_FILE%"
echo Запуск Java-процесса: >> "%LOG_FILE%"
echo java -cp "%CP%" %MAIN_CLASS% >> "%LOG_FILE%"
echo ==================================================== >> "%LOG_FILE%"
echo.

echo Сервер будет запущен. Для остановки нажмите Ctrl+C
echo.
echo ВНИМАНИЕ: После Ctrl+C появится запрос "Terminate batch job (Y/N)?".
echo Подождите несколько секунд пока не появится сообщение "Сервер Остановлен!".
echo Ответьте Y и нажмите Enter. После этого программа полность завершится.
echo.

:: Запускаем Java напрямую — её вывод идёт прямо в консоль
java -cp "%CP%" %MAIN_CLASS%
set EXIT_CODE=%ERRORLEVEL%

:: Интерпретируем код возврата
set "EXIT_REASON="
if %EXIT_CODE% equ 0 (
    set "EXIT_REASON=Штатное завершение"
) else if %EXIT_CODE% equ 1 (
    set "EXIT_REASON=Завершение с ошибкой (код 1)"
) else if %EXIT_CODE% equ 130 (
    set "EXIT_REASON=Прерывание по Ctrl+C"
) else (
    set "EXIT_REASON=Неизвестная причина (код %EXIT_CODE%)"
)

call :log "Приложение завершилось с кодом %EXIT_CODE%. Причина: %EXIT_REASON%"

echo.
echo ====================================================
echo Приложение завершилось с кодом %EXIT_CODE%.
echo Причина: %EXIT_REASON%
if %EXIT_CODE% neq 0 (
    echo.
    echo Приложение завершилось с ошибкой или было прервано.
) else (
    echo.
    echo Сервер успешно остановлен.
)
echo ====================================================
echo Нажмите любую клавишу для закрытия окна...
pause >nul

exit /b %EXIT_CODE%