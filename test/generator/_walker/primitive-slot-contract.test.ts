// ---------------------------------------------------------------------------
// `WALKER_PRIMITIVE_SLOTS` is the MEMBERSHIP the
// `loom.page-primitive-extra-children` gate reads, so it has to stay tied to
// what the emitters actually render.
//
// It replaced a table hand-listed inside the check itself at exactly `Stat` /
// `KeyValueRow` / the op-form `Modal` — every other fixed-arity read in the
// primitive table sat outside the gate, so `EnumBadge { "x", "dropped" }` and
// `Image { "/a.png", "/dropped.png", alt: "a" }` both parsed `0 error(s)` and
// both emitted only positional 0.  Hand-listing is what let that happen, so the
// two directions that matter are pinned here:
//
//   * every primitive is CLASSIFIED — it declares a slot count or it is a
//     children container.  A new primitive can no longer land in neither
//     bucket by accident, which is how the three-entry table stayed at three;
//   * a capped primitive NAMES its slots, so the diagnostic can say what the
//     reader is allowed to pass.
//
// The counts themselves are proved behaviourally, per primitive, in
// `test/ir/page-primitive-extra-children.test.ts` — a probe body per shape,
// asserting the emitted page really drops the extra positional.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  WALKER_LAYOUT_PRIMITIVES,
  WALKER_PRIMITIVE_SLOTS,
  WALKER_SUB_PRIMITIVES,
} from "../../../src/util/walker-primitive-names.js";

/** Primitives with NO slot cap, and why each is a genuine children container.
 *  Spelled out rather than defaulted: "I forgot to classify it" and "it really
 *  takes any number of children" are the two states this gate exists to keep
 *  apart, and only a stated reason distinguishes them. */
const CHILDREN_CONTAINERS: Readonly<Record<string, string>> = {
  Stack: "vertical flow — every positional is a child",
  Group: "horizontal flow — every positional is a child",
  Grid: "every positional is a grid cell",
  Container: "centred max-width wrapper around all its children",
  Tabs: "every positional is a `Tab`",
  Tab: "positional 0 is the caption only when text-like; the rest is the panel body",
  Toolbar: "every positional is a toolbar control",
  Card: "positional 0 is the title only when text-like; the rest is the body",
  Paper: "surface wrapper around all its children",
  Breadcrumbs: "every positional is a crumb",
  Section: "landmark wrapper around all its children",
  Sticky: "position wrapper around all its children",
  Table: "every positional is a `Column`",
  DataGrid: "every positional is a `Column`",
  Modal:
    "the state-controlled shape (`open:`) walks every positional; the op-form shape is capped by its own arm in the check",
};

describe("walker primitive slot contract", () => {
  it("classifies every primitive — a slot cap or a stated container reason", () => {
    const unclassified = [...WALKER_LAYOUT_PRIMITIVES, ...WALKER_SUB_PRIMITIVES].filter(
      (n) => !WALKER_PRIMITIVE_SLOTS.has(n) && !CHILDREN_CONTAINERS[n],
    );
    expect(
      unclassified,
      "these primitives declare neither a positional slot cap nor a reason for being a children " +
        "container, so `loom.page-primitive-extra-children` cannot see them — an extra positional " +
        "on one is dropped from every frontend in silence.  Add a row to " +
        "WALKER_PRIMITIVE_SLOTS in src/util/walker-primitive-names.ts, or a reason here.",
    ).toEqual([]);
  });

  it("declares no slot cap for a name that is not a primitive", () => {
    const extra = [...WALKER_PRIMITIVE_SLOTS.keys()].filter(
      (n) => !WALKER_LAYOUT_PRIMITIVES.has(n) && !WALKER_SUB_PRIMITIVES.has(n),
    );
    expect(extra, "orphaned slot row — the primitive was renamed or removed").toEqual([]);
  });

  it("has no stale container reason (a listed name that now declares a cap)", () => {
    const stale = Object.keys(CHILDREN_CONTAINERS).filter(
      (n) =>
        WALKER_PRIMITIVE_SLOTS.has(n) ||
        (!WALKER_LAYOUT_PRIMITIVES.has(n) && !WALKER_SUB_PRIMITIVES.has(n)),
    );
    expect(stale, "stale CHILDREN_CONTAINERS entry — delete it").toEqual([]);
  });

  it("names the rendered slots wherever it caps positionals above zero", () => {
    const unnamed = [...WALKER_PRIMITIVE_SLOTS.entries()]
      .filter(([, c]) => c.max > 0 && !c.slots)
      .map(([n]) => n);
    expect(unnamed, "a positional cap needs a `slots` phrase for the diagnostic").toEqual([]);
  });
});
