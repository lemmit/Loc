// ---------------------------------------------------------------------------
// The agent's PLAN step (M-T8.19 slice 2; research §4 #3).
//
// Every AI builder surveyed grew a "plan / discuss before build" mode, because
// their unit of work is a chat turn over fifteen files and nobody can review
// that.  Loom's unit is a small text file, so the plan does not have to be
// prose the model invents: it is a **model-node delta**, derived by running
// `loom_outline` over the candidate `.ddd` and diffing it against the outline
// of what is in the editor right now.  The user approves, removes a line, or
// rejects — and only an approval writes source.
//
// This module is the PURE half: outline → outline → `PlanItem[]`, plus the
// `ModelPatch[]` that honours the lines the user removed.  No React, no
// `callTool`, no DOM — so `test/playground/agent-plan.test.ts` drives it with
// two real outlines and no model.
// ---------------------------------------------------------------------------

import type {
  ModelPatch,
  Outline,
  OutlineContext,
  OutlineDecl,
} from "../../../src/diagnostics/contract.js";

/** What a plan line does to the model. */
export type PlanChange = "add" | "change" | "remove";

/** One line of the plan — a declaration the turn would add, change or remove.
 *  `node` is the canonical patch address (`aggregate Sales.Order`), so the
 *  line is directly actionable: excluding it becomes a `ModelPatch`. */
export interface PlanItem {
  /** Canonical node address — the same address space diagnostics and
   *  `loom_apply_patch` targets use. */
  node: string;
  change: PlanChange;
  /** The declaration keyword — `aggregate`, `page`, `deployable`, … */
  kind: string;
  /** The dotted name — `Sales.Order`. */
  name: string;
  /** Member addresses this line introduces (empty for a pure removal). */
  addedMembers: string[];
  /** Member addresses this line drops. */
  removedMembers: string[];
  /** Whether removing this line from the plan can be honoured mechanically.
   *  An `add` can (delete the new declaration from the candidate) and so can a
   *  `change` that only ADDS members (delete those members); reverting a
   *  deletion would need the base declaration's source text, which the outline
   *  does not carry — so those lines are all-or-nothing, and the UI says so. */
  excludable: boolean;
}

/** A plan awaiting the user's verdict.  Carries both sides of the write so an
 *  approval needs nothing else: `candidate` is what would be written, `base`
 *  is what the editor holds now. */
export interface AgentPlan {
  items: PlanItem[];
  base: string;
  candidate: string;
  /** 1-based conversation turn this plan belongs to — the receipt and the
   *  checkpoint label the same number. */
  turn: number;
}

/** Split a canonical address into its keyword and dotted name.  `addressOf`
 *  always emits `<keyword> <segment>[.<segment>…]`; anything unexpected
 *  degrades to kind `""` rather than throwing. */
export function splitAddress(address: string): { kind: string; name: string } {
  const at = address.indexOf(" ");
  if (at < 0) return { kind: "", name: address };
  return { kind: address.slice(0, at), name: address.slice(at + 1) };
}

/** Flatten an outline to `address → member addresses`.  Declarations with no
 *  addressable members (workflows, enums, events, repositories, deployables)
 *  map to an empty list, so they still participate in add/remove detection. */
export function declMap(outline: Outline): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const putDecl = (d: OutlineDecl): void => {
    out.set(d.node, [...d.members]);
  };
  const putName = (a: string): void => {
    if (!out.has(a)) out.set(a, []);
  };
  const putContext = (c: OutlineContext): void => {
    putName(`context ${c.name}`);
    for (const d of c.aggregates) putDecl(d);
    for (const d of c.valueObjects) putDecl(d);
    for (const a of c.workflows) putName(a);
    for (const a of c.enums) putName(a);
    for (const a of c.events) putName(a);
    for (const a of c.repositories) putName(a);
  };

  for (const sys of outline.systems) {
    putName(`system ${sys.name}`);
    for (const c of sys.contexts) putContext(c);
    for (const u of sys.uis) putDecl(u);
    for (const a of sys.deployables) putName(a);
  }
  for (const c of outline.contexts) putContext(c);
  return out;
}

/** Order plan lines the way a reader scans them: additions first (that is what
 *  a turn usually is), then changes, then removals; alphabetical within a
 *  group so two runs over the same delta produce the same list. */
const CHANGE_RANK: Record<PlanChange, number> = { add: 0, change: 1, remove: 2 };

/** The model-node delta between two outlines.  A declaration present in both
 *  is a `change` line only when its member set actually moved — a re-formatted
 *  body with the same members is not a plan line. */
export function diffOutlines(before: Outline, after: Outline): PlanItem[] {
  const a = declMap(before);
  const b = declMap(after);
  const items: PlanItem[] = [];

  for (const [node, members] of b) {
    const prior = a.get(node);
    if (prior === undefined) {
      items.push({
        ...splitAddress(node),
        node,
        change: "add",
        addedMembers: [...members],
        removedMembers: [],
        excludable: true,
      });
      continue;
    }
    const priorSet = new Set(prior);
    const nextSet = new Set(members);
    const addedMembers = members.filter((m) => !priorSet.has(m));
    const removedMembers = prior.filter((m) => !nextSet.has(m));
    if (addedMembers.length === 0 && removedMembers.length === 0) continue;
    items.push({
      ...splitAddress(node),
      node,
      change: "change",
      addedMembers,
      removedMembers,
      // Only the added members can be taken back out mechanically.
      excludable: addedMembers.length > 0,
    });
  }

  for (const [node, members] of a) {
    if (b.has(node)) continue;
    items.push({
      ...splitAddress(node),
      node,
      change: "remove",
      addedMembers: [],
      removedMembers: [...members],
      excludable: false,
    });
  }

  items.sort(
    (x, y) => CHANGE_RANK[x.change] - CHANGE_RANK[y.change] || x.node.localeCompare(y.node),
  );
  return items;
}

/** Assemble the plan a turn presents. */
export function buildPlan(args: {
  before: Outline;
  after: Outline;
  base: string;
  candidate: string;
  turn: number;
}): AgentPlan {
  return {
    items: diffOutlines(args.before, args.after),
    base: args.base,
    candidate: args.candidate,
    turn: args.turn,
  };
}

/** True when the plan carries nothing to approve — the turn only read the
 *  model (or reformatted it), so there is no gate to show. */
export function planIsEmpty(plan: AgentPlan): boolean {
  return plan.items.length === 0;
}

/** The patches that honour the lines the user removed, applied to the
 *  CANDIDATE source before it is written.
 *
 *  An excluded `add` deletes the whole new declaration; an excluded `change`
 *  deletes only the members that change introduced (the rest of the
 *  declaration is untouched, which is the point — a plan line is a
 *  declaration, not a file).  Non-excludable lines contribute nothing: the UI
 *  never offers to remove them.
 *
 *  Deeper addresses come first so a batch that removes a declaration AND one
 *  of its members does not produce overlapping edits — `applyPatches` rejects
 *  overlaps atomically, so the caller must not build one.  A member of an
 *  excluded declaration is therefore dropped: the declaration removal already
 *  takes it. */
export function exclusionPatches(
  items: readonly PlanItem[],
  excluded: readonly string[],
): ModelPatch[] {
  const drop = new Set(excluded);
  const removedDecls = new Set<string>();
  const patches: ModelPatch[] = [];

  for (const item of items) {
    if (!drop.has(item.node) || !item.excludable) continue;
    if (item.change === "add") {
      removedDecls.add(item.node);
      patches.push({ op: "remove", target: item.node });
    }
  }
  for (const item of items) {
    if (!drop.has(item.node) || !item.excludable) continue;
    if (item.change !== "change") continue;
    if (removedDecls.has(item.node)) continue;
    for (const member of item.addedMembers) {
      patches.push({ op: "remove", target: member });
    }
  }
  return patches;
}

/** The one-line summary shown on the collapsed plan card and in the receipt —
 *  `2 added · 1 changed`. */
export function planSummary(items: readonly PlanItem[]): string {
  const counts: Record<PlanChange, number> = { add: 0, change: 0, remove: 0 };
  for (const i of items) counts[i.change]++;
  const parts: string[] = [];
  if (counts.add) parts.push(`${counts.add} added`);
  if (counts.change) parts.push(`${counts.change} changed`);
  if (counts.remove) parts.push(`${counts.remove} removed`);
  return parts.join(" · ");
}

/** Whether a turn is STRUCTURAL — one that adds or removes declarations
 *  rather than tweaking bodies.  The owner default for plan mode is "on for
 *  the first turn of a conversation and for any structural turn, off for
 *  follow-ups", and this is the second half of that rule. */
export function isStructural(items: readonly PlanItem[]): boolean {
  return items.some((i) => i.change !== "change");
}
