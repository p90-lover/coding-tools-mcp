import type { PetMood } from "./ao-chat";

// Clawd in split view: one pet for every pane, not one per chat box. Each pane's chat box offers it
// a seat (its box and its chat's mood); the pet lives in one pane at a time (the host) and leaps
// across to another pane's box, where that pane's ChatPet carries on from where it landed. Its
// house stands under the chat list, not beside any pane's box (three houses and three pets over the
// goal bars and boxes, seen in split view 2026-10-23).

/** A pane's chat box and its chat's mood. */
export type PetSeat = { composer: HTMLElement; mood: PetMood };
/** Where it lands in the pane it leapt to: how far along the box's top edge (px), whether it brings
 *  the file box it carried, and what it says on landing. */
export type PetArrival = { x: number; carry: boolean; line: string };
export type PetStageEvent<K> =
  | { kind: "host" }
  | { kind: "mood"; pane: K; mood: PetMood; was: PetMood }
  | { kind: "focus"; pane: K };

/** A hand-off counts only for the pet that mounts right after it. */
const ARRIVAL_MS = 3000;
/** Panes sit down one after another as a split opens: the focused pane's box joining this soon
 *  after the pet was placed by itself still takes it (it went to whichever pane's box came first). */
const SETTLE_MS = 1000;

/** The pane the pet lives in: the one it is in while that stays open, else the focused one, else the first. */
export function petHost<K>(current: K | null, seats: readonly K[], focused: K | null): K | null {
  if (current !== null && seats.includes(current)) return current;
  if (focused !== null && seats.includes(focused)) return focused;
  return seats[0] ?? null;
}

/**
 * Whether another pane's chat calls Clawd over as its mood changes, and what it says on landing
 * there. A request waiting on you always does; a finished turn usually and a failed one sometimes
 * (`roll`, 0-1), so it does not ping-pong between busy panes.
 */
export function petCall(mood: PetMood, was: PetMood, roll: number): string | null {
  if (mood === was) return null;
  if (mood === "ask") return "Over here!";
  if (mood === "done") return roll < 0.6 ? "Done next door!" : null;
  if (mood === "error") return roll < 0.5 ? "There, there." : null;
  return null;
}

export function createPetStage<K>(now: () => number = Date.now) {
  const seats = new Map<K, PetSeat>();
  let host: K | null = null;
  let focused: K | null = null;
  let arrival: { pane: K; at: number; arrival: PetArrival } | null = null;
  // When the pet was last placed by itself rather than by a leap.
  let placedAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<(event: PetStageEvent<K>) => void>();
  const emit = (event: PetStageEvent<K>) => listeners.forEach((listener) => listener(event));
  const settle = () => {
    const next = petHost(host, [...seats.keys()], focused);
    if (next !== host) { host = next; placedAt = now(); emit({ kind: "host" }); }
  };
  return {
    host: () => host,
    focused: () => focused,
    seats: () => seats as ReadonlyMap<K, PetSeat>,
    /** A pane's box joins, or its chat's mood changes. */
    seat(pane: K, seat: PetSeat) {
      const was = seats.get(pane)?.mood;
      seats.set(pane, seat);
      settle();
      if (was === undefined && pane === focused && host !== pane && now() - placedAt < SETTLE_MS) { host = pane; emit({ kind: "host" }); }
      if (was !== undefined && was !== seat.mood) emit({ kind: "mood", pane, mood: seat.mood, was });
    },
    /** A pane closed, or its chat has no box any more (no chat open, pet hidden). */
    leave(pane: K) {
      if (!seats.delete(pane)) return;
      if (arrival?.pane === pane) arrival = null;
      settle();
    },
    focus(pane: K | null) {
      if (focused === pane) return;
      focused = pane;
      if (pane !== null) emit({ kind: "focus", pane });
      settle();
    },
    /** The pet leapt onto `pane`'s box: it lives there now. False when that pane has no seat. */
    handoff(pane: K, landing: PetArrival) {
      if (!seats.has(pane) || pane === host) return false;
      arrival = { pane, at: now(), arrival: landing };
      placedAt = Number.NEGATIVE_INFINITY;
      host = pane;
      emit({ kind: "host" });
      return true;
    },
    /** Where the pet mounting in `pane` landed, if it just leapt there. */
    arrivalFor(pane: K) {
      return arrival && arrival.pane === pane && now() - arrival.at < ARRIVAL_MS ? arrival.arrival : null;
    },
    subscribe(listener: (event: PetStageEvent<K>) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type PetStage<K> = ReturnType<typeof createPetStage<K>>;
/** The window's one stage: panes are the split grid's pane elements. */
export const petStage = createPetStage<HTMLElement>();
