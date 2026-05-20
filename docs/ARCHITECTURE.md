# Architecture

## System overview

A Chrome extension is three separate JavaScript contexts that communicate via messages. VibeApply uses all three:

```
┌──────────────────────────────────┐
│  POPUP                           │  src/popup/
│  - User UI: API key, resume      │  
│  - Calls Gemini for resume parse │
│  - Triggers START_AUTOFILL       │
└────────────────┬─────────────────┘
                 │ chrome.tabs.sendMessage / chrome.scripting.executeScript
                 ▼
┌──────────────────────────────────┐
│  CONTENT SCRIPT                  │  src/content/workday-filler.js
│  - Lives inside Workday page     │  + src/lib/gemini.js
│  - Field detection (DOM walker)  │
│  - AI mapping (Gemini)           │
│  - Filling (events, picker)      │
│  - MutationObserver autopilot    │
│  - Review modal + submit guard   │
└────────────────┬─────────────────┘
                 │ chrome.storage.local
                 ▼
┌──────────────────────────────────┐
│  BACKGROUND SERVICE WORKER       │  src/background/service-worker.js
│  - Currently minimal (logs only) │
└──────────────────────────────────┘
```

Shared state lives in `chrome.storage.local` so popup + content script see the same data:
- `vibeapply.apiKey` — Gemini API key
- `vibeapply.resume` — `{ filename, size, uploadedAt, text, data, pdfBase64 }`
- `vibeapply.profile` — Additional Info fields

## Modules (matches the assignment's required "Parser, Mapper, Filler, Navigator" architecture)

### 1. Parser
**Where:** `popup/popup.js` (`extractPdfText`) + `lib/gemini.js` (`parseResumeWithAI`)

**What it does:**
1. Reads the uploaded PDF as `ArrayBuffer`
2. Uses Mozilla **PDF.js** to extract visible text from each page
3. Also extracts hyperlink annotations (real URLs hidden under "LinkedIn" labels)
4. Sends raw text + URL list to Gemini with the resume parsing prompt
5. Receives structured JSON: `{ name, email, phone, location, links, summary, skills, work_experience, education, certifications, projects }`
6. Saves to `chrome.storage.local` along with the base64-encoded PDF (for re-upload to form file inputs)

### 2. Mapper
**Where:** `lib/gemini.js` (`mapFieldsWithAI`, `pickOptionWithAI`)

**What it does:**
1. Receives detected field descriptors + resume JSON + profile JSON
2. Sends to Gemini with the field-mapping prompt
3. Returns `{ fieldId: bestValueOrNull }` mapping
4. **Per-field fallback:** if local filler matching (exact / contains / abbreviation / hardcoded dictionary) fails on a dropdown, a second Gemini call (`pickOptionWithAI`) asks "given these on-screen options and this value, which one fits best?"

### 3. Filler
**Where:** `content/workday-filler.js` (`fillFields`, `fillOne` + type handlers)

**What it does:** turns mapped values into actual page interactions.

| Field type | Handler | Strategy |
|---|---|---|
| text / textarea | `setReactInputValue` | Native prototype setter + input/change/blur events |
| password / auth | (filtered out at detection) | Never filled |
| date (HTML5) | `formatDateForWorkday` | YYYY-MM-DD → MM/DD/YYYY |
| date (custom picker) | `fillWorkdayDatePicker` | Click trigger → navigate year arrows → click month |
| dropdown (native) | direct `value` set | Plus change event |
| dropdown (custom Workday) | `fillDropdown` | Click button → wait for popup → click matching option |
| checkbox | `fillCheckbox` | Click if state differs |
| radio | `fillRadio` | Find sibling by label, click |
| file | `fillFile` | DataTransfer-based PDF upload from `pdfBase64` |
| multi-value (Skills) | `fillMultiValue` | Type → wait → click matching checkbox option (or fall back to Enter for chip inputs) |

**Safeguards run before any value is typed:**
- URL fields: reject non-URLs, normalize `linkedin.com` → `www.linkedin.com`
- Date fields: reject implausibly old/future years, reject "To" that's before its corresponding "From"
- Resume-verification: refuse dates whose year doesn't match `resume.work_experience[occurrenceIndex]`
- Auth/honeypot: skipped at detection time
- Pre-filled: skip if `currentValue` is non-empty (assignment rule)

### 4. Navigator
**Where:** `content/workday-filler.js` (`startAutopilot`, `onPossibleStepChange`)

**What it does:** detects when Workday's React app swaps in a new application step and triggers another autofill cycle without user intervention.

1. After the first manual click of Autofill, the content script saves a *fingerprint* of all field labels for the current step:
   ```
   computeSignature(fields) = sorted "label#occurrenceIndex" tuples
   ```
2. Starts a `MutationObserver` on `document.body` (childList + subtree)
3. On each mutation, debounces 600ms then checks for transitions
4. Compares the new fingerprint to the old:
   - If at least one new fingerprint appears → new fields rendered → run another autofill cycle
   - Catches both full step transitions AND "Add Another" expansion of repeated sections
5. 2.5-second cooldown after each fill prevents our own DOM writes from triggering a loop
6. Detects extension reload (`chrome.runtime.id` undefined) → stops cleanly and shows a toast

## Data flow — one full autofill cycle

```
User clicks Autofill in popup
        ↓
Popup → chrome.tabs.sendMessage({type: "START_AUTOFILL"}) → content script
        ↓
Content script reads chrome.storage.local: apiKey + resume + profile
        ↓
Content script detects all fields on the page (DOM walker, ~15 selectors)
        ↓
Pre-expand custom dropdowns: click → read options → close (deduped per label)
        ↓
Content script POSTs to Gemini → { fieldId: value } mapping
        ↓
For each field in mapping:
   verify date against resume → skip / replace / ok
   ↓
   fillOne(element, meta, value) → React-safe event simulation
   ↓
   record in sessionHistory (for review modal)
        ↓
Show success toast: "filled X / Y fields"
        ↓
Start MutationObserver for next step
        ↓
... user clicks "Save and Continue" on Workday ...
        ↓
Observer fires → debounce → onPossibleStepChange → cycle repeats
        ↓
... eventually user clicks "Submit Application" ...
        ↓
Submit interceptor blocks the click (capture phase)
        ↓
Review modal renders sessionHistory grouped by step
        ↓
User clicks "Submit application" in our modal
        ↓
Original Submit button is marked approved and re-clicked
        ↓
Workday submits the application
```

## Storage schema

```jsonc
"vibeapply.apiKey": "AIza...",

"vibeapply.resume": {
  "filename": "dev-rathore-fixed.pdf",
  "size": 156789,
  "uploadedAt": "2026-05-19T18:30:00.000Z",
  "text": "Dev Rathore | dev@example.com | ...",   // raw extracted text
  "pdfBase64": "JVBERi0xLjQKJ...",                  // for resume upload
  "data": {                                          // structured JSON from Gemini
    "name": "Dev Rathore",
    "email": "devrathore653@gmail.com",
    "phone": "6269141202",
    "location": "Gwalior, M.P., India",
    "links": {
      "linkedin": "https://www.linkedin.com/in/dev-rathore-15299a201",
      "github": "https://github.com/DevPro6269",
      "portfolio": null,
      "other": []
    },
    "summary": "...",
    "skills": ["React", "Next.js", "Node.js", "..."],
    "work_experience": [
      { "company": "Sihari Labs", "title": "Founding Engineer", "start_date": "2025-06", "end_date": "present", "description": "...", "location": "Gwalior, India" },
      { "company": "Infotech Global Consultancy", "title": "Full Stack Developer Intern", "start_date": "2025-05", "end_date": "2025-07", ... }
    ],
    "education": [...],
    "certifications": [],
    "projects": [...]
  }
},

"vibeapply.profile": {
  "workAuthorization": "Authorized to work without sponsorship",
  "sponsorshipNeeded": "No",
  "noticePeriod": "Immediate",
  "expectedSalary": "Negotiable",
  "startDate": "Immediate",
  "howDidYouHear": "LinkedIn",
  "willingToRelocate": "Yes",
  "gender": "Male",
  "veteranStatus": "I am not a protected veteran",
  "disabilityStatus": "No, I do not have a disability"
}
```

## Why no bundler?

The extension uses **plain vanilla JavaScript** loaded via `<script>` tags. No webpack/vite/rollup. Reasons:

- Smaller deliverable — the reviewer can read every source file directly
- Faster iteration during development (no build step)
- No build artifacts to ship — just the source folder is the loadable extension

The only "library" loaded as a vendored asset is **PDF.js** (`vendor/pdfjs/`).

## Communication paths

| Source → Target | Mechanism | Use case |
|---|---|---|
| Popup → Content script | `chrome.tabs.sendMessage` | START_AUTOFILL, STOP_AUTOFILL |
| Popup → Page (cold start) | `chrome.scripting.executeScript` | Inject content script if not present |
| Content script ↔ Storage | `chrome.storage.local` | Read api key, resume, profile |
| Content script → Gemini | `fetch()` to `generativelanguage.googleapis.com` | Resume parse, field mapping, per-field option |
| Content script → Page | Direct DOM manipulation | Fill values, click pickers, intercept submit |
