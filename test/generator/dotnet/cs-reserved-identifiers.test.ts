// A `.ddd` field/param named after a C# KEYWORD must reach the generated C# as
// a verbatim identifier (`@case`), not bare (F2-ADP-7).
//
// The M-T6.42 quoting work fixed the SQL identifier position on this backend
// (`"case"` in the DDL / statements); the HOST-LANGUAGE identifier position
// derived from the same name was left bare, so `aggregate Ticket { case: string
// do: int lock: string }` emitted `public void Update(string case, int do,
// string lock)` and `public int do { get; set; }` — CS1041, `dotnet build`
// fails outright while generation reports zero diagnostics. Only a compile tier
// could see it.
//
// PascalCase positions (`Case`, `Do`, `Lock`) are safe by construction — every
// C# keyword is lowercase — so the gate targets the lowerCamel/snake positions:
// operation + factory parameters and their uses, the create-command named
// arguments, the Dapper row DTO + its hydration + the save anon-object members,
// and the Dapper query-projection row DTO.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = (persistence: string) => `
  system S {
    subdomain D { context C {
      aggregate Ticket with crudish {
        case: string
        do: int
        lock: string
      }
      repository Tickets for Ticket {
        find byCase(case: string): Ticket[] where this.case == case
      }
      projection Volume {
        tickets: int
        do: int
        from Ticket as t
        select tickets = count(), do = sum(t.do)
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable d { platform: ${persistence}  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

const cache = new Map<string, Map<string, string>>();
async function files(persistence: string): Promise<Map<string, string>> {
  let f = cache.get(persistence);
  if (!f) {
    f = await generateSystemFiles(SRC(persistence));
    cache.set(persistence, f);
  }
  return f;
}

function file(f: Map<string, string>, suffix: string): string {
  const key = [...f.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return f.get(key!)!;
}

/** Lines that use a C# keyword in an IDENTIFIER position — i.e. the keyword is
 *  not preceded by `@`, a `.`, or a quote.  String literals and comments are
 *  dropped first so the aggregate's `Inspect` string (which legitimately spells
 *  `"case: "`) and the SQL literals don't register. */
function bareKeywordUses(src: string): string[] {
  const KEYWORDS = ["case", "do", "lock"];
  const re = new RegExp(`(?<![@.\\w])(?:${KEYWORDS.join("|")})(?![\\w])`);
  return src
    .split("\n")
    .map((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, ""))
    .filter((l) => re.test(l) && !/^\s*(\/\/|#line)/.test(l))
    .map((l) => l.trim());
}

describe.each([
  ["efcore", "dotnet"],
  ["dapper", "dotnet { persistence: dapper }"],
])("%s: C#-keyword field names are emitted as verbatim identifiers", (adapter, persistence) => {
  it("the domain entity's factory + update signatures and their bodies", async () => {
    const entity = file(await files(persistence), "Domain/Tickets/Ticket.cs");
    expect(entity).toContain("public void Update(string @case, int @do, string @lock)");
    expect(entity).toContain("public static Ticket Create(string @case, int @do, string @lock)");
    expect(entity).toContain("Case = @case;");
    expect(entity).toContain("e.Do = @do;");
    expect(bareKeywordUses(entity)).toEqual([]);
  });

  it("a repository find's parameter and its uses", async () => {
    const repo = file(await files(persistence), "Infrastructure/Repositories/TicketRepository.cs");
    const port = file(await files(persistence), "Domain/Tickets/ITicketRepository.cs");
    expect(port).toContain("ByCase(string @case,");
    expect(repo).toContain("ByCase(string @case,");
    expect(bareKeywordUses(port)).toEqual([]);
    // …and the controller action that binds it from the query string, plus the
    // query record it constructs.
    const controller = file(await files(persistence), "Api/TicketsController.cs");
    expect(controller).toContain("] string @case)");
    expect(controller).toContain("new ByCaseQuery(@case)");
    expect(bareKeywordUses(controller)).toEqual([]);
  });

  it("the create-command handler's named arguments", async () => {
    const handler = file(await files(persistence), "Commands/CreateTicketHandler.cs");
    expect(handler).toContain("Ticket.Create(@case: command.Case, @do: command.Do");
    expect(bareKeywordUses(handler)).toEqual([]);
  });

  if (adapter === "dapper") {
    it("the Dapper row DTO, its hydration, and the save anon-object members", async () => {
      const repo = file(
        await files(persistence),
        "Infrastructure/Repositories/TicketRepository.cs",
      );
      expect(repo).toContain("public string @case { get; set; }");
      expect(repo).toContain("public int @do { get; set; }");
      expect(repo).toContain("Case = r.@case,");
      // The anon object's member name is still `case`, so Dapper binds it to
      // the `@case` SQL parameter exactly as before.
      expect(repo).toContain("@case = aggregate.Case");
      expect(bareKeywordUses(repo)).toEqual([]);
    });

    it("the Dapper query-time projection row DTO", async () => {
      const qp = file(await files(persistence), "Projections/VolumeQpHandler.cs");
      // The row DTO member is snake-named after the SQL alias, so a projection
      // field called `do` lands in the same identifier position.
      expect(qp).toContain("@do { get; set; }");
      expect(bareKeywordUses(qp)).toEqual([]);
    });
  }
});
