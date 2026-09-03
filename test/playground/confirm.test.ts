import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_IDLE,
  type ConfirmState,
  canConfirm,
  confirmReduce,
  confirmSites,
} from "../../web/src/util/confirm-state.js";

// ---------------------------------------------------------------------------
// The playground's confirm layer (M-T8.17 slice 1, audit H8).
//
// Three things are pinned, and each is a gate on a different way the layer
// could rot:
//
//  1. The STATE MACHINE (`confirmReduce` / `canConfirm`) — arm, cancel,
//     confirm, and the type-to-confirm gate.  Pure; the React half in
//     `confirm.tsx` only dispatches into it.
//  2. The SITE CATALOG (`confirmSites`) — the copy each destructive action
//     shows.  The audit's finding was inconsistency (seven native dialogs,
//     three unconfirmed deletes, one confirm on a cosmetic action); the
//     catalog is what makes every site say WHAT is lost and name the verb on
//     the affirmative button, and the assertions here are the shape a new
//     row must satisfy.
//  3. A RATCHET: no `window.confirm` / `window.prompt` / `window.alert`
//     anywhere under `web/src` (the generated-test runner's DOMAIN language
//     `confirm()` in `src/testing/` is not a dialog and is excluded by path).
//     A site that regresses to a native dialog fails CI.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");

describe("confirm state machine", () => {
  it("arms on the trigger and idles on cancel", () => {
    const armed = confirmReduce(CONFIRM_IDLE, { type: "arm" });
    expect(armed.armed).toBe(true);
    expect(confirmReduce(armed, { type: "cancel" })).toEqual(CONFIRM_IDLE);
  });

  it("a successful confirm disarms", () => {
    const armed = confirmReduce(CONFIRM_IDLE, { type: "arm" });
    expect(confirmReduce(armed, { type: "confirm" })).toEqual(CONFIRM_IDLE);
  });

  it("re-arming does not clear a typed token; arming from idle starts blank", () => {
    let s: ConfirmState = confirmReduce(CONFIRM_IDLE, { type: "arm" });
    s = confirmReduce(s, { type: "type", value: "Sales" });
    expect(confirmReduce(s, { type: "arm" })).toBe(s);
    const fresh = confirmReduce(confirmReduce(s, { type: "cancel" }), { type: "arm" });
    expect(fresh.typed).toBe("");
  });

  it("typing while idle is ignored — there is no box to type into", () => {
    expect(confirmReduce(CONFIRM_IDLE, { type: "type", value: "x" })).toBe(CONFIRM_IDLE);
  });

  it("canConfirm: idle is never confirmable", () => {
    expect(canConfirm(CONFIRM_IDLE, {})).toBe(false);
    expect(canConfirm(CONFIRM_IDLE, { typeToConfirm: "Sales" })).toBe(false);
  });

  it("canConfirm: armed without a token requirement is confirmable", () => {
    expect(canConfirm({ armed: true, typed: "" }, {})).toBe(true);
  });

  it("canConfirm: a type-to-confirm token gates until it matches exactly (trimmed)", () => {
    const spec = { typeToConfirm: "Sales System" };
    expect(canConfirm({ armed: true, typed: "" }, spec)).toBe(false);
    expect(canConfirm({ armed: true, typed: "Sales" }, spec)).toBe(false);
    expect(canConfirm({ armed: true, typed: "sales system" }, spec)).toBe(false);
    expect(canConfirm({ armed: true, typed: "Sales System" }, spec)).toBe(true);
    expect(canConfirm({ armed: true, typed: " Sales System " }, spec)).toBe(true);
  });
});

describe("confirm site catalog — every site names the loss and the verb", () => {
  /** The whole catalog, instantiated with representative arguments. */
  const all = {
    workspaceDelete: confirmSites.workspaceDelete("Sales System", 3),
    workspaceDeleteUnknownCount: confirmSites.workspaceDelete("Sales System", null),
    sourceFileDelete: confirmSites.sourceFileDelete("shared/money.ddd"),
    sourceFolderDelete: confirmSites.sourceFolderDelete("shared", 2),
    exampleImport: confirmSites.exampleImport("Acme ERP", ["shared/money.ddd", "sales.ddd"]),
    clearStoredData: confirmSites.clearStoredData(),
    resetDatabase: confirmSites.resetDatabase(),
    declarationDelete: confirmSites.declarationDelete("aggregate", "Order"),
    uiMemberDelete: confirmSites.uiMemberDelete("store", "cart"),
    historyRestore: confirmSites.historyRestore("a1b2c3d"),
    discardCanvasSwitch: confirmSites.discardCanvasEdits("switch"),
    discardCanvasReseed: confirmSites.discardCanvasEdits("reseed"),
    discardFormEdits: confirmSites.discardFormEdits("US-001"),
  };

  it("no site says a bare 'Are you sure?' and every affirmative names its verb", () => {
    for (const [name, spec] of Object.entries(all)) {
      expect(spec.consequence, name).not.toMatch(/are you sure/i);
      // Names the thing ("Delete store cart?"), never a bare verb.
      expect(spec.consequence.length, name).toBeGreaterThan(12);
      expect(spec.confirmLabel, name).toMatch(/^Yes, /);
      expect(spec.confirmLabel, name).not.toBe("Yes");
      expect(spec.confirmLabel, name).not.toMatch(/^OK$/i);
    }
  });

  it("the seven former window.confirm / window.prompt sites have the shapes the program doc names", () => {
    // Switcher + drawer delete → modal; file + folder delete → inline;
    // example import → modal listing the dropped files.  (The switcher
    // rename is an inline TextInput, not a confirm; the layout reset has NO
    // confirm at all — neither appears in the catalog by design.)
    expect(all.workspaceDelete.shape).toBe("modal");
    expect(all.sourceFileDelete.shape).toBe("inline");
    expect(all.sourceFolderDelete.shape).toBe("inline");
    expect(all.exampleImport.shape).toBe("modal");
    expect(all.exampleImport.details).toEqual(["shared/money.ddd", "sales.ddd"]);
    expect(all.exampleImport.consequence).toContain("2 files");
    expect("layoutReset" in confirmSites).toBe(false);
    expect("workspaceRename" in confirmSites).toBe(false);
  });

  it("workspace delete names the file count and requires the name to be typed", () => {
    expect(all.workspaceDelete.consequence).toContain("3 .ddd files");
    expect(all.workspaceDelete.typeToConfirm).toBe("Sales System");
    expect(all.workspaceDelete.title).toContain("Sales System");
    // Unknown count (a non-active workspace in the drawer) still names the
    // blast radius rather than printing "null files".
    expect(all.workspaceDeleteUnknownCount.consequence).toContain("every file in it");
    expect(all.workspaceDeleteUnknownCount.consequence).not.toMatch(/null|undefined|NaN/);
  });

  it("the previously-unconfirmed sites are inline and name the construct", () => {
    // Clear stored data & retry, model-canvas declaration deletes, and the
    // page-builder chrome deletes (store / menu / state field) had NO confirm.
    expect(all.clearStoredData.shape).toBe("inline");
    expect(all.declarationDelete.shape).toBe("inline");
    expect(all.declarationDelete.consequence).toContain("aggregate Order");
    expect(all.uiMemberDelete.shape).toBe("inline");
    expect(all.uiMemberDelete.consequence).toContain("store cart");
    expect(all.sourceFolderDelete.consequence).toContain("2 files");
    expect(all.sourceFileDelete.consequence).toContain("shared/money.ddd");
  });

  it("history restore says the live edits are replaced AND that the restore is itself a commit", () => {
    expect(all.historyRestore.consequence).toMatch(/replaces your current edits/i);
    expect(all.historyRestore.consequence).toMatch(/new commit/i);
    expect(all.historyRestore.consequence).toContain("a1b2c3d");
  });

  it("the dirty guards name what is discarded", () => {
    expect(all.discardCanvasSwitch.consequence).toMatch(/unapplied canvas edits/);
    expect(all.discardCanvasReseed.consequence).toMatch(/source changed/);
    expect(all.discardFormEdits.consequence).toContain("US-001");
    expect(all.discardFormEdits.consequence).toMatch(/unsaved/);
  });
});

describe("ratchet — no native dialogs under web/src", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The generated-test runner's DSL `confirm()` is a domain operation
        // name, not a dialog.
        if (entry.name === "testing" || entry.name === "node_modules") continue;
        walk(p, out);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
    return out;
  }

  it("no web/src file calls window.confirm / window.prompt / window.alert", () => {
    const offenders: string[] = [];
    for (const file of walk(webSrc)) {
      const text = fs.readFileSync(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (/\bwindow\.(confirm|prompt|alert)\s*\(/.test(line)) {
          offenders.push(`${path.relative(webSrc, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
