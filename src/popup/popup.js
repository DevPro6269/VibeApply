// Storage keys
const STORAGE_KEY_API = "vibeapply.openaiKey";
const STORAGE_KEY_RESUME = "vibeapply.resume";

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
    setStatus(resumeStatus, `Saved: ${savedResume.filename}`, "ok");
  }

  updateAutofillEnabled(!!savedKey, !!savedResume?.filename);
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
  updateAutofillEnabled(true, !!stored[STORAGE_KEY_RESUME]?.filename);
});

// ---------- save resume (stub: filename only for now) ----------
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

  // For now, save only filename + size. PDF parsing comes in the next step.
  const resumeMeta = {
    filename: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY_RESUME]: resumeMeta });

  setStatus(resumeStatus, `Saved: ${file.name}`, "ok");

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
