const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const userQueryText = document.getElementById("userQueryText");
const aiResponseText = document.getElementById("aiResponseText");
const statusMessage = document.getElementById("statusMessage");
const audioPlayer = document.getElementById("audioPlayer");
const processAudioBtn = document.getElementById("processAudioBtn");
const sendTextBtn = document.getElementById("sendTextBtn");
const chipBtns = document.querySelectorAll(".chip-btn");

let mediaRecorder = null;
let audioChunks = [];
let recordedAudioBlob = null;
let isRecording = false;

function setStatus(msg, type = "normal") {
  statusMessage.textContent = msg;
  statusMessage.className = "status-box" + (type === "error" ? " error" : type === "success" ? " success" : "");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function audioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const samples = audioBuffer.length;
  const blockAlign = numChannels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;

  const buffer = new ArrayBuffer(44 + samples * blockAlign);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples * blockAlign, true);
  writeString(8, "WAVE");

  // Format chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // Data chunk
  writeString(36, "data");
  view.setUint32(40, samples * blockAlign, true);

  let offset = 44;
  const channelData = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(audioBuffer.getChannelData(ch));
  }

  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channelData[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return buffer;
}

async function convertBlobToWavBase64(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("AudioContext not supported");
    }

    const audioCtx = new AudioContextClass();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    // Resample to 16kHz Mono for optimal STT performance
    const targetSampleRate = 16000;
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetSampleRate), targetSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    audioCtx.close();

    const wavBuffer = audioBufferToWav(renderedBuffer);
    const base64 = arrayBufferToBase64(wavBuffer);
    return { base64, mimeType: "audio/wav" };
  } catch (err) {
    console.warn("Browser audio resampling notice (backend fallback will convert):", err);
    const arrayBuffer = await blob.arrayBuffer();
    return { base64: arrayBufferToBase64(arrayBuffer), mimeType: blob.type || "audio/webm" };
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    const preferredMimeTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    const mimeType = preferredMimeTypes.find((t) => MediaRecorder.isTypeSupported(t)) || "";

    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recordedAudioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });

      if (recordedAudioBlob.size > 500) {
        audioPlayer.src = URL.createObjectURL(recordedAudioBlob);
        processAudioBtn.disabled = false;
        // Automatically process the recorded audio
        await processAudio(recordedAudioBlob);
      } else {
        setStatus("వాయిస్ చాలా తక్కువగా ఉంది. దయచేసి మళ్లీ రికార్డ్ చేయండి.", "error");
      }
    };

    mediaRecorder.start();
    isRecording = true;
    recordBtn.classList.add("recording");
    recordBtn.disabled = true;
    stopBtn.disabled = false;
    processAudioBtn.disabled = true;

    setStatus("వింటున్నాను... మాట్లాడండి (ఆపడానికి 'ఆపు' బటన్ నొక్కండి)");
    userQueryText.value = "వింటున్నాను...";
    aiResponseText.textContent = "సమాధానం కోసం వేచి చూస్తున్నాము...";
  } catch (err) {
    console.error("Microphone access error:", err);
    setStatus("మైక్ యాక్సెస్ లోపం: దయచేసి బ్రౌజర్‌లో మైక్రోఫోన్ అనుమతించండి.", "error");
    isRecording = false;
    recordBtn.classList.remove("recording");
    recordBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecording = false;
  recordBtn.classList.remove("recording");
  recordBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("ఆడియో ప్రాసెస్ చేస్తున్నాము...");
}

async function processAudio(blobToProcess) {
  const blob = blobToProcess || recordedAudioBlob;
  if (!blob) {
    setStatus("దయచేసి ముందుగా మైక్ ద్వారా మాట్లాడండి లేదా ఆడియో రికార్డ్ చేయండి.", "error");
    return;
  }

  try {
    recordBtn.disabled = true;
    stopBtn.disabled = true;
    processAudioBtn.disabled = true;
    sendTextBtn.disabled = true;

    setStatus("ఆడియోను ప్రాసెస్ చేస్తున్నాము (Prisma STT)...");

    const { base64, mimeType } = await convertBlobToWavBase64(blob);

    setStatus("Gnani AI సమాధానం తీసుకువస్తోంది (రైతు నేస్తం)...");

    const resp = await fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: base64, mimeType }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || `Request failed (${resp.status})`);
    }

    renderResponse(data);
  } catch (err) {
    console.error("Processing error:", err);
    setStatus(`Error: ${err.message || "సమస్య ఎదురైంది. మళ్లీ ప్రయత్నించండి."}`, "error");
    aiResponseText.textContent = "క్షమించండి, ఆడియో ప్రాసెస్ చేయడంలో లోపం ఏర్పడింది. దయచేసి మళ్లీ ప్రయత్నించండి.";
  } finally {
    recordBtn.disabled = false;
    processAudioBtn.disabled = !recordedAudioBlob;
    sendTextBtn.disabled = false;
  }
}

async function sendTextQuery(text) {
  const query = (text || userQueryText.value || "").trim();
  if (!query) {
    setStatus("దయచేసి మీ ప్రశ్నను నమోదు చేయండి.", "error");
    return;
  }

  try {
    recordBtn.disabled = true;
    sendTextBtn.disabled = true;
    processAudioBtn.disabled = true;

    userQueryText.value = query;
    setStatus("సమాధానం తీసుకువస్తున్నాము...");
    aiResponseText.textContent = "సమాధానం విశ్లేషిస్తున్నాము...";

    const resp = await fetch("/api/ask-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: query }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.error || `Request failed (${resp.status})`);
    }

    renderResponse(data);
  } catch (err) {
    console.error("Text query error:", err);
    setStatus(`Error: ${err.message || "సమస్య ఎదురైంది."}`, "error");
    aiResponseText.textContent = "క్షమించండి, సమాధానం తీసుకురావడంలో లోపం ఏర్పడింది.";
  } finally {
    recordBtn.disabled = false;
    sendTextBtn.disabled = false;
    processAudioBtn.disabled = !recordedAudioBlob;
  }
}

function renderResponse(data) {
  if (data.transcriptText) {
    userQueryText.value = data.transcriptText;
  }

  const bullets = (data.answerTeluguBullets || []).map((b) => `• ${b}`).join("\n");

  // Only show if content exists
  const nextStep = (data.nextStep && data.nextStep.trim()) ? `\n\n👉 తర్వాత ఏమి చేయాలి: ${data.nextStep}` : "";
  const clarify = (data.clarifyingQuestion && data.clarifyingQuestion.trim()) ? `\n\n❓ ${data.clarifyingQuestion}` : "";

  aiResponseText.textContent = bullets + nextStep + clarify;

  if (data.audio?.audioBase64) {
    const mime = data.audio.audioMimeType || "audio/ogg";
    audioPlayer.src = `data:${mime};base64,${data.audio.audioBase64}`;
    audioPlayer.play().catch((e) => console.log("Auto-play blocked by browser policy:", e));
  }

  setStatus("సమాధానం సిద్ధమైంది!", "success");
}

// Event Listeners
recordBtn.addEventListener("click", () => {
  if (!isRecording) startRecording();
});

stopBtn.addEventListener("click", () => {
  if (isRecording) stopRecording();
});

processAudioBtn.addEventListener("click", () => {
  if (recordedAudioBlob) processAudio(recordedAudioBlob);
});

sendTextBtn.addEventListener("click", () => {
  sendTextQuery();
});

userQueryText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTextQuery();
  }
});

chipBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const query = btn.getAttribute("data-query");
    if (query) {
      userQueryText.value = query;
      sendTextQuery(query);
    }
  });
});
