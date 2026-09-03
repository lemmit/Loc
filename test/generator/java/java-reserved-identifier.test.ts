// ---------------------------------------------------------------------------
// F2-ADP-7 (java arm) — a `.ddd` name that collides with a JAVA reserved word.
//
// `aggregate Ticket with crudish { case: string  do: int }` on `platform: java`
// used to parse with ZERO diagnostics and emit, in
// `features/tickets/Ticket.java`:
//
//     @Column(name = "`case`")
//     String case;                        // <- javac: <identifier> expected
//     public String case() { … }
//     public static Ticket create(String case, int do, …)
//
// …plus `record TicketResponse(String case, int do, …)` and
// `record CreateTicketRequest(String case, …)`.  The SQL half was already
// quoted by M-T6.42/M-T6.43; the HOST-IDENTIFIER half was bare, so the failure
// surfaced only in a compile tier.
//
// WHY A GATE AND NOT AN ESCAPE.  The .NET arm of the same row escapes (`@case`
// is a C# verbatim identifier — lexically `case`, so the member name and the
// JSON property System.Text.Json derives from it are unchanged).  Java has no
// verbatim-identifier syntax; the only available "escape" is the rename
// `escapeJavaIdent` already applies to LOCALS (`case` → `case_`).  A record
// component name IS the Jackson property name, so renaming a declared field
// would move `{"case": …}` to `{"case_": …}` on java alone.  Refusing at the
// IR layer is the honest answer while that stays true.
//
// SCOPED TO THE AXIS: java-hosted contexts only.  `get case()` (node),
// `def case` (python), `field :case` (elixir) and `@case` (dotnet) are all
// legal, and this file pins that those four stay unaffected.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const CODE = "loom.java-reserved-identifier-unsupported";

const src = (platform: string, body: string): string => `
system RW {
  subdomain S {
    context C {
      aggregate Ticket with crudish {
${body}
      }
      repository Tickets for Ticket { }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }
}`;

async function codesFor(source: string): Promise<string[]> {
  const loom = await buildLoomModel(source);
  return validateLoomModel(loom)
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

async function messagesFor(source: string): Promise<string[]> {
  const loom = await buildLoomModel(source);
  return validateLoomModel(loom)
    .filter((d) => d.code === CODE)
    .map((d) => d.message);
}

describe("loom.java-reserved-identifier-unsupported (F2-ADP-7, java arm)", () => {
  it("refuses a field named after a java keyword on a java deployable", async () => {
    expect(await codesFor(src("java", "        case: string"))).toContain(CODE);
  });

  // The field is only ONE of the positions the name reaches: `crudish` derives
  // `update(String case, …)` and `create(String case, …)` from it, and those
  // emit as java METHOD PARAMETERS.  A gate that saw only the field would let
  // an aggregate whose keyword-named value arrives solely through an action
  // parameter compile-fail exactly as before.
  it("refuses the derived action PARAMETERS the same name reaches", async () => {
    const msgs = await messagesFor(src("java", "        case: string"));
    expect(msgs.some((m) => m.includes("'C.Ticket.update' declares parameter 'case'"))).toBe(true);
    expect(msgs.some((m) => m.includes("'C.Ticket.create' declares parameter 'case'"))).toBe(true);
  });

  it("names the declaration, the position and the keyword", async () => {
    const [msg] = await messagesFor(src("java", "        case: string"));
    expect(msg).toContain("'C.Ticket' declares field 'case'");
    expect(msg).toContain("Java reserved word");
  });

  // THE SCOPING ASSERTION — the axis this gate lives on is `platform: java`,
  // not "reserved words in general".  `case` is legal in all four siblings.
  for (const platform of ["node", "dotnet", "python", "elixir"]) {
    it(`stays silent on platform: ${platform}`, async () => {
      expect(await codesFor(src(platform, "        case: string"))).not.toContain(CODE);
    });
  }

  // `lock` is a C# keyword and a SQL reserved word, but NOT a java one — the
  // gate must read the java list, not a union of every target's.
  it("does not refuse `lock`, which is not a java keyword", async () => {
    expect(await codesFor(src("java", "        lock: string"))).not.toContain(CODE);
  });

  it("passes a non-colliding field through untouched", async () => {
    expect(await codesFor(src("java", "        title: string"))).not.toContain(CODE);
  });
});
