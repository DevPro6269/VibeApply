console.log("[VibeApply] service worker started");

chrome.runtime.onInstalled.addListener(() => {
  console.log("[VibeApply] extension installed");
});
