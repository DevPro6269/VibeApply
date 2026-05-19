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

// Generic Gemini JSON call — used by both resume parsing and field mapping.
async function geminiJsonCall({ apiKey, systemInstruction, userPrompt }) {
  const response = await fetch(GEMINI_ENDPOINT(GEMINI_MODEL, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 400) throw new Error("Invalid request or API key (400)");
    if (response.status === 403) throw new Error("API key forbidden — check it's enabled (403)");
    if (response.status === 429) throw new Error("Rate limit exceeded — wait a minute (429)");
    throw new Error(`Gemini error ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = await response.json();
  const content = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error("Gemini returned no content");

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error("Gemini returned invalid JSON: " + content.slice(0, 200));
  }
}

// ---------- Gemini: form fields + resume → { fieldId: value } ----------
const MAPPER_SYSTEM_INSTRUCTION = `You are a form-filling assistant for job applications. Given (1) a list of form fields detected on a job application page and (2) the candidate's structured resume, you must produce a JSON mapping of field IDs to the best value from the resume.

Rules:
- Return JSON only. No prose, no markdown.
- The output shape is exactly: { "<fieldId>": <value>, ... } — one entry per input field.
- For text/textarea fields: return a plain string suitable for that input. Use the resume value verbatim when possible.
- For dropdown fields: if "options" are provided, you MUST pick one of those exact option strings. Otherwise return the best match as a string.
- For date fields: return "YYYY-MM-DD". If only month is known, use day "01".
- For checkbox/radio fields: return either an exact option string from the field's options, or a boolean.
- For file fields: return null (we'll handle file upload separately).
- If no good match exists in the resume, return null for that field. NEVER invent data.
- Required fields ("required": true) deserve extra effort — still return null if no data exists, but make sure obvious matches are made.
- For open-ended questions (e.g. "Why are you a fit?", "Tell us about yourself"), generate a concise 2-3 sentence answer using the resume's summary/skills/experience. Be professional, no clichés.
- Skip fields whose label suggests they're for the next step / pagination (e.g. "Search", "Continue", "Next") — return null.

Field label normalization:
- "Given Name" / "Legal First Name" / "First Name" → resume.name (first token)
- "Family Name" / "Surname" / "Legal Last Name" / "Last Name" → resume.name (last token)
- "Preferred Name" → resume.name (first token, unless otherwise indicated)
- "Email" / "Email Address" → resume.email
- "Phone" / "Mobile" / "Phone Number" → resume.phone
- "Country" / "Country/Region" → infer from resume.location
- "City" / "State" / "Zip" → parse from resume.location
- "LinkedIn" / "LinkedIn URL" → resume.links.linkedin
- "GitHub" / "Personal Website" / "Portfolio" → resume.links.github / portfolio`;

function buildMapperPrompt(fields, resume) {
  const fieldDescriptors = fields.map((f) => ({
    id: f.id,
    label: f.label,
    type: f.type,
    required: f.required || false,
    ...(f.options?.length ? { options: f.options } : {}),
    ...(f.currentValue ? { currentValue: f.currentValue } : {}),
  }));

  return `Resume (structured JSON):
${JSON.stringify(resume, null, 2)}

Form fields on the current page (${fields.length} total):
${JSON.stringify(fieldDescriptors, null, 2)}

Return a JSON object mapping each field id to its best value. Example shape:
{
  "f0": "Pallavi",
  "f1": "Patel",
  "f2": "pallavipatel8080@gmail.com",
  "f3": null
}`;
}

async function mapFieldsWithAI(fields, resume, apiKey) {
  return await geminiJsonCall({
    apiKey,
    systemInstruction: MAPPER_SYSTEM_INSTRUCTION,
    userPrompt: buildMapperPrompt(fields, resume),
  });
}

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

// Send a message; if the content script isn't loaded yet, inject it and retry.
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
      files: ["src/content/workday-filler.js"],
    });

    // brief pause to let listeners attach
    await new Promise((r) => setTimeout(r, 100));

    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// ---------- autofill: detect → map → (next step) fill ----------
autofillBtn.addEventListener("click", async () => {
  const originalText = autofillBtn.textContent;
  autofillBtn.disabled = true;

  try {
    // 1. Tab check
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/myworkdayjobs\.com/.test(tab.url)) {
      alert("Open a Workday job application page first (a *.myworkdayjobs.com URL).");
      return;
    }

    // 2. Load saved resume + key
    const stored = await chrome.storage.local.get([STORAGE_KEY_API, STORAGE_KEY_RESUME]);
    const apiKey = stored[STORAGE_KEY_API];
    const resume = stored[STORAGE_KEY_RESUME]?.data;
    if (!apiKey) { alert("Save your Gemini API key first."); return; }
    if (!resume) { alert("Save your resume first."); return; }

    // 3. Detect fields
    autofillBtn.textContent = "Detecting fields…";
    const detectResponse = await sendToContentScript(tab.id, { type: "DETECT_FIELDS" });
    if (!detectResponse?.ok) {
      alert(`Field detection failed: ${detectResponse?.error || "no response"}`);
      return;
    }
    const fields = detectResponse.fields;
    console.log(`[VibeApply] detected ${fields.length} fields:`, fields);

    if (fields.length === 0) {
      alert("No fillable fields detected on this page. Are you on a sign-in/honeypot screen?");
      return;
    }

    // 4. AI map: fields + resume → { fieldId: value }
    autofillBtn.textContent = "Asking AI to map fields…";
    const mapping = await mapFieldsWithAI(fields, resume, apiKey);
    console.log("[VibeApply] AI mapping:", mapping);

    // 5. Fill: tell content script to apply the mapping to the page
    autofillBtn.textContent = "Filling fields…";
    const fillResponse = await sendToContentScript(tab.id, {
      type: "FILL_FIELDS",
      mapping,
    });

    if (!fillResponse?.ok) {
      alert(`Fill failed: ${fillResponse?.error || "no response"}`);
      return;
    }

    const results = fillResponse.results;
    const filled = results.filter((r) => r.status === "filled").length;
    const skippedNoValue = results.filter((r) => r.status === "skipped_no_value").length;
    const skippedPrefilled = results.filter((r) => r.status === "skipped_prefilled").length;
    const errors = results.filter((r) => r.status === "error");

    console.log("[VibeApply] fill summary:", { filled, skippedNoValue, skippedPrefilled, errors });

    let summary = `Filled ${filled} / ${results.length} fields.`;
    if (skippedPrefilled) summary += `\nSkipped (already filled): ${skippedPrefilled}`;
    if (skippedNoValue) summary += `\nSkipped (no resume data): ${skippedNoValue}`;
    if (errors.length) {
      summary += `\nErrors: ${errors.length} — see console`;
      console.warn("[VibeApply] errored fields:", errors);
    }
    alert(summary);
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
