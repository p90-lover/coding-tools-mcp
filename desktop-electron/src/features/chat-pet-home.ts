/**
 * Clawd's life inside its house: where each piece of furniture is, how it gets there (along a floor,
 * up or down the ladder between the storeys, a hop onto the bed, a chair or into the tub), and the
 * beats of each chore. Pure, so the routines can be read and tested without the pet's timers.
 *
 * Positions are in the house's pixels (40 × 20, see ChatPet's HouseInside). At home Clawd is drawn at
 * half size, one house pixel per glyph cell, 9 wide and 3 tall, so the furniture can be Clawd-sized:
 * full size it was 18 × 6, as tall as a whole storey and twice as wide as its bed.
 */

export type Storey = "down" | "up";
/** Each storey's floor line: the house row its feet stand on (the bottom edge of that row's floor). */
export const FLOOR_LINE: Record<Storey, number> = { down: 20, up: 13 };
/** Where its feet are: a column (its middle), a storey, and how many rows up off the floor. */
export type HomePlace = { x: number; storey: Storey; lift: number };

export type Chore = "sleep" | "cook" | "snack" | "bath" | "work" | "read" | "window";
export const CHORES: readonly Chore[] = ["sleep", "cook", "snack", "bath", "work", "read", "window"];
/** What it is doing in a beat: moving, or using a piece of furniture. */
export type Doing = "stand" | "walk" | "climb" | "hop" | "sleep" | "cook" | "serve" | "eat" | "fridge" | "snack"
  | "bath" | "work" | "read" | "window";
export type HomeBeat = HomePlace & {
  doing: Doing;
  look: -1 | 0 | 1;
  /** How long the beat lasts (ms); a move takes this long to get there. */
  ms: number;
  say?: string;
  float?: string;
  /** Food left on the plate or cookie (3 whole, 0 eaten). */
  bites?: number;
};

/** Through the open front into the middle of the ground floor, clear of every piece in front of it. */
export const ENTRY: HomePlace = { x: 26, storey: "down", lift: 0 };
/** The ladder between the storeys, through a hatch in the upstairs floor. */
export const LADDER_X = 14;
/** One column of walking, and the climb and hop. */
const WALK_MS = 150;
const CLIMB_MS = 1500;
const HOP_MS = 450;

/**
 * Where it stands to use each piece: its spot, which way it faces, and how high the piece lifts it
 * (into the bed, onto the desk chair, into the tub).
 */
export const SPOTS: Record<Chore | "eat", HomePlace & { look: -1 | 0 | 1 }> = {
  sleep: { x: 8, storey: "down", lift: 2, look: 0 },
  // On its chair at the table and the desk: lifted so its head clears their tops, which stand in
  // front of it.
  eat: { x: 18.5, storey: "down", lift: 2, look: 0 },
  cook: { x: 26, storey: "down", lift: 0, look: 1 },
  snack: { x: 29, storey: "down", lift: 0, look: 1 },
  bath: { x: 7, storey: "up", lift: 1, look: 0 },
  read: { x: 15.5, storey: "up", lift: 0, look: 0 },
  work: { x: 23, storey: "up", lift: 2, look: 1 },
  window: { x: 33, storey: "up", lift: 0, look: 0 },
};

const sameFloor = (a: HomePlace, b: HomePlace) => a.storey === b.storey;
const walk = (from: HomePlace, x: number): HomeBeat[] => from.x === x ? []
  : [{ x, storey: from.storey, lift: 0, doing: "walk", look: x < from.x ? -1 : 1, ms: Math.max(250, Math.round(Math.abs(x - from.x) * WALK_MS)) }];

/**
 * The moves from `from` to standing at `to` (on its floor, not yet lifted): down off what it is on,
 * along to the ladder and up or down it when the storeys differ, then along to the spot.
 */
export function pathBeats(from: HomePlace, to: HomePlace): HomeBeat[] {
  const beats: HomeBeat[] = [];
  let at: HomePlace = from;
  if (at.lift) {
    beats.push({ ...at, lift: 0, doing: "hop", look: 0, ms: HOP_MS });
    at = { ...at, lift: 0 };
  }
  if (!sameFloor(at, to)) {
    beats.push(...walk(at, LADDER_X));
    at = { x: LADDER_X, storey: to.storey, lift: 0 };
    beats.push({ ...at, doing: "climb", look: 0, ms: CLIMB_MS });
  }
  beats.push(...walk(at, to.x));
  return beats;
}

const settle = (spot: HomePlace & { look: -1 | 0 | 1 }): HomeBeat[] =>
  spot.lift ? [{ ...spot, doing: "hop", ms: HOP_MS }] : [];
const at = (spot: HomePlace & { look: -1 | 0 | 1 }, doing: Doing, ms: number, extra: Partial<HomeBeat> = {}): HomeBeat =>
  ({ x: spot.x, storey: spot.storey, lift: spot.lift, look: spot.look, doing, ms, ...extra });

/**
 * A chore from wherever it stands: the way there, then its beats. Sleep ends in bed (the pet stays
 * asleep there until woken); every other chore ends standing, ready for the next.
 */
export function choreBeats(chore: Chore, from: HomePlace): HomeBeat[] {
  const spot = SPOTS[chore];
  const there = [...pathBeats(from, spot), ...settle(spot)];
  switch (chore) {
    case "sleep":
      return [...there, at(spot, "sleep", 700, { say: "Night night" })];
    case "cook": {
      const table = SPOTS.eat;
      return [...there,
        at(spot, "cook", 1400, { say: "Something tasty…" }), at(spot, "cook", 1400), at(spot, "cook", 1400, { float: "♨" }),
        // Over to the table with the plate held up, up onto its chair, three bites, and down again.
        { ...table, lift: 0, look: -1, doing: "serve", ms: Math.round((spot.x - table.x) * WALK_MS * 1.5) },
        { ...table, doing: "hop", ms: HOP_MS },
        at(table, "eat", 900, { bites: 3 }), at(table, "eat", 900, { bites: 2, float: "nom" }),
        at(table, "eat", 900, { bites: 1, float: "nom" }), at(table, "eat", 900, { bites: 0, float: "♥", say: "Yum!" }),
        { ...table, lift: 0, doing: "hop", ms: HOP_MS }];
    }
    case "snack":
      return [...there, at(spot, "fridge", 1200, { say: "Snack time" }), at(spot, "snack", 800, { bites: 3 }),
        at(spot, "snack", 800, { bites: 2, float: "nom" }), at(spot, "snack", 800, { bites: 1, float: "nom" }),
        at(spot, "stand", 500, { bites: 0 })];
    case "bath":
      return [...there, at(spot, "bath", 1500, { say: "Bath time!" }), at(spot, "bath", 1500), at(spot, "bath", 1500),
        { ...spot, lift: 0, doing: "hop", ms: HOP_MS }, at({ ...spot, lift: 0 }, "stand", 900, { say: "Squeaky clean" })];
    case "work":
      return [...there, at(spot, "work", 1600), at(spot, "work", 1600, { say: "Shipping it" }), at(spot, "work", 1600),
        { ...spot, lift: 0, doing: "hop", ms: HOP_MS }];
    case "read":
      return [...there, at(spot, "read", 2200), at(spot, "read", 2200, { say: "Good book" })];
    case "window":
      return [...there, at(spot, "window", 1800, { say: "Nice day out" }), at(spot, "window", 1800, { float: "♪" })];
  }
}

/** Back to the entry from wherever it is (out of bed, down the ladder), to go out through the front. */
export const exitBeats = (from: HomePlace): HomeBeat[] => pathBeats(from, ENTRY);

/** What it has done lately, for choosing its next chore. */
export type HomeMemory = {
  /** The chore it just finished, if any. */
  last: Chore | null;
  /** Chores since it last ate (cooked or snacked). */
  sinceMeal: number;
  /** The local hour, 0-23. */
  hour: number;
};

/**
 * Which chore Clawd takes up next while it is home and awake. Sleep is never picked here: it goes to
 * bed when the chat is quiet long enough (ChatPet's nap), or when you click the bed.
 */
export function pickChore(memory: HomeMemory, random: () => number = Math.random): Exclude<Chore, "sleep"> {
  const { last, sinceMeal, hour } = memory;
  const day = hour >= 8 && hour < 19;
  const late = hour >= 21 || hour < 6;
  // Hungrier the longer since it ate; busier at its desk by day, reading and stargazing late.
  const weights: Record<Exclude<Chore, "sleep">, number> = {
    cook: 1 + Math.min(sinceMeal, 4),
    snack: 1 + Math.min(sinceMeal, 4) / 2,
    bath: late ? 3 : 1,
    work: day ? 3 : 1,
    read: late ? 3 : 2,
    window: late ? 2 : 1.5,
  };
  // The same chore twice running looked like a stutter.
  const choices = (Object.keys(weights) as Exclude<Chore, "sleep">[]).filter((chore) => chore !== last);
  let roll = random() * choices.reduce((total, chore) => total + weights[chore], 0);
  for (const chore of choices) {
    roll -= weights[chore];
    if (roll < 0) return chore;
  }
  return choices.at(-1)!;
}
