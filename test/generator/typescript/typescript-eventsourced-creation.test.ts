import { describe, expect, it } from "vitest";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../../src/platform/hono/v4/pins.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Hono/Drizzle event-sourced creation (appliers A2.2).
//
// An event-sourced aggregate is constructed from its creation event, not by
// writing state: the single `create` action's emit-only body runs against a
// fresh empty shell (`_init`), where each `emit` records-and-folds.  So
// `create(...)` returns an instance that already holds the folded state AND
// carries the creation event for `repo.save` to append.  The POST route's
// request body is the create action's params (the command shape), not the
// field set.
// ---------------------------------------------------------------------------

const SRC = `
context Accounts {
  event Opened { account: Account id, owner: string }
  event Deposited { account: Account id, amount: int }

  aggregate Account persistedAs: eventLog {
    owner: string
    balance: int

    invariant balance >= 0

    create open(owner: string) {
      emit Opened { account: id, owner: owner }
    }
    operation deposit(amount: int) {
      precondition amount > 0
      emit Deposited { account: id, amount: amount }
    }

    apply(e: Opened) { owner := e.owner  balance := 0 }
    apply(e: Deposited) { balance := balance + e.amount }
  }

  repository Accounts for Account { }
}
`;

async function generate(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  expect(errors, errors.join("\n")).toEqual([]);
  return generateTypeScript(model, HONO_V4_PINS);
}

function routesFile(files: Map<string, string>): string {
  const key = [...files.keys()].find((k) => k.includes("account") && k.includes("route"))!;
  return files.get(key)!;
}

describe("Hono/Drizzle event-sourced creation (persistedAs: eventLog + create)", () => {
  it("renders create(...) as a shell + emit-body factory, not a state writer", async () => {
    const domain = (await generate()).get("domain/account.ts")!;
    // Factory takes the create action's params (owner), news an empty shell,
    // and runs the body via _init.
    expect(domain).toContain("static create(input: { owner: string }): Account {");
    expect(domain).toMatch(
      /const inst = new Account\(\{ id: Ids\.newAccountId\(\) \} as unknown as .+\);/,
    );
    expect(domain).toContain("inst._init(input.owner);");
    expect(domain).toContain("return inst;");
    // _init runs the emit-only body: record-and-fold the creation event.
    expect(domain).toContain("private _init(owner: string): void {");
    expect(domain).toMatch(
      /const __ev: Events\.DomainEvent = \{ type: "Opened", account: this\._id, owner: owner \};\s*this\._events\.push\(__ev\);\s*this\._apply\(__ev\);/,
    );
    // No field-based state-writing create factory.
    expect(domain).not.toContain("static create(input: { owner: string; balance: number })");
  });

  it("folds the creation event BEFORE asserting invariants (B1)", async () => {
    const domain = (await generate()).get("domain/account.ts")!;
    // The shell is built with `trustStore = true` so the constructor does NOT
    // assert `balance >= 0` against the pre-fold (empty) state; invariants run
    // ONCE after `_init` emits-and-folds the creation event.  Order:
    //   new shell (trust) -> _init (emit+fold) -> _assertInvariants -> return
    expect(domain).toMatch(
      /const inst = new Account\(\{ id: Ids\.newAccountId\(\) \} as unknown as .+, true\);\s*inst\._init\(input\.owner\);\s*inst\._assertInvariants\(\);\s*return inst;/,
    );
    // Sanity: the invariant IS enforced (just after the fold, not before).
    expect(domain).toContain("_assertInvariants(): void {");
  });

  it("wires the POST route to the create action's params (not the field set)", async () => {
    const routes = routesFile(await generate());
    // Request schema is the command params: owner only, no balance.
    expect(routes).toContain("const CreateAccountRequest = z.object({");
    expect(routes).toMatch(/CreateAccountRequest = z\.object\(\{\s*owner: z\.string\(\),\s*\}\)/);
    // Handler calls the factory with the command params, then saves (append).
    expect(routes).toContain("const created = Account.create({ owner: body.owner });");
    expect(routes).toContain("await repo.save(created);");
  });

  it("flags an event-sourced aggregate with more than one create", async () => {
    const { errors } = await parseString(`
      context Accounts {
        event Opened { account: Account id, owner: string }
        aggregate Account persistedAs: eventLog {
          owner: string
          create open(owner: string) { emit Opened { account: id, owner: owner } }
          create reopen(owner: string) { emit Opened { account: id, owner: owner } }
          apply(e: Opened) { owner := e.owner }
        }
        repository Accounts for Account { }
      }
    `);
    expect(errors.some((e) => /single canonical creator/.test(e))).toBe(true);
  });

  it("omits the create route for an event-sourced aggregate with no create", async () => {
    const { model } = await parseString(`
      context Accounts {
        event Deposited { account: Account id, amount: int }
        aggregate Account persistedAs: eventLog {
          balance: int
          operation deposit(amount: int) { emit Deposited { account: id, amount: amount } }
          apply(e: Deposited) { balance := balance + e.amount }
        }
        repository Accounts for Account { }
      }
    `);
    const files = generateTypeScript(model, HONO_V4_PINS);
    const routes = routesFile(files);
    // No POST create route / request schema when there's no creator.
    expect(routes).not.toContain("CreateAccountRequest");
    expect(routes).not.toContain("Account.create(");
  });
});
