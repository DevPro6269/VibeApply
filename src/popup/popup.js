// Storage keys
const STORAGE_KEY_API = "vibeapply.apiKey";
const STORAGE_KEY_RESUME = "vibeapply.resume";

// AI config — Google Gemini
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_ENDPOINT = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

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
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function updateAutofillEnabled(keySet, resumeSet) {
  autofillBtn.disabled = !(keySet && resumeSet);
}

// ---------- PDF text + hyperlink extraction ----------
async function extractPdfText(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const pageTexts = [];
  const urls = new Set();

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    // visible text
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    pageTexts.push(text);

    // hyperlink annotations — PDF "LinkedIn" labels often hide the real URL
    const annotations = await page.getAnnotations();
    for (const ann of annotations) {
      if (ann.subtype === "Link" && ann.url) {
        urls.add(ann.url);
      }
    }
  }

  const cleanText = pageTexts.join("\n\n").replace(/\s+/g, " ").trim();
  const urlList = Array.from(urls);

  // Append URLs so the AI can see them. The prompt explains how to use them.
  return urlList.length > 0
    ? `${cleanText}\n\nHyperlinks found in PDF (use these as the actual URLs for matching labels in the text above):\n${urlList.join("\n")}`
    : cleanText;
}

// ---------- Gemini: resume text → structured JSON ----------
const RESUME_SYSTEM_INSTRUCTION = `You are a precise resume parser. You will be given raw text extracted from a resume PDF, sometimes followed by a list of hyperlinks found in the PDF. Your job is to convert it to STRICT JSON that matches the schema described in the user message.

Rules:
- Return JSON only. No prose, no markdown, no commentary.
- Use null for any field you cannot confidently determine.
- Do NOT invent information. If something is missing, use null.
- Dates: normalize to "YYYY-MM" when month is known, "YYYY" when only year is known, or "present" for current roles.
- Phone: keep the original formatting if reasonable.
- skills: a flat array of distinct technical skills/tools/languages (no soft skills).
- description fields: 1-3 sentences, summarizing key responsibilities & impact.

Links handling:
- The visible text may show "LinkedIn", "GitHub", "Portfolio" as labels — these are NOT URLs.
- Use the hyperlinks list at the bottom (if provided) to figure out the real URL for each label.
- Match: github.com URLs → links.github; linkedin.com → links.linkedin; personal sites → links.portfolio; anything else → links.other[].
- If no matching URL exists for a label, set that link to null.`;

const RESUME_USER_PROMPT_TEMPLATE = (resumeText) => `Extract this resume into JSON matching exactly this schema:

{
  "name": string,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "links": {
    "linkedin": string | null,
    "github": string | null,
    "portfolio": string | null,
    "other": string[]
  },
  "summary": string | null,
  "skills": string[],
  "work_experience": [
    {
      "company": string,
      "title": string,
      "location": string | null,
      "start_date": string,
      "end_date": string,
      "description": string | null
    }
  ],
  "education": [
    {
      "institution": string,
      "degree": string | null,
      "field": string | null,
      "start_date": string | null,
      "end_date": string | null,
      "gpa": string | null
    }
  ],
  "certifications": [
    {
      "name": string,
      "issuer": string | null,
      "date": string | null
    }
  ],
  "projects": [
    {
      "name": string,
      "description": string | null,
      "tech": string[],
      "url": string | null
    }
  ]
}

Resume text:
---
${resumeText}
---`;

async function parseResumeWithAI(resumeText, apiKey) {
  const response = await fetch(GEMINI_ENDPOINT(GEMINI_MODEL, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: RESUME_SYSTEM_INSTRUCTION }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: RESUME_USER_PROMPT_TEMPLATE(resumeText) }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 400) {
      throw new Error("Invalid request or API key (400)");
    }
    if (response.status === 403) {
      throw new Error("API key forbidden — check it's enabled for Gemini (403)");
    }
    if (response.status === 429) {
      throw new Error("Rate limit exceeded — wait a minute (429)");
    }
    throw new Error(`Gemini error ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = await response.json();
  const content = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) {
    throw new Error("Gemini returned no content");
  }

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error("Gemini returned invalid JSON: " + content.slice(0, 200));
  }
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
    setStatus(
      keyStatus,
      "Doesn't look like a Gemini key (expected AIza...)",
      "err",
    );
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
    data = await parseResumeWithAI(text, apiKey);
  } catch (err) {
    console.error("[VibeApply] AI parse failed", err);
    setStatus(resumeStatus, `AI parse failed: ${err.message}`, "err");
    saveResumeBtn.disabled = false;
    return;
  }

  const resume = {
    filename: file.name,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    text, // keep raw text as backup
    data, // structured JSON from AI
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

// ---------- autofill button (wired in a later step) ----------
autofillBtn.addEventListener("click", () => {
  console.log("[VibeApply] autofill clicked — not wired yet");
});

// init
loadSavedState();
console.log("[VibeApply] popup ready");
