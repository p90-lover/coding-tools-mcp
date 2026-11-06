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
  } else {
    throw new Error(`Unknown browser navigation action: ${action}`);
  }
}

module.exports = {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
  scaleBrowserBounds,
  shellZoomActionForInput,
};
