// Cross-backend redaction acceptance — one DSL source, three host
// languages, one contract: a field tagged `sensitive(...)` MUST
// render as the literal `<redacted>` inside the structural debug
// form (`toString()` / `Inspect` / `def inspect/1`), and the
// sensitive field's value access MUST NOT appear in that form.
//
// PR #524 → #559 → #567 → #570 landed the redaction expression in
// the IR + each backend's render-expr.  The per-backend tests pin
// shape locally:
//   - test/language/display-inspect-derived.test.ts  (IR walk)
//   - test/generator/phoenix-live-view-pipeline.test.ts (Phoenix)
//   - .NET / TS rely on the IR walk + the entity emitter loop.
//
// What this file adds is the *acceptance gate*: a single source-of-
// truth assertion that the three backends emit redaction-aware
// output in the same way against the SAME DSL.  Drift on any one
// (a backend forgetting to wire `sensitive` through `render-expr`,
// or a future emitter regression) shows up here.
//
// Scope notes
// -----------
// - In-process only: no `tsc` / `dotnet build` / `mix compile`.
//   The runtime guarantee (calling `String(user)` / `customer.ToString()`
//   / `MyApp.X.Person.inspect(p)` actually prints the redacted form)
//   is left to the LOOM_TS_BUILD / LOOM_DOTNET_BUILD / LOOM_PHOENIX_BUILD
//   opt-in suites; this test asserts the *emitted source* contains
//   the right literal, which is a strict precondition for runtime.
// - Three slots covered: top-level field on the aggregate, field on
//   a contained part, field inside a VO that the aggregate embeds.
//   Each must redact independently.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// Deployable names use a `*Api` suffix instead of bare `dotnet` /
// `elixir` — the bare platform keywords clash with the grammar when
// reused as identifiers, surfacing as a generator-time crash
// (`Cannot read properties of undefined (reading 'replace')` in
// `serviceSlug`).
const REDACTION_SOURCE = `
  system Bank {
    subdomain M {
      context People {
        valueobject ContactInfo {
          email: string
          phone: string sensitive(pii)
        }
        aggregate Person {
          fullName: string
          ssn: string sensitive(pii)
          contact: ContactInfo
          derived display: string = fullName
        }
        repository People for Person { }
      }
    }
    deployable honoApi { platform: hono, contexts: [C], port: 3000 }
    deployable dotnetApi { platform: dotnet, contexts: [C], port: 3001 }
    deployable elixirApi { platform: phoenixLiveView, contexts: [C], port: 4000 }
  }
`;

describe("cross-backend inspect redaction — `sensitive(...)` renders as `<redacted>`", () => {
  it("TS aggregate inspect getter: redacts ssn + nested VO phone, never references field values", async () => {
    const files = await generateSystemFiles(REDACTION_SOURCE);
    const personTs = files.get("hono_api/domain/person.ts")!;
    expect(personTs, "TS Person domain file missing — system emission shape changed").toBeDefined();

    // Locate the synthesized inspect getter body.
    const inspectLine = personTs.split("\n").find((l) => l.includes("get inspect()"))!;
    expect(inspectLine, "TS inspect getter not emitted on Person").toBeDefined();

    // Top-level sensitive field: ssn → "<redacted>", no `this._ssn`.
    expect(inspectLine).toContain('"<redacted>"');
    expect(inspectLine).not.toContain("this._ssn");
    // Structural slot stays so log readers see the field name.
    expect(inspectLine).toContain('"ssn: "');

    // Nested VO sensitive field: contact.phone → "<redacted>", no
    // `this._contact.phone` access.
    expect(inspectLine).toContain('"phone: "');
    expect(inspectLine).not.toMatch(/this\._contact\.phone\b/);

    // Non-sensitive sibling is reached normally.
    expect(inspectLine).toMatch(/this\._contact\.email\b/);
  });

  it(".NET aggregate Inspect property: redacts ssn + nested VO phone, never references field values", async () => {
    const files = await generateSystemFiles(REDACTION_SOURCE);
    const personCs = files.get("dotnet_api/Domain/Persons/Person.cs")!;
    expect(personCs, ".NET Person.cs missing — system emission shape changed").toBeDefined();

    const inspectLine = personCs.split("\n").find((l) => l.includes("public string Inspect"))!;
    expect(inspectLine, ".NET Inspect getter not emitted on Person").toBeDefined();

    expect(inspectLine).toContain('"<redacted>"');
    expect(inspectLine).toContain('"ssn: "');
    // .NET access is `this.Ssn` (PascalCase) — redaction means no such
    // access for sensitive fields.
    expect(inspectLine).not.toMatch(/\bthis\.Ssn\b/);

    expect(inspectLine).toContain('"phone: "');
    // VO field access is `this.Contact.Phone` — must not appear.
    expect(inspectLine).not.toMatch(/\bthis\.Contact\.Phone\b/);
    // Non-sensitive VO sibling still reached.
    expect(inspectLine).toMatch(/\bthis\.Contact\.Email\b/);

    // ToString delegates to Inspect on the aggregate root.
    expect(personCs).toContain("public override string ToString() => Inspect;");
  });

  it("Phoenix `def inspect/1`: redacts ssn + nested VO phone, never references field values", async () => {
    const files = await generateSystemFiles(REDACTION_SOURCE);
    const personEx = files.get("elixir_api/lib/elixir_api/people/person.ex")!;
    expect(
      personEx,
      "Phoenix Person resource module missing — emission shape changed",
    ).toBeDefined();

    // Phoenix emits the inspect body on its own line (multi-line def).
    const inspectBody = personEx
      .split("\n")
      .find((l) => l.includes("<redacted>") || l.includes("record.ssn"))!;
    expect(inspectBody, "Phoenix inspect body line not found").toBeDefined();

    expect(inspectBody).toContain('"<redacted>"');
    expect(inspectBody).toContain('"ssn: "');
    expect(inspectBody).not.toMatch(/\brecord\.ssn\b/);

    expect(inspectBody).toContain('"phone: "');
    // Phoenix uses snake_case for field accesses on Ash structs;
    // VO field access on a stored map is `record.contact.phone`.
    expect(inspectBody).not.toMatch(/\brecord\.contact\.phone\b/);
    // Non-sensitive sibling reached normally.
    expect(inspectBody).toMatch(/\brecord\.contact\.email\b/);

    // Module function exists and is reachable as `Person.inspect/1`
    // (not a `defimpl Inspect` protocol impl — would collide with
    // Ash 3.x's auto-derived form).
    expect(personEx).toMatch(/\bdef inspect\(record\) do\b/);
    expect(personEx).not.toMatch(/\bdefimpl Inspect, for: /);
  });

  it("all three backends agree on the structural envelope: same field order, same labels", async () => {
    // Anti-drift gate: even if the redaction works on each backend
    // individually, the structural envelopes can desync (one backend
    // skips a field, another reorders).  Pin that the human-readable
    // labels appear in the SAME ORDER across all three.
    const files = await generateSystemFiles(REDACTION_SOURCE);
    const ts = files.get("hono_api/domain/person.ts")!;
    const cs = files.get("dotnet_api/Domain/Persons/Person.cs")!;
    const ex = files.get("elixir_api/lib/elixir_api/people/person.ex")!;

    const extractLabels = (source: string): string[] => {
      // Pull every `"<name>: "` literal from the inspect body — the
      // structural slot prefixes.  Filter out the type-name envelope
      // `"Person("`, `"ContactInfo("` etc.
      const labels = source.match(/"\w+: "/g) ?? [];
      return labels.map((l) => l.slice(1, -3));
    };

    const tsLabels = extractLabels(ts.split("\n").find((l) => l.includes("get inspect()"))!);
    const csLabels = extractLabels(
      cs.split("\n").find((l) => l.includes("public string Inspect"))!,
    );
    const exLabels = extractLabels(ex.split("\n").find((l) => l.includes("<redacted>"))!);

    // Expected sequence: aggregate id, then declared fields in source
    // order, with the inlined VO's fields nested between `contact: `
    // and the next aggregate-level slot.
    const expected = ["id", "fullName", "ssn", "contact", "email", "phone"];
    expect(tsLabels).toEqual(expected);
    expect(csLabels).toEqual(expected);
    expect(exLabels).toEqual(expected);
  });
});
