import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// .NET (EF Core) event-sourcing emission (`persistedAs(eventLog)`, A2.2b).
//
// The .NET counterpart of the Hono event store: an event-sourced aggregate
// persists to an append-only `<agg>_events` table (an EF `<Agg>EventRecord`
// entity, no state table); appliers fold the stream via `_Apply` /
// `_FromEvents`; `emit` records-and-applies; `create` builds an empty shell
// + runs its emit-only body.  A top-level context drives the single-project
// (legacy) `generateDotnet` path; the `dotnet build /warnaserror` gate lives
// in test/e2e/generated-dotnet-build.test.ts.
// ---------------------------------------------------------------------------

const SRC = `
context Accounts {
  event Opened { account: Account id, owner: string }
  event Deposited { account: Account id, amount: int }
  event Withdrawn { account: Account id, amount: int }

  aggregate Account persistedAs(eventLog) {
    owner: string
    balance: int

    create open(owner: string) {
      emit Opened { account: id, owner: owner }
    }
    operation deposit(amount: int) {
      precondition amount > 0
      emit Deposited { account: id, amount: amount }
    }
    operation withdraw(amount: int) {
      precondition amount > 0
      precondition balance >= amount
      emit Withdrawn { account: id, amount: amount }
    }

    apply(e: Opened) { owner := e.owner  balance := 0 }
    apply(e: Deposited) { balance := balance + e.amount }
    apply(e: Withdrawn) { balance := balance - e.amount }
  }

  repository Accounts for Account { }
}
`;

async function generate(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  expect(errors, errors.join("\n")).toEqual([]);
  return generateDotnet(model);
}

describe(".NET event-sourcing emission (persistedAs(eventLog))", () => {
  it("emits the shared EventRecord POCO + per-context event-log config (no normalised entity config)", async () => {
    const files = await generate();
    const keys = [...files.keys()];
    // ONE shared POCO + ONE per-context config (the `<agg>_events` tables
    // collapsed into the per-context `<ctx>_events` log, event-log-architecture.md).
    expect(keys).toContain("Infrastructure/Persistence/Events/EventRecord.cs");
    expect(keys).toContain(
      "Infrastructure/Persistence/Configurations/AccountsEventRecordConfiguration.cs",
    );
    // No per-aggregate record entity / config any more.
    expect(keys).not.toContain("Infrastructure/Persistence/Events/AccountEventRecord.cs");
    expect(keys).not.toContain(
      "Infrastructure/Persistence/Configurations/AccountEventRecordConfiguration.cs",
    );
    // No normalised entity configuration for the event-sourced aggregate.
    expect(keys).not.toContain("Infrastructure/Persistence/Configurations/AccountConfiguration.cs");

    const cfg = files.get(
      "Infrastructure/Persistence/Configurations/AccountsEventRecordConfiguration.cs",
    )!;
    expect(cfg).toContain('builder.ToTable("accounts_events");');
    expect(cfg).toContain("builder.HasKey(x => new { x.StreamType, x.StreamId, x.Version });");
    expect(cfg).toContain('builder.Property(x => x.StreamType).HasColumnName("stream_type");');
    expect(cfg).toContain('builder.Property(x => x.StreamId).HasColumnName("stream_id");');
    // `seq` is the DB-assigned context-global cursor — EF reads it, never writes it.
    expect(cfg).toContain(
      'builder.Property(x => x.Seq).HasColumnName("seq").ValueGeneratedOnAdd();',
    );
    expect(cfg).toContain(
      'builder.Property(x => x.Data).HasColumnName("data").HasColumnType("jsonb");',
    );

    const poco = files.get("Infrastructure/Persistence/Events/EventRecord.cs")!;
    expect(poco).toContain("public sealed class EventRecord");
    expect(poco).toContain("public string StreamType { get; set; }");
    expect(poco).toContain("public long Seq { get; set; }");
  });

  it("renders appliers as a _Apply dispatch + _FromEvents rehydrator on the aggregate", async () => {
    const domain = (await generate()).get("Domain/Accounts/Account.cs")!;
    expect(domain).toContain("private void _ApplyOpened(Opened e)");
    expect(domain).toContain("private void _Apply(IDomainEvent ev)");
    expect(domain).toContain("case Deposited e: _ApplyDeposited(e); break;");
    expect(domain).toContain(
      "public static Account _FromEvents(AccountId id, IReadOnlyList<IDomainEvent> events)",
    );
    expect(domain).toContain("foreach (var ev in events) e._Apply(ev);");
  });

  it("makes a command emit record-and-apply, and create run an emit-only _Init", async () => {
    const domain = (await generate()).get("Domain/Accounts/Account.cs")!;
    // deposit body: record AND fold.
    expect(domain).toContain(
      "{ var __ev = new Deposited(Account: this.Id, Amount: amount); _domainEvents.Add(__ev); _Apply(__ev); }",
    );
    // create: empty shell + _Init (the create action's params), not a state writer.
    expect(domain).toContain("public static Account Create(string owner)");
    expect(domain).toContain("e._Init(owner);");
    expect(domain).toContain("private void _Init(string owner)");
  });

  it("emits the event-store repository (fold on load, append on save)", async () => {
    const repo = (await generate()).get("Infrastructure/Repositories/AccountRepository.cs")!;
    expect(repo).toContain("Account._FromEvents(id, __rows.Select(RowToEvent).ToList());");
    expect(repo).toContain("var __pending = aggregate.PullEvents();");
    // Append to the shared per-context log, stamped + scoped by stream_type
    // (the correctness trap — a sibling stream sharing the table must never fold in).
    expect(repo).toContain("_db.Events.Add(new EventRecord");
    expect(repo).toContain('StreamType = "Account",');
    expect(repo).toContain('e.StreamType == "Account"');
    expect(repo).toContain('"Opened" => System.Text.Json.JsonSerializer.Deserialize<Opened>');
    // The DbContext exposes the ONE shared event-log DbSet.
    const ctx = (await generate()).get("Infrastructure/Persistence/AppDbContext.cs")!;
    expect(ctx).toContain("DbSet<EventRecord> Events");
  });

  it("binds the create command to the create action's params (not the field set)", async () => {
    const files = await generate();
    const req = files.get("Application/Accounts/Requests/AccountRequests.cs")!;
    // CreateAccountRequest carries owner (the create param), not balance (a field).
    expect(req).toContain("CreateAccountRequest");
    expect(req).toContain("Owner");
    expect(req).not.toMatch(/CreateAccountRequest\([^)]*Balance/);
    const handler = files.get("Application/Accounts/Commands/CreateAccountHandler.cs")!;
    expect(handler).toContain("Account.Create(command.Owner)");
  });
});
