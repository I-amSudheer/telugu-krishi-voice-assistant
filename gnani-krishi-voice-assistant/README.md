# Telugu Krishi Voice Assistant (Gnani Voice + LLM)

A simple web app: **Telugu speech (Prisma)** → **Evon answer in Telugu** → **Telugu audio (Timbre)**.

## Folder
- `backend/server.js` – Express backend (calls Gnani)
- `backend/public/*` – Simple UI (record mic, show transcript + answer, play audio)
- `backend/knowledgeBase.json` – Starter scheme/doc KB (includes **Rythu Nestham**)

## 1) Configure Gnani keys
Copy the env template:
- `backend/.env.example` → `backend/.env`

Update these with your real values from Gnani dashboard/docs:
- `GNANI_PRISMA_URL`, `GNANI_PRISMA_KEY`
- `GNANI_EVON_URL`, `GNANI_EVON_KEY`
- `GNANI_TIMBRE_URL`, `GNANI_TIMBRE_KEY`

## 2) Run
From `backend/`:
- `npm install`
- `npm start`

Open:
- `http://localhost:3001`

## Important (because API schemas differ)
This MVP includes **scaffolding** for Gnani requests:
- Prisma is called with JSON body by default (audio base64).
- Evon is called with `{ prompt, language, response_format }`.
- Timbre is called with `{ text, language, format }`.

If Gnani requires `multipart/form-data` or different field names, paste the **example request/response** from the Gnani docs for Prisma/Timbre/Evon and I’ll adjust the code precisely.
