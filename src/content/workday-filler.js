console.log("[VibeApply] content script injected on", window.location.href);

// Module-level cache of last detected fields, indexed by id.
// Keeps element refs (which can't cross the message boundary).
let lastDetected = new Map(); // fieldId -> { meta, element }

// ===========================================================================
// Message listener — entry point for popup → content script communication
// ===========================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "DETECT_FIELDS") {
    try {
      const fields = detectFields();
      console.log(`[VibeApply] detected ${fields.length} fields`, fields);
      sendResponse({ ok: true, fields });
    } catch (err) {
      console.error("[VibeApply] field detection failed", err);
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }

  if (msg?.type === "FILL_FIELDS") {
    fillFields(msg.mapping)
      .then((results) => {
        console.log("[VibeApply] fill results:", results);
        sendResponse({ ok: true, results });
      })
      .catch((err) => {
        console.error("[VibeApply] fill failed", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async response
  }
});

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

  for (const el of elements) {
    if (!isVisible(el)) continue;
    if (isInsideHeader(el)) continue; // skip search bars in nav etc.
    if (isAuthField(el)) continue; // never fill auth fields — assignment rule
    if (isHoneypot(el)) continue; // never fill bot traps

    const type = classifyField(el);
    if (!type) continue;

    const label = resolveLabel(el);
    if (!label) continue; // unlabeled fields are unreliable to fill

    const field = {
      id: `f${counter++}`,
      label,
      type,
      automationId:
        el.getAttribute("data-automation-id") ||
        el.closest("[data-automation-id]")?.getAttribute("data-automation-id") ||
        null,
      currentValue: getCurrentValue(el),
      required: isRequired(el),
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
      // We won't programmatically upload the resume file here — too brittle
      // and Workday usually has an explicit "Upload Resume" button outside our scope.
      throw new Error("file uploads not auto-filled");

    default:
      throw new Error(`unsupported field type: ${meta.type}`);
  }
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
