function browserViewVisible(requestedVisible, surfaceActive, boundsReady = true) {
  return requestedVisible === true && surfaceActive === true && boundsReady === true;
}

function scaleBrowserBounds(bounds, zoomFactor = 1) {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    throw new Error("Renderer zoom factor must be positive and finite");
  }
  return {
    x: bounds.x * zoomFactor,
    y: bounds.y * zoomFactor,
    width: bounds.width * zoomFactor,
    height: bounds.height * zoomFactor,
  };
}

function shellZoomActionForInput(input, platform = process.platform) {
  if (input?.type !== "keyDown" || input.alt === true) return null;
  const primaryModifier = platform === "darwin" ? input.meta === true : input.control === true;
  if (!primaryModifier) return null;
  if (input.key === "+" || input.key === "=") return "in";
  if (input.key === "-" || input.key === "_") return "out";
  if (input.key === "0") return "reset";
  return null;
}

/**
 * What a key pressed on a Browser tab page asks for, as Chrome does it, or null to leave it to the
 * page. The Browser tab used to hand every key to the page: F12 opened nothing, and Ctrl+R, Alt+Left
 * or Ctrl+L did nothing (2026-11-13).
 */
function browserKeyActionForInput(input, platform = process.platform) {
  if (input?.type !== "keyDown") return null;
  const mac = platform === "darwin";
  const primary = mac ? input.meta === true : input.control === true;
  const shift = input.shift === true, alt = input.alt === true;
  const key = String(input.key || "");
  const letter = key.length === 1 ? key.toLowerCase() : "";
  // Developer tools: F12, and Ctrl+Shift+I / J / C (Cmd+Option+I / J / C on macOS).
  if (key === "F12" && !primary && !alt && !shift) return "devtools";
  if (primary && (mac ? alt : shift && !alt) && ["i", "j", "c"].includes(letter)) return "devtools";
  // Reload: F5 or Ctrl+R; Ctrl+F5, Shift+F5 or Ctrl+Shift+R reload without the cache.
  if (key === "F5" && !alt) return primary || shift ? "hard-reload" : "reload";
  if (primary && !alt && letter === "r") return shift ? "hard-reload" : "reload";
  // Back and forward: Alt+Left / Alt+Right (Cmd+[ / Cmd+] on macOS) and the keyboards' own keys.
  if ((alt && !primary && key === "ArrowLeft") || (mac && primary && key === "[") || key === "BrowserBack") return "back";
  if ((alt && !primary && key === "ArrowRight") || (mac && primary && key === "]") || key === "BrowserForward") return "forward";
  // The address bar: Ctrl+L, Alt+D, F6.
  if ((primary && !alt && !shift && letter === "l") || (alt && !primary && letter === "d") || (key === "F6" && !primary && !alt)) {
    return "focus-address";
  }
  // Tabs: Ctrl+T opens one; Ctrl+W or Ctrl+F4 closes the one shown.
  if (primary && !alt && !shift && letter === "t") return "new-tab";
  if (primary && !alt && !shift && (letter === "w" || key === "F4")) return "close-tab";
  return null;
}

function constrainBrowserBounds(bounds, contentSize) {
  const contentWidth = Math.max(1, Math.round(contentSize?.width || 0));
  const contentHeight = Math.max(1, Math.round(contentSize?.height || 0));
  const x = Math.min(contentWidth - 1, Math.max(0, Math.round(bounds.x)));
  const y = Math.min(contentHeight - 1, Math.max(0, Math.round(bounds.y)));
  return {
    x,
    y,
    width: Math.min(contentWidth - x, Math.max(1, Math.round(bounds.width))),
    height: Math.min(contentHeight - y, Math.max(1, Math.round(bounds.height))),
  };
}

function readBrowserNavigationState(contents, fallback, { readPageTitle = true } = {}) {
  if (!contents || contents.isDestroyed()) return { ...fallback };
  const history = contents.navigationHistory;
  return {
    ...fallback,
    url: contents.getURL() || fallback.url,
    title: readPageTitle ? contents.getTitle() || fallback.title || "ChatGPT" : fallback.title || "ChatGPT",
    loading: contents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}

function normalizeBrowserAddress(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 16384) {
    throw new Error("Enter a valid HTTP or HTTPS address");
  }
  const input = value.trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input);
  const hostWithPort = /^[^/:?#\s]+:\d+(?:[/?#]|$)/.test(input);
  let parsed;
  try {
    parsed = new URL(input.startsWith("//") ? `https:${input}`
      : hasScheme && !hostWithPort ? input : `https://${input}`);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS address");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("Browser addresses must use HTTP or HTTPS without embedded credentials");
  }
  return parsed.href;
}

function navigateBrowser(contents, action) {
  if (action && typeof action === "object" && !Array.isArray(action)) {
    return contents.loadURL(normalizeBrowserAddress(action.url));
  }
  const history = contents.navigationHistory;
  if (action === "back") {
    if (history.canGoBack()) history.goBack();
  } else if (action === "forward") {
    if (history.canGoForward()) history.goForward();
  } else if (action === "reload") {
    contents.reload();
  } else if (action === "hard-reload") {
    contents.reloadIgnoringCache();
  } else {
    throw new Error(`Unknown browser navigation action: ${action}`);
  }
}

module.exports = {
  browserKeyActionForInput,
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
  scaleBrowserBounds,
  shellZoomActionForInput,
};
