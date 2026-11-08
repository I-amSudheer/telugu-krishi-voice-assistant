const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const WebSocket = require("ws");
const { spawnSync } = require("child_process");

dotenv.config({ path: path.join(__dirname, ".env"), override: true });

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

// Allow JSON payloads for base64 audio.
app.use(express.json({ limit: process.env.JSON_LIMIT || "25mb" }));
app.use(cors());

app.use(express.static(path.join(__dirname, "public")));

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findFirstString(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj === "string") return obj;

  // Common shapes.
  const candidates = [
    obj.transcript,
    obj.text,
    obj.output,
    obj.result,
    obj.message,
    obj.data,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }

  // Deep search (bounded).
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.trim()) return v;
    if (v && typeof v === "object") {
      const nested = findFirstString(v);
      if (nested) return nested;
    }
  }
  return null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return Buffer.from(binary, "binary").toString("base64");
}

function base64ToBuffer(base64) {
  return Buffer.from(base64, "base64");
}

function normalizeEvonResponse(maybeJsonOrText) {
  // We want:
  // {
  //   detectedIntent,
  //   answerTeluguBullets: string[],
  //   nextStep,
  //   clarifyingQuestion?: string | null
  // }
  if (!maybeJsonOrText) {
    return {
      answerTeluguBullets: ["క్షమించండి, సమాధానం తీసుకురాలేకపోయాను."],
      nextStep: "మళ్లీ ప్రయత్నించండి.",
      clarifyingQuestion: null,
      detectedIntent: "general-ask",
    };
  }

  if (typeof maybeJsonOrText === "string") {
    const parsed = safeJsonParse(maybeJsonOrText);
    if (parsed) return normalizeEvonResponse(parsed);

    // If the LLM returned plain text, attempt to coerce to bullets.
    const lines = maybeJsonOrText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const bullets = lines
      .filter((l) => l.startsWith("-") || l.startsWith("•") || l.match(/^\d+[\.)]/))
      .map((l) => l.replace(/^(-|•|\d+[\.)])\s*/, "").trim());

    const fallbackBullets = bullets.length >= 2 ? bullets : lines.slice(0, 4);
    const last = lines.length ? lines[lines.length - 1] : "";
    return {
      detectedIntent: "general-ask",
      answerTeluguBullets: fallbackBullets.slice(0, 6),
      nextStep: last || "తర్వాత ఏమి చేయాలో యాప్‌లో మళ్లీ అడగండి.",
      clarifyingQuestion: null,
    };
  }

  if (typeof maybeJsonOrText === "object") {
    const answerTeluguBullets = Array.isArray(maybeJsonOrText.answerTeluguBullets)
      ? maybeJsonOrText.answerTeluguBullets
      : [];

    const nextStep = typeof maybeJsonOrText.nextStep === "string" ? maybeJsonOrText.nextStep : null;
    const clarifyingQuestion =
      typeof maybeJsonOrText.clarifyingQuestion === "string" || maybeJsonOrText.clarifyingQuestion === null
        ? maybeJsonOrText.clarifyingQuestion
        : null;

    const detectedIntent =
      typeof maybeJsonOrText.detectedIntent === "string" ? maybeJsonOrText.detectedIntent : "general-ask";

    if (answerTeluguBullets.length) {
      return {
        detectedIntent,
        answerTeluguBullets: answerTeluguBullets.slice(0, 6),
        nextStep: nextStep || "తర్వాత ఏమి చేయాలో యాప్‌లో అడగండి.",
        clarifyingQuestion,
      };
    }

    // Try to find a text field that contains JSON.
    const firstString = findFirstString(maybeJsonOrText);
    if (firstString) {
      return normalizeEvonResponse(firstString);
    }
  }

  return {
    answerTeluguBullets: ["క్షమించండి, సమాధానం తీసుకురాలేకపోయాను."],
    nextStep: "మళ్లీ ప్రయత్నించండి.",
    clarifyingQuestion: null,
    detectedIntent: "general-ask",
  };
}

function buildEvonPrompt({ transcriptText, kb }) {
  const kbSchemes = kb?.schemes || [];
  const kbDocs = kb?.requiredDocumentsGeneral || [];

  const schemesText = kbSchemes
    .map((s) => {
      return [
        `పథకం పేరు: ${s.name}`,
        ...(s.benefits || []).slice(0, 2).map((b) => `- ప్రయోజనం: ${b}`),
        ...(s.eligibilityHints || []).slice(0, 2).map((h) => `- అర్హత సూచనలు: ${h}`),
        `- అవసరమైన పత్రాలు: ${(s.documents || []).slice(0, 6).join(", ")}`,
      ].join("\n");
    })
    .join("\n\n");

  const documentsText = kbDocs.slice(0, 8).join(", ");

  return `
మీరు తెలుగు వ్యవసాయ సహాయకుడు. లక్ష్య ప్రాంతం: ఆంధ్రప్రదేశ్.

వాడుకరి అడిగింది: "${transcriptText}".

సమాధానం నియమాలు:
1) సమాధానం ఎప్పుడూ తెలుగు లోనే ఇవ్వండి.
2) అవుట్‌పుట్ ఖచ్చితంగా క్రింది JSON ఫార్మాట్‌లో ఉండాలి (అదనపు టెక్స్ట్ లేకుండా):
{
  "detectedIntent": "weather"|"prices"|"schemes"|"documents"|"crop-guidance"|"general-ask",
  "answerTeluguBullets": ["...","..."],
  "nextStep": "...",
  "clarifyingQuestion": "string or null"
}
3) answerTeluguBullets తప్పకుండా 2–6 బులెట్లు ఉండాలి.
4) prices intent కి జిల్లా/ప్రాంతం + పంట (crop) అవసరం; district/crop సమాచారం లేకపోతే clarifyingQuestion లో కేవలం ఒక్క ప్రశ్న అడగండి.
5) weather intent కి జిల్లా/ప్రాంతం అవసరం; లేకపోతే clarifyingQuestion లో కేవలం ఒక్క ప్రశ్న అడగండి.
6) schemes/documents/crop-guidance కి clarifyingQuestion ఐచ్ఛికం (సాధ్యమైనప్పుడు సాధారణంగా స్పందించండి).
7) అర్హతలు/నిబంధనలు అని చెబితే "ఖచ్చితమైన అర్హతను సంబంధిత అధికారిక మార్గదర్శకాల ప్రకారం" అని చిన్నగా సూచించండి (ఒక బులెట్‌లో).

జ్ఞానబేస్ (పథకాలు & సాధారణ పత్రాలు):
${schemesText}

సాధారణ అవసరమైన పత్రాలు (జనరల్): ${documentsText}

ఇప్పుడు JSON అవుట్‌పుట్ ఇవ్వండి.
`;
}

async function callGnaniJson({ url, apiKey, payload }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await res.json();
  }

  const text = await res.text();
  const parsed = safeJsonParse(text);
  if (parsed) return parsed;
  return text;
}

function mimeTypeFromTtsContainer(container) {
  switch (container) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "mulaw":
      return "audio/basic";
    case "alaw":
      return "audio/alaw";
    case "raw":
      return "application/octet-stream";
    default:
      return "audio/ogg";
  }
}

function ensureWavBuffer(buffer) {
  // Check if buffer is already a valid WAV (RIFF .... WAVE)
  const isWav =
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE";

  if (isWav) {
    return buffer;
  }

  // If not WAV (e.g. WebM/Opus from browser), convert using local ffmpeg
  try {
    const result = spawnSync(
      "ffmpeg",
      ["-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
      { input: buffer, maxBuffer: 25 * 1024 * 1024 }
    );
    if (result.status === 0 && result.stdout && result.stdout.length > 44) {
      console.log(`[Audio Transcode] Converted input (${buffer.length} bytes) to 16kHz mono WAV (${result.stdout.length} bytes)`);
      return result.stdout;
    }
  } catch (err) {
    console.warn("ffmpeg audio conversion notice:", err.message);
  }
  return buffer;
}

// Prisma call: STT
async function callPrismaTranscribe({ audioWavBase64, mimeType }) {
  const prismaUrl = requireEnv("GNANI_PRISMA_URL");
  const prismaKey = requireEnv("GNANI_PRISMA_KEY");

  const model = process.env.GNANI_PRISMA_MODEL || "prisma-v3.0";
  const languageCode = process.env.GNANI_PRISMA_LANGUAGE_CODE || "te-IN";
  const format = process.env.GNANI_PRISMA_FORMAT || "transcribe";

  const rawBuffer = base64ToBuffer(audioWavBase64);
  const buffer = ensureWavBuffer(rawBuffer);
  const audioBlob = new Blob([buffer], { type: "audio/wav" });

  const form = new globalThis.FormData();
  form.append("audio_file", audioBlob, "recording.wav");
  form.append("language_code", languageCode);
  if (model) form.append("model", model);
  if (format) form.append("format", format);

  const res = await fetch(prismaUrl, {
    method: "POST",
    headers: {
      "X-API-Key-ID": prismaKey,
    },
    body: form,
  });

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await res.json();
    if (!res.ok) {
      const errMsg = j?.error?.message || JSON.stringify(j);
      throw new Error(`Prisma failed: ${errMsg}`);
    }
    const transcript = typeof j.transcript === "string" ? j.transcript : findFirstString(j);
    if (transcript === undefined || transcript === null) {
      throw new Error("Prisma response did not include transcript text.");
    }
    return transcript;
  }

  const text = await res.text();
  throw new Error(`Prisma returned non-JSON response: ${text.slice(0, 200)}`);
}

function fallbackKnowledgeBaseAnswer({ transcriptText, kb }) {
  const t = (transcriptText || "").toLowerCase();

  // 1. Rythu Nestham specific query
  if (
    t.includes("రైతు నేస్తం") ||
    t.includes("nestham") ||
    t.includes("రైతుబంధు") ||
    t.includes("భరోసా")
  ) {
    const s =
      (kb.schemes || []).find((item) => item.name === "Rythu Nestham") ||
      (kb.schemes || [])[3] ||
      {};
    return {
      detectedIntent: "schemes",
      answerTeluguBullets: [
        "రైతు నేస్తం పథకం ద్వారా రైతులకు వ్యవసాయం మరియు ఉత్పాదకత మద్దతు అందించబడుతుంది.",
        `ప్రధాన ప్రయోజనాలు: ${(s.benefits || []).join(", ")}`,
        `కావలసిన పత్రాలు: ${(s.documents || []).join(", ")}`,
        "అర్హత నిబంధనలు ఆంధ్రప్రదేశ్ రాష్ట్ర ప్రభుత్వ మార్గదర్శకాల ప్రకారం వర్తిస్తాయి.",
      ],
      nextStep: "దరఖాస్తు మరియు రిజిస్ట్రేషన్ కోసం మీ సమీప రైతు భరోసా కేంద్రం (RBK) వద్ద సంప్రదించండి.",
      clarifyingQuestion: null,
    };
  }

  // 2. General Schemes query
  if (
    t.includes("పథక") ||
    t.includes("స్కీమ్") ||
    t.includes("scheme") ||
    t.includes("సాయం") ||
    t.includes("సహాయం")
  ) {
    return {
      detectedIntent: "schemes",
      answerTeluguBullets: [
        "రైతు నేస్తం: ఆంధ్రప్రదేశ్ రైతులకు సాగు మద్దతు మరియు మార్గదర్శకత్వం.",
        "PM-KISAN: అర్హులైన రైతులకు కేంద్ర ప్రభుత్వం ఇచ్చే వార్షిక ఆర్థిక సాయం.",
        "PMFBY: ప్రకృతి వైపరీత్యాల వల్ల పంట నష్టపోతే ఆదుకునే పంట బీమా పథకం.",
        "కిసాన్ క్రెడిట్ కార్డ్ (KCC): బ్యాంకుల ద్వారా తక్కువ వడ్డీతో పంట పెట్టుబడి రుణాలు.",
      ],
      nextStep: "మీకు ఏదైనా ఒక నిర్దిష్ట పథకం వివరాలు లేదా పత్రాలు కావాలంటే ఆ పథకం పేరు చెప్పండి.",
      clarifyingQuestion: null,
    };
  }

  // 3. Documents query
  if (
    t.includes("డాక్యుమెంట్") ||
    t.includes("పత్రాలు") ||
    t.includes("కాగితాలు") ||
    t.includes("document") ||
    t.includes("ఆధార్") ||
    t.includes("aadhaar")
  ) {
    const docs = kb.requiredDocumentsGeneral || [
      "ఆధార్ కార్డు",
      "బ్యాంక్ ఖాతా వివరాలు (పాస్‌బుక్)",
      "భూమి పట్టాదారు పాస్‌బుక్ / అడంగల్",
      "మొబైల్ నంబర్ (ఆధార్ లింక్ అయినది)",
    ];
    return {
      detectedIntent: "documents",
      answerTeluguBullets: docs.slice(0, 5).map((d) => `అవసరమైన పత్రం: ${d}`),
      nextStep: "ఈ పత్రాల నకలు (జిరాక్స్) తో పాటు ఒరిజినల్ ప్రతులను RBK వద్ద సిద్ధంగా ఉంచుకోండి.",
      clarifyingQuestion: null,
    };
  }

  // 4. Weather query
  if (
    t.includes("వాతావరణ") ||
    t.includes("వర్షం") ||
    t.includes("ఎండ") ||
    t.includes("weather") ||
    t.includes("rain") ||
    t.includes("తుఫాను")
  ) {
    return {
      detectedIntent: "weather",
      answerTeluguBullets: [
        "ఆంధ్రప్రదేశ్ ప్రాంతాలలో ప్రస్తుత వాతావరణ హెచ్చరికలను గమనిస్తూ సాగు పనులు చేపట్టండి.",
        "భారీ వర్ష సూచన ఉంటే పురుగుమందులు, ఎరువుల పిచికారీని తాత్కాలికంగా ఆపండి.",
        "పొలాల్లో నీరు నిలవకుండా మురుగు కాలువలు శుభ్రపరచుకోండి.",
        "ఖచ్చితమైన రోజువారీ సమాచారం కోసం స్థానిక RBK వాతావరణ సూచన బోర్డును చూడండి.",
      ],
      nextStep: "మీ జిల్లా వాతావరణ సూచనల కోసం మీ జిల్లా పేరు తెలియజేయండి.",
      clarifyingQuestion: "మీరు ఏ జిల్లా లేదా ప్రాంతానికి సంబంధించిన వాతావరణం తెలుసుకోవాలనుకుంటున్నారు?",
    };
  }

  // 5. Prices query
  if (
    t.includes("ధర") ||
    t.includes("మార్కెట్") ||
    t.includes("రేటు") ||
    t.includes("రేట్") ||
    t.includes("price") ||
    t.includes("mandi")
  ) {
    return {
      detectedIntent: "prices",
      answerTeluguBullets: [
        "వ్యవసాయ మార్కెట్ యార్డులలో పంట నాణ్యత, తేమ శాతం బట్టి ధరలు నిర్ణయిస్తారు.",
        "మిర్చి, పత్తి, వరి వంటి పంటల రోజువారీ గరిష్ట ధరల వివరాలకు సమీప e-NAM మార్కెట్ చూడండి.",
        "దళారుల మాటలు నమ్మకుండా ప్రభుత్వం ప్రకటించిన కనీస మద్దతు ధర (MSP) గమనించండి.",
        "పంటను విక్రయించే ముందు మార్కెట్ యార్డ్ వ్యాపారుల కోట్లను సరిచూసుకోండి.",
      ],
      nextStep: "మీ పంట పేరు మరియు మార్కెట్ జిల్లా చెబితే తగిన సమాచారం తెలుసుకోవచ్చు.",
      clarifyingQuestion: "మీరు ఏ పంట మరియు ఏ జిల్లా మార్కెట్ ధర గురించి తెలుసుకోవాలనుకుంటున్నారు?",
    };
  }

  // 6. Default: General agricultural guidance
  return {
    detectedIntent: "crop-guidance",
    answerTeluguBullets: [
      "విత్తే సమయానికి అనువైన ధృవీకరించిన విత్తనాలను ఎంచుకోండి.",
      "భూసార పరీక్షలు (Soil Test) చేయించి సమతుల్యంగా ఎరువులు వాడండి.",
      "సహజ ఎరువులు, జీవ నియంత్రణ పద్ధతులతో పురుగుల నివారణ చేపట్టండి.",
      "ప్రభుత్వ రాయితీ విత్తనాలు, ఎరువుల సమాచారానికి గ్రామ RBK కేంద్రాన్ని సందర్శించండి.",
    ],
    nextStep: "పథకాలు, అవసరమైన పత్రాలు, వాతావరణం లేదా పంట ధరల గురించి ఏదైనా అడగవచ్చు.",
    clarifyingQuestion: null,
  };
}

async function callEvonAnswer({ transcriptText, kb }) {
  const evonUrl = process.env.GNANI_EVON_URL;
  const evonKey = process.env.GNANI_EVON_KEY;

  if (
    !evonUrl ||
    !evonKey ||
    evonUrl.includes("api.evon.ai") ||
    evonKey.includes("api.evon.ai")
  ) {
    throw new Error("Evon endpoint or key is not configured or using placeholder.");
  }

  const requestMode = process.env.GNANI_EVON_REQUEST_MODE || "auto";
  const evonModel = process.env.GNANI_EVON_MODEL || "evon";

  const promptText = buildEvonPrompt({ transcriptText, kb });

  function extractAssistantContent(data) {
    // OpenAI-compatible: choices[0].message.content
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      data?.output?.text ??
      data?.content ??
      null;

    if (typeof content === "string") return content;
    if (content && typeof content === "object") return content;
    return null;
  }

  async function tryPromptStyle() {
    const payload = {
      prompt: promptText,
      language: "te",
      response_format: "json",
    };

    const result = await callGnaniJson({ url: evonUrl, apiKey: evonKey, payload });
    return result;
  }

  async function tryChatCompletionsStyle() {
    const payload = {
      model: evonModel,
      messages: [
        {
          role: "system",
          content:
            "You must respond with strict JSON only. Do not include any extra text.",
        },
        {
          role: "user",
          content: promptText,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    };

    const result = await callGnaniJson({ url: evonUrl, apiKey: evonKey, payload });
    return result;
  }

  let raw;

  if (requestMode === "prompt") {
    raw = await tryPromptStyle();
  } else if (requestMode === "chat_completions") {
    raw = await tryChatCompletionsStyle();
  } else {
    // auto: try prompt style first, then chat style if it fails.
    try {
      raw = await tryPromptStyle();
    } catch {
      raw = await tryChatCompletionsStyle();
    }
  }

  // If the API returns chat-completion style, extract content.
  if (raw && typeof raw === "object") {
    const assistantContent = extractAssistantContent(raw);
    if (assistantContent) {
      // content might be a JSON string.
      return normalizeEvonResponse(assistantContent);
    }
  }

  return normalizeEvonResponse(raw);
}

async function callTimbreTTS({ textTelugu }) {
  const timbreKey = requireEnv("GNANI_TIMBRE_KEY");
  const timbreUrl = process.env.GNANI_TIMBRE_URL || "wss://api.vachana.ai/api/v1/tts";

  // Pick defaults that work for Telugu.
  // You can override voice/model via env vars.
  const voice = process.env.GNANI_TIMBRE_VOICE || "Kaveri";
  const model = process.env.GNANI_TIMBRE_MODEL || "timbre-v2.5";
  const language = process.env.GNANI_TIMBRE_LANGUAGE || "te-IN";
  const speed = process.env.GNANI_TIMBRE_SPEED ? Number(process.env.GNANI_TIMBRE_SPEED) : 1.0;

  // We request a single OGG file chunk after synthesis completes.
  const audioConfig = {
    sample_rate: 48000,
    num_channels: 1,
    sample_width: 2,
    encoding: "linear_pcm",
    container: "ogg",
  };

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(timbreUrl, {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key-ID": timbreKey,
      },
    });

    const chunks = [];
    let resolved = false;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          text: textTelugu,
          voice,
          model,
          language,
          speed,
          audio_config: audioConfig,
        })
      );
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "audio") {
          const b64 = msg.data?.audio;
          if (typeof b64 === "string" && b64.trim()) {
            chunks.push(Buffer.from(b64, "base64"));
          }
        } else if (msg.type === "complete") {
          const audioBytes = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
          const audioBase64 = audioBytes.toString("base64");

          resolved = true;
          ws.close();
          resolve({ audioBase64, audioMimeType: "audio/ogg" });
        } else if (msg.type === "error") {
          const m = msg.message || msg.data?.message || msg.error || "TTS error";
          ws.close();
          reject(new Error(m));
        }
      } catch (e) {
        // Ignore non-JSON frames.
      }
    });

    ws.on("error", (err) => {
      if (resolved) return;
      reject(err);
    });

    ws.on("close", () => {
      // If close happens before 'complete', treat as failure.
      if (!resolved && chunks.length === 0) {
        reject(new Error("TTS connection closed before audio was received."));
      }
    });
  });
}

function bulletsToTtsText({ bullets, nextStep }) {
  // Speak only the short answer. "nextStep" is shown on screen, not read aloud,
  // so the voice reply stays to a couple of sentences.
  return (bullets || []).join(" ");
}

// Telugu place names the farmer is likely to say, mapped to an OpenWeather query.
const PLACE_NAMES = [
  ["విశాఖపట్నం", "Visakhapatnam"],
  ["విశాఖ", "Visakhapatnam"],
  ["విజయవాడ", "Vijayawada"],
  ["బెజవాడ", "Vijayawada"],
  ["గుంటూరు", "Guntur"],
  ["గుంటూర్", "Guntur"],
  ["guntur", "Guntur"],
  ["తెనాలి", "Tenali"],
  ["tenali", "Tenali"],
  ["నెల్లూరు", "Nellore"],
  ["నెల్లూర్", "Nellore"],
  ["nellore", "Nellore"],
  ["తిరుపతి", "Tirupati"],
  ["tirupati", "Tirupati"],
  ["కర్నూలు", "Kurnool"],
  ["కర్నూల్", "Kurnool"],
  ["kurnool", "Kurnool"],
  ["కడప", "Kadapa"],
  ["kadapa", "Kadapa"],
  ["అనంతపురం", "Anantapur"],
  ["anantapur", "Anantapur"],
  ["చిత్తూరు", "Chittoor"],
  ["chittoor", "Chittoor"],
  ["ఒంగోలు", "Ongole"],
  ["ongole", "Ongole"],
  ["రాజమండ్రి", "Rajahmundry"],
  ["రాజమహేంద్రవరం", "Rajahmundry"],
  ["కాకినాడ", "Kakinada"],
  ["kakinada", "Kakinada"],
  ["ఏలూరు", "Eluru"],
  ["eluru", "Eluru"],
  ["శ్రీకాకుళం", "Srikakulam"],
  ["విజయనగరం", "Vizianagaram"],
  ["నరసరావుపేట", "Narasaraopet"],
  ["మచిలీపట్నం", "Machilipatnam"],
  ["హైదరాబాద్", "Hyderabad"],
  ["hyderabad", "Hyderabad"],
  ["వరంగల్", "Warangal"],
];

function detectPlace(text) {
  const t = (text || "").toLowerCase();
  console.log(`[DetectPlace] Checking text: "${t}"`);
  for (const [needle, city] of PLACE_NAMES) {
    if (t.includes(needle.toLowerCase())) {
      console.log(`[DetectPlace] Found match: ${needle} -> ${city}`);
      return city;
    }
  }
  return null;
}

function isWeatherQuestion(text) {
  const t = (text || "").toLowerCase();
  const weatherKeywords = ["వాతావరణ", "వర్షం", "ఎండ", "weather", "rain", "తుఫాను", "ఉష్ణోగ్రత", "చలి"];
  const isWeather = weatherKeywords.some((w) => t.includes(w));
  console.log(`[IsWeatherQuestion] Text: "${t}", Result: ${isWeather}`);
  return isWeather;
}

// Live weather for a named place. Returns null when the place is missing or the API fails.
async function fetchLiveWeather(city) {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) {
    console.warn("[Weather] Missing API Key");
    return null;
  }
  if (!city) return null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)},IN&appid=${key}&units=metric&lang=te`;
    console.log(`[Weather] Fetching: ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[Weather] API error: ${res.status} ${res.statusText}`);
      return null;
    }
    const j = await res.json();
    const temp = Math.round(j?.main?.temp);
    const desc = j?.weather?.[0]?.description;
    if (Number.isNaN(temp) || !desc) {
      console.warn("[Weather] Invalid response data", j);
      return null;
    }
    console.log(`[Weather] Success: ${city} is ${temp}C, ${desc}`);
    return { city, temp, desc };
  } catch (err) {
    console.error("[Weather] Exception:", err.message);
    return null;
  }
}

// One short, spoken Telugu answer from Groq. Returns null if Groq is unavailable,
// so the caller can fall back to the local knowledge base.
async function callGroqAnswer({ transcriptText, weather }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const model = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

  const weatherLine = weather
    ? `Live weather right now in ${weather.city}: ${weather.temp}°C, ${weather.desc}. Use these exact numbers; do not invent any other figures.`
    : "No live weather data is available. If the farmer asks about weather for a place you were not given numbers for, say you could not fetch it and ask which district.";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are రైతు నేస్తం, a Telugu farming assistant for Andhra Pradesh farmers. " +
            "Reply in simple spoken Telugu only, in 2 short sentences at most. " +
            "Answer the question directly. No bullet points, no headings, no English sentences, no long advice lists. " +
            weatherLine,
        },
        { role: "user", content: transcriptText },
      ],
      max_tokens: 160,
      temperature: 0.5,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq failed (${res.status}): ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  const text = (data?.choices?.[0]?.message?.content || "").trim();
  if (!text) return null;

  return {
    detectedIntent: weather ? "weather" : "general-ask",
    answerTeluguBullets: [text],
    nextStep: "",
    clarifyingQuestion: null,
  };
}

// Decides the answer: live weather when a place is named, a short Groq reply otherwise,
// and the local knowledge base only when Groq is unreachable.
async function answerQuestion({ transcriptText, kb }) {
  console.log(`[Answer Engine] Processing query: "${transcriptText}"`);
  const city = detectPlace(transcriptText);
  const isWeather = isWeatherQuestion(transcriptText);

  console.log(`[Answer Engine] Detected city: ${city}, Is weather question: ${isWeather}`);

  const weather = isWeather ? await fetchLiveWeather(city) : null;
  if (weather) {
    console.log(`[Answer Engine] Live weather fetched: ${weather.temp}°C, ${weather.desc}`);
  }

  if (isWeather && !city) {
    console.log(`[Answer Engine] Weather question without city - asking for clarification`);
    return {
      detectedIntent: "weather",
      answerTeluguBullets: ["వాతావరణం చెప్పడానికి మీ జిల్లా పేరు కావాలి."],
      nextStep: "",
      clarifyingQuestion: "మీ జిల్లా పేరు చెప్పండి.",
    };
  }

  try {
    const groq = await callGroqAnswer({ transcriptText, weather });
    if (groq) {
      console.log(`[Answer Engine] Groq reply received: "${groq.answerTeluguBullets[0]}"`);
      return groq;
    }
  } catch (err) {
    console.warn("[Answer Engine] Groq error:", err.message);
  }

  // Weather with live numbers but no LLM: answer directly instead of the generic bulletin.
  if (weather) {
    console.log(`[Answer Engine] Falling back to direct weather answer (no LLM)`);
    return {
      detectedIntent: "weather",
      answerTeluguBullets: [`${weather.city} లో ఇప్పుడు ${weather.temp} డిగ్రీలు, ${weather.desc}.`],
      nextStep: "",
      clarifyingQuestion: null,
    };
  }

  console.log(`[Answer Engine] Falling back to local knowledge base`);
  return fallbackKnowledgeBaseAnswer({ transcriptText, kb });
}

app.post("/api/process", async (req, res) => {
  try {
    const { audioBase64, mimeType } = req.body || {};

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({ error: "Missing audioBase64" });
    }

    const kbPath = path.join(__dirname, "knowledgeBase.json");
    const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));

    const transcriptText = await callPrismaTranscribe({
      audioWavBase64: audioBase64,
      mimeType: mimeType || "audio/wav",
    });

    if (!transcriptText || !transcriptText.trim()) {
      return res.json({
        transcriptText: "(మాట స్పష్టంగా వినిపించలేదు)",
        detectedIntent: "general-ask",
        answerTeluguBullets: [
          "మీ వాయిస్ స్పష్టంగా వినబడలేదు.",
          "దయచేసి మైక్రోఫోన్ దగ్గరగా మాట్లాడండి లేదా మళ్లీ ప్రయత్నించండి."
        ],
        nextStep: "మైక్ రికార్డ్ బటన్ నొక్కి మళ్లీ స్పష్టంగా మాట్లాడండి.",
        clarifyingQuestion: null,
        audio: null,
      });
    }

    const evon = await answerQuestion({ transcriptText, kb });

    const responseTextForTts = bulletsToTtsText({
      bullets: evon.answerTeluguBullets,
      nextStep: evon.nextStep,
    });

    let audioPayload = null;
    try {
      const { audioBase64: audioOutBase64, audioMimeType } = await callTimbreTTS({ textTelugu: responseTextForTts });
      audioPayload = {
        audioBase64: audioOutBase64,
        audioMimeType,
      };
    } catch (ttsErr) {
      console.warn("Timbre TTS warning:", ttsErr.message);
    }

    return res.json({
      transcriptText,
      detectedIntent: evon.detectedIntent,
      answerTeluguBullets: evon.answerTeluguBullets,
      nextStep: evon.nextStep,
      clarifyingQuestion: evon.clarifyingQuestion,
      audio: audioPayload,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err?.message || String(err),
    });
  }
});

app.post("/api/ask-text", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text query" });
    }

    const kbPath = path.join(__dirname, "knowledgeBase.json");
    const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));

    const evon = await answerQuestion({ transcriptText: text, kb });

    const responseTextForTts = bulletsToTtsText({
      bullets: evon.answerTeluguBullets,
      nextStep: evon.nextStep,
    });

    let audioPayload = null;
    try {
      const { audioBase64, audioMimeType } = await callTimbreTTS({ textTelugu: responseTextForTts });
      audioPayload = {
        audioBase64,
        audioMimeType,
      };
    } catch (ttsErr) {
      console.warn("Timbre TTS warning:", ttsErr.message);
    }

    return res.json({
      transcriptText: text,
      detectedIntent: evon.detectedIntent,
      answerTeluguBullets: evon.answerTeluguBullets,
      nextStep: evon.nextStep,
      clarifyingQuestion: evon.clarifyingQuestion,
      audio: audioPayload,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err?.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
