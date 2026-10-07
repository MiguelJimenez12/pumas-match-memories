@echo off
cd /d "%~dp0"
if not exist "%~dp0server.js" (
  echo No se encuentra la aplicacion en esta carpeta.
  echo Si abriste este archivo desde el ZIP, primero extrae todo el ZIP.
  echo Despues abre el archivo CMD desde la carpeta extraida.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Necesitas Node.js 24 o posterior para abrir el album.
  echo Consulta el archivo README.md para instalarlo.
  pause
  exit /b 1
)
echo Abre http://127.0.0.1:3000 en tu navegador.
echo Manten esta ventana abierta mientras usas el album.
node "%~dp0server.js"
pause
