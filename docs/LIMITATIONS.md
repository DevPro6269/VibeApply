# Known Limitations

Honest list of what VibeApply doesn't do well, and why.

## Workday tenant variability

Every Workday customer (NVIDIA, Netflix, PNC, Remitly, etc.) customizes their tenant. Field labels, dropdown options, page flow, and even DOM structure differ. VibeApply has been tested primarily against NVIDIA and a couple of others. Other tenants may have:

- Differently-named gender/race/veteran questions
- Different date widget implementations
- Differently-keyed `data-automation-id` values
- Custom multi-select widgets we haven't seen

When something doesn't fit our heuristics, the field is left blank rather than filled wrong — the user can correct it.

## Date fields

Workday's date inputs come in at least 3 shapes:
1. **HTML5 `<input type="date">`** — fully supported via direct value setting.
2. **Single text input with MM/YYYY mask + calendar icon** — supported via picker (`fillWorkdayDatePicker`) with arrow navigation and month click.
3. **Compound widget with separate Month / Year inputs** — partially supported. We attempt the picker; if that fails, we fall back to typing just the month or year digits.

**Known issue:** the picker UI's exact DOM (popup container, year display element, prev/next arrow buttons) varies between tenants. If `fillWorkdayDatePicker` can't find one of those elements, it throws and the field is left empty. The console shows the specific reason. Recovery: user fills the date manually.

**Hallucination guard:** even if Gemini returns a fictitious date, our filler:
- Refuses any year outside 1980 .. current+5 (catches `06/2006` for a 2025-era grad)
- Refuses any "To" earlier than its "From" within the same occurrence
- **Verifies** the AI's year against `resume.work_experience[occurrenceIndex].start_date` and skips if they don't match

So we either fill correctly or leave empty — we never type something inconsistent.

## File uploads

- Resume upload works through the `DataTransfer` + `change` event pattern. Tested on the standard "Drop files here / Select files" pattern.
- **Drag-and-drop-only zones** (no underlying `<input type="file">`) are not supported.
- Multiple file types (Resume + Cover Letter + Transcript) — we only upload to fields explicitly labeled as Resume / CV. The AI is instructed to return `null` for other document types.

## Authentication

Per the assignment's "must not bypass authentication" rule:
- Password fields are **never filled**
- Email fields **inside recognized auth forms** (sign-in / create account) are never filled
- 2FA / SMS codes are never touched
- User must complete sign-in / account creation manually

## Skills field — Workday taxonomy mismatch

Workday's Skills search uses Workday's own skill taxonomy. Typing "Express.js" might not match anything if Workday's catalog has it under "Express Framework" or similar. We try exact / startsWith / contains matching against the popup options. If no match, that one skill is skipped (others still fill).

## Multi-language / non-English Workday tenants

Tested only on English-language Workday tenants. Field detection relies on text labels in English ("From", "To", "Email", etc.). Labels in other languages won't match.

## Resume PDF formats

- **Text-based PDFs:** fully supported (PDF.js extracts text + hyperlinks).
- **Scanned PDFs (images):** not supported. We detect this and show an error: *"Extracted text looks too short — is this a scanned/image PDF?"*. The user would need to OCR the PDF first.

## Shadow DOM

Our DOM walker uses standard `querySelectorAll` which doesn't pierce shadow DOM. Workday currently doesn't use shadow DOM heavily, but if a tenant customizes with custom elements that do, those fields will be invisible to us.

## Rate limits

Gemini free tier:
- 15 requests / minute
- 1,500 requests / day

A 4-step application typically uses 5 calls (1 resume parse + 4 step mappings). You can do ~300 applications/day comfortably. Per-minute limits could be hit if you autofill aggressively across many tabs simultaneously — wait 60s if you see a 429.

## Refresh required after extension reload

Standard Chrome extension behavior: when you reload the extension at `chrome://extensions`, content scripts already injected in tabs become "orphaned" and can't talk to the new extension instance. VibeApply detects this (`chrome.runtime.id` undefined) and shows a clear toast: *"VibeApply was reloaded. Refresh this tab to continue."* User must Cmd+R the tab to resume.

## Things on purpose

These are conscious design decisions, not bugs:

- **No automatic submission** — assignment requires user confirmation via the review modal.
- **No clicking "Save and Continue"** between steps — keeps the user in control of workflow.
- **No filling of already-filled fields** — assignment rule + protects user's manual edits.
- **No filling of demographic fields without profile data** — picks "Decline to state" instead of guessing.

## Things that could improve with more time

- Sniff dropdown layout to handle picker variations (e.g., date pickers that use year *grids* instead of arrows).
- Heuristic-first matching for common dropdowns to avoid 1 AI call per dropdown.
- Visual highlighting of unfilled required fields in orange after each cycle.
- Per-tenant "tweak" modules — small adapters for specific company DOMs.
- Background sync of profile across devices (currently local-only).
