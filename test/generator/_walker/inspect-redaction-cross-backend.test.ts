// Cross-backend redaction acceptance — one DSL source, three host
// languages, one contract: a field tagged `sensitive(...)` MUST
// render as the literal `<redacted>` inside the structural debug
// form (`toString()` / `Inspect`), and the sensitive field's value
// access MUST NOT appear in that form.
//
// The Elixir backend (plain Phoenix+Ecto, the only foundation) honours
// the contract via the `Inspect` protocol: `schema-emit.ts` appends a
// `defimpl Inspect, for: <Module>` rendering the IR's synthesized
// `inspect` derived member through ELIXIR_TARGET (vanilla-phoenix-gaps §3).
//
// PR #524 → #559 → #567 → #570 landed the redaction expression in
// the IR + each backend's render-expr.  The per-backend tests pin
// shape locally:
//   - test/language/display-inspect-derived.test.ts  (IR walk)
//   - test/generator/elixir/vanilla-inspect-redaction.test.ts (Phoenix)
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
    api PeopleApi from M
    storage primary { type: postgres }
    resource peopleState { for: People, kind: state, use: primary }
    deployable honoApi { platform: node, contexts: [People], port: 3000 }
    deployable dotnetApi { platform: dotnet, contexts: [People], port: 3001 }
    deployable elixirApi {
      platform: elixir { foundation: vanilla }
      contexts: [People]
      dataSources: [peopleState]
      serves: PeopleApi
      port: 3002
    }
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

  it("Elixir vanilla Inspect impl: redacts ssn + nested VO phone, never references field values", async () => {
    const files = await generateSystemFiles(REDACTION_SOURCE);
    const personEx = files.get("elixir_api/lib/elixir_api/people/person.ex")!;
    expect(personEx, "Elixir Person.ex missing — system emission shape changed").toBeDefined();

    // The `defimpl Inspect, for: ...Person` block must be emitted (the
    // sensitive-field leak guard — vanilla-phoenix-gaps §3).
    expect(personEx).toContain("defimpl Inspect, for: ElixirApi.People.Person do");

    const inspectLine = personEx.split("\n").find((l) => l.includes("string("))!;
    expect(inspectLine, "Elixir Inspect body not emitted on Person").toBeDefined();

    // Top-level sensitive field: ssn → "<redacted>", no `record.ssn`.
    expect(inspectLine).toContain('"<redacted>"');
    expect(inspectLine).toContain('"ssn: "');
    expect(inspectLine).not.toMatch(/\brecord\.ssn\b/);

    // Nested VO sensitive field: contact.phone → "<redacted>", no
    // `record.contact.phone` access.
    expect(inspectLine).toContain('"phone: "');
    expect(inspectLine).not.toMatch(/record\.contact\.phone\b/);

    // Non-sensitive VO sibling reached normally — via the key-type-agnostic
    // VO-subfield fallback (a VO map may be string- or atom-keyed; #1660), not
    // struct-dot (`record.contact.email` would KeyError on the string-keyed map).
    expect(inspectLine).toContain(
      'Map.get(record.contact, :email, Map.get(record.contact, "email"))',
    );
    // Non-sensitive top-level field reached normally (snake_cased).
    expect(inspectLine).toMatch(/record\.full_name\b/);
  });

  it("an aggregate with no sensitive field emits NO Elixir Inspect impl", async () => {
    // Byte-identical-to-before guard: the impl appears ONLY for aggregates
    // carrying a sensitive leaf.
    const NO_SENSITIVE = `
      system Plain {
        subdomain M {
          context People {
            aggregate Person { fullName: string }
            repository People for Person { }
          }
        }
        api PeopleApi from M
        storage primary { type: postgres }
        resource peopleState { for: People, kind: state, use: primary }
        deployable elixirApi {
          platform: elixir { foundation: vanilla }
          contexts: [People]
          dataSources: [peopleState]
          serves: PeopleApi
          port: 4000
        }
      }
    `;
    const files = await generateSystemFiles(NO_SENSITIVE);
    const personEx = files.get("elixir_api/lib/elixir_api/people/person.ex")!;
    expect(personEx).toBeDefined();
    expect(personEx).not.toContain("defimpl Inspect");
  });

  it("all three backends agree on the structural envelope: same field order, same labels", async () => {
    // Anti-drift gate: even if the redaction works on each backend
    // individually, the structural envelopes can desync (one backend
    // skips a field, another reorders).  Pin that the human-readable
    // labels appear in the SAME ORDER across both.
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
    const exLabels = extractLabels(ex.split("\n").find((l) => l.includes("string("))!);

    // Expected sequence: aggregate id, then declared fields in source
    // order, with the inlined VO's fields nested between `contact: `
    // and the next aggregate-level slot.  Labels are the declared field
    // names (NOT host-cased) on every backend, since the inspect literal
    // is built from the IR field name.
    const expected = ["id", "fullName", "ssn", "contact", "email", "phone"];
    expect(tsLabels).toEqual(expected);
    expect(csLabels).toEqual(expected);
    expect(exLabels).toEqual(expected);
  });
});
