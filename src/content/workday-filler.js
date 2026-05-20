console.log("[VibeApply] content script injected on", window.location.href);

// Module-level cache of last detected fields, indexed by id.
// Keeps element refs (which can't cross the message boundary).
let lastDetected = new Map(); // fieldId -> { meta, element }

// Autopilot state — tracks the multi-step session
const autopilot = {
  active: false,
  observer: null,
  lastSignature: "",
  cooldownUntil: 0,
  debounceTimer: null,
  cycleInFlight: false,
};

// ===========================================================================
// Message listener — entry point for popup → content script communication
// ===========================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "START_AUTOFILL") {
    startAutofill()
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => {
        console.error("[VibeApply] start autofill failed", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg?.type === "STOP_AUTOFILL") {
    stopAutopilot();
    sendResponse({ ok: true });
    return false;
  }
});

// ===========================================================================
// Autofill cycle: detect → AI map → fill → observe for next step
// ===========================================================================

async function startAutofill() {
  showToast("VibeApply: starting…", "info");

  const summary = await runAutofillCycle();

  // Start the observer so subsequent step transitions are auto-handled
  startAutopilot();

  return summary;
}

async function runAutofillCycle() {
  if (autopilot.cycleInFlight) {
    console.log("[VibeApply] cycle already in flight, skipping");
    return { filled: 0, total: 0, skippedNoValue: 0, skippedPrefilled: 0, errors: 0 };
  }
  autopilot.cycleInFlight = true;

  try {
    // 1. Read credentials + resume + profile from storage
    const stored = await chrome.storage.local.get([
      "vibeapply.apiKey",
      "vibeapply.resume",
      "vibeapply.profile",
    ]);
    const apiKey = stored["vibeapply.apiKey"];
    const resume = stored["vibeapply.resume"]?.data;
    const profile = stored["vibeapply.profile"] || {};

    if (!apiKey) throw new Error("No API key saved");
    if (!resume) throw new Error("No resume saved");

    // 2. Detect fields on the current page
    const fields = detectFields();
    if (fields.length === 0) {
      showToast("VibeApply: no fillable fields on this step", "info");
      return { filled: 0, total: 0, skippedNoValue: 0, skippedPrefilled: 0, errors: 0 };
    }

    // 3. Record signature so the observer can detect transitions
    autopilot.lastSignature = computeSignature(fields);

    // 4. AI map: fields + resume + profile → { fieldId: value }
    showToast(`VibeApply: mapping ${fields.length} fields with AI…`, "info");
    const mapping = await VIBEAPPLY_GEMINI.mapFieldsWithAI(
      fields,
      resume,
      profile,
      apiKey,
    );
    console.log("[VibeApply] AI mapping:", mapping);

    // 5. Fill
    const results = await fillFields(mapping);
    console.log("[VibeApply] fill results:", results);

    const filled = results.filter((r) => r.status === "filled").length;
    const skippedNoValue = results.filter((r) => r.status === "skipped_no_value").length;
    const skippedPrefilled = results.filter((r) => r.status === "skipped_prefilled").length;
    const errors = results.filter((r) => r.status === "error").length;

    showToast(`VibeApply: filled ${filled} / ${results.length} fields ✓`, "success");

    // Cooldown — prevents our own fill events from triggering a "new step" detection
    autopilot.cooldownUntil = Date.now() + 2500;

    return { filled, total: results.length, skippedNoValue, skippedPrefilled, errors };
  } finally {
    autopilot.cycleInFlight = false;
  }
}

// ===========================================================================
// MutationObserver — watches for new application steps
// ===========================================================================

function startAutopilot() {
  if (autopilot.observer) autopilot.observer.disconnect();
  autopilot.active = true;

  autopilot.observer = new MutationObserver(() => {
    if (!autopilot.active) return;
    if (Date.now() < autopilot.cooldownUntil) return;
    if (autopilot.cycleInFlight) return;

    clearTimeout(autopilot.debounceTimer);
    autopilot.debounceTimer = setTimeout(onPossibleStepChange, 600);
  });

  autopilot.observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log("[VibeApply] autopilot observer started");
}

function stopAutopilot() {
  autopilot.active = false;
  if (autopilot.observer) {
    autopilot.observer.disconnect();
    autopilot.observer = null;
  }
  clearTimeout(autopilot.debounceTimer);
  console.log("[VibeApply] autopilot stopped");
}

async function onPossibleStepChange() {
  if (!autopilot.active) return;
  if (autopilot.cycleInFlight) return;
  if (Date.now() < autopilot.cooldownUntil) return;

  const fields = detectFields();
  if (fields.length === 0) return; // not a meaningful step

  const sig = computeSignature(fields);
  if (sig === autopilot.lastSignature) return;

  // Trigger if there's at least one NEW fingerprint we haven't seen.
  // This catches both: (a) "Add Another" → new repeated-section fields, and
  // (b) full step transitions → almost all fingerprints are new.
  if (autopilot.lastSignature) {
    const oldFps = new Set(autopilot.lastSignature.split("||"));
    const newFps = sig.split("||");
    const hasNewFingerprint = newFps.some((fp) => !oldFps.has(fp));
    if (!hasNewFingerprint) return;
  }

  console.log("[VibeApply] new fields/step detected — running autofill cycle");

  try {
    await runAutofillCycle();
  } catch (err) {
    console.error("[VibeApply] autopilot cycle error", err);
    showToast(`VibeApply: ${err.message}`, "error");
  }
}

function computeSignature(fields) {
  // Each fingerprint is `${label}#${occurrenceIndex}` so a second "Company"
  // field is distinct from the first — required to detect "Add Another" clicks.
  return fields
    .map((f) => `${f.label}#${f.occurrenceIndex ?? 0}`)
    .sort()
    .join("||");
}

// ===========================================================================
// On-page toast notifications
// ===========================================================================

function showToast(message, kind = "info") {
  let toast = document.getElementById("vibeapply-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "vibeapply-toast";
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      padding: 12px 18px;
      color: white;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      transition: opacity 0.25s, transform 0.25s;
      max-width: 320px;
      pointer-events: none;
    `;
    document.body.appendChild(toast);
  }
  const colors = {
    info: "#0969da",
    success: "#1f883d",
    error: "#cf222e",
  };
  toast.style.background = colors[kind] || colors.info;
  toast.textContent = message;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
  }, 3500);
}

// ===========================================================================
// Field detection
// ===========================================================================

function detectFields() {
  lastDetected.clear();

  // Selector strategy: cover all common Workday interactive controls
  const selector = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
    "select",
    "textarea",
    'button[aria-haspopup="listbox"]',
    '[role="combobox"]',
    '[role="textbox"][contenteditable="true"]',
  ].join(",");

  const elements = Array.from(document.querySelectorAll(selector));

  const fields = [];
  let counter = 0;
  const labelCounts = new Map(); // for occurrenceIndex

  for (const el of elements) {
    // File inputs are often hidden behind a styled button — include them anyway.
    const isFile =
      el.tagName.toLowerCase() === "input" && el.type === "file";

    if (!isFile && !isVisible(el)) continue;
    if (isInsideHeader(el)) continue; // skip search bars in nav etc.
    if (isAuthField(el)) continue; // never fill auth fields — assignment rule
    if (isHoneypot(el)) continue; // never fill bot traps

    const type = classifyField(el);
    if (!type) continue;

    let label = resolveLabel(el);
    if (!label && isFile) label = resolveFileInputLabel(el);
    if (!label) continue; // unlabeled fields are unreliable to fill

    // occurrenceIndex: how many fields with this exact label came before.
    // Used so the AI can map repeated fields → resume.work_experience[idx].
    const occurrenceIndex = labelCounts.get(label) || 0;
    labelCounts.set(label, occurrenceIndex + 1);

    const placeholder =
      el.getAttribute("placeholder") ||
      el.getAttribute("aria-placeholder") ||
      null;

    const field = {
      id: `f${counter++}`,
      label,
      type,
      occurrenceIndex,
      automationId:
        el.getAttribute("data-automation-id") ||
        el.closest("[data-automation-id]")?.getAttribute("data-automation-id") ||
        null,
      currentValue: getCurrentValue(el),
      required: isRequired(el),
      ...(placeholder ? { placeholder } : {}),
    };

    // For dropdowns/radios, capture the options
    if (type === "dropdown" || type === "radio" || type === "checkbox-group") {
      field.options = getOptions(el, type);
    }

    fields.push(field);
    lastDetected.set(field.id, { meta: field, element: el });
  }

  return fields;
}

// ===========================================================================
// Helpers
// ===========================================================================

function isVisible(el) {
  if (!el || el.offsetParent === null) {
    // offsetParent=null means display:none, fixed positioning, or detached
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
  }
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (parseFloat(style.opacity) === 0) return false;
  return true;
}

function isInsideHeader(el) {
  // Workday job pages have a search input in the top nav — skip it
  return !!el.closest("header, nav, [role='banner']");
}

function isAuthField(el) {
  // Never fill password fields, account creation fields, or 2FA codes —
  // the assignment forbids bypassing auth.
  const tag = el.tagName.toLowerCase();
  if (tag === "input" && (el.type === "password" || el.type === "email")) {
    // Only skip email/password if they're inside a recognizable auth form
    const inAuthForm = !!el.closest(
      "form[action*='login'], form[action*='signin'], form[action*='register'], " +
      "[data-automation-id*='signIn'], [data-automation-id*='createAccount'], " +
      "[data-automation-id*='auth']"
    );
    if (el.type === "password") return true; // always skip passwords
    if (inAuthForm) return true;
  }
  return false;
}

function isHoneypot(el) {
  // Workday's bot traps: visible label says "for robots only" / "do not enter"
  // or the field has tabindex=-1 / autocomplete=off + hidden-ish styling.
  const label = (el.getAttribute("aria-label") || "").toLowerCase();
  const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
  const combined = label + " " + placeholder;
  if (
    combined.includes("for robots") ||
    combined.includes("do not enter") ||
    combined.includes("leave blank") ||
    combined.includes("anti-spam")
  ) {
    return true;
  }
  // Honeypots often have tabindex=-1 to keep keyboard users away
  if (el.getAttribute("tabindex") === "-1") return true;
  return false;
}

function classifyField(el) {
  const tag = el.tagName.toLowerCase();

  if (tag === "select") return "dropdown";
  if (tag === "textarea") return "textarea";
  if (tag === "button") {
    const haspopup = el.getAttribute("aria-haspopup");
    if (haspopup === "listbox" || haspopup === "menu") return "dropdown";
    return null;
  }

  // role-based detection (Workday uses these heavily)
  const role = el.getAttribute("role");
  if (role === "combobox") return "dropdown";
  if (role === "textbox") return "text";

  if (tag === "input") {
    const inputType = (el.type || "text").toLowerCase();
    switch (inputType) {
      case "text":
      case "email":
      case "tel":
      case "url":
      case "number":
      case "search":
        return "text";
      case "password":
        return "password";
      case "date":
      case "month":
        return "date";
      case "file":
        return "file";
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      default:
        return "text";
    }
  }

  return null;
}

function resolveLabel(el) {
  // Strategy 1: aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const text = ids
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
      .trim();
    if (text) return cleanLabel(text);
  }

  // Strategy 2: aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return cleanLabel(ariaLabel);

  // Strategy 3: explicit <label for="...">
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent) return cleanLabel(label.textContent);
  }

  // Strategy 4: parent <label>
  const parentLabel = el.closest("label");
  if (parentLabel?.textContent) return cleanLabel(parentLabel.textContent);

  // Strategy 5: nearest preceding label-like element in the same field container
  const container = el.closest(
    "[data-automation-id], .field, .form-group, fieldset, div"
  );
  if (container) {
    const labelEl = container.querySelector("label");
    if (labelEl?.textContent) return cleanLabel(labelEl.textContent);
  }

  // Strategy 6: data-automation-id as a last resort
  const automationId =
    el.getAttribute("data-automation-id") ||
    el.closest("[data-automation-id]")?.getAttribute("data-automation-id");
  if (automationId) return humanizeId(automationId);

  // Strategy 7: placeholder
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return cleanLabel(placeholder);

  return null;
}

function cleanLabel(text) {
  return text
    .replace(/\*/g, "") // required asterisks
    .replace(/\s+/g, " ")
    .replace(/\(required\)/i, "")
    .trim();
}

function humanizeId(id) {
  // "legalNameSection_firstName" → "Legal Name Section First Name"
  return id
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

// File inputs are usually invisible, with a styled <button> or <label> nearby
// that triggers the picker. Look for the visible proxy text.
function resolveFileInputLabel(el) {
  const container = el.closest(
    "[data-automation-id], .file-upload, .upload, .drop-zone, fieldset, div"
  );
  if (!container) return null;

  // Prefer a button/heading/label with short text
  const proxy = container.querySelector(
    "button, [role='button'], h1, h2, h3, h4, label, [class*='label']"
  );
  if (proxy?.textContent) {
    const text = proxy.textContent.replace(/\s+/g, " ").trim();
    if (text.length > 0 && text.length < 80) return text;
  }

  // Fall back to first text node in the container
  const text = container.textContent?.replace(/\s+/g, " ").trim();
  if (text && text.length < 120) return text;

  return null;
}

function getCurrentValue(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return el.value || "";
  }
  if (tag === "textarea" || tag === "select") return el.value || "";
  return el.textContent?.trim() || "";
}

function isRequired(el) {
  return (
    el.required ||
    el.getAttribute("aria-required") === "true" ||
    !!el.closest("[aria-required='true']")
  );
}

function getOptions(el, type) {
  const tag = el.tagName.toLowerCase();

  if (tag === "select") {
    return Array.from(el.options).map((o) => o.textContent.trim()).filter(Boolean);
  }

  if (type === "radio" || type === "checkbox-group") {
    // Find siblings with the same name attribute
    const name = el.getAttribute("name");
    if (!name) return [];
    const group = Array.from(
      document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)
    );
    return group
      .map((opt) => {
        const optLabel = resolveLabel(opt);
        return optLabel;
      })
      .filter(Boolean);
  }

  // Workday custom dropdowns — options only render after the button is clicked.
  // For now return empty; we'll click-and-read in the filler step.
  return [];
}

// ===========================================================================
// Filler
// ===========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fillFields(mapping) {
  const results = [];

  for (const [id, entry] of lastDetected) {
    const { meta, element } = entry;
    const value = mapping[id];

    if (value === null || value === undefined || value === "") {
      results.push({ id, label: meta.label, status: "skipped_no_value" });
      continue;
    }

    // Don't overwrite valid pre-filled data (assignment rule)
    if (
      meta.currentValue &&
      typeof meta.currentValue === "string" &&
      meta.currentValue.trim() !== "" &&
      meta.currentValue !== "Select One" &&
      meta.currentValue !== "Search"
    ) {
      results.push({ id, label: meta.label, status: "skipped_prefilled" });
      continue;
    }

    try {
      await fillOne(element, meta, value);
      results.push({ id, label: meta.label, status: "filled", value: String(value) });
    } catch (err) {
      console.warn(`[VibeApply] failed to fill ${meta.label}:`, err);
      results.push({ id, label: meta.label, status: "error", error: err.message });
    }

    // Tiny pause so React/Workday processes between fills
    await sleep(50);
  }

  return results;
}

async function fillOne(el, meta, value) {
  // Defensive: if the field looks like a URL field, refuse to type a non-URL value.
  // Prevents Workday from rejecting our autofill with "Invalid LinkedIn URL" etc.
  if (looksLikeUrlField(meta) && !looksLikeUrl(value)) {
    throw new Error(`refused to type non-URL value into URL field: "${value}"`);
  }

  // Defensive: if the field looks like a date and we can detect the desired
  // format from placeholder/label, normalize the value before typing.
  if (looksLikeDateField(meta)) {
    const normalized = normalizeDateToPlaceholder(String(value), meta.placeholder, meta.label);
    if (normalized) value = normalized;
  }

  switch (meta.type) {
    case "text":
    case "textarea":
    case "password": // already filtered upstream, but defensive
      setReactInputValue(el, String(value));
      return;

    case "date":
      // Workday date inputs accept "MM/DD/YYYY" — convert from YYYY-MM-DD if needed
      setReactInputValue(el, formatDateForWorkday(String(value)));
      return;

    case "dropdown":
      await fillDropdown(el, String(value));
      return;

    case "checkbox":
      await fillCheckbox(el, value);
      return;

    case "radio":
      await fillRadio(el, String(value));
      return;

    case "file":
      await fillFile(el, String(value));
      return;

    default:
      throw new Error(`unsupported field type: ${meta.type}`);
  }
}

function looksLikeUrlField(meta) {
  const haystack = `${meta.label} ${meta.placeholder || ""}`.toLowerCase();
  return /\b(url|link|website|linkedin|github|portfolio|homepage)\b/.test(haystack);
}

function looksLikeUrl(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 5) return false;
  // accept full URLs OR bare domains containing a dot
  return /^https?:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(v);
}

function looksLikeDateField(meta) {
  const haystack = `${meta.label} ${meta.placeholder || ""}`.toLowerCase();
  return (
    meta.type === "date" ||
    /\b(date|from|to|start|end|since|until|year|month)\b/.test(haystack) ||
    /\b(mm\/?yyyy|mm\/?dd\/?yyyy|yyyy[-/]mm[-/]?(dd)?)\b/i.test(haystack)
  );
}

// Parse various date strings into {y, m, d}. Returns null if not parseable.
function parseDateParts(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  // YYYY-MM-DD
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: m[1], m: m[2].padStart(2, "0"), d: m[3].padStart(2, "0") };
  // YYYY-MM
  m = v.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return { y: m[1], m: m[2].padStart(2, "0"), d: "01" };
  // YYYY
  m = v.match(/^(\d{4})$/);
  if (m) return { y: m[1], m: "01", d: "01" };
  // MM/DD/YYYY
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { y: m[3], m: m[1].padStart(2, "0"), d: m[2].padStart(2, "0") };
  // MM/YYYY
  m = v.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return { y: m[2], m: m[1].padStart(2, "0"), d: "01" };
  // DD/MM/YYYY (less likely on US-defaulted Workday but possible)
  // we leave as-is, ambiguous with MM/DD/YYYY
  return null;
}

// Reformat a date value to match the placeholder's format, if we can detect one.
function normalizeDateToPlaceholder(value, placeholder, label) {
  // Don't normalize words like "Present" or "Current"
  if (/^(present|current|now|ongoing)$/i.test(value.trim())) return value;

  const parts = parseDateParts(value);
  if (!parts) return null; // can't parse — let the original value through

  const hint = `${placeholder || ""} ${label || ""}`.toLowerCase();

  if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(hint)) return `${parts.m}/${parts.d}/${parts.y}`;
  if (/mm\s*\/\s*yyyy/.test(hint)) return `${parts.m}/${parts.y}`;
  if (/yyyy\s*-\s*mm\s*-\s*dd/.test(hint)) return `${parts.y}-${parts.m}-${parts.d}`;
  if (/yyyy\s*-\s*mm/.test(hint)) return `${parts.y}-${parts.m}`;
  if (/dd\s*\/\s*mm\s*\/\s*yyyy/.test(hint)) return `${parts.d}/${parts.m}/${parts.y}`;

  // No format hint — default MM/DD/YYYY for US Workday
  return `${parts.m}/${parts.d}/${parts.y}`;
}

// React tracks its own internal value on inputs; the standard setter bypasses
// React's tracking, so we have to use the native prototype setter and dispatch
// events the way a real keystroke would.
function setReactInputValue(el, value) {
  const tag = el.tagName.toLowerCase();
  const proto =
    tag === "textarea"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

  el.focus();
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function formatDateForWorkday(value) {
  // Accept YYYY-MM-DD or YYYY-MM and return MM/DD/YYYY
  const m = value.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) return value; // leave as-is, Workday might accept it
  const [, y, mo, d] = m;
  return `${mo.padStart(2, "0")}/${(d || "01").padStart(2, "0")}/${y}`;
}

async function fillDropdown(el, value) {
  // Case 1: native <select>
  if (el.tagName.toLowerCase() === "select") {
    const option = Array.from(el.options).find(
      (o) =>
        o.textContent.trim().toLowerCase() === value.toLowerCase() ||
        o.value?.toLowerCase() === value.toLowerCase()
    );
    if (!option) throw new Error(`no <option> matches "${value}"`);
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // Case 2: Workday custom dropdown — click the button, then click the matching option.
  el.click();
  await sleep(300);

  // Options can be portaled anywhere in the DOM. Search globally.
  const optionSelector = '[role="option"], [role="menuitem"], li[role="option"]';
  let attempts = 0;
  let options = [];
  while (attempts < 10) {
    options = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
    if (options.length > 0) break;
    await sleep(100);
    attempts++;
  }
  if (options.length === 0) throw new Error("dropdown options never rendered");

  const target =
    options.find((o) => o.textContent.trim().toLowerCase() === value.toLowerCase()) ||
    options.find((o) => o.textContent.trim().toLowerCase().includes(value.toLowerCase()));

  if (!target) {
    // Close the dropdown to avoid leaving a popup open
    document.body.click();
    throw new Error(`no option matches "${value}"`);
  }

  target.click();
  await sleep(100);
}

async function fillFile(el, value) {
  // Only "resume" is currently supported. The AI is instructed to return
  // "resume" for resume/CV upload fields and null for everything else.
  if (value.toLowerCase() !== "resume") {
    throw new Error(`unsupported file value "${value}" — only "resume" is implemented`);
  }

  const stored = await chrome.storage.local.get("vibeapply.resume");
  const resume = stored["vibeapply.resume"];
  if (!resume?.pdfBase64) {
    throw new Error(
      "No PDF bytes saved — re-upload your resume in the VibeApply popup",
    );
  }

  // base64 → binary → Blob → File
  const binary = atob(resume.pdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const file = new File([blob], resume.filename || "resume.pdf", {
    type: "application/pdf",
  });

  // input.files is normally read-only, but a DataTransfer's FileList is accepted.
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;

  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fillCheckbox(el, desired) {
  const want = desired === true || /^(true|yes|on|1)$/i.test(String(desired));
  if (!!el.checked !== want) {
    el.click();
  }
}

async function fillRadio(el, value) {
  const name = el.getAttribute("name");
  if (!name) {
    el.click();
    return;
  }
  const group = Array.from(
    document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)
  );
  const target = group.find((opt) => {
    const label = resolveLabel(opt) || "";
    return label.toLowerCase() === String(value).toLowerCase();
  });
  if (!target) throw new Error(`no radio option matches "${value}"`);
  target.click();
}
