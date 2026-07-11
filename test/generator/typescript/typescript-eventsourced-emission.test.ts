import { describe, expect, it } from "vitest";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Hono/Drizzle event-sourcing emission (`persistedAs(eventLog)`, appliers A2).
//
// An event-sourced aggregate persists to an append-only `<agg>_events`
// stream table (no state table); state is rehydrated by folding the stream
// through the appliers (`_fromEvents`).  Command `emit`s both record the
// event and fold it (`_apply`) so the in-memory aggregate is consistent for
// the response.  A top-level context drives the single-project (legacy)
// generateTypeScript path; the deployable-gating lives in the IR validator
// (test/ir) and the tsc gate in test/e2e/generated-build.test.ts.
// ---------------------------------------------------------------------------

const SRC = `
context Accounts {
  event Opened { account: Account id, owner: string }
  event Deposited { account: Account id, amount: int }
  event Withdrawn { account: Account id, amount: int }

  aggregate Account persistedAs(eventLog) {
    owner: string
    balance: int

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
  return generateTypeScript(model, HONO_V4_PINS);
}

describe("Hono/Drizzle event-sourcing emission (persistedAs(eventLog))", () => {
  it("emits an append-only <agg>_events stream table (no state table)", async () => {
    const schema = (await generate()).get("db/schema.ts")!;
    expect(schema).toContain('export const accountEvents = pgTable("account_events", {');
    expect(schema).toContain('streamId: text("stream_id").notNull(),');
    expect(schema).toContain('version: integer("version").notNull(),');
    expect(schema).toContain('data: jsonb("data").notNull(),');
    expect(schema).toContain("primaryKey({ columns: [table.streamId, table.version] })");
    // No state table for the aggregate.
    expect(schema).not.toContain('pgTable("accounts"');
  });

  it("renders appliers as a _apply fold dispatch + _fromEvents rehydrator", async () => {
    const domain = (await generate()).get("domain/account.ts")!;
    expect(domain).toContain("private _applyOpened(e: Events.Opened): void {");
    expect(domain).toContain("private _applyDeposited(e: Events.Deposited): void {");
    expect(domain).toContain("private _apply(ev: Events.DomainEvent): void {");
    expect(domain).toContain('case "Deposited":');
    expect(domain).toContain("this._applyDeposited(ev as Events.Deposited);");
    expect(domain).toContain(
      "static _fromEvents(id: Ids.AccountId, events: Events.DomainEvent[]): Account {",
    );
    expect(domain).toContain("for (const ev of events) inst._apply(ev);");
  });

  it("makes a command emit record-and-fold (push + _apply)", async () => {
    const domain = (await generate()).get("domain/account.ts")!;
    // The deposit body's emit pushes the event AND folds it via _apply.
    expect(domain).toMatch(
      /const __ev: Events\.DomainEvent = \{ type: "Deposited", account: this\._id, amount: amount \};\s*this\._events\.push\(__ev\);\s*this\._apply\(__ev\);/,
    );
    // The fold itself mutates state (balance := balance + e.amount).
    expect(domain).toContain("this._balance = this._balance + e.amount;");
  });

  it("repository folds the stream on load and appends pending events on save", async () => {
    const repo = (await generate()).get("db/repositories/account-repository.ts")!;
    // Load: read stream in version order, fold via _fromEvents.
    expect(repo).toContain("from(schema.accountEvents)");
    expect(repo).toContain(".orderBy(schema.accountEvents.version);");
    expect(repo).toContain("Account._fromEvents(");
    // Save: append pulled events with gap-free versions continuing the stream.
    expect(repo).toContain("const pending = aggregate.pullEvents();");
    expect(repo).toContain("version: ++version,");
    expect(repo).toContain("data: eventToData(event),");
    // Stream (de)serialisers present.
    expect(repo).toContain(
      "function eventToData(ev: Events.DomainEvent): Record<string, unknown> {",
    );
    expect(repo).toContain(
      "function rowToEvent(row: { type: string; data: unknown }): Events.DomainEvent {",
    );
  });

  it("does not emit a state-table repository helper for the event-sourced aggregate", async () => {
    const repo = (await generate()).get("db/repositories/account-repository.ts")!;
    // No relational upsert / row projection — the event repo is append/fold only.
    expect(repo).not.toContain("toRow(");
    expect(repo).not.toContain(".onConflictDoUpdate(");
  });
});
