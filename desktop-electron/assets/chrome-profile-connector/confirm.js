"use strict";
function status() {
  chrome.runtime.sendMessage({ type: "status" }, reply => {
    if (chrome.runtime.lastError || !reply) return;
    document.getElementById("status").textContent = reply.status;
    document.getElementById("approval").hidden = !reply.approvalRequired || reply.expiresAt <= Date.now();
    document.getElementById("code").textContent = reply.code || "";
  });
}
document.getElementById("approve").addEventListener("click", () => {
  const button = document.getElementById("approve"); button.disabled = true;
  chrome.runtime.sendMessage({ type: "approve", code: document.getElementById("code").textContent }, reply => { button.disabled = false; if (!reply?.ok) document.getElementById("status").textContent = "The connection changed or expired. Open a fresh connection from Coding Tools and compare its code."; else status(); });
});
document.getElementById("check").addEventListener("click", () => { chrome.runtime.sendMessage({ type: "check" }, status); });
chrome.storage.onChanged.addListener((_changes, area) => { if (area === "session") status(); });
status();
