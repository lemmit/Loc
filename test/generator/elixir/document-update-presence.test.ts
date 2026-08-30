// ---------------------------------------------------------------------------
// RS-26 on the DOCUMENT write seam (M-T6.26 residual).
//
// Loom's update contract is full-replacement: an ABSENT KEY is a missing field,
// and the other four backends reject it at their deserialization boundary.  On
// Elixir the relational aggregate gets that from `update_changeset/2`'s
// `__require_keys/3` (`changeset-emit.ts`) — but a `shape: document` aggregate
// takes a different emitter entirely, and `document_changeset/3` had no
// presence check at all:
//
//   `cast_embed(:data, on_replace: :update)` MERGES the incoming attrs onto the
//   stored embed, so the embed's own `validate_required/2` reads the retained
//   value and passes.  PUT omitting a required field answered 204 on Elixir and
//   422 everywhere else — the one changeset the M-T6.26 check did not reach.
//
// Compile gates are blind to it (both shapes compile), and the wire-golden
// differential never produces a comparable body, so the assertion is against
// the ENFORCEMENT surface: the changeset the request actually hits, and the
// repository call site that routes the update through it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// `itemCount` is deliberately MULTI-WORD: the document path snake-cases the
// wire keys inside `<Agg>.Data.changeset/2`, not on the root changeset, so a
// presence check reading the raw attrs would miss every camelCase key.
// `note` is optional — it must NOT be required.
const DOC_SYSTEM = `system DocPresence {
  subdomain S {
    context C {
      aggregate Cart shape: document with crudish {
        reference: string
        itemCount: int
        note: string?
      }
      repository Carts for Cart { }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

async function emitted(suffix: string): Promise<string> {
  const files = await generateSystemFiles(DOC_SYSTEM);
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`${suffix} not found in: ${[...files.keys()].join(", ")}`);
}

describe("a document aggregate's PUT rejects an omitted required field", () => {
  it("the update changeset checks presence against the raw attrs", async () => {
    const changeset = await emitted("/cart_changeset.ex");
    expect(changeset).toContain("def document_update_changeset(");
    // The required set, and only it — `note` is optional.
    expect(changeset).toContain(
      "__require_keys(__normalize_keys(attrs), [:reference, :item_count])",
    );
    expect(changeset).not.toContain(":note");
    // The check runs BEFORE `cast_embed` merges onto the stored document —
    // after it, the retained value hides the omission.
    const at = changeset.indexOf("__require_keys(__normalize_keys(attrs)");
    const cast = changeset.indexOf("cast_embed(:data", at);
    expect(at).toBeGreaterThan(0);
    expect(cast).toBeGreaterThan(at);
    // The helper itself, with `validate_required/2`'s own error shape so
    // ProblemDetails still renders `{"pointer":"/<field>"}`.
    expect(changeset).toContain('add_error(cs, field, "can\'t be blank", validation: :required)');
  });

  it("the repository's update routes through it (create still does not)", async () => {
    const repo = await emitted("/cart_repository.ex");
    expect(repo).toMatch(/def update\([\s\S]*?document_update_changeset\(attrs,/);
    // Create is a construction, not a replacement — it keeps the plain head.
    expect(repo).toMatch(/def insert\([\s\S]*?\|> \w[\w.]*\.document_changeset\(attrs, 1\)/);
  });
});
