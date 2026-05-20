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

    // 3.5. Pre-expand custom dropdowns to read their options.
    // Without this, the AI doesn't know the available choices and may return
    // a value like "Bachelor of Technology" when the option list is ["BTECH", "MCA"].
    await expandDropdownOptions(fields);

    // 4. AI map: fields + resume + profile → { fieldId: value }
    showToast(`VibeApply: mapping ${fields.length} fields with AI…`, "info");
    const mapping = await VIBEAPPLY_GEMINI.mapFieldsWithAI(
      fields,
      resume,
      profile,
      apiKey,
    );
    console.log("[VibeApply] AI mapping:", mapping);

    // 5. Fill — pass resume so we can verify any date the AI returns
    const results = await fillFields(mapping, resume);
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
    // Fail fast if extension was reloaded (no point waiting for debounce)
    if (!chrome?.runtime?.id) {
      handleExtensionInvalidated();
      return;
    }
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

  // If the extension was reloaded, chrome.runtime.id becomes undefined and any
  // chrome.* call throws "Extension context invalidated". Stop cleanly.
  if (!chrome?.runtime?.id) {
    handleExtensionInvalidated();
    return;
  }

  const fields = detectFields();
  if (fields.length === 0) return; // not a meaningful step

  const sig = computeSignature(fields);
  if (sig === autopilot.lastSignature) return;

  // Trigger if there's at least one NEW fingerprint we haven't seen.
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
    if (isExtensionInvalidated(err)) {
      handleExtensionInvalidated();
      return;
    }
    console.error("[VibeApply] autopilot cycle error", err);
    showToast(`VibeApply: ${err.message}`, "error");
  }
}

function isExtensionInvalidated(err) {
  const msg = String(err?.message || err);
  return msg.includes("Extension context invalidated");
}

function handleExtensionInvalidated() {
  console.warn(
    "[VibeApply] extension was reloaded — stopping autopilot. Refresh this tab to continue.",
  );
  try {
    showToast(
      "VibeApply was reloaded. Refresh this tab (Cmd+R) to continue autofilling.",
      "error",
    );
  } catch {}
  stopAutopilot();
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
  const seenFileLabels = new Set(); // dedup file inputs with same label

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

    // Dedup file inputs that share the same label (e.g., drop-zone + click-pick)
    if (isFile) {
      const key = label.toLowerCase().trim();
      if (seenFileLabels.has(key)) continue;
      seenFileLabels.add(key);
    }

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
//
// Strategy: walk up the DOM looking for a section heading (h1-h6) that
// precedes this file input — Workday's pattern is:
//   <h2>Resume/CV</h2>
//   <p>Upload a file (5MB max)</p>
//   <div class="drop-zone"><input type="file" hidden> ... </div>
function resolveFileInputLabel(el) {
  // 1. Walk up the DOM looking for a preceding heading at any ancestor level
  let node = el;
  for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      // Heading directly?
      if (/^H[1-6]$/.test(sibling.tagName)) {
        const text = (sibling.textContent || "").replace(/\s+/g, " ").trim();
        if (text && text.length < 80) return text;
      }
      // Heading inside the sibling?
      const heading = sibling.querySelector?.("h1, h2, h3, h4, h5, h6");
      if (heading?.textContent) {
        const text = heading.textContent.replace(/\s+/g, " ").trim();
        if (text && text.length < 80) return text;
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }

  // 2. Fall back to button/label proxy in nearest container
  const container = el.closest(
    "[data-automation-id], .file-upload, .upload, .drop-zone, fieldset, div"
  );
  if (container) {
    const proxy = container.querySelector(
      "button, [role='button'], label, [class*='label']"
    );
    if (proxy?.textContent) {
      const text = proxy.textContent.replace(/\s+/g, " ").trim();
      if (text.length > 0 && text.length < 80) return text;
    }
  }

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

async function fillFields(mapping, resume) {
  const results = [];

  // Track filled From dates per occurrence so we can sanity-check To values.
  // Keyed by occurrenceIndex (0,1,2…), holds parsed YYYY-MM string.
  const filledFromByIndex = new Map();

  for (const [id, entry] of lastDetected) {
    const { meta, element } = entry;
    let value = mapping[id];

    if (value === null || value === undefined || value === "") {
      results.push({ id, label: meta.label, status: "skipped_no_value" });
      continue;
    }

    // VERIFY work-experience date fields against the resume data.
    // If the AI's value doesn't match anything in resume.work_experience for
    // this occurrenceIndex, refuse to type it — likely hallucination.
    if (looksLikeDateField(meta) && resume) {
      const verdict = verifyDateAgainstResume(value, meta, resume);
      if (verdict.action === "skip") {
        results.push({
          id,
          label: meta.label,
          status: "error",
          error: verdict.reason,
        });
        continue;
      }
      if (verdict.action === "replace") {
        value = verdict.value;
      }
    }

    // Date sanity check: if this is a "To" field and the matching "From" was
    // filled with a later date, skip — refuses to type inconsistent dates.
    const labelLower = meta.label.toLowerCase();
    const isToField = /\b(to|end|end date|until)\b/.test(labelLower);
    const isFromField = /\b(from|start|start date|since)\b/.test(labelLower);

    if (isToField && looksLikeDateField(meta)) {
      const fromYm = filledFromByIndex.get(meta.occurrenceIndex || 0);
      const toYm = dateToComparable(value);
      if (fromYm && toYm && toYm < fromYm) {
        results.push({
          id,
          label: meta.label,
          status: "error",
          error: `would type ${value} (To) which is before ${fromYm} (From) — refused`,
        });
        continue;
      }
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

    // For chip / multi-value fields the input's value is always empty —
    // the actual selections live in a separate "chips" container nearby.
    // Skip if any chip is already present so we don't keep re-adding skills.
    if (Array.isArray(value) && hasExistingChips(element)) {
      results.push({ id, label: meta.label, status: "skipped_prefilled" });
      continue;
    }

    try {
      await fillOne(element, meta, value);
      results.push({ id, label: meta.label, status: "filled", value: String(value) });

      // Remember From dates so later "To" fills can compare against them
      if (isFromField && looksLikeDateField(meta)) {
        const ym = dateToComparable(value);
        if (ym) filledFromByIndex.set(meta.occurrenceIndex || 0, ym);
      }
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

  // Defensive: refuse implausibly old/future dates (likely AI hallucination).
  if (looksLikeDateField(meta) && isImplausibleDate(value)) {
    throw new Error(`refused to type implausible date "${value}" (year out of 1980..current+5 range)`);
  }

  // Workday's MM/YYYY date inputs are often calendar-picker widgets — typing
  // doesn't work because the picker holds its own state. Try the picker UI first,
  // fall back to typing if picker can't be operated.
  if (looksLikeDateField(meta) && hasCalendarPicker(el)) {
    try {
      await fillWorkdayDatePicker(el, String(value));
      return;
    } catch (err) {
      console.warn(
        `[VibeApply] picker failed for "${meta.label}", falling back to typing: ${err.message}`,
      );
      // Fall through to normal typing path
    }
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
      if (Array.isArray(value)) {
        await fillMultiValue(el, value);
      } else {
        setReactInputValue(el, String(value));
      }
      return;

    case "date":
      // Workday date inputs accept "MM/DD/YYYY" — convert from YYYY-MM-DD if needed
      setReactInputValue(el, formatDateForWorkday(String(value)));
      return;

    case "dropdown":
      await fillDropdown(el, String(value), meta);
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

// Detects whether a chip/tag field already has selections nearby.
// Workday usually renders selected chips in a sibling container with
// remove-x buttons.
function hasExistingChips(el) {
  // Walk up a few levels — chips can be in the same or a parent container
  let container = el;
  for (let depth = 0; depth < 4 && container; depth++) {
    container = container.parentElement;
    if (!container) break;

    // Look for chip-shaped elements anywhere in this scope (excluding popup options
    // which would appear during typing, not after-selection chips)
    const chipLike = container.querySelectorAll(
      [
        '[data-automation-id*="selectedItem" i]',
        '[data-automation-id*="multiselectInputChip" i]',
        '[class*="chip" i]',
        '[class*="tag-pill" i]',
        '[class*="selected-item" i]',
      ].join(","),
    );
    for (const c of chipLike) {
      if (isVisible(c) && (c.textContent || "").trim().length > 0) return true;
    }

    // Workday often renders an X / Remove button per selected chip
    const removers = container.querySelectorAll(
      'button[aria-label*="Remove" i], button[aria-label*="Delete" i], ' +
        'button[title*="Remove" i], [data-automation-id*="DELETE" i]',
    );
    for (const r of removers) {
      if (isVisible(r)) return true;
    }
  }
  return false;
}

// Cross-check a date the AI wants to type against the resume.
// Returns:
//   { action: "ok" }            — looks consistent with resume, type it as-is
//   { action: "replace", value } — replace AI's value with the resume's value
//   { action: "skip", reason }   — refuse to type
function verifyDateAgainstResume(aiValue, meta, resume) {
  const occ = meta.occurrenceIndex || 0;
  const labelLower = meta.label.toLowerCase();
  const isStart = /\b(from|start|since)\b/.test(labelLower);
  const isEnd = /\b(to|end|until)\b/.test(labelLower) || /actual or expected/i.test(meta.label);

  if (!isStart && !isEnd) return { action: "ok" };

  // Determine if this is education or work-experience context by walking up the DOM
  const fieldId = meta.id || Object.keys(meta).find((k) => k === "id");
  const entry = lastDetected.get(meta.id);
  const context = sniffDateContext(entry?.element);

  const list =
    context === "education" ? resume.education : resume.work_experience;
  if (!Array.isArray(list)) return { action: "ok" };

  const item = list[occ];

  if (!item) {
    return {
      action: "skip",
      reason: `no resume entry at index ${occ} for ${context || "work_experience"} — AI would invent`,
    };
  }

  const expected = isStart ? item.start_date : item.end_date;
  if (!expected) {
    return {
      action: "skip",
      reason: `resume has no ${isStart ? "start_date" : "end_date"} for index ${occ} — AI invented`,
    };
  }

  // Compare years (most reliable). If AI's year differs from resume's year,
  // we trust the resume and replace.
  const aiParsed = parseDateParts(aiValue);
  const expectedParsed = parseDateParts(expected);

  // "Present" / "present" handling
  if (/^(present|current|now|ongoing)$/i.test(String(expected).trim())) {
    // resume says ongoing — if AI typed an actual date, replace with "Present"
    if (aiParsed) return { action: "replace", value: "Present" };
    return { action: "ok" };
  }

  if (!aiParsed || !expectedParsed) return { action: "ok" };

  if (aiParsed.y !== expectedParsed.y) {
    return {
      action: "skip",
      reason: `AI year ${aiParsed.y} doesn't match resume year ${expectedParsed.y} for index ${occ}`,
    };
  }

  // Year matches — accept AI's value (it may have month-correctly formatted)
  return { action: "ok" };
}

// Walk up the DOM to figure out whether a date field is in a "Work Experience"
// or "Education" section. Returns "work_experience" by default.
function sniffDateContext(el) {
  if (!el) return "work_experience";
  let node = el;
  for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
    const headings = node.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, [class*='section-title' i]");
    for (const h of headings) {
      const t = (h.textContent || "").toLowerCase();
      if (t.includes("education")) return "education";
      if (t.includes("work experience") || t.includes("employment")) return "work_experience";
    }
    node = node.parentElement;
  }
  return "work_experience";
}

// Detect whether the field has a Workday calendar-picker widget attached.
// Workday's date widget often labels the input as "Month" (aria-label) and
// puts a button next to it that opens a calendar popup.
function hasCalendarPicker(el) {
  // Walk up a few levels — the picker button can be in the same wrapper as the input
  let container = el;
  for (let i = 0; i < 4 && container; i++) {
    container = container.parentElement;
    if (!container) break;

    const picker = container.querySelector(
      'button[aria-haspopup="dialog"], ' +
        'button[aria-haspopup="grid"], ' +
        'button[aria-label*="alendar" i], ' +
        'button[aria-label*="oose date" i], ' +
        'button[data-automation-id*="datePicker" i], ' +
        '[class*="DatePicker" i] button, ' +
        '[data-automation-id*="datePicker" i]',
    );
    if (picker) return true;
  }

  // Heuristic: input with aria-label "Month" + sibling button likely belongs
  // to a Workday compound date widget
  const labelLower = (el.getAttribute("aria-label") || "").toLowerCase();
  if (labelLower === "month" || labelLower === "year") {
    const wrapper = el.closest("[data-automation-id], fieldset, div");
    if (wrapper?.querySelector("button")) return true;
  }
  return false;
}

// Workday's MM/YYYY date picker UI: arrows to change year, click month name.
async function fillWorkdayDatePicker(el, value) {
  console.log(`[VibeApply] picker: filling "${value}" for`, el);

  if (/^(present|current|now|ongoing)$/i.test(value.trim())) {
    throw new Error('cannot type "Present" into a date picker — leave it for "I currently work here" checkbox');
  }

  const parts = parseDateParts(value);
  if (!parts) throw new Error(`unparseable date value: ${value}`);
  const targetYear = parseInt(parts.y, 10);
  const targetMonth = parseInt(parts.m, 10);
  if (!Number.isFinite(targetYear) || !Number.isFinite(targetMonth)) {
    throw new Error(`invalid date parts in "${value}"`);
  }

  const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthsFull = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const targetMonthShort = monthsShort[targetMonth - 1];
  const targetMonthFull = monthsFull[targetMonth - 1];

  // Open the picker — click the trigger button next to the input, or the input itself
  const container = el.closest("[data-automation-id], fieldset, div") || el.parentElement;
  const trigger =
    container?.querySelector(
      'button[aria-haspopup="dialog"], button[aria-haspopup="grid"], button[aria-label*="alendar" i]',
    ) || el;

  console.log("[VibeApply] picker: opening via", trigger);
  el.focus();
  trigger.click();

  // Wait for popup containing month abbreviations
  let popup = null;
  for (let i = 0; i < 25; i++) {
    await sleep(120);
    popup = findDatePickerPopup(monthsShort, monthsFull);
    if (popup) break;
  }
  if (!popup) {
    throw new Error("date picker popup did not appear after 3s");
  }
  console.log("[VibeApply] picker: found popup", popup);

  // Navigate year via < / > arrows
  let lastYear = null;
  let stuckCount = 0;
  for (let safety = 0; safety < 250; safety++) {
    const currentYear = findYearInPopup(popup);
    if (currentYear === null) {
      throw new Error("cannot read current year from picker");
    }
    if (currentYear === targetYear) break;

    if (currentYear === lastYear) {
      stuckCount++;
      if (stuckCount > 3) throw new Error(`year stuck at ${currentYear}, can't reach ${targetYear}`);
    } else {
      stuckCount = 0;
    }
    lastYear = currentYear;

    const direction = currentYear < targetYear ? "next" : "prev";
    const arrow = findArrowButton(popup, direction);
    if (!arrow) {
      throw new Error(`year-${direction} arrow not found (current=${currentYear} target=${targetYear})`);
    }
    arrow.click();
    await sleep(70);
  }

  // Click the target month button (try short name then full name)
  const buttons = Array.from(popup.querySelectorAll("button, [role='button'], [role='gridcell']"));
  const monthBtn =
    buttons.find((b) => b.textContent.trim() === targetMonthShort) ||
    buttons.find((b) => b.textContent.trim() === targetMonthFull) ||
    buttons.find((b) => b.textContent.trim().startsWith(targetMonthShort));

  if (!monthBtn) {
    throw new Error(`month "${targetMonthShort}/${targetMonthFull}" not found among ${buttons.length} buttons`);
  }

  monthBtn.click();
  await sleep(200);
  console.log(`[VibeApply] picker: clicked ${targetMonthShort} ${targetYear}`);
}

function findDatePickerPopup(monthsShort, monthsFull) {
  // Strategy 1: explicit popup roles + class hints
  const candidates = document.querySelectorAll(
    '[role="dialog"], [role="grid"], [role="presentation"], ' +
      '[class*="popover" i], [class*="DatePicker" i], [class*="calendar" i]',
  );
  for (const c of candidates) {
    if (!isVisible(c)) continue;
    const text = c.textContent;
    if (monthsShort.every((m) => text.includes(m))) return c;
    if (monthsFull.every((m) => text.includes(m))) return c;
  }

  // Strategy 2: any reasonably small element containing all month names
  const allDivs = document.querySelectorAll("div, section");
  for (const c of allDivs) {
    if (!isVisible(c)) continue;
    if (c.children.length > 60) continue; // skip whole-document containers
    const text = c.textContent;
    if (text.length > 5000) continue; // skip huge containers
    if (
      monthsShort.every((m) => text.includes(m)) ||
      monthsFull.every((m) => text.includes(m))
    ) {
      return c;
    }
  }
  return null;
}

function findYearInPopup(popup) {
  const candidates = popup.querySelectorAll("button, h1, h2, h3, h4, [role='heading'], span");
  for (const c of candidates) {
    const text = c.textContent.trim();
    if (/^\d{4}$/.test(text)) return parseInt(text, 10);
  }
  return null;
}

function findArrowButton(popup, direction) {
  const buttons = Array.from(popup.querySelectorAll("button, [role='button']"));
  for (const b of buttons) {
    const text = b.textContent.replace(/\s+/g, "").trim();
    const aria = (b.getAttribute("aria-label") || "").toLowerCase();
    if (direction === "next") {
      if (text === ">" || text === "›" || aria.includes("next") || aria.includes("forward") || aria.includes("increment")) {
        return b;
      }
    } else {
      if (text === "<" || text === "‹" || aria.includes("prev") || aria.includes("back") || aria.includes("decrement")) {
        return b;
      }
    }
  }
  return null;
}

// Reject dates with implausible years (likely AI hallucination)
function isImplausibleDate(value) {
  if (value == null) return false;
  const v = String(value).trim();
  if (/^(present|current|now|ongoing)$/i.test(v)) return false;
  const parts = parseDateParts(v);
  if (!parts) return false;
  const year = parseInt(parts.y, 10);
  if (!Number.isFinite(year)) return false;
  const currentYear = new Date().getFullYear();
  return year < 1980 || year > currentYear + 5;
}

// Reduce any common date string to a comparable YYYY-MM key.
// Returns null if the input doesn't look like a date.
function dateToComparable(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (/^(present|current|now|ongoing)$/i.test(v)) {
    // "Present" is the maximum — anything before it is OK.
    return "9999-12";
  }
  const parts = parseDateParts(v);
  if (!parts) return null;
  return `${parts.y}-${parts.m}`;
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
  const labelLower = (label || "").toLowerCase();

  if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(hint)) return `${parts.m}/${parts.d}/${parts.y}`;
  if (/mm\s*\/\s*yyyy/.test(hint)) return `${parts.m}/${parts.y}`;
  if (/yyyy\s*-\s*mm\s*-\s*dd/.test(hint)) return `${parts.y}-${parts.m}-${parts.d}`;
  if (/yyyy\s*-\s*mm/.test(hint)) return `${parts.y}-${parts.m}`;
  if (/dd\s*\/\s*mm\s*\/\s*yyyy/.test(hint)) return `${parts.d}/${parts.m}/${parts.y}`;

  // Year-only field — common for education ("From"/"To (Actual or Expected)")
  if (/^\s*yyyy\s*$/.test(placeholder || "") || /^\s*year\s*$/i.test(label || "")) {
    return parts.y;
  }

  // Heuristic: "From" / "To" / "Start" / "End" labels in Workday work-experience
  // sections almost always use MM/YYYY (no day component). Type day-less.
  if (/\b(from|to|start|end|since|until)\b/.test(labelLower)) {
    return `${parts.m}/${parts.y}`;
  }

  // Workday's compound date widget: input aria-label is just "Month" or "Year"
  if (labelLower === "month" || /^\s*mm\s*$/.test(placeholder || "")) {
    return parts.m;
  }
  if (labelLower === "year" || /^\s*yyyy\s*$/.test(placeholder || "")) {
    return parts.y;
  }

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

// Briefly open each custom dropdown to harvest its options, then close it.
// Reuses options for fields with the same label (e.g., 3 "Degree" dropdowns
// across repeated education blocks). Pause cooldown so our own clicks
// don't trick the MutationObserver into thinking the step changed.
async function expandDropdownOptions(fields) {
  autopilot.cooldownUntil = Date.now() + 8000;

  // Reuse options across repeated labels (e.g. "Degree" appearing 3 times)
  const optionsByLabel = new Map();

  for (const field of fields) {
    if (field.type !== "dropdown") continue;
    if (field.options && field.options.length > 0) continue;

    if (optionsByLabel.has(field.label)) {
      field.options = optionsByLabel.get(field.label);
      continue;
    }

    const entry = lastDetected.get(field.id);
    if (!entry) continue;
    const el = entry.element;

    // Native select — read directly, no opening needed
    if (el.tagName.toLowerCase() === "select") {
      const opts = Array.from(el.options).map((o) => o.textContent.trim()).filter(Boolean);
      field.options = opts;
      optionsByLabel.set(field.label, opts);
      continue;
    }

    // Try a pre-rendered popup via aria-controls
    const popupId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    if (popupId) {
      const popup = document.getElementById(popupId);
      if (popup) {
        const pre = Array.from(popup.querySelectorAll('[role="option"], li'))
          .map((o) => o.textContent.trim())
          .filter(Boolean);
        if (pre.length > 0) {
          const slice = pre.slice(0, 50);
          field.options = slice;
          optionsByLabel.set(field.label, slice);
          continue;
        }
      }
    }

    // Otherwise: click → read → close
    const options = await openReadClose(el);
    if (options.length > 0) {
      const slice = options.slice(0, 50);
      field.options = slice;
      optionsByLabel.set(field.label, slice);
    }
  }
}

// Open the dropdown, read visible options, then aggressively close it.
async function openReadClose(el) {
  try {
    el.click();
  } catch {
    return [];
  }

  // Wait for options to appear
  let options = [];
  for (let i = 0; i < 10; i++) {
    options = Array.from(
      document.querySelectorAll(
        '[role="option"], [role="menuitem"], [role="menuitemradio"], li[role="option"]',
      ),
    )
      .filter((o) => isVisible(o))
      .map((o) => o.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (options.length > 0) break;
    await sleep(120);
  }

  await closeAnyOpenPopup(el);
  return options;
}

// Try several strategies in order until no option elements are visible.
async function closeAnyOpenPopup(originalTrigger) {
  const isStillOpen = () =>
    Array.from(document.querySelectorAll('[role="option"], [role="menuitem"]')).some(
      (o) => isVisible(o),
    );

  // 1. Escape
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }),
  );
  document.dispatchEvent(
    new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }),
  );
  await sleep(120);
  if (!isStillOpen()) return;

  // 2. Click the trigger button again (toggle)
  if (originalTrigger) {
    try {
      originalTrigger.click();
    } catch {}
    await sleep(120);
    if (!isStillOpen()) return;
  }

  // 3. Click on body
  document.body.click();
  await sleep(120);
  if (!isStillOpen()) return;

  // 4. Last resort: dispatch a mousedown at (1,1) — Workday closes on outside mousedown
  const safeTarget = document.elementFromPoint(1, 1);
  if (safeTarget) {
    safeTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 1, clientY: 1 }));
    safeTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 1, clientY: 1 }));
    await sleep(120);
  }
}

async function fillDropdown(el, value, meta) {
  // Case 1: native <select>
  if (el.tagName.toLowerCase() === "select") {
    const optionsArr = Array.from(el.options);
    let option =
      optionsArr.find((o) => o.textContent.trim().toLowerCase() === value.toLowerCase()) ||
      optionsArr.find((o) => o.value?.toLowerCase() === value.toLowerCase());
    if (!option) {
      // Try AI fallback for native select
      const choice = await aiPickOption(value, optionsArr.map((o) => o.textContent.trim()), meta);
      if (choice) {
        option = optionsArr.find((o) => o.textContent.trim() === choice);
      }
    }
    if (!option) throw new Error(`no <option> matches "${value}"`);
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // Case 2: Workday custom dropdown — click the button, then click the matching option.
  el.click();
  await sleep(300);

  // Options can be portaled anywhere in the DOM. Search globally.
  const optionSelector = '[role="option"], [role="menuitem"], [role="menuitemradio"], li[role="option"]';
  let attempts = 0;
  let options = [];
  while (attempts < 10) {
    options = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
    if (options.length > 0) break;
    await sleep(100);
    attempts++;
  }
  if (options.length === 0) {
    await closeAnyOpenPopup(el);
    throw new Error("dropdown options never rendered");
  }

  // Try local matching first (fast)
  let target = findBestOption(value, options);

  // Fallback: ask Gemini to pick from the actual on-screen options
  if (!target) {
    const optionTexts = options.map((o) => o.textContent.replace(/\s+/g, " ").trim());
    const choice = await aiPickOption(value, optionTexts, meta);
    if (choice) {
      target = options.find((o) => o.textContent.replace(/\s+/g, " ").trim() === choice);
    }
  }

  if (!target) {
    await closeAnyOpenPopup(el);
    throw new Error(`no option matches "${value}"`);
  }

  target.click();
  await sleep(100);
}

// Ask Gemini to map a value to the best of the given option strings.
// Best-effort — returns null if no API key, no match, or call fails.
async function aiPickOption(value, options, meta) {
  const stored = await chrome.storage.local.get("vibeapply.apiKey");
  const apiKey = stored["vibeapply.apiKey"];
  if (!apiKey) return null;

  const context = meta?.label
    ? `field label: "${meta.label}"${meta.placeholder ? `, placeholder: "${meta.placeholder}"` : ""}`
    : "dropdown";

  console.log(
    `[VibeApply] asking AI to map "${value}" → one of ${options.length} options for "${meta?.label}"`,
  );
  const choice = await VIBEAPPLY_GEMINI.pickOptionWithAI(value, options, context, apiKey);
  if (choice) {
    console.log(`[VibeApply] AI picked: "${choice}"`);
  } else {
    console.log("[VibeApply] AI returned no match");
  }
  return choice;
}

// Smart option matching: exact → contains-each-other → abbreviation
function findBestOption(value, options) {
  const lower = String(value).trim().toLowerCase();

  // 1. exact match (case-insensitive)
  let m = options.find((o) => o.textContent.trim().toLowerCase() === lower);
  if (m) return m;

  // 2. option text contained in value (e.g. value="Bachelor of Technology BTECH" includes "btech")
  m = options.find((o) => {
    const ot = o.textContent.trim().toLowerCase();
    return ot.length >= 2 && lower.includes(ot);
  });
  if (m) return m;

  // 3. value contained in option text
  m = options.find((o) => o.textContent.trim().toLowerCase().includes(lower));
  if (m) return m;

  // 4. abbreviation: "Bachelor of Technology" → initials "BT"; loose match against options
  const valueInitials = lower
    .split(/[\s.\-_,]+/)
    .filter((w) => w && !["of", "in", "the", "and", "a"].includes(w))
    .map((w) => w[0])
    .join("");
  if (valueInitials.length >= 2) {
    m = options.find((o) => o.textContent.trim().toLowerCase().includes(valueInitials));
    if (m) return m;
  }

  // 5. Common degree abbreviation hardcoded mapping (Indian Workday tenants
  // often use BTECH/MTECH/MCA — common enough to be worth handling)
  const degreeMap = {
    "bachelor of technology": "btech",
    "b.tech": "btech",
    "bachelor of engineering": "btech",
    "b.e.": "btech",
    "master of technology": "mtech",
    "m.tech": "mtech",
    "master of computer applications": "mca",
    "master of computer application": "mca",
    "bachelor of computer applications": "bca",
    "bachelor of science": "bsc",
    "master of science": "msc",
    "bachelor of arts": "ba",
    "master of arts": "ma",
    "bachelor of commerce": "bcom",
    "master of business administration": "mba",
  };
  for (const [k, v] of Object.entries(degreeMap)) {
    if (lower.includes(k)) {
      m = options.find((o) => o.textContent.trim().toLowerCase() === v);
      if (m) return m;
    }
  }

  return null;
}

// Multi-value field filler. Handles two Workday patterns:
//   (a) Search + checkbox list (e.g. Skills): type → wait for dropdown →
//       click the checkbox that matches → input auto-clears → repeat.
//   (b) Chip input: type → press Enter → chip appears → repeat.
// We try (a) first; if no matching option appears, we fall back to (b).
async function fillMultiValue(el, values) {
  if (!Array.isArray(values)) values = [values];

  for (const raw of values) {
    if (raw === null || raw === undefined || raw === "") continue;
    const value = String(raw).trim();
    if (!value) continue;

    // Clear any leftover text in the input
    el.focus();
    if (el.value) {
      setReactInputValue(el, "");
      await sleep(120);
    }

    // Type the value to trigger search
    setReactInputValue(el, value);
    await sleep(400); // give Workday time to filter the option list

    const clicked = await clickMatchingOption(value);

    if (!clicked) {
      // Fallback: try Enter (works for plain chip inputs)
      for (const eventType of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(
          new KeyboardEvent(eventType, {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      await sleep(220);
    }

    await sleep(150);
  }

  // Close any lingering popup
  document.body.click();
}

// Look for a visible option in any popup whose text matches `value`, and click it.
// Handles both <input type="checkbox"> and ARIA-role checkboxes.
async function clickMatchingOption(value) {
  const lower = value.toLowerCase();

  // Poll briefly — Workday's dropdown can take 300-800ms to populate
  for (let attempt = 0; attempt < 6; attempt++) {
    const options = Array.from(
      document.querySelectorAll(
        '[role="option"], [role="checkbox"], [role="menuitemcheckbox"], ' +
        'li[role="presentation"], label[class*="checkbox" i]',
      ),
    ).filter((o) => isVisible(o));

    // 1. exact match (case-insensitive)
    let target = options.find(
      (o) => o.textContent.trim().toLowerCase() === lower,
    );
    // 2. startsWith
    if (!target) {
      target = options.find((o) =>
        o.textContent.trim().toLowerCase().startsWith(lower),
      );
    }
    // 3. contains (last resort — riskier)
    if (!target) {
      target = options.find((o) =>
        o.textContent.trim().toLowerCase().includes(lower),
      );
    }

    if (target) {
      // Click the option container; also click any inner checkbox
      target.click();
      const inner = target.querySelector(
        'input[type="checkbox"], [role="checkbox"]',
      );
      if (inner && inner !== target && inner.getAttribute("aria-checked") !== "true" && !inner.checked) {
        inner.click();
      }
      await sleep(180);
      return true;
    }

    await sleep(180);
  }
  return false;
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
