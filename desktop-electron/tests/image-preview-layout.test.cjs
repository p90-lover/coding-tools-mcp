const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.resolve(__dirname, "../src/features/codex-chat.css"), "utf8");
const view = fs.readFileSync(path.resolve(__dirname, "../src/features/ImagePreview.tsx"), "utf8");

// Reported 2026-11-03: in the window's top right corner the title bar's minimize, maximize and close
// covered the preview's Markup, Download and Close buttons.
test("the image preview's buttons stand in a column beside the image, clear of the window buttons", () => {
  assert.match(view, /className="cdx-preview-actions is-beside" style=\{beside \?\? \{ visibility: "hidden" \}\}/, "placed where the image is measured");
  assert.match(view, /left: Math\.min\(Math\.min\(shownBox\.right, view\.right\) \+ 12, window\.innerWidth - 52\), top: Math\.max\(shownBox\.top, view\.top\)/,
    "12 px right of the image's top right corner, never off the window");
  assert.match(css, /\.cdx-preview-actions\.is-beside \{ right: auto; flex-direction: column; \}/);
  assert.match(css, /\.cdx-preview-column \{[^}]*padding: 96px 72px 32px;/, "room beside the widest image for the column");
  assert.match(css, /\.cdx-markup \.cdx-preview-actions \{ top: auto; bottom: 16px; right: 16px; \}/, "Markup's Add to chat and Back to image at the bottom");
  assert.match(css, /\.cdx-markup-stage \{[^}]*padding: 64px 80px 72px;/, "the marked image stays clear of them");
});

test("a press anywhere but the image and its controls closes the preview, and the chat shows through", () => {
  assert.match(view, /role="dialog" aria-modal="true" aria-label="Image preview" onPointerDown=\{dismiss\}/, "on the whole overlay, the zoom pill's row included");
  assert.match(view, /target\.closest\("img, button, \.cdx-zoom-pill"\)\) return;/);
  assert.match(view, /event\.clientX >= rect\.left \+ box\.clientWidth \|\| event\.clientY >= rect\.top \+ box\.clientHeight\) return;/, "a zoomed image's scrollbars only scroll");
  assert.match(css, /\.cdx-preview \{[^}]*background: rgb\(0 0 0 \/ \.75\);/);
});
