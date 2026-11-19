# ChangLang

A React + Express web app with a self-hosted IndicTrans2 engine for English ↔ Hindi document translation.

## Run locally on Windows (no Docker)

1. Extract this folder from the ZIP.
2. Double-click `setup-local-windows.bat` once. It attempts to install Node.js LTS, Python 3.11, and C++ Build Tools with `winget` if they are missing.
3. Double-click `start-local-windows.bat` whenever you want to run the app.
4. Open <http://localhost:5173>.

Automatic prerequisite installation requires Windows Package Manager (`winget`, usually provided by the Microsoft Store's App Installer).

The first setup installs dependencies and the CPU build of PyTorch. The first model startup downloads model weights and can take several minutes. Keep both terminal windows open while using the app. See [`TRANSLATION_SETUP.md`](./TRANSLATION_SETUP.md) for troubleshooting and optional NVIDIA GPU acceleration.

## Services

- React/Vite website: `http://localhost:5173`
- Express API: `http://localhost:4000`
- Local IndicTrans2 service: `http://127.0.0.1:8001`

Document translation uses the local model and does not require a Gemini key. The optional writing/email assistant still uses Gemini if you choose to use those features. No document uploads are persisted by the current API.

## Limitations

This initial integration supports English ↔ Hindi only. The model does not guarantee perfect preservation of scientific meaning; review translations, especially technical terminology, equations, numbers, and citations. The app's checks are safeguards, not proof of translation accuracy.
