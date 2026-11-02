// Codex desktop's image Markup (26.1016: its ImageMarkupEditor, sketch engine and export), ported:
// marks drawn over an image in the image's own pixels, burned into a PNG for the agent, and a line
// per numbered pin saying where it is and what the person wrote there.

/** A mark, in the image's natural pixels. Widths and pin sizes are fixed when drawn (screen px at that zoom). */
export type MarkupMark =
  | { kind: "pen"; points: [number, number][]; color: string; width: number }
  | { kind: "line" | "arrow" | "rectangle" | "ellipse"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: "comment"; x: number; y: number; size: number; text: string };

export type MarkupTool = "comment" | "pen" | "line" | "arrow" | "rectangle" | "ellipse";
export type MarkupShape = Extract<MarkupMark, { x1: number }>;

/** Codex's editor defaults (verbatim): red pen, 4 screen px. */
export const MARKUP_DEFAULTS = { tool: "pen" as MarkupTool, color: "#dc2626", widthPx: 4, pinPx: 24 };
/** Codex's colour presets in order; in dark mode the first is white. */
export const MARKUP_COLORS = ["#000000", "#6b7280", "#92400e", "#dc2626", "#f97316", "#f59e0b", "#16a34a", "#0d9488", "#06b6d4", "#2563eb", "#4f46e5", "#9333ea", "#db2777"];
export const MARKUP_COLOR_NAMES = ["black", "gray", "brown", "red", "orange", "yellow", "green", "teal", "cyan", "blue", "indigo", "purple", "pink"];
/** Codex refuses Markup on images over 20 megapixels. */
export const MARKUP_MAX_PIXELS = 20_000_000;

/** The preview dialog's zoom steps (Codex's ramp, verbatim) with the fit value among them. */
const ZOOM_RAMP = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
export function zoomSteps(fit: number): number[] {
  return [...new Set([...ZOOM_RAMP, Math.round(fit)])].sort((a, b) => a - b);
}
export function zoomStep(current: number, fit: number, direction: 1 | -1): number {
  const steps = zoomSteps(fit);
  const next = direction > 0 ? steps.find((step) => step > current + 0.5) : [...steps].reverse().find((step) => step < current - 0.5);
  return next ?? (direction > 0 ? steps[steps.length - 1] : steps[0]);
}
export const clampZoom = (value: number, fit: number) => { const steps = zoomSteps(fit); return Math.min(steps[steps.length - 1], Math.max(steps[0], value)); };

/** Shift while dragging: equal sides for box shapes, 45° steps for a line or an arrow (Codex's). */
export function constrainShape(kind: MarkupShape["kind"], x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  if (kind === "line" || kind === "arrow") {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy);
    return [x1 + Math.cos(angle) * length, y1 + Math.sin(angle) * length];
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [x1 + Math.sign(dx || 1) * side, y1 + Math.sign(dy || 1) * side];
}

/** The pins in document order, numbered from 1 as the picture shows them. */
export const markupPins = (marks: MarkupMark[]) => marks.filter((mark): mark is Extract<MarkupMark, { kind: "comment" }> => mark.kind === "comment");

/** Draws every mark onto a context already scaled to the image's pixels (the export and the editor). */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: MarkupMark[]) {
  let pin = 0;
  for (const mark of marks) {
    ctx.save();
    if (mark.kind === "comment") {
      pin += 1;
      // Codex's burned-in pin: a #111827 dot, a white ring, the number in white, weight 600.
      const r = mark.size / 2;
      ctx.beginPath(); ctx.arc(mark.x, mark.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#111827"; ctx.fill();
      ctx.lineWidth = r / 3; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      ctx.fillStyle = "#ffffff"; ctx.font = `600 ${mark.size / 2}px sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(pin), mark.x, mark.y + mark.size * 0.02);
      ctx.restore();
      continue;
    }
    ctx.strokeStyle = mark.color; ctx.lineWidth = mark.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    if (mark.kind === "pen") {
      const [first, ...rest] = mark.points;
      if (!first) { ctx.restore(); continue; }
      ctx.moveTo(first[0], first[1]);
      if (!rest.length) ctx.lineTo(first[0] + 0.01, first[1]);
      // Through the midpoints, so a mouse stroke reads as a line and not as a polygon.
      for (let i = 0; i < rest.length - 1; i += 1) {
        const [x, y] = rest[i], [nx, ny] = rest[i + 1];
        ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      if (rest.length) ctx.lineTo(rest[rest.length - 1][0], rest[rest.length - 1][1]);
    } else if (mark.kind === "rectangle") {
      ctx.rect(Math.min(mark.x1, mark.x2), Math.min(mark.y1, mark.y2), Math.abs(mark.x2 - mark.x1), Math.abs(mark.y2 - mark.y1));
    } else if (mark.kind === "ellipse") {
      ctx.ellipse((mark.x1 + mark.x2) / 2, (mark.y1 + mark.y2) / 2, Math.abs(mark.x2 - mark.x1) / 2, Math.abs(mark.y2 - mark.y1) / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(mark.x1, mark.y1); ctx.lineTo(mark.x2, mark.y2);
      if (mark.kind === "arrow") {
        // Two strokes at ±30°, as long as clamp(width × 3, 12, 0.6 × length) (Codex's arrowhead).
        const length = Math.hypot(mark.x2 - mark.x1, mark.y2 - mark.y1);
        const head = Math.min(Math.max(mark.width * 3, 12), 0.6 * length);
        const angle = Math.atan2(mark.y2 - mark.y1, mark.x2 - mark.x1);
        for (const side of [-1, 1]) {
          ctx.moveTo(mark.x2, mark.y2);
          ctx.lineTo(mark.x2 - head * Math.cos(angle + side * Math.PI / 6), mark.y2 - head * Math.sin(angle + side * Math.PI / 6));
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}

/** One coordinate as Codex writes it: a share of the image, clamped to 0-100 %, one decimal. */
export const markupPercent = (value: number) => `${(Math.min(Math.max(value, 0), 1) * 100).toFixed(1)}%`;

/**
 * Lines telling the agent about the circled and boxed areas, which Codex's text leaves out (only its
 * pins have lines). Pins already say where they are; these make a circle as clear without one.
 */
export function shapeLines(marks: MarkupMark[], width: number, height: number): string[] {
  // TODO(human): describe the ellipses/rectangles/arrows for the agent.
  void marks; void width; void height;
  return [];
}

/**
 * The text that goes ahead of the person's message (Codex's export, verbatim for the pins):
 * "1. (x: 12.3%, y: 45.6%) comment", one line per pin at its centre, then the shape lines.
 */
export function markupPrompt(marks: MarkupMark[], width: number, height: number): string {
  const pins = markupPins(marks).map((pin, index) => `${index + 1}. (x: ${markupPercent(pin.x / width)}, y: ${markupPercent(pin.y / height)}) ${pin.text}`.trimEnd());
  return [pins.join("\n"), shapeLines(marks, width, height).join("\n")].filter((part) => part.length > 0).join("\n\n");
}

/** A sent message shows its pin lines without the coordinates, as Codex shows them ("1. comment"). */
export const markupReadable = (text: string) => text.replace(/^(\d+)\. \(x: \d{1,3}\.\d%, y: \d{1,3}\.\d%\) /gm, "$1. ");

/** The image with every mark burned in, at its natural size, as PNG bytes. */
export async function exportMarkup(image: HTMLImageElement, marks: MarkupMark[]): Promise<Uint8Array> {
  const width = image.naturalWidth, height = image.naturalHeight;
  if (width * height > MARKUP_MAX_PIXELS) throw new Error("This image is too large to mark up");
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare markup. Try again");
  ctx.drawImage(image, 0, 0, width, height);
  drawMarks(ctx, marks);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not prepare markup. Try again");
  return new Uint8Array(await blob.arrayBuffer());
}
