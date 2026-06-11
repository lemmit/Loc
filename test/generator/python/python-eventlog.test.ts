import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — event sourcing (plan S14, appliers A2).  Verified
// live against Postgres during the slice: create→Opened, ops append
// gap-free versions, state folds (100-30=70), overdraw precondition
// 400, in-memory find over the folded set.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/eventlog.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python event sourcing", () => {
  it("emits the append-only stream table instead of a state table", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain("class AccountEventRow(Base):");
    expect(schema).toContain('    __tablename__ = "account_events"');
    expect(schema).toContain('PrimaryKeyConstraint("stream_id", "version")');
    // stream_id is TEXT in the shared DDL (Drizzle parity).
    expect(schema).toContain("    stream_id: Mapped[str] = mapped_column(Text)");
    expect(schema).not.toContain("class AccountRow");
  });

  it("the aggregate folds: per-event appliers, _apply dispatch, _from_events, ES create", async () => {
    const files = await build();
    const acct = files.get("api/app/domain/account.py")!;
    expect(acct).toContain("def _apply_opened(self, e: Opened) -> None:");
    expect(acct).toContain("def _apply(self, ev: DomainEvent) -> None:");
    expect(acct).toContain("if isinstance(ev, Opened):");
    expect(acct).toContain(
      'def _from_events(cls, id: AccountId, events: list[DomainEvent]) -> "Account":',
    );
    // ES create: empty shell + emit-only _init that records AND folds.
    expect(acct).toContain('def create(cls, *, owner: str) -> "Account":');
    expect(acct).toContain("inst._init(owner)");
    expect(acct).toContain("self._events.append(__ev)");
    expect(acct).toContain("self._apply(__ev)");
  });

  it("the repository folds on load and appends gap-free versions on save", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/account_repository.py")!;
    expect(repo).toContain(
      "return Account._from_events(id, [self._row_to_event(row) for row in rows])",
    );
    expect(repo).toContain("select(func.max(AccountEventRow.version))");
    expect(repo).toContain("version += 1");
    expect(repo).toContain("type=type(ev).type,");
    // Wire round-trip dispatchers.
    expect(repo).toContain('if row.type == "Opened":');
    expect(repo).toContain("def _event_to_data(self, ev: DomainEvent) -> dict[str, object]:");
    // Finds filter the folded set in memory.
    expect(repo).toContain("[a for a in await self.all() if a.owner == owner]");
  });

  it("the create route takes the create ACTION's params", async () => {
    const files = await build();
    const routes = files.get("api/app/http/account_routes.py")!;
    expect(routes).toContain("class CreateAccountRequest(BaseModel):");
    expect(routes).toContain("    owner: str");
    expect(routes).toContain("created = Account.create(owner=body.owner)");
  });
});
