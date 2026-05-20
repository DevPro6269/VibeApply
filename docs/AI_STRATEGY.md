# AI Prompting Strategy

## Why Gemini?

- Free tier with generous limits (15 RPM, 1,500 RPD) — covers the entire assignment workload.
- Strict **JSON mode** (`responseMimeType: "application/json"`) eliminates parsing errors.
- `gemini-2.0-flash` is fast enough for live form interaction (~1-2 s per call).
- API shape is similar enough to OpenAI that a future provider swap is one file.

## Three distinct AI calls

VibeApply makes three different kinds of Gemini calls. Each is in `src/lib/gemini.js`.

### Call 1 — Resume → JSON (one-time, at upload)

**Function:** `parseResumeWithAI(resumeText, apiKey)`

**Input:** raw text from the PDF, optionally followed by a list of hyperlink URLs found in the PDF's annotations:
```
Dev Rathore | 6269141202 | devrathore653@gmail.com | linkedin.com/in/dev-rathore-15299a201 ...

Hyperlinks found in PDF (use these as the actual URLs for matching labels in the text above):
https://www.linkedin.com/in/dev-rathore-15299a201
https://github.com/DevPro6269
```

**Output:** strict JSON matching the schema embedded in the prompt (name, email, phone, location, links, summary, skills, work_experience[], education[], certifications[], projects[]).

**Key prompt decisions:**

| Decision | Why |
|---|---|
| `temperature: 0` | Deterministic; resumes shouldn't be "creative." |
| JSON mode | Guarantees valid JSON without `\`\`\`json` markdown fences. |
| Schema embedded in the user prompt | The model reads it adjacent to the task; we don't rely on `responseSchema`. |
| Hyperlink list appended after raw text | PDF text says "LinkedIn" / "GitHub" as labels; real URLs are hidden in annotations. We extract both and let the AI match labels → URLs. |
| Explicit rules: "Use null if missing", "Never invent" | Resumes vary; hallucinated phone numbers are worse than null. |
| Date normalization rule (`YYYY-MM`, `YYYY`, `"present"`) | One canonical form makes downstream date handling simpler. |

### Call 2 — Fields → Mapping (per autofill cycle)

**Function:** `mapFieldsWithAI(fields, resume, profile, apiKey)`

**Input:** a list of detected field descriptors + the structured resume JSON + the user's profile JSON.

Each field descriptor includes:
```jsonc
{
  "id": "f5",
  "label": "Given Name",                  // resolved from aria/label/<label for>/etc.
  "type": "text",
  "required": true,
  "context": "What is your gender?",      // only when label is generic
  "occurrenceIndex": 1,                   // for repeatable sections (work_experience[1])
  "placeholder": "MM/YYYY",               // hint for date format
  "options": ["BTECH", "MTECH", "MCA"],   // pre-expanded from Workday's custom dropdowns
  "currentValue": ""                      // skip if non-empty
}
```

**Output:** `{ "f5": "Dev", "f6": "Rathore", "f7": null, ... }`.

**Key prompt decisions:**

| Decision | Why |
|---|---|
| Field-label normalization table | "Given Name" / "Legal First Name" all → resume.name first token. Saves us from training the model. |
| Profile fields explicitly listed | The AI gets the same vocabulary the popup uses, so semantic matching works. |
| `context` field for generic labels | Workday uses "Please Select One" labels with the real question in a heading. We surface it. |
| `occurrenceIndex` for repeatable sections | "Company" occurrence 0 = `work_experience[0]`. Without this, the AI would map all "Company" fields to the most recent job. |
| `options` array sent when known | For dropdowns where we successfully pre-expanded the popup. AI MUST pick one of these strings verbatim. |
| Aggressive null-return rules | "Never invent dates / addresses / identity numbers. Better to leave 10 fields null than invent one wrong." |
| ABSOLUTE-rules section for date fields | Repeated trial-and-error showed Gemini Flash sometimes hallucinated job dates. The strongest framing was "ABSOLUTE RULES" + explicit examples. |
| URL fields require `https://` + `www.linkedin.com` | Workday's LinkedIn validation is strict. |
| Multi-value rule for "Skills" / "Languages" | Return a JSON array of strings, capped at ~10, using common public-taxonomy names ("JavaScript" not "JS / ES6+"). |
| Sensitive-question rule | If profile has the value, use it; otherwise pick "Decline to state" / "Prefer not to answer". Never invent demographics. |

### Call 3 — Per-field Option Picker (fallback)

**Function:** `pickOptionWithAI(value, options, context, apiKey)`

When the Filler is about to type a value into a dropdown and **local matching (exact / contains / abbreviation / hardcoded dictionary) fails**, we ask Gemini specifically: "given these on-screen option strings and this candidate value, which one fits best?"

Example:
```
Field context: field label: "Degree"
Value the candidate gave: "Bachelor of Technology in Computer Science & Engineering"

Available options:
- "Post-diploma studies"
- "BTECH"
- "MTECH"
- "MCA"
- "University Diploma"

Pick the best matching option. Return JSON: { "choice": "..." } or { "choice": null }.
```

**Output:** `{ "choice": "BTECH" }` (or `null`).

Why a second AI call? Workday's option lists are often abbreviated, regional, or weirdly worded ("BTECH" not "B.Tech."). A small focused call with the actual option text in context performs much better than trying to predict all possible Workday catalogs in the main mapping call.

## Defense in depth — why the AI's answer isn't blindly trusted

The Filler validates every value before typing. AI mistakes get caught here:

1. **URL fields:** must look like a URL (`https://...` or `domain.tld/...`). Normalized to include `www.` for LinkedIn.
2. **Date fields:**
   - Year must be between 1980 and current+5 (catches `06/2006` for a 2025 graduate)
   - "To" must be ≥ "From" within the same `occurrenceIndex` (catches inconsistent pairs)
   - **Verified against the resume:** if AI's year doesn't match `resume.work_experience[occ].start_date`'s year → refused
   - "Present" / "Current" → never typed into a date picker (left for "I currently work here" checkbox)
3. **Pre-filled fields:** never overwritten if `currentValue` is non-empty
4. **Auth fields:** password inputs and email inputs inside `signIn` / `createAccount` automation IDs are skipped at detection
5. **Honeypots:** fields with `aria-label="for robots only"` or `tabindex=-1` are skipped

This means even when Gemini hallucinates, the form stays clean — bad values get logged in the fill results with an `error` status and the field stays empty for the user to fill manually.

## What we don't ask the AI to do

- Decide whether to submit. The user always confirms via the review modal.
- Click "Save and Continue" between steps. The user moves through the form; we only detect transitions.
- Fill auth/login forms. Hard rule.
- Choose race/ethnicity unless explicitly in the profile.

## Prompt sizes and costs

| Call | Input tokens | Output tokens | Cost (Gemini Flash 2.0) |
|---|---|---|---|
| Resume parse | ~1,500 (1-2 page PDF) | ~800 | ~$0 (free tier) |
| Field mapping per step | ~1,000 + ~50/field | ~50/field | ~$0 |
| Per-field option pick | ~200 | ~30 | ~$0 |

A typical 4-step application = 5 Gemini calls total. Free tier is 1,500 calls/day.

## Things tried that didn't work, and why

- **JSON-schema strict mode (Gemini's `responseSchema`):** Worked but reduced output quality on edge cases. Sticking with plain `responseMimeType: "application/json"` + schema-in-prompt.
- **Single AI call per field:** Was 20× the API cost and had inconsistent global decisions. Batch mapping is cleaner.
- **Telling AI to NEVER fill demographics:** Too aggressive — left required fields blank, blocking the user. Replaced with "use profile if available, else pick Decline to state."
- **Heuristic-only field matching:** Worked for ~40% of fields. The AI layer brought it to ~90%. We kept the heuristics as a fast path *before* the AI call.
