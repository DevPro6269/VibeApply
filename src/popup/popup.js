// Storage keys
const STORAGE_KEY_API = "vibeapply.apiKey";
const STORAGE_KEY_RESUME = "vibeapply.resume";
const STORAGE_KEY_PROFILE = "vibeapply.profile";

const PROFILE_FIELDS = [
  "workAuthorization",
  "sponsorshipNeeded",
  "noticePeriod",
  "expectedSalary",
  "startDate",
  "howDidYouHear",
  "willingToRelocate",
  "gender",
  "veteranStatus",
  "disabilityStatus",
];

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

const profileStatus = document.getElementById("profileStatus");
const saveProfileBtn = document.getElementById("saveProfileBtn");
const profileInputs = Object.fromEntries(
  PROFILE_FIELDS.map((key) => [key, document.getElementById(key)])
);

// ---------- helpers ----------
function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function updateAutofillEnabled(keySet, resumeSet) {
  autofillBtn.disabled = !(keySet && resumeSet);
}

// Read a file as base64 (without the data: prefix). Used to persist the PDF
// for later upload to Workday "Upload Resume" fields.
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------- PDF text + hyperlink extraction ----------
async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const pageTexts = [];
  const urls = new Set();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    pageTexts.push(text);

    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      if (ann.subtype === "Link" && ann.url) {
        urls.add(ann.url);
      }
    }
  }

  const cleanText = pageTexts.join("\n\n").replace(/\s+/g, " ").trim();
  const urlList = Array.from(urls);

  return urlList.length > 0
    ? `${cleanText}\n\nHyperlinks found in PDF (use these as the actual URLs for matching labels in the text above):\n${urlList.join("\n")}`
    : cleanText;
}

// ---------- content-script messaging ----------
async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const msg = String(err?.message || err);
    const looksMissing =
      msg.includes("Could not establish connection") ||
      msg.includes("Receiving end does not exist");
    if (!looksMissing) throw err;

    console.log("[VibeApply] content script not present, injecting…");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/lib/gemini.js", "src/content/workday-filler.js"],
    });

    await new Promise((r) => setTimeout(r, 100));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// ---------- profile helpers ----------
function readProfileFromUI() {
  const profile = {};
  for (const key of PROFILE_FIELDS) {
    const value = profileInputs[key].value.trim();
    if (value) profile[key] = value;
  }
  return profile;
}

function applyProfileToUI(profile) {
  for (const key of PROFILE_FIELDS) {
    if (profile?.[key] != null) profileInputs[key].value = profile[key];
  }
}

function updateProfileStatus(profile) {
  const filled = Object.values(profile || {}).filter(Boolean).length;
  profileStatus.textContent = `${filled} / ${PROFILE_FIELDS.length} filled`;
  profileStatus.classList.toggle("ok", filled > 0);
}

saveProfileBtn.addEventListener("click", async () => {
  const profile = readProfileFromUI();
  await chrome.storage.local.set({ [STORAGE_KEY_PROFILE]: profile });
  updateProfileStatus(profile);
  saveProfileBtn.textContent = "Saved ✓";
  setTimeout(() => (saveProfileBtn.textContent = "Save profile"), 1200);
});

// ---------- load saved state on open ----------
async function loadSavedState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_API,
    STORAGE_KEY_RESUME,
    STORAGE_KEY_PROFILE,
  ]);

  const savedKey = stored[STORAGE_KEY_API];
  const savedResume = stored[STORAGE_KEY_RESUME];
  const savedProfile = stored[STORAGE_KEY_PROFILE];

  if (savedKey) {
    apiKeyInput.value = savedKey;
    setStatus(keyStatus, `Saved: ${maskKey(savedKey)}`, "ok");
  }

  if (savedResume?.data) {
    const name = savedResume.data.name || "(no name)";
    const jobs = savedResume.data.work_experience?.length || 0;
    const projects = savedResume.data.projects?.length || 0;
    const skills = savedResume.data.skills?.length || 0;
    setStatus(
      resumeStatus,
      `Saved: ${name} — ${jobs} jobs, ${projects} projects, ${skills} skills`,
      "ok",
    );
  }

  if (savedProfile) {
    applyProfileToUI(savedProfile);
    updateProfileStatus(savedProfile);
  } else {
    updateProfileStatus({});
  }

  updateAutofillEnabled(!!savedKey, !!savedResume?.data);
}

// ---------- save API key ----------
saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    setStatus(keyStatus, "Please paste a key first", "err");
    return;
  }
  if (!key.startsWith("AIza")) {
    setStatus(keyStatus, "Doesn't look like a Gemini key (expected AIza...)", "err");
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY_API]: key });
  setStatus(keyStatus, `Saved: ${maskKey(key)}`, "ok");

  const stored = await chrome.storage.local.get(STORAGE_KEY_RESUME);
  updateAutofillEnabled(true, !!stored[STORAGE_KEY_RESUME]?.data);
});

// ---------- save resume: extract text → AI parse → save JSON ----------
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

  const stored = await chrome.storage.local.get(STORAGE_KEY_API);
  const apiKey = stored[STORAGE_KEY_API];
  if (!apiKey) {
    setStatus(resumeStatus, "Save your Gemini API key first", "err");
    return;
  }

  saveResumeBtn.disabled = true;
  setStatus(resumeStatus, "Extracting text from PDF…");

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

  setStatus(resumeStatus, "Asking Gemini to structure your resume…");

  let data;
  try {
    data = await VIBEAPPLY_GEMINI.parseResumeWithAI(text, apiKey);
  } catch (err) {
    console.error("[VibeApply] AI parse failed", err);
    setStatus(resumeStatus, `AI parse failed: ${err.message}`, "err");
    saveResumeBtn.disabled = false;
    return;
  }

  // Persist the raw PDF bytes too, so the filler can re-upload it later.
  let pdfBase64;
  try {
    pdfBase64 = await fileToBase64(file);
  } catch (err) {
    console.warn("[VibeApply] could not encode PDF for storage", err);
  }

  const resume = {
    filename: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    text,
    data,
    pdfBase64,
  };
  await chrome.storage.local.set({ [STORAGE_KEY_RESUME]: resume });

  console.log("[VibeApply] parsed resume:", data);

  const name = data.name || "(no name)";
  const jobs = data.work_experience?.length || 0;
  const projects = data.projects?.length || 0;
  const skills = data.skills?.length || 0;
  setStatus(
    resumeStatus,
    `Saved: ${name} — ${jobs} jobs, ${projects} projects, ${skills} skills`,
    "ok",
  );

  saveResumeBtn.disabled = false;
  updateAutofillEnabled(true, true);
});

// ---------- autofill: trigger autopilot in the content script ----------
autofillBtn.addEventListener("click", async () => {
  const originalText = autofillBtn.textContent;
  autofillBtn.disabled = true;
  autofillBtn.textContent = "Starting autofill…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/myworkdayjobs\.com/.test(tab.url)) {
      alert("Open a Workday job application page first (a *.myworkdayjobs.com URL).");
      return;
    }

    const response = await sendToContentScript(tab.id, { type: "START_AUTOFILL" });

    if (!response?.ok) {
      alert(`Autofill failed: ${response?.error || "no response"}`);
      return;
    }

    const r = response.summary;
    console.log("[VibeApply] first-step summary:", r);

    let msg = `First step done. Filled ${r.filled} / ${r.total} fields.`;
    if (r.skippedPrefilled) msg += `\nSkipped (already filled): ${r.skippedPrefilled}`;
    if (r.skippedNoValue) msg += `\nSkipped (no resume data): ${r.skippedNoValue}`;
    if (r.errors) msg += `\nErrors: ${r.errors} — see console`;
    msg += `\n\nAutopilot is now active. Click "Save & Continue" on Workday — the next step will auto-fill within ~1 second.`;
    alert(msg);
  } catch (err) {
    console.error("[VibeApply] autofill error", err);
    alert(`Error: ${err.message}`);
  } finally {
    autofillBtn.disabled = false;
    autofillBtn.textContent = originalText;
  }
});

// init
loadSavedState();
console.log("[VibeApply] popup ready");
