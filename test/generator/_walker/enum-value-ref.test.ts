// A bare enum-member reference in a page body — `o.vis == Public`.
//
// The IR half of this bug is pinned in test/ir/ui-enum-value-ref.test.ts (a ui
// body has no enclosing `ctx`, so the ref lowered to `refKind: "unknown"`).
// This is the EMISSION half: `emitExpr`'s `ref` arm in the shared walker core
// handled store-field / state / derived / param / shell-local / let and then
// fell through to `/* unresolved: <name> */ undefined` — so every shared-walker
// frontend rendered the comparison against `undefined` (an undeclared
// identifier in Dart, which fails `flutter analyze`), silently, with zero
// diagnostics at parse.
//
// WIRE SPELLING.  A frontend never sees the enum as a type: it rides the wire
// as the member's bare NAME string — `z.enum(["Public", …])` in
// `_frontend/zod-schemas.ts`, `String` in `flutter/dart-types.ts`, `string` in
// `feliz/wire.ts`'s `wireFieldType` — which is why the two frontend renderers
// that already handled this ref (`_frontend/gate-expr.ts`,
// `_frontend/default-seed.ts`) both emit `JSON.stringify(e.name)`.  The new arm
// renders through the target's existing literal seam, so each embedded language
// spells the same string its own way; that breadth is the point of this test.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** `platform` is the FRONTEND deployable's platform; `elixir` instead mounts
 *  the ui on the backend deployable itself (LiveView is not a bundle host). */
const source = (platform: string, valueRef = "Public") => {
  const heex = platform === "elixir";
  return `
system EnumRef {
  subdomain Ops {
    context Ops {
      enum Visibility { Public, Private }
      aggregate Doc with crudish {
        title: string
        vis: Visibility
      }
      repository Docs for Doc { }
    }
  }
  api OpsApi from Ops
  ui Web {
    api ops: OpsApi
    page Board {
      route: "/board"
      body: Stack {
        QueryView {
          of: ops.Doc.all,
          data: rows => Table {
            Column { "Vis", o => Text { o.vis == ${valueRef} ? "pub" : "priv" } },
            rows: rows
          }
        }
      }
    }
  }
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: ${heex ? "elixir" : "node"}
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    ${heex ? "ui: Web { ops: svc }" : ""}
    port: 4000
  }
  ${heex ? "" : `deployable web { platform: ${platform} targets: svc ui: Web { ops: svc } port: 3000 }`}
}
`;
};

async function pageFor(
  platform: string,
  match: (path: string) => boolean,
  valueRef?: string,
): Promise<string> {
  const files = await generateSystemFiles(source(platform, valueRef));
  const hit = [...files].find(([p]) => match(p));
  if (!hit) throw new Error(`no page file for ${platform} in:\n${[...files.keys()].join("\n")}`);
  return hit[1];
}

describe("bare enum-value ref in a page body", () => {
  it("compares against the member's wire string on every JSX-family frontend", async () => {
    const react = await pageFor("react", (p) => p.endsWith("src/pages/board.tsx"));
    expect(react).toContain(`(row.vis === "Public")`);
    expect(react).not.toContain("unresolved: Public");

    const vue = await pageFor("vue", (p) => p.endsWith("src/pages/board.vue"));
    expect(vue).toContain(`(row.vis === "Public")`);

    const svelte = await pageFor("svelte", (p) => p.endsWith("board/+page.svelte"));
    expect(svelte).toContain(`(row.vis === "Public")`);

    const angular = await pageFor("angular", (p) => p.endsWith("pages/board.component.ts"));
    expect(angular).toContain(`(row.vis === "Public")`);
  });

  it("spells the same string idiomatically on Feliz (F#) and Flutter (Dart)", async () => {
    // The wire field is `string` on Feliz (`wireFieldType`) and `String` on
    // Flutter (`dartType`), so both compare against a plain string literal —
    // no new per-target seam, just the existing literal formatter.
    const feliz = await pageFor("feliz", (p) => p.endsWith("web/src/App.fs"));
    expect(feliz).toContain(`(row.vis = "Public")`);

    const flutter = await pageFor("flutter", (p) => p.endsWith("lib/pages/board_page.dart"));
    expect(flutter).toContain(`(row.vis == 'Public')`);
    expect(flutter).not.toContain("unresolved: Public");
  });

  it("resolves the QUALIFIED form too — `Visibility.Public`", async () => {
    // `EnumName.Value` lowers through a different arm (a member access whose
    // receiver is an unresolved bare name).  That arm was gated on `env.ctx` /
    // the root-level ambient index just like the bare form, so from a ui body
    // the receiver stayed unresolved and the page emitted `undefined.Public`.
    const react = await pageFor(
      "react",
      (p) => p.endsWith("src/pages/board.tsx"),
      "Visibility.Public",
    );
    expect(react).toContain(`(row.vis === "Public")`);
    expect(react).not.toContain("undefined.Public");
  });

  it("reaches the HEEx engine's own enum-value arm", async () => {
    // Phoenix/LiveView does NOT ride the shared walker — `heex-walker-core.ts`
    // is a parallel engine, and its `renderRef` already had an `enum-value`
    // arm that no lowering could reach.  The lowering fix alone makes it
    // live: the page renders an ATOM comparison instead of a bare, unbound
    // variable (`o.vis == public`, which does not compile).
    //
    // The atom must carry the DECLARED casing: the Ecto schema this page reads declares
    // `field :vis, Ecto.Enum, values: [:Public, :Private]`, so `:public`
    // would never equal the loaded atom (`elixir/render-expr.ts`,
    // `enum-value` arm carries the full rationale).
    const live = await pageFor("elixir", (p) => p.endsWith("live/board_live.ex"));
    expect(live).toMatch(/o\.vis == :Public/);
    expect(live).not.toMatch(/o\.vis == public\b/);
  });
});
