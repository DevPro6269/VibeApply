// Storage keys
const STORAGE_KEY_API = "vibeapply.openaiKey";
const STORAGE_KEY_RESUME = "vibeapply.resume";

// pdf.js: tell it where the worker lives (relative to popup.html)
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "../../vendor/pdfjs/pdf.worker.min.js";

// DOM refs
const apiKeyInput = document.getElementById("apiKey");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const keyStatus = document.getElementById("keyStatus");

const resumeFileInput = document.getElementById("resumeFile");
const saveResumeBtn = document.getElementById("saveResumeBtn");
const resumeStatus = document.getElementById("resumeStatus");

const autofillBtn = document.getElementById("autofillBtn");

// ---------- helpers ----------
function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function updateAutofillEnabled(keySet, resumeSet) {
  autofillBtn.disabled = !(keySet && resumeSet);
}

async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const pageTexts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    pageTexts.push(text);
  }

  return pageTexts.join("\n\n").replace(/\s+/g, " ").trim();
}

// ---------- load saved state on open ----------
async function loadSavedState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_API,
    STORAGE_KEY_RESUME,
  ]);

  const savedKey = stored[STORAGE_KEY_API];
  const savedResume = stored[STORAGE_KEY_RESUME];

  if (savedKey) {
    apiKeyInput.value = savedKey;
    setStatus(keyStatus, `Saved: ${maskKey(savedKey)}`, "ok");
  }

  if (savedResume?.filename) {
    const charCount = savedResume.text?.length || 0;
    setStatus(
      resumeStatus,
      `Saved: ${savedResume.filename} (${charCount.toLocaleString()} chars)`,
      "ok",
    );
  }

  updateAutofillEnabled(!!savedKey, !!savedResume?.text);
}

// ---------- save API key ----------
saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    setStatus(keyStatus, "Please paste a key first", "err");
    return;
  }
  if (!key.startsWith("sk-")) {
    setStatus(keyStatus, "Doesn't look like an OpenAI key (expected sk-...)", "err");
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY_API]: key });
  setStatus(keyStatus, `Saved: ${maskKey(key)}`, "ok");

  const stored = await chrome.storage.local.get(STORAGE_KEY_RESUME);
  updateAutofillEnabled(true, !!stored[STORAGE_KEY_RESUME]?.text);
});

// ---------- save resume: extract text from PDF, save text ----------
saveResumeBtn.addEventListener("click", async () => {
  const file = resumeFileInput.files?.[0];

  if (!file) {
    setStatus(resumeStatus, "Please choose a PDF first", "err");
    return;
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    setStatus(resumeStatus, "Only PDF files are supported", "err");
    return;
  }

  saveResumeBtn.disabled = true;
  setStatus(resumeStatus, "Extracting text…");

  let text;
  try {
    text = await extractPdfText(file);
  } catch (err) {
    console.error("[VibeApply] PDF parse failed", err);
    setStatus(resumeStatus, `Failed to read PDF: ${err.message}`, "err");
    saveResumeBtn.disabled = false;
    return;
  }

  if (!text || text.length < 50) {
    setStatus(
      resumeStatus,
      "Extracted text looks too short — is this a scanned/image PDF?",
      "err",
    );
    saveResumeBtn.disabled = false;
    return;
  }

  const resume = {
    filename: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    text, // raw extracted text — JSON parsing comes in Step 3
  };
  await chrome.storage.local.set({ [STORAGE_KEY_RESUME]: resume });

  console.log("[VibeApply] extracted resume text:", text.slice(0, 500) + "...");
  setStatus(
    resumeStatus,
    `Saved: ${file.name} (${text.length.toLocaleString()} chars)`,
    "ok",
  );

  saveResumeBtn.disabled = false;

  const stored = await chrome.storage.local.get(STORAGE_KEY_API);
  updateAutofillEnabled(!!stored[STORAGE_KEY_API], true);
});

// ---------- autofill button (wired in a later step) ----------
autofillBtn.addEventListener("click", () => {
  console.log("[VibeApply] autofill clicked — not wired yet");
});

// init
loadSavedState();
console.log("[VibeApply] popup ready");
