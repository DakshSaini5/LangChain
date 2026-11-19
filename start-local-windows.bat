@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup-local-windows.bat first.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo Node dependencies are missing. Run setup-local-windows.bat first.
  pause
  exit /b 1
)
echo Starting local IndicTrans2 translation service...
start "ChangLang - Translation Model" cmd /k "cd /d ""%~dp0translation-service"" && ""%~dp0.venv\Scripts\python.exe"" -m uvicorn app:app --host 127.0.0.1 --port 8001"
timeout /t 5 /nobreak >nul
echo Starting ChangLang website and API...
start "ChangLang - Web and API" cmd /k "cd /d ""%~dp0"" && set "PORT=4000" && npm run dev"
echo.
echo Open http://localhost:5173 in your browser.
echo The first model startup downloads model files and may take several minutes.
echo Keep both terminal windows open while using ChangLang.
