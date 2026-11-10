import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { CELL_H, CELL_W } from "./Clawd";
import type { Chore, Doing } from "./chat-pet-home";

// Clawd's house: a small cottage standing beside the chat box (or in the yard under the chat list),
// and, when you click it, a peek inside at the doll's house where Clawd sleeps, cooks, bathes and
// works (chat-pet-home.ts). The house used to be that doll's house itself, 160 × 160 px with its
// front open, standing on the chat box's top edge over the last messages whenever the window left no
// room beside the box (the user, 2026-11-10: "its house blocking the screen"). The cottage is 88 × 64,
// never taller than the box beside it, and the rooms show only while you look in.

/** Props and the house are drawn in Clawd's own pixels: half a terminal cell, twice as tall as wide. */
export const PIXEL_W = CELL_W / 2;
export const PIXEL_H = CELL_H / 2;

export const P = { frame: "#3d3d3a", screen: "#1f2a33", glow: "#7fd1ff", key: "#b4b2a7", mug: "#efede6", rim: "#8c8a82", steam: "#c9c7bd",
  page: "#faf9f5", cover: "#6a9bcc", wood: "#8a5a3c", metal: "#5b5a55", lens: "#bfe3f5", box: "#c8a26b", boxDark: "#9b7a48",
  roof: "#b85c3f", roofEdge: "#8f4430", wall: "#e3cfa6", wallEdge: "#b89b6a", door: "#5a3a26", knob: "#f5c451",
  glass: "#3d5a73", lit: "#f5c451", frameLight: "#faf9f5", doorway: "#2a1f18",
  // The rooms: walls a shade darker than the house's outside, so the furniture stands out against them.
  inside: "#cfb586", insideEdge: "#a8895a", floor: "#8a5a3c", plank: "#74482e", rug: "#4f7fb3", rugEdge: "#c0563f",
  shelf: "#5a3a26", sky: "#9fd3f0", leaf: "#5f9a4c", leafDark: "#3f7a34",
  // The washroom's tiles and porcelain, the bed's linen, and the kitchen's fridge and flame.
  tile: "#cfe3ea", tileEdge: "#a9c6d1", porcelain: "#f4f3ee", porcelainEdge: "#c9c7bd", water: "#6fb3dc",
  blanket: "#6a9bcc", pillow: "#faf9f5", fridge: "#e8ebe6", flame: "#e8743b",
  // Home life: the turned-down blanket, the open fridge's light, the night sky, a cookie and its chips,
  // and the stew it cooks.
  blanketFold: "#9cc0e4", fridgeLight: "#fff6d6", night: "#22314a", cookie: "#c08a4a", chip: "#5a3a26", stew: "#c0563f" };

export const rect = (x: number, y: number, w: number, h: number, color: string, key: string) =>
  <rect key={key} x={x} y={y} width={w} height={h} fill={color} />;

/** What the house shows: whether Clawd is in, asleep, what it is doing there, and the beat it is on. */
export type HomeView = { home: boolean; asleep: boolean; doing: Doing | null; tick: number; step: boolean; bites: number };

/** The cottage: 22 × 8 of Clawd's pixels, 88 × 64 px. */
const COTTAGE_COLS = 22;
const COTTAGE_ROWS = 8;
export const COTTAGE_W = COTTAGE_COLS * PIXEL_W;
export const COTTAGE_H = COTTAGE_ROWS * PIXEL_H;
/** The middle of its door, px from its left: where Clawd goes in and comes out. */
export const DOOR_X = 14.5 * PIXEL_W;
/** How small Clawd gets going through the door, which is 20 px wide to its 72. */
export const DOOR_SCALE = 0.28;

/** The window's light: dark while Clawd is out, the lamp while it is up, the laptop's glow at work, night asleep. */
function windowLight({ home, asleep, doing }: Pick<HomeView, "home" | "asleep" | "doing">) {
  if (!home) return P.glass;
  if (asleep) return P.night;
  if (doing === "work") return P.glow;
  if (doing === "bath") return P.water;
  return P.lit;
}

/**
 * Clawd's cottage from outside: a clay roof with its chimney, a window and a door. It shows what
 * Clawd is up to in it: the window lit while it is home (the laptop's blue while it works, night
 * while it sleeps, with z's over the roof), smoke from the chimney while it cooks, and the door
 * open while it goes in or comes out. Click it to look inside (and to call Clawd home if it is out).
 */
export function Cottage({ home, asleep, doing, open, peeking, style, onClick }: Pick<HomeView, "home" | "asleep" | "doing"> & {
  open: boolean; peeking: boolean; style?: CSSProperties; onClick: () => void;
}) {
  const r = rect;
  const lit = home && !asleep;
  const parts: ReactElement[] = [
    // The roof in three courses, wider each row down, with the chimney on its right slope.
    r(8, 0, 6, 1, P.roof, "roof-0"), r(4, 1, 14, 1, P.roof, "roof-1"),
    ...[7, 11, 15].map((x) => r(x, 1, 1, 1, P.roofEdge, `shingle-${x}`)),
    r(0, 2, 22, 1, P.roofEdge, "eave"), r(16, 0, 2, 2, P.roofEdge, "chimney"),
    // The walls, edged darker at the corners.
    r(1, 3, 20, 5, P.wall, "walls"), r(1, 3, 1, 5, P.wallEdge, "corner-l"), r(20, 3, 1, 5, P.wallEdge, "corner-r"),
    // The window with its frame and sill.
    r(3, 4, 6, 3, P.frameLight, "window-frame"), r(4, 4, 4, 2, windowLight({ home, asleep, doing }), "window"),
    ...(lit ? [r(4, 4, 1, 1, P.fridgeLight, "window-shine")] : []),
    // The door in its frame: shut, its panel and knob; open, the dark doorway, lit at the floor while
    // Clawd is home, and the door swung out against the wall.
    r(11, 3, 7, 5, P.shelf, "door-frame"),
    ...(open
      ? [r(12, 4, 5, 4, P.doorway, "doorway"), ...(lit ? [r(12, 7, 5, 1, P.wood, "doorway-floor")] : []), r(18, 4, 1, 4, P.door, "door-open")]
      : [r(12, 4, 5, 4, P.door, "door"), r(14, 4, 1, 4, P.plank, "door-panel"), r(15, 6, 1, 1, P.knob, "knob")]),
    // A bush by the door.
    r(19, 6, 2, 2, P.leaf, "bush"), r(20, 7, 1, 1, P.leafDark, "bush-shade"), r(19, 6, 1, 1, P.rugEdge, "flower"),
  ];
  const label = home ? (asleep ? "Clawd's house: Clawd is napping inside" : "Clawd's house: Clawd is home") : "Clawd's house";
  return <button type="button" className={`cx-pet-cottage${home ? " is-home" : ""}${peeking ? " is-peeking" : ""}`} style={style}
    title={home ? "Look inside Clawd's house" : "Clawd's house. Click to look inside and call Clawd home"} aria-label={label}
    aria-expanded={peeking} onClick={onClick}>
    <svg viewBox={`0 0 ${COTTAGE_COLS} ${COTTAGE_ROWS}`} width={COTTAGE_W} height={COTTAGE_H} preserveAspectRatio="none" aria-hidden="true"
      shapeRendering="crispEdges">{parts}</svg>
    {home && doing === "cook" ? <span className="cx-pet-cottage-smoke" aria-hidden="true"><span /><span /><span /></span> : null}
    {home && asleep ? <span className="cx-pet-house-z cx-pet-cottage-z" aria-hidden="true"><span>z</span><span>z</span><span>Z</span></span> : null}
  </button>;
}

/** The doll's house: 40 × 20 of Clawd's pixels, two storeys under the roof, its front open. */
const HOUSE_COLS = 40;
const HOUSE_ROWS = 20;
export const HOUSE_W = HOUSE_COLS * PIXEL_W;
export const HOUSE_H = HOUSE_ROWS * PIXEL_H;

const houseSvg = (parts: ReactElement[]) =>
  <svg viewBox={`0 0 ${HOUSE_COLS} ${HOUSE_ROWS}`} width={HOUSE_W} height={HOUSE_H} preserveAspectRatio="none" aria-hidden="true"
    shapeRendering="crispEdges">{parts}</svg>;

/**
 * Inside the house, drawn behind Clawd: its rooms. Clawd is half size in here, as wide as its bed
 * (chat-pet-home.ts), and uses everything:
 * - downstairs (rows 13-19): its bed with a lamp, a ladder up through a hatch, the table it eats at
 *   under a framed landscape, and the kitchen: a stove whose pot bubbles while it cooks, and a
 *   fridge that opens, lit inside, for a snack;
 * - upstairs (rows 6-12): a tiled washroom with a tub it bathes in, the bookshelf it reads from,
 *   the desk with a laptop it works at, and a window, sky by day and the moon while it sleeps.
 * The lamp, laptop and window light up while it is home and awake.
 */
export function HouseRooms({ home, asleep, doing, tick, step }: HomeView) {
  const r = rect;
  const lit = home && !asleep;
  const cooking = home && doing === "cook";
  const fridgeOpen = home && doing === "fridge";
  const working = home && doing === "work";
  return houseSvg([
    // Upstairs: back wall with a skirting board, and its planked floor (the ground floor's ceiling)
    // with the hatch the ladder comes up through.
    r(3, 6, 34, 6, P.inside, "up-back"), r(3, 11, 34, 1, P.insideEdge, "up-skirting"),
    r(3, 12, 10, 1, P.floor, "up-floor-l"), r(16, 12, 21, 1, P.floor, "up-floor-r"),
    ...[6, 20, 26, 33].map((x) => r(x, 12, 1, 1, P.plank, `up-plank${x}`)),
    // The washroom (columns 3-11), tiled, under a lintel: a mirror, a towel on its rail, the tap and
    // the tub's back (its front stands in front of Clawd, in HouseFront).
    r(3, 6, 9, 6, P.tile, "bath-tiles"), ...[5, 8].map((x) => r(x, 8, 1, 1, P.tileEdge, `bath-grout${x}`)),
    r(12, 6, 1, 2, P.wallEdge, "bath-lintel"),
    r(4, 6, 3, 2, P.frameLight, "mirror-frame"), r(5, 7, 1, 1, P.lens, "mirror"),
    r(9, 7, 2, 1, P.metal, "towel-rail"), r(10, 7, 1, 2, P.rugEdge, "towel"),
    r(3, 8, 1, 1, P.metal, "tub-tap"), r(3, 9, 9, 1, P.porcelainEdge, "tub-back"),
    // The study: the bookshelf with a plant on top, and the window, sky by day, the moon at night.
    r(15, 7, 4, 5, P.shelf, "shelf"),
    r(15, 8, 1, 1, P.cover, "book-1"), r(16, 8, 1, 1, P.roof, "book-2"), r(17, 8, 1, 1, P.knob, "book-3"),
    r(15, 10, 1, 1, P.leaf, "book-4"), r(16, 10, 1, 1, P.page, "book-5"), r(17, 10, 1, 1, P.cover, "book-6"),
    r(15, 6, 3, 1, P.leaf, "plant"), r(16, 6, 1, 1, P.leafDark, "plant-middle"),
    r(31, 7, 5, 3, P.frameLight, "window-frame"), r(32, 8, 3, 1, home && asleep ? P.night : P.sky, "window"),
    ...(home && asleep ? [r(34, 8, 1, 1, P.knob, "moon")] : [r(32, 8, 1, 1, P.page, "cloud")]),
    // Downstairs: back wall with a skirting board, a planked floor and a rug in the middle.
    r(3, 13, 34, 6, P.inside, "back"), r(3, 18, 34, 1, P.insideEdge, "skirting"), r(3, 19, 34, 1, P.floor, "floor"),
    ...[5, 9, 31, 35].map((x) => r(x, 19, 1, 1, P.plank, `plank${x}`)),
    r(23, 19, 6, 1, P.rug, "rug"), r(23, 19, 1, 1, P.rugEdge, "rug-l"), r(28, 19, 1, 1, P.rugEdge, "rug-r"),
    // The ladder, from the floor up through the hatch.
    r(13, 10, 1, 10, P.wood, "ladder-l"), r(15, 10, 1, 10, P.wood, "ladder-r"),
    ...[11, 13, 15, 17].map((y) => r(14, y, 1, 1, P.wood, `rung${y}`)),
    // A framed landscape over the table.
    r(17, 13, 5, 3, P.wood, "picture"), r(18, 14, 3, 1, P.sky, "picture-sky"), r(19, 14, 1, 1, P.leaf, "picture-hill"),
    // The bed, head to the wall: headboard, a mattress and its pillow, a footboard, and the lamp over
    // it (on while Clawd is up). The blanket is in HouseFront, over Clawd when it is tucked in.
    r(3, 14, 1, 6, P.shelf, "bed-head"), r(4, 18, 8, 1, P.porcelain, "mattress"), r(4, 19, 8, 1, P.wood, "bed-frame"),
    r(4, 17, 2, 1, P.pillow, "pillow"), r(12, 17, 1, 3, P.shelf, "bed-foot"),
    r(5, 13, 1, 1, lit ? P.lit : P.porcelainEdge, "bed-lamp"),
    // The stove: a pot on the hob, its lid lifting and steam rising while Clawd cooks over the flame.
    r(30, 18, 4, 2, P.metal, "stove"), r(31, 18, 2, 1, P.glass, "oven-door"), r(30, 17, 4, 1, P.frame, "hob"),
    r(31, 15, 2, 2, P.metal, "pot"), r(31, cooking && step ? 14 : 15, 2, 1, P.rim, "pot-lid"),
    ...(cooking ? [r(31, 17, 2, 1, P.flame, "flame"), r(31 + (tick % 2), 13, 1, 1, P.steam, "pot-steam")] : []),
    // The fridge: shut, its two doors and handles; open, lit inside with milk, an apple and the cookie
    // jar, its door swung out to the left.
    ...(fridgeOpen
      ? [r(34, 13, 3, 7, P.fridgeLight, "fridge-inside"), r(34, 15, 3, 1, P.porcelainEdge, "fridge-shelf-1"),
        r(34, 17, 3, 1, P.porcelainEdge, "fridge-shelf-2"), r(35, 13, 1, 2, P.page, "milk"), r(34, 14, 1, 1, P.roof, "apple"),
        r(36, 16, 1, 1, P.cookie, "cookie-jar"), r(33, 13, 1, 7, P.fridge, "fridge-door-open")]
      : [r(34, 13, 3, 7, P.fridge, "fridge"), r(34, 15, 3, 1, P.porcelainEdge, "fridge-door"),
        r(34, 14, 1, 1, P.metal, "fridge-handle-1"), r(34, 17, 1, 1, P.metal, "fridge-handle-2")]),
    // The desk chair's back, behind Clawd at the desk.
    r(21, 8, 1, 2, P.shelf, "chair-back"),
    // The laptop's screen faces Clawd, lines of code running down it while it works.
    ...(working ? [r(27 + (tick % 2), 7, 1, 1, P.glow, "screen-line")] : []),
  ]);
}

/** Furniture you can click: the chore Clawd goes there to do, and where it stands (house pixels). */
export const FURNITURE: readonly { chore: Chore; label: string; x: number; y: number; w: number; h: number }[] = [
  { chore: "sleep", label: "the bed: Clawd tucks itself in for a nap", x: 3, y: 14, w: 10, h: 6 },
  { chore: "cook", label: "the table: Clawd cooks something and eats it here", x: 16, y: 15, w: 6, h: 5 },
  { chore: "cook", label: "the stove: Clawd cooks something and eats it at the table", x: 30, y: 14, w: 4, h: 6 },
  { chore: "snack", label: "the fridge: Clawd grabs a cookie", x: 33, y: 13, w: 4, h: 7 },
  { chore: "bath", label: "the tub: Clawd takes a bath", x: 3, y: 8, w: 9, h: 5 },
  { chore: "read", label: "the bookshelf: Clawd reads a book", x: 15, y: 6, w: 4, h: 6 },
  { chore: "work", label: "the desk: Clawd works on its laptop", x: 21, y: 7, w: 9, h: 6 },
  { chore: "window", label: "the window: Clawd looks outside", x: 31, y: 7, w: 5, h: 3 },
];

/**
 * The house's front, drawn over Clawd: a clay roof with its chimney, the side walls, the front wall
 * swung open on its hinge at the left, and the furniture Clawd gets into or behind: the blanket on
 * its bed, the table with its plate, the tub with its water and bubbles, and the desk with its
 * laptop. Each piece of furniture is a button: Clawd comes over and uses it. Asleep, z's rise over
 * its bed.
 */
export function HouseFront({ home, asleep, doing, tick, step, bites, onUse }: HomeView & { onUse: (chore: Chore) => void }) {
  const r = rect;
  const parts: ReactElement[] = [r(30, 0, 2, 3, P.roofEdge, "chimney")];
  // The roof, three pixels wider each side each row down, with an eave line under it.
  [[14, 12], [11, 18], [8, 24], [5, 30], [2, 36]].forEach(([x, w], row) => parts.push(r(x!, row, w!, 1, P.roof, `roof${row}`)));
  parts.push(r(1, 5, 38, 1, P.roofEdge, "eave"));
  // A puff from the chimney while the stove is on.
  if (home && doing === "cook") parts.push(r(30 + (tick % 2), tick % 2 ? -1 : 0, 1, 1, P.steam, "chimney-puff"));
  // The side walls, edged darker outside, up both storeys; between them the rooms are open.
  parts.push(r(2, 6, 1, 14, P.wall, "wall-l"), r(1, 6, 1, 14, P.wallEdge, "wall-l-edge"),
    r(37, 6, 1, 14, P.wall, "wall-r"), r(38, 6, 1, 14, P.wallEdge, "wall-r-edge"));
  // The front wall, swung open on its left hinge so its edge shows, with the door's knob on it.
  parts.push(r(0, 6, 1, 14, P.wall, "front"), r(0, 16, 1, 1, P.knob, "front-knob"));
  // The blanket, turned down at the pillow end: tucked in, Clawd's feet are under it.
  parts.push(r(6, 17, 6, 1, P.blanket, "blanket"), r(6, 17, 1, 1, P.blanketFold, "blanket-fold"));
  // The table, its plate with what is left of the meal while Clawd eats.
  parts.push(r(16, 17, 6, 1, P.wood, "table"), r(16, 18, 1, 2, P.wood, "table-leg-l"), r(21, 18, 1, 2, P.wood, "table-leg-r"));
  if (home && doing === "eat") {
    parts.push(r(16.5, 16, 5, 1, P.porcelain, "plate"));
    if (bites > 0) parts.push(r(17.5, 16, bites, 1, P.stew, "food"));
  }
  // The tub on its feet: its water up to the rim and bubbles round Clawd while it bathes.
  const bathing = home && doing === "bath";
  parts.push(r(3, 10, 9, 2, P.porcelain, "tub"), r(3, 10, 9, 1, bathing ? P.water : P.porcelainEdge, "tub-rim"),
    r(4, 12, 1, 1, P.metal, "tub-foot-l"), r(10, 12, 1, 1, P.metal, "tub-foot-r"));
  if (bathing) parts.push(...[3, 6, 9].map((x, index) => r(x + ((tick + index) % 2), step === (index % 2 === 0) ? 9 : 10, 1, 1, P.page, `bubble${x}`)));
  // The desk with its laptop, the screen turned to Clawd's seat.
  parts.push(r(21, 10, 9, 1, P.wood, "desk"), r(21, 11, 1, 2, P.wood, "desk-leg-l"), r(29, 11, 1, 2, P.wood, "desk-leg-r"),
    r(26, 9, 3, 1, P.key, "laptop-base"), r(28, 7, 1, 2, P.frame, "laptop-lid"));
  return <>
    <span className="cx-pet-peek-front" aria-hidden="true">{houseSvg(parts)}</span>
    {home && asleep ? <span className="cx-pet-house-z" aria-hidden="true"><span>z</span><span>z</span><span>Z</span></span> : null}
    {FURNITURE.map((piece) => <button key={`${piece.chore}-${piece.x}`} type="button" className="cx-pet-furniture"
      style={{ left: piece.x * PIXEL_W, top: piece.y * PIXEL_H, width: piece.w * PIXEL_W, height: piece.h * PIXEL_H }}
      title={piece.label} aria-label={piece.label} onClick={() => onUse(piece.chore)} />)}
  </>;
}

/**
 * A look inside the cottage, over the page beside it: the rooms, Clawd at half size where it is in
 * them (`clawd`, drawn by ChatPet), and the furniture to send it to. It closes on a click outside it
 * (the cottage's own click toggles it), on Escape, and when Clawd goes out.
 */
export function HousePeek({ view, anchor, clawd, palette, onUse, onClose }: {
  view: HomeView; anchor: () => DOMRect | null; clawd: ReactNode;
  /** The chat's colours (ChatMenu's chatPalette): drawn on <body>, the peek is outside the chat's theme. */
  palette?: CSSProperties; onUse: (chore: Chore) => void; onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const spot = anchor();
      const box = panel.current;
      if (!spot || !box) return;
      const width = box.offsetWidth, height = box.offsetHeight;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, spot.left + spot.width / 2 - width / 2));
      const above = spot.top - height - 10;
      setAt({ left: Math.round(left), top: Math.round(above >= 8 ? above : Math.min(window.innerHeight - height - 8, spot.bottom + 10)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || panel.current?.contains(target) || target.closest?.(".cx-pet-cottage")) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key); };
  }, [onClose]);
  return <div ref={panel} className="cx-pet-peek" role="dialog" aria-label="Inside Clawd's house"
    style={{ ...palette, ...(at ? { left: at.left, top: at.top } : { visibility: "hidden" }) }}>
    <div className="cx-pet-peek-head">
      <span>Clawd's house</span>
      <button type="button" className="cx-pet-peek-close" aria-label="Close" title="Close" onClick={onClose}>×</button>
    </div>
    <div className="cx-pet-peek-room">
      <HouseRooms {...view} />
      {clawd}
      <HouseFront {...view} onUse={onUse} />
    </div>
    <p className="cx-pet-peek-hint">{!view.home ? "Clawd is on its way home…" : view.asleep ? "Napping. Click Clawd to wake it." : "Click a piece of furniture to send Clawd there."}</p>
  </div>;
}
