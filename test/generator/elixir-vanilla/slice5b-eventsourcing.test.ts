import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Slice P4.1/P4.2 of docs/plans/elixir-eventsourcing-vanilla-plan.md —
// event sourcing on the elixir vanilla foundation (D-VANILLA-ES-HOME).
//
// Two halves:
//   1. the gate — `persistedAs(eventLog)` is accepted on `foundation: vanilla`
//      (the only elixir foundation since Ash was removed);
//   2. the emit — in-memory struct + event-log Ecto schema + fold +
//      event-store repository + emit/append/fold command runners + ES
//      controller (per-op endpoints, atom-error mapping).
// ---------------------------------------------------------------------------

const AGG = `
      event Opened { account: Account id, owner: string }
      event Deposited { account: Account id, amount: int }
      aggregate Account persistedAs(eventLog) {
        owner: string
        balance: int
        create open(owner: string) { emit Opened { account: id, owner: owner } }
        operation deposit(amount: int) {
          precondition amount > 0
          emit Deposited { account: id, amount: amount }
        }
        apply(e: Opened) { owner := e.owner  balance := 0 }
        apply(e: Deposited) { balance := balance + e.amount }
      }
      repository Accounts for Account { find byOwner(owner: string): Account? where this.owner == owner }`;

const source = () => `
system L {
  subdomain Core {
    context Accounts {${AGG}
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource log { for: Accounts, kind: eventLog, use: pg }
  deployable api {
    platform: elixir
    contexts: [Accounts]
    dataSources: [log]
    serves: A
    port: 4000
  }
}
`;

async function diagnostics() {
  const { model } = await parseString(source(), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const ES_GATE = "loom.event-sourcing-backend-unsupported";

describe("vanilla — Slice P4.1 event-sourcing gate", () => {
  it("accepts persistedAs(eventLog) on foundation: vanilla", async () => {
    const diags = await diagnostics();
    expect(diags.find((d) => d.code === ES_GATE)).toBeUndefined();
  });
});

describe("vanilla — Slice P4.2 event-sourcing emit", () => {
  const files = () => generateSystemFiles(source());
  const get = (m: Map<string, string>, suffix: string) =>
    m.get([...m.keys()].find((k) => k.endsWith(suffix))!)!;

  it("emits the aggregate as a plain in-memory struct (no Ecto state table)", async () => {
    const f = await files();
    const struct = get(f, "/accounts/account.ex");
    expect(struct).toContain("defstruct [:id, :owner, :balance]");
    expect(struct).not.toContain("use Ecto.Schema");
    expect(struct).not.toContain("timestamps(");
  });

  it("emits an event-log Ecto schema over <agg>_events", async () => {
    const log = get(await files(), "/accounts/account_event_log.ex");
    expect(log).toContain('schema "account_events" do');
    expect(log).toContain("field :stream_id, :string, primary_key: true");
    expect(log).toContain("field :version, :integer, primary_key: true");
    expect(log).toContain("field :data, :map");
  });

  it("emits a fold module (apply_event clauses + from_events fold-from-zero)", async () => {
    const fold = get(await files(), "/accounts/account_fold.ex");
    expect(fold).toContain("def from_events(id, events)");
    expect(fold).toContain("def apply_event(state, %Api.Accounts.Events.Opened{} = e)");
    expect(fold).toContain("def apply_event(state, %Api.Accounts.Events.Deposited{} = e)");
    // `balance := balance + e.amount` folds against the threaded `state`.
    expect(fold).toContain("state = %{state | balance: state.balance + e.amount}");
  });

  it("emits an event-store repository (load+fold reads, gap-free append)", async () => {
    const repo = get(await files(), "/accounts/account_repository.ex");
    expect(repo).toContain("def find_by_id(id) when is_binary(id)");
    expect(repo).toContain("def append(id, events) when is_binary(id) and is_list(events)");
    expect(repo).toContain("Repo.transaction(fn ->");
    expect(repo).toContain("Enum.with_index(prior + 1)");
    // event <-> JSONB round-trip
    expect(repo).toContain('defp event_type(%Api.Accounts.Events.Opened{}), do: "Opened"');
    expect(repo).toContain('defp row_to_event(%{type: "Deposited", data: d})');
    // in-memory find (no queryable state columns)
    expect(repo).toContain("def by_owner(owner)");
    // unused-alias hygiene (`--warnings-as-errors`): aliases are referenced short.
    expect(repo).not.toMatch(
      /alias Api\.Accounts\.AccountFold\n[\s\S]*Api\.Accounts\.AccountFold\.from_events/,
    );
  });

  it("context create/op runners emit→append→fold; guard helper present", async () => {
    const ctx = get(await files(), "lib/api/accounts.ex");
    expect(ctx).toContain("def create_account(attrs) do");
    expect(ctx).toContain("id = Ecto.UUID.generate()");
    expect(ctx).toContain("Api.Accounts.AccountRepository.append(id, events)");
    expect(ctx).toContain("def deposit_account(%Api.Accounts.Account{} = state, attrs) do");
    expect(ctx).toContain("ensure(amount > 0, :precondition_failed)");
    expect(ctx).toContain("defp ensure(true, _reason), do: :ok");
    // delegate reads
    expect(ctx).toContain("defdelegate get_account(id)");
    expect(ctx).toContain("defdelegate list_accounts()");
  });

  it("ES controller maps atom command errors; routes drop generic update/delete", async () => {
    const f = await files();
    const ctl = get(f, "/controllers/account_controller.ex");
    expect(ctl).toContain('def deposit(conn, %{"id" => id} = params)');
    expect(ctl).toContain("send_resp(conn, 204");
    expect(ctl).toContain("defp command_error(conn, :forbidden)");
    expect(ctl).toContain('ProblemDetails.problem_response(conn, 422, "Unprocessable Entity"');
    const router = get(f, "/router.ex");
    expect(router).toContain('post "/accounts/:id/deposit", AccountController, :deposit');
    // event-sourced aggregates have no generic field-update / delete surface
    expect(router).not.toContain('patch "/accounts/:id"');
    expect(router).not.toContain('delete "/accounts/:id"');
  });

  it("§14: ES controller serialize projects camelCase wire keys (not a raw snake struct dump)", async () => {
    const esCamel = `
system L {
  subdomain Core {
    context Accounts {
      event Opened { account: Account id, owner: string }
      aggregate Account persistedAs(eventLog) {
        owner: string
        currentBalance: int
        create open(owner: string) { emit Opened { account: id, owner: owner } }
        apply(e: Opened) { owner := e.owner  currentBalance := 0 }
      }
      repository Accounts for Account { }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource log { for: Accounts, kind: eventLog, use: pg }
  deployable api {
    platform: elixir
    contexts: [Accounts]
    dataSources: [log]
    serves: A
    port: 4000
  }
}
`;
    const f = await generateSystemFiles(esCamel);
    const ctl = get(f, "/controllers/account_controller.ex");
    // wireShape-driven serialize: camelCase JSON key, snake struct-field read.
    expect(ctl).toContain('"currentBalance" => record.current_balance');
    expect(ctl).toContain('"owner" => record.owner');
    // NOT the old raw dump.
    expect(ctl).not.toContain("|> Map.from_struct()");
  });
});
