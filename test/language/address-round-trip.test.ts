import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import type { Model } from "../../src/language/generated/ast.js";
import { indexTargets } from "../../src/language/model-patch.js";
import { addressOf } from "../../src/language/print/outline.js";
import { loadExampleModel } from "../_helpers/examples.js";

// ---------------------------------------------------------------------------
// The address round trip.
//
// `addressOf` produces the address a diagnostic hands an agent (and that the
// outline lists); `indexTargets` resolves the address a patch names back to a
// node.  They are two halves of ONE contract and nothing checked they agree.
//
// They didn't.  `indexTargets` looked for pages under `BoundedContext.members`,
// but the grammar only allows `Page` as a `UiMember`/`AreaMember` — so every
// page address was emitted into diagnostics and resolved by nothing, and
// `outline.contexts[].pages` was always empty.  Two pages named alike in
// different `ui` blocks produced the SAME address, because the ui subtree
// contributed no qualifying segments at all.
//
// Three invariants, each of which fails when one half drifts from the other:
//
//   1. RESOLVABLE — an address `addressOf` produces resolves back through the
//      index to the very same node.  (A node the index deliberately does not
//      target — an expression, a type reference — is exempt: the rule is about
//      DECLARATIONS, which are what patches and diagnostics name.)
//   2. UNAMBIGUOUS — no two declarations share an address.  A canonical address
//      that names two nodes is not canonical.
//   3. KEYWORDED — no addressable declaration falls back to the `node`
//      placeholder keyword, which means "this AST type was never mapped".
// ---------------------------------------------------------------------------

/** Sources chosen for surface breadth: ui blocks with areas and pages, state
 *  and actions, workflows, projections, and multi-context systems. */
const CORPUS = [
  "examples/acme.ddd",
  "examples/showcase.ddd",
  "examples/banking.ddd",
  "examples/event-sourcing.ddd",
];

/** Declaration-like nodes — the ones an agent can name in a patch.  Keyed off
 *  the AST `$type` suffixes the address space is meant to cover, so a new
 *  declaration kind joins the gate by existing rather than by being listed. */
const DECLARATION_TYPES =
  /^(Aggregate|ValueObject|EnumDecl|EventDecl|Repository|Workflow|Projection|Page|Component|Area|Ui|Deployable|Operation|FunctionDecl|ActionDecl|StateField|DerivedProp|Property)$/;

async function modelsOf(): Promise<{ path: string; model: Model }[]> {
  return Promise.all(
    CORPUS.map(async (path) => ({
      path,
      model: await loadExampleModel(path, { validate: false }),
    })),
  );
}

describe("address round trip", () => {
  it("every declaration's address resolves back to that same declaration", async () => {
    const misses: string[] = [];
    for (const { path, model } of await modelsOf()) {
      const { map } = indexTargets(model);
      for (const node of AstUtils.streamAllContents(model)) {
        if (!DECLARATION_TYPES.test(node.$type)) continue;
        const address = addressOf(node);
        if (!address) {
          misses.push(`${path}: ${node.$type} has NO address`);
          continue;
        }
        const resolved = map.get(address);
        if (resolved !== node) {
          misses.push(
            `${path}: ${node.$type} '${address}' resolves to ${
              resolved === undefined ? "NOTHING" : `a ${resolved.$type}`
            }`,
          );
        }
      }
    }
    expect([...new Set(misses)].sort()).toEqual([]);
  });

  it("no two declarations share one address", async () => {
    const collisions: string[] = [];
    for (const { path, model } of await modelsOf()) {
      const { ambiguous } = indexTargets(model);
      for (const a of ambiguous) collisions.push(`${path}: '${a}'`);
    }
    expect(collisions.sort()).toEqual([]);
  });

  it("no declaration falls back to the 'node' placeholder keyword", async () => {
    const unmapped: string[] = [];
    for (const { path, model } of await modelsOf()) {
      for (const node of AstUtils.streamAllContents(model)) {
        if (!DECLARATION_TYPES.test(node.$type)) continue;
        const address = addressOf(node);
        if (address?.startsWith("node ")) unmapped.push(`${path}: ${node.$type} → '${address}'`);
      }
    }
    expect([...new Set(unmapped)].sort()).toEqual([]);
  });
});
