@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo ============================================
echo ChangLang - Automatic local setup (no Docker)
echo ============================================
echo This script can install Node.js LTS, Python 3.11 and C++ Build Tools if missing.
echo Large downloads may take some time and may ask for administrator approval.
echo.

where winget >nul 2>nul
if errorlevel 1 (
  echo WARNING: Windows Package Manager winget was not found.
  echo Automatic prerequisite installation may not work.
  echo Install or update "App Installer" from Microsoft Store, then rerun this script.
  echo.
)

REM ---- Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Trying to install Node.js LTS...
  where winget >nul 2>nul
  if errorlevel 1 goto :missing_winget
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo ERROR: Node.js installation failed. Install Node.js LTS from https://nodejs.org/ and rerun.
    goto :failed
  )
)
REM Add standard install locations to this script's PATH in case Windows has not refreshed PATH yet.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was installed, but this terminal cannot find it yet.
  echo Close this window and run setup-local-windows.bat again.
  goto :failed
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found after checking Node.js. Reinstall Node.js LTS from https://nodejs.org/
  goto :failed
)
node --version
call npm --version

REM ---- Python 3.11 ----
echo.
echo Checking for Python 3.11...
set "PYTHON311="
py -3.11 --version >nul 2>nul
if not errorlevel 1 (
  set "PYTHON311=py -3.11"
  goto :python_found
)
if exist "%LocalAppData%\Programs\Python\Python311\python.exe" (
  set "PYTHON311=%LocalAppData%\Programs\Python\Python311\python.exe"
  goto :python_found
)
if exist "%ProgramFiles%\Python311\python.exe" (
  set "PYTHON311=%ProgramFiles%\Python311\python.exe"
  goto :python_found
)
echo Python 3.11 was not found. Trying to install it...
where winget >nul 2>nul
if errorlevel 1 goto :missing_winget
winget install --id Python.Python.3.11 --exact --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo ERROR: Python 3.11 installation failed.
  echo Install Python 3.11 from https://www.python.org/downloads/release/python-3119/ and rerun.
  goto :failed
)
REM Common Python 3.11 locations, because PATH updates do not always appear in the current terminal.
if exist "%LocalAppData%\Programs\Python\Python311\python.exe" (
  set "PYTHON311=%LocalAppData%\Programs\Python\Python311\python.exe"
  set "PATH=%LocalAppData%\Programs\Python\Python311;%LocalAppData%\Programs\Python\Python311\Scripts;%PATH%"
  goto :python_found
)
if exist "%ProgramFiles%\Python311\python.exe" (
  set "PYTHON311=%ProgramFiles%\Python311\python.exe"
  set "PATH=%ProgramFiles%\Python311;%ProgramFiles%\Python311\Scripts;%PATH%"
  goto :python_found
)
py -3.11 --version >nul 2>nul
if not errorlevel 1 (
  set "PYTHON311=py -3.11"
  goto :python_found
)
echo Python 3.11 appears to have installed, but this terminal cannot locate it.
echo Close this window and run setup-local-windows.bat again.
goto :failed

:python_found
echo Found Python 3.11:
%PYTHON311% --version
if errorlevel 1 (
  echo ERROR: Python 3.11 could not be launched.
  goto :failed
)

REM ---- Isolated virtual environment ----
if not exist ".venv\Scripts\python.exe" (
  if exist ".venv" rmdir /s /q ".venv"
  echo.
  echo Creating isolated Python 3.11 virtual environment...
  %PYTHON311% -m venv .venv
  if errorlevel 1 (
    echo ERROR: Virtual environment creation failed. Check the Python installation.
    goto :failed
  )
)
if not exist ".venv\Scripts\python.exe" (
  echo ERROR: The virtual environment was not created.
  goto :failed
)
echo Using project Python:
".venv\Scripts\python.exe" --version
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed

echo.
echo Installing PyTorch CPU build inside ChangLang's virtual environment...
echo CPU translation can be slow; NVIDIA acceleration can be configured later.
".venv\Scripts\python.exe" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 goto :failed

REM ---- C++ Build Tools (required to compile IndicTransToolkit) ----
echo.
echo Checking whether Microsoft C++ Build Tools are available...
where cl.exe >nul 2>nul
if not errorlevel 1 goto :compiler_ready
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSINSTALL="
if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%V in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VSINSTALL=%%V"
)
if defined VSINSTALL if exist "%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat" goto :compiler_ready
echo Microsoft C++ Build Tools were not found. Trying automatic installation...
where winget >nul 2>nul
if errorlevel 1 goto :missing_winget
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --accept-package-agreements --accept-source-agreements --override "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if errorlevel 1 (
  echo Automatic Build Tools installation did not complete.
  echo Install from https://visualstudio.microsoft.com/visual-cpp-build-tools/ and select "Desktop development with C++".
  goto :failed
)
REM Verify that the C++ workload really installed; winget can return success without it.
set "VSINSTALL="
if exist "%VSWHERE%" (
  for /f "usebackq delims=" %%V in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VSINSTALL=%%V"
)
if not defined VSINSTALL (
  echo ERROR: The Build Tools installer did not register the required C++ workload.
  echo Open Visual Studio Installer, modify Build Tools, and select "Desktop development with C++".
  goto :failed
)
if not exist "%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat" (
  echo ERROR: The C++ compiler workload is still missing from the Build Tools installation.
  echo Open Visual Studio Installer and add "Desktop development with C++".
  goto :failed
)
echo Microsoft C++ Build Tools are installed.
:compiler_ready

echo.
echo Installing translation service requirements...
".venv\Scripts\python.exe" -m pip install -r "translation-service\requirements.txt"
if errorlevel 1 goto :failed

echo.
echo Installing ChangLang web/API dependencies...
call npm install
if errorlevel 1 goto :failed
if not exist ".env" copy ".env.example" ".env" >nul
echo.
echo ============================================
echo Setup complete!
echo Run start-local-windows.bat to launch ChangLang.
echo ============================================
pause
exit /b 0

:missing_winget
echo.
echo ERROR: winget is required to install missing prerequisites automatically.
echo Install or update "App Installer" from the Microsoft Store, then rerun this script.
echo Alternatively install Node.js LTS from https://nodejs.org/ and Python 3.11 from https://www.python.org/downloads/release/python-3119/
goto :failed

:failed
echo.
echo ERROR: Setup did not finish. Read the message above, fix the issue, and rerun this script.
echo Python packages are installed only inside this project's .venv folder.
pause
exit /b 1
