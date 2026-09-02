// ---------------------------------------------------------------------------
// A MULTI-WORD value-object field must round-trip on Phoenix (F2-W-01).
//
// A single value object is stored as a `field :<name>, :map` jsonb column: the
// wire sub-map is `cast/3`-ed VERBATIM, with no nested changeset to recurse
// through.  `__normalize_keys/1` snake-cases only the TOP-LEVEL wire keys, so
// `{"dims": {"maxWidth": 3}}` was stored with the camelCase sub-key — while
// every read site (this serializer, the expression renderer's VO sub-field
// read, the VO's own `new/1`) looks up `:max_width`.
//
// Result: `maxWidth`/`unitPrice`/`postalCode` read back as `null` on Phoenix
// and returned the written value on the other four — and the null violated
// Phoenix's OWN OpenAPI, which declares the property required.  Single-word VO
// fields (`amount`, `height`) accidentally worked, which is why the corpus
// (`Money{amount, currency}`) never caught it.
//
// The fix picks SNAKE as the one canonical stored key (every read site already
// assumes it) and normalizes the sub-map on the way in; the serializer keeps a
// camelCase fallback arm so rows an older build wrote still serve.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = (shape: string) => `system VoKeys {
  subdomain S {
    context C {
      valueobject Dimensions { maxWidth: decimal  height: decimal }
      aggregate Box${shape} with crudish {
        reference: string
        dims: Dimensions
      }
      repository Boxes for Box { }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable d { platform: elixir  contexts: [C]  dataSources: [st]  serves: A  port: 4000 }
}`;

async function emitted(shape: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(SRC(shape));
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`${suffix} not found in: ${[...files.keys()].join(", ")}`);
}

describe("a value object's jsonb sub-keys are normalized on write", () => {
  it("the relational changeset snake-cases the VO sub-map (both seams)", async () => {
    const cs = await emitted("", "/box_changeset.ex");
    // Create AND the generic update seam — a PUT that only fixed create would
    // still write camelCase.  (The per-action `change_create/1` helper casts raw
    // attrs and normalizes nothing at all, top level included — a separate,
    // pre-existing gap on a non-HTTP path, so it is deliberately not asserted.)
    const seams = ["base_changeset", "update_changeset"].map((name) => {
      const at = cs.indexOf(`def ${name}(`);
      expect(at, `no ${name} in the emitted changeset`).toBeGreaterThan(0);
      return cs.slice(at, cs.indexOf("\n  end", at));
    });
    for (const seam of seams) {
      expect(seam).toContain('attrs = __normalize_vo_keys(attrs, ["dims"])');
    }
    // Only the VO column is listed — a plain `json`/`map` column keeps its
    // arbitrary keys (that is `key-normalize.ts`'s documented contract).
    expect(cs).not.toContain('__normalize_vo_keys(attrs, ["reference"');
    expect(cs).toContain("defp __vo_value(value) when is_map(value) and not is_struct(value) do");
    expect(cs).toContain("{k, v} when is_binary(k) -> {Macro.underscore(k), v}");
  });

  it("the document embed's changeset does it too", async () => {
    const data = await emitted(" shape: document", "/box.ex");
    expect(data).toContain('attrs = __normalize_vo_keys(attrs, ["dims"])');
  });

  it("the serializer keeps a camelCase fallback for rows an older build wrote", async () => {
    const ctl = await emitted("", "/box_controller.ex");
    // Multi-word: atom key, then the canonical snake string key, then the
    // legacy camelCase one.
    expect(ctl).toContain(
      'Map.get(record, :max_width, Map.get(record, "max_width", Map.get(record, "maxWidth")))',
    );
    // Single-word snakes to itself — unchanged, two arms, no redundant third.
    expect(ctl).toContain('Map.get(record, :height, Map.get(record, "height"))');
    expect(ctl).not.toContain('Map.get(record, "height", Map.get(record, "height"))');
  });
});

describe("an aggregate with no value-object field is byte-identical", () => {
  const PLAIN = `system NoVo {
  subdomain S {
    context C {
      aggregate Box with crudish { reference: string  meta: json }
      repository Boxes for Box { }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable d { platform: elixir  contexts: [C]  dataSources: [st]  serves: A  port: 4000 }
}`;

  it("emits neither the call nor the helper", async () => {
    const files = await generateSystemFiles(PLAIN);
    const cs = [...files].find(([p]) => p.endsWith("/box_changeset.ex"))?.[1] as string;
    expect(cs).toBeTruthy();
    expect(cs).not.toContain("__normalize_vo_keys");
    expect(cs).not.toContain("__vo_value");
  });
});
