// ---------------------------------------------------------------------------
// Per-TURN attachments on the chat transcript (M-T8.19).
//
// The display bubbles are FOLDED from the raw transcript on every render
// (`foldTranscript`), so anything the playground knows that the model does not
// — the plan awaiting approval, the turn's receipt, the commit it produced,
// the loop guard's stop signal — cannot live on a bubble: the next fold would
// erase it.  It lives in a parallel array indexed by turn, and is grafted back
// on at render time by `attachTurnExtras`.
//
// Pure: an array in, an array out.  Both halves are unit-testable without
// React.
// ---------------------------------------------------------------------------

import type { AgentMessage } from "./demo.js";
import type { AgentPlan } from "./plan.js";
import type { TurnReceipt } from "./receipt.js";

/** The plan card's lifecycle.  `pending` is the only state that blocks the
 *  turn; the other two are the record of what the user decided. */
export type PlanCardState = "pending" | "approved" | "rejected";

/** One turn's plan card — the delta plus the verdict. */
export interface PlanCard {
  plan: AgentPlan;
  state: PlanCardState;
  /** Node addresses the user removed from the checklist before approving. */
  excluded: string[];
}

/** Everything the playground attaches to a turn.  Grows one field per slice
 *  (receipt, checkpoint, stuck) — each is optional, so a turn that produced
 *  none of them renders exactly as it did before. */
/** The commit a turn produced, and the human name of the point it marks.
 *  Restoring to it is itself a commit, so it is undoable (slice 4). */
export interface TurnCheckpoint {
  oid: string;
  /** "the end of turn 2" — what a Restore from this message lands on. */
  point: string;
}

export interface TurnExtras {
  plan?: PlanCard;
  /** What the turn actually did, computed by the playground rather than
   *  claimed by the model (slice 3). */
  receipt?: TurnReceipt;
  /** The labelled commit this turn's write produced (slice 4). */
  checkpoint?: TurnCheckpoint;
}

/** Graft `extras[n]` onto the LAST bubble of turn `n`.
 *
 *  A turn starts at each `you` bubble (every send appends exactly one), so the
 *  turn index is the running count of user bubbles minus one; the attachment
 *  point is the last bubble before the next user bubble — the assistant's
 *  closing turn when there is one, the user bubble itself when the model has
 *  not answered yet.  Bubbles are copied, never mutated. */
export function attachTurnExtras(
  bubbles: readonly AgentMessage[],
  extras: readonly (TurnExtras | undefined)[],
): AgentMessage[] {
  if (extras.length === 0) return bubbles as AgentMessage[];
  const lastOfTurn = new Map<number, number>();
  let turn = -1;
  bubbles.forEach((b, i) => {
    if (b.role === "user") turn++;
    if (turn >= 0) lastOfTurn.set(turn, i);
  });

  const out = [...bubbles];
  for (const [t, i] of lastOfTurn) {
    const e = extras[t];
    if (e && Object.keys(e).length > 0) out[i] = { ...out[i], extras: e };
  }
  return out;
}

/** Immutably set one turn's extras, growing the array as needed. */
export function withTurnExtras(
  extras: readonly (TurnExtras | undefined)[],
  turn: number,
  patch: TurnExtras,
): (TurnExtras | undefined)[] {
  const next = [...extras];
  while (next.length <= turn) next.push(undefined);
  next[turn] = { ...next[turn], ...patch };
  return next;
}
