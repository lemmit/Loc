import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// nested-errors-pointer-shape (java half) — the `errors[]` `pointer` field must
// be an RFC 6901 JSON pointer on every backend.
//
// Spring spells a nested VO-collection binding path in JAVA PROPERTY notation
// (`lineTotals[0].unitPrice`).  The advice used to concatenate it raw —
// `"/" + err.getField()` — so a nested 422 shipped
// `/lineTotals[0].unitPrice`, which is not a pointer, while .NET
// (`PointerOf`), node (`pointerOf`) and python (`_pointer`) all shipped
// `/lineTotals/0/unitPrice` for the same model.  A frontend ACL resolving the
// pointer against the request body found nothing on java alone.
//
// WIRE-VISIBLE: this changes the 422 body java emits.  The wire goldens that
// record a nested error body must be rebaselined deliberately.
//
// The helper's own arithmetic is proven by transcribing it here (the emitted
// java was separately compiled and run against the same table): a helper that
// is wired at both call sites but converts wrongly is the same bug.
// ---------------------------------------------------------------------------

const SOURCE = `
system Ptr {
  subdomain S {
    context C {
      valueobject LineTotal {
        unitPrice: int
        invariant unitPrice > 0
      }
      aggregate Order with crudish {
        name: string
        lineTotals: LineTotal[]
        one: LineTotal
      }
      repository Orders for Order { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d {
    platform: java
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }
}
`;

async function advice(): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  const hit = [...files.entries()].find(([p]) => p.endsWith("api/ApiExceptionAdvice.java"));
  if (!hit) throw new Error(`no ApiExceptionAdvice; got:\n${[...files.keys()].sort().join("\n")}`);
  return hit[1];
}

/** The emitted `pointerOf`, transcribed. */
function pointerOf(path: string): string {
  if (!path) return "";
  const segments: string[] = [];
  for (const dotPart of path.split(".")) {
    let idx = 0;
    while (idx < dotPart.length) {
      const bracket = dotPart.indexOf("[", idx);
      if (bracket < 0) {
        segments.push(dotPart.substring(idx));
        break;
      }
      if (bracket > idx) segments.push(dotPart.substring(idx, bracket));
      const close = dotPart.indexOf("]", bracket);
      if (close < 0) break;
      segments.push(dotPart.substring(bracket + 1, close));
      idx = close + 1;
    }
  }
  return segments.map((s) => `/${s.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

describe("java errors[] pointer is RFC 6901", () => {
  it("both pointer call sites go through the converter, not raw concatenation", async () => {
    const text = await advice();
    // The body-validation arm (nested VO / VO-collection violations land here).
    expect(text).toContain('entry.put("pointer", pointerOf(err.getField()));');
    // The request-part type-mismatch arm shares the same shape.
    expect(text).toContain('entry.put("pointer", pointerOf(e.getName()));');
    // The raw concatenation that produced `/lineTotals[0].unitPrice` is gone.
    expect(text).not.toContain('entry.put("pointer", "/" + err.getField());');
    expect(text).not.toContain('entry.put("pointer", "/" + e.getName());');
  });

  it("emits the converter beside the advice's other private helpers", async () => {
    const text = await advice();
    expect(text).toContain("private static String pointerOf(String path) {");
    // Indexer → its own numeric segment; RFC 6901 escapes inside each segment.
    expect(text).toContain("segments.add(dotPart.substring(bracket + 1, close));");
    expect(text).toContain('seg.replace("~", "~0").replace("/", "~1")');
  });

  it("the nested VO-collection path that produced the row converts correctly", () => {
    // The exact shape from the evidence: `lineTotals[0].unitPrice`.
    expect(pointerOf("lineTotals[0].unitPrice")).toBe("/lineTotals/0/unitPrice");
    // A flat field and a single nested VO are unchanged in meaning.
    expect(pointerOf("name")).toBe("/name");
    expect(pointerOf("one.unitPrice")).toBe("/one/unitPrice");
    // Empty path → the empty pointer (the whole document), per RFC 6901.
    expect(pointerOf("")).toBe("");
    // Consecutive indexers each get their own segment.
    expect(pointerOf("items[2][3].x")).toBe("/items/2/3/x");
    // The two RFC 6901 escapes.
    expect(pointerOf("a~b")).toBe("/a~0b");
    expect(pointerOf("a/b")).toBe("/a~1b");
  });

  it("the validator still pushes the java-notation nested path (the converter's input)", async () => {
    const files = await generateSystemFiles(SOURCE);
    const validator = [...files.entries()].find(([p]) =>
      p.endsWith("features/orders/CreateOrderValidator.java"),
    );
    expect(validator).toBeDefined();
    // Unchanged on purpose: Spring's BindingResult owns this notation, and the
    // conversion happens once, at the envelope.
    expect(validator?.[1]).toContain('errors.pushNestedPath("lineTotals[" + i + "]");');
  });
});
