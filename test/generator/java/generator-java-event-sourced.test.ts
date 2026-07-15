// ---------------------------------------------------------------------------
// Java backend — event sourcing (`persistedAs: eventLog`, appliers A2;
// java joined EVENT_SOURCING_BACKENDS).  No state table and no Spring
// Data interface: the entity is a plain domain class (no JPA bindings)
// folded from the stream via `_fromEvents` / `_apply`; the repository
// impl appends to the single per-context `<ctx>_events` log (stream_type,
// stream_id, version, type, data jsonb) through JdbcTemplate with Jackson
// event ser/de, filtering + stamping `stream_type = "<Agg>"` so streams stay
// isolated;
// finds fold every stream and filter in memory; the create route rides
// the `create` action's params (the command shape) instead of the
// field-derived inputs.  Boot-verified end-to-end against Postgres via
// test/e2e/fixtures/java-build/event-sourced.ddd (create → deposit →
// withdraw folds to balance 70; overdraw precondition over folded
// state → 400; 3 versioned rows in the stream).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/event-sourced.ddd", "utf8");

const ROOT = "es_api/src/main/java/com/loom/esapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — event sourcing", () => {
  it("passes validation (java joined EVENT_SOURCING_BACKENDS)", async () => {
    const loom = await buildLoomModel(SRC);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.event-sourced-unsupported" || d.severity === "error",
    );
    expect(errors).toEqual([]);
  });

  it("the entity is a plain domain class folding the stream (no JPA bindings)", async () => {
    const e = (await files()).get(`${ROOT}/features/accounts/Account.java`)!;
    expect(e).not.toContain("@Table(");
    expect(e).not.toContain("@EmbeddedId");
    expect(e).toContain(
      "public static Account _fromEvents(AccountId id, List<DomainEvent> events) {",
    );
    expect(e).toContain("void _apply(DomainEvent ev) {");
    expect(e).toContain("case Opened e -> _applyOpened(e);");
    // The ES create action emits-and-folds through _init.
    expect(e).toContain("public static Account create(String owner) {");
  });

  it("emits the JdbcTemplate event-store impl and no Spring Data interface", async () => {
    const files_ = await files();
    expect(files_.has(`${ROOT}/features/accounts/AccountJpaRepository.java`)).toBe(false);
    const impl = files_.get(`${ROOT}/features/accounts/AccountRepositoryImpl.java`)!;
    expect(impl).toContain(
      '"insert into accounts.accounts_events (stream_type, stream_id, version, type, data) values (?, ?, ?, ?, ?::jsonb)"',
    );
    // The stream_type stamp discriminates this aggregate's rows in the shared log.
    expect(impl).toContain(
      '"Account", sid, version, ev.getClass().getSimpleName(), JSON.writeValueAsString(ev)',
    );
    expect(impl).toContain('case "Opened" -> JSON.readValue(data, Opened.class);');
    expect(impl).toContain("Account._fromEvents(id, events)");
    expect(impl).toContain(
      '"select stream_id, type, data from accounts.accounts_events where stream_type = ? order by stream_id, version", "Account"',
    );
    // load / delete / max(version) all filter the aggregate's own stream_type.
    expect(impl).toContain(
      '"select type, data from accounts.accounts_events where stream_type = ? and stream_id = ? order by version", "Account", sid',
    );
    expect(impl).toContain(
      '"select max(version) from accounts.accounts_events where stream_type = ? and stream_id = ?", Integer.class, "Account", sid',
    );
    expect(impl).toContain(
      '"delete from accounts.accounts_events where stream_type = ? and stream_id = ?", "Account"',
    );
  });

  it("the create surface rides the create action's params (the command shape)", async () => {
    const files_ = await files();
    const req = files_.get(`${ROOT}/features/accounts/CreateAccountRequest.java`)!;
    expect(req).toContain("public record CreateAccountRequest(String owner) {");
    const svc = files_.get(`${ROOT}/features/accounts/AccountService.java`)!;
    expect(svc).toContain("var aggregate = Account.create(owner);");
    const c = files_.get(`${ROOT}/features/accounts/AccountsController.java`)!;
    expect(c).toContain("public ResponseEntity<CreateAccountResponse> createAccount(");
  });
});
