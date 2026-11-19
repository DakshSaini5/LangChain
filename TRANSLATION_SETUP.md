# ChangLang local translation setup (no Docker)

This runs the app and the IndicTrans2 model directly on your Windows computer. No Docker account or Docker Desktop is required.

## What you need

- Windows 10/11
- Node.js LTS (the setup script attempts to install it with `winget` if missing)
- Python 3.11 (the setup script attempts to install it with `winget` if missing)
- Windows Package Manager (`winget`, normally included with current Windows 10/11 via App Installer)
- Internet access on first setup, to install Python packages and download model weights
- Several GB of free disk space and RAM

The included quick setup installs the **CPU** version of PyTorch so it works without checking your GPU first. This is the easiest baseline, but translating long papers on CPU can be slow. If your computer has a compatible NVIDIA GPU, you can switch to a CUDA-enabled PyTorch build later.

## First-time setup

1. Extract the entire ZIP to a normal folder, for example `C:\ChangLang`. Do not run it from inside the ZIP.
2. Install Node.js 20 LTS or newer from <https://nodejs.org/>.
3. Install 64-bit Python 3.11 from <https://www.python.org/downloads/release/python-3119/>. During installation, tick **Add python.exe to PATH**.
4. Open the extracted `ChangLang` folder.
5. Double-click `setup-local-windows.bat`. It creates a Python virtual environment and installs PyTorch, the model-service dependencies, and Node packages. If needed, it attempts to install Microsoft Visual Studio Build Tools with the C++ workload using `winget`; this is a large download and may require administrator approval.
6. Wait for setup to finish. It can take a while because PyTorch is large.

## Start ChangLang

1. Double-click `start-local-windows.bat`.
2. Two terminal windows will open: one for the translation model and one for the website/API. Keep both open.
3. Open <http://localhost:5173>.
4. On first launch, the service downloads two IndicTrans2 model checkpoints. Wait until the translation terminal shows that both models have loaded before translating.

The local translation API is at `http://127.0.0.1:8001`; its health check is <http://127.0.0.1:8001/health>. The Express API health check is <http://localhost:4000/api/health>.

## Stop the app

Close both terminal windows, or press `Ctrl+C` in each one.

## Optional: NVIDIA GPU acceleration

The quick setup intentionally uses CPU PyTorch to maximize compatibility. To use an NVIDIA GPU, first check that `nvidia-smi` works in Command Prompt. Then follow the official PyTorch selector at <https://pytorch.org/get-started/locally/> and install the matching CUDA-enabled PyTorch build inside this project's `.venv`. Afterward, verify with:

```bat
.venv\Scripts\python -c "import torch; print('CUDA available:', torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU mode')"
```

Do not install a CUDA build unless the installed NVIDIA driver and selected PyTorch build are compatible.

## Troubleshooting

- **`py -3.11` not found:** the script tries `py install 3.11`; if that fails, install Python 3.11 (64-bit), enable the Python launcher and `Add python.exe to PATH`, then rerun setup.
- **C++ Build Tools install fails:** install from <https://visualstudio.microsoft.com/visual-cpp-build-tools/>, select **Desktop development with C++**, then rerun setup. Build Tools require a large download and may need administrator approval.
- **Port already in use:** close another app using port 4000, 5173, or 8001.
- **Model download fails:** check internet access and rerun `start-local-windows.bat`; Hugging Face model files must download before first use.
- **Translation says it cannot reach the model:** check that the translation terminal is still running and visit `http://127.0.0.1:8001/health`.
- **Very slow translation:** CPU inference is slow for long academic documents. GPU acceleration may help if you have a compatible NVIDIA GPU.
- **RAM is exhausted:** close other apps. The service loads both translation directions into memory.
- **Writing/email assistant:** document translation uses local IndicTrans2. The optional writing and email polishing endpoints still require `GEMINI_API_KEY`; they are not required for English↔Hindi document translation.

## Important quality note

Self-hosting avoids a per-request translation API fee, but it does not make the model perfectly accurate. Scientific claims, equations, citations, numbers, and domain-specific terminology still need human review. The current number/link checks can flag some errors but cannot guarantee semantic preservation.
