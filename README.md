# VibeApply

**AI-powered Chrome extension for automated Workday job application filling.**

VibeApply parses your resume PDF into structured data using Gemini, then fills in Workday application forms across multiple steps with semantic AI-driven field mapping. Built for the assignment *"Advanced Job Application Automation for Workday (AI-Driven)."*

## Features

- 📄 **Resume parsing** — Upload a PDF, Gemini extracts a structured JSON (name, email, work history, education, skills, projects, hyperlinks).
- 🧠 **AI-driven field mapping** — For every form field, Gemini decides which resume value fits. Falls back to a per-field AI call when local matching fails.
- 🚀 **Multi-step autopilot** — A `MutationObserver` detects when Workday loads the next step and runs another autofill cycle automatically.
- 📋 **Workday widgets supported** — text/textarea, native + custom dropdowns, calendar-picker dates, file uploads, radios, checkboxes, chip/multi-select inputs.
- 🔁 **Repeatable sections** — "Add Another" experience/education blocks are detected via field fingerprinting and filled with `work_experience[N]` mapping.
- 👤 **Additional Info profile** — Configure work authorization, notice period, expected salary, gender, veteran status, etc. once; AI uses these for non-resume questions.
- ✅ **Review modal** — Submit button is intercepted; user sees every filled value grouped by step before confirming.
- 🛡️ **Safeguards** — Never autofills auth/honeypot fields, refuses inconsistent dates, validates URLs, deduplicates file uploads, never overwrites pre-filled data.

## Setup

### 1. Get a free Google Gemini API key

1. Go to https://aistudio.google.com/app/apikey
2. Sign in with a Google account
3. Click **"Create API key"** → "Create API key in new project"
4. Copy the key (starts with `AIza...`)

Free tier limits (more than enough for the assignment): 15 requests/min, 1,500 requests/day.

### 2. Install the extension

1. Clone or download this repository:
   ```bash
   git clone <repo-url>
   cd vibeapply
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Toggle **"Developer mode"** on (top right)
4. Click **"Load unpacked"**
5. Select the `vibeapply/` folder

The VibeApply extension card should appear with no errors.

> **Pin it to your toolbar** for easy access: click the puzzle icon in Chrome → pin **VibeApply**.

### 3. Configure inside the popup

1. Click the **VibeApply** icon
2. Paste your **Gemini API key** → click **Save**
3. Pick your **resume PDF** → click **Save**. The extension extracts text, sends it to Gemini, and saves the structured JSON.
4. (Optional but recommended) Expand **"Additional Info"** and fill in:
   - Work Authorization
   - Visa Sponsorship Needed
   - Notice Period
   - Expected Salary
   - Available Start Date
   - How Did You Hear About Us
   - Willing to Relocate
   - Gender / Veteran / Disability (privacy-respecting defaults applied if blank)

   Click **Save profile**.

Status indicators in the popup show what's saved.

## Usage

1. Open any Workday application page (`*.myworkdayjobs.com`). Example URLs:
   - https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/details/...
   - https://remitly.wd5.myworkdayjobs.com/en-US/Remitly_Careers/...
   - https://pnc.wd5.myworkdayjobs.com/en-US/External/...
   - https://netflix.wd108.myworkdayjobs.com/en-US/Netflix/...
2. Sign in or create a Workday account (per the assignment's *"must not bypass authentication"* rule — this step is manual).
3. Reach the application form (first step is usually name/contact/country).
4. Click the **VibeApply** icon → click **"Autofill current page"**.
5. Watch the page fill itself — you'll see toasts in the bottom-right reporting progress.
6. Click Workday's **"Save and Continue"** button. VibeApply auto-detects the new step and fills it automatically.
7. Repeat for each step.
8. On the final step, click Workday's **"Submit Application"** button.
9. VibeApply's **review modal** pops up with every value it filled, grouped by step. Click **"Submit application"** to confirm — VibeApply re-fires the submit click; Workday submits.

## Project structure

```
vibeapply/
├── manifest.json                # Manifest V3 extension config
├── src/
│   ├── popup/                   # Popup UI (HTML/CSS/JS)
│   ├── background/              # Service worker (currently minimal)
│   ├── content/
│   │   └── workday-filler.js    # Detection, AI orchestration, filling, observer, review modal
│   └── lib/
│       └── gemini.js            # Shared Gemini client + prompts (resume parser + field mapper + per-field option picker)
├── vendor/
│   └── pdfjs/                   # Mozilla PDF.js for in-browser PDF text extraction
├── docs/
│   ├── ARCHITECTURE.md
│   ├── AI_STRATEGY.md
│   └── LIMITATIONS.md
└── README.md
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system design, [`docs/AI_STRATEGY.md`](docs/AI_STRATEGY.md) for the prompt strategy, and [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) for known limitations.

## Tech stack

- **Manifest V3** Chrome extension (no bundler, plain vanilla JS)
- **Google Gemini 2.0 Flash** for resume parsing, field mapping, and per-field option matching
- **Mozilla PDF.js** for PDF text + hyperlink extraction
- **`MutationObserver`** for multi-step detection

## Privacy & security

- Your API key is stored in `chrome.storage.local` — never sent anywhere except `generativelanguage.googleapis.com`.
- Your resume PDF + parsed JSON also stay in `chrome.storage.local`.
- No backend, no analytics, no third-party scripts.
- Password fields and recognized auth forms are explicitly ignored.

## License

For assignment evaluation. Not for redistribution.
