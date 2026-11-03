const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.resolve(__dirname, "../src/features/codex-chat.css"), "utf8");
const view = fs.readFileSync(path.resolve(__dirname, "../src/features/ImagePreview.tsx"), "utf8");

// Reported 2026-11-03 (#983): in the window's top right corner the title bar's minimize, maximize and
// close covered the preview's Markup, Download and Close buttons. Then asked for the same day: the
// preview exactly as Codex's, whose zoom, Download and Close sit in a header at the top right.
test("the image preview's header and Markup's buttons stop short of the window buttons", () => {
  assert.match(css, /\.cdx-preview \{ --cdx-window-buttons: calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\); \}/,
    "their width is what the title bar area leaves (0 px without a title bar overlay)");
  assert.match(css, /\.cdx-viewer-head \{[^}]*padding: 8px calc\(var\(--cdx-window-buttons\) \+ 8px\) 8px 8px;/, "zoom, Download and Close end left of them");
  assert.match(css, /\.cdx-preview-actions \{[^}]*right: calc\(var\(--cdx-window-buttons\) \+ 8px\);/, "Markup's Add to chat and Back to image too");
  assert.match(css, /\.cdx-preview-viewport \{ position: absolute; top: 48px;/, "the image starts under the header, below the title bar's 46 px");
});

test("a click anywhere but the image and its controls closes the preview, and the chat shows through", () => {
  assert.match(view, /Math\.hypot\(event\.clientX - start\.x, event\.clientY - start\.y\) > 5\) return;/, "a drag is not a click (Codex's 5 px)");
  assert.match(view, /closest\("img, button, a, input, \[role=toolbar\], \[role=menu\]"\)\) return;/, "the image, its buttons, the tool bar and menus keep it open");
  assert.match(view, /event\.target === box && \(event\.clientX >= rect\.left \+ box\.clientWidth \|\| event\.clientY >= rect\.top \+ box\.clientHeight\)/,
    "a zoomed image's scrollbars only scroll (#983)");
  assert.match(css, /background: #e3e3e380; backdrop-filter: blur\(1px\);/, "Codex's veil, lighter than #983's black/75");
  assert.match(css, /--cdx-menu: rgb\(45 45 45 \/ \.9\); --cdx-image-shadow: 0 4px 8px -2px rgb\(0 0 0 \/ \.36\); background: #00000080; \}/, "and in the dark theme");
});
