# Domain services rev. 4 — Slice 1 (`reading`) + `mutating` preview — paper simulation

> **Paper only.** Nothing below is implemented. Every fragment is **adapted
> from real generated output** of the shipped pure-tier `domainService` and the
> shipped load+read+save `workflow`, both generated here at
> `claude/loom-domain-services-0mks5a` (build green). Each spot where the shape
> goes **beyond** what the analog actually emits is marked **⟦EXTRAPOLATED⟧**.
>
> Analogs generated:
> - `scratchpad/sys-pure.ddd` → pure `domainService FeeQuote` on all 5 backends.
> - `scratchpad/sys-wf.ddd` → `workflow MoveMoney` (load `getById` ×2 → mutate via
>   ops → one transactional commit) on all 5 backends.
>
> The `reading`/`mutating` service is, structurally, the **pure-tier service
> declaration** (the namespace/static-class/module/context-fn shell, verbatim)
> with the **workflow's read-handle and commit machinery** spliced in. The whole
> proposal is "these two already-shipped shapes compose"; the sim shows exactly
> where they meet.

---

## 1. The `.ddd` source — Banking / `MoveMoney`

```ddd
context Banking {

  valueobject Money {
    amount: decimal
    currency: string
    invariant amount >= 0
  }

  error InsufficientFunds { account: Account id, shortfall: Money }

  aggregate Account with crudish {
    holder: string
    balance: Money

    operation withdraw(amount: Money) {                      // mutating op on the aggregate
      precondition balance.amount >= amount.amount
      balance := Money { amount: balance.amount - amount.amount, currency: balance.currency }
    }
    operation deposit(amount: Money) {
      balance := Money { amount: balance.amount + amount.amount, currency: balance.currency }
    }
  }

  repository Accounts for Account {
    find byHolder(holder: string): Account? where this.holder == holder
  }

  // ── reading tier ──  read-only repo query, no writes.  Orchestrator-only.
  domainService Registration {
    operation isEmailAvailable(holder: string): bool {
      return Accounts.byHolder(holder) == null      // a Repo.find — look-up, no mutation
    }
  }

  // ── mutating tier ──  mutates the PASSED-IN aggregates via their own ops.
  domainService Transfer {
    operation run(src: Account, dst: Account, amount: Money)
      : Transferred or InsufficientFunds {
      require amount.amount > 0  "amount must be positive"
      if (src.balance.amount < amount.amount)
        return InsufficientFunds { account: src.id, shortfall: amount }
      src.withdraw(amount)                          // mutate a PASSED-IN aggregate
      dst.deposit(amount)                           // via its own operation
      return Transferred { src: src.id, dst: dst.id, amount: amount }
    }
  }

  // ── orchestrator ──  loads the targets, calls the service, owns the commit.
  workflow MoveMoney transactional {
    create(source: Account id, dest: Account id, amount: Money) {
      let src = Accounts.getById(source)            // orchestrator LOADS the targets
      let dst = Accounts.getById(dest)
      Transfer.run(src, dst, amount)                // service reads/decides + MUTATES src,dst
      // src/dst are saved by the orchestrator (idiomatic per backend, below)
    }
  }
}
```

> **Two reserved-word gotchas surfaced while generating the analog** (real, not
> hypothetical): `from`/`to` are **reserved** in `.ddd` (params must be
> `source`/`dest`), and the header-param workflow form is gone — a workflow body
> is members-only, so the orchestrator is `workflow X { create(params){…} }`.
> **⟦EXTRAPOLATED⟧** surface choices below — `require … "msg"` on a service op,
> `Transfer.run(...)` as a workflow statement, and the result threading — are
> covered in §4.

---

## 2. Generated output per backend

The reading/mutating declaration = **pure-tier shell** (real, §2.0) + **read
handle** (reading) + **mutation-of-passed-in-aggregate** (mutating). The
orchestrator persistence = **the workflow's real commit idiom** (real, §2.x).

### 2.0 — The pure-tier shell that everything starts from (REAL)

This is the *actual* emitted `FeeQuote` pure service per backend — the DI-free
static/namespace/module/context-fn. The reading/mutating shell is this, plus a
handle:

```ts   // node_api/domain/services.ts  — REAL
export namespace FeeQuote {
  export function forAmount(amount: Money): Money {
      return new Money(amount.amount, amount.currency);
  }
}
```
```csharp // dotnet_api/Domain/Services/FeeQuote.cs — REAL
public static class FeeQuote
{
    public static Money ForAmount(Money amount) { return new Money(amount.Amount, amount.Currency); }
}
```
```java  // FeeQuote.java — REAL
public final class FeeQuote {
    private FeeQuote() {}
    public static Money forAmount(Money amount) { return new Money(amount.amount(), amount.currency()); }
}
```
```python # fee_quote.py — REAL
def for_amount(amount: Money) -> Money:
    return Money(amount.amount, amount.currency)
```
```elixir # fee_quote.ex — REAL
defmodule ElixirApi.Domain.Services.FeeQuote do
  @spec for_amount(map()) :: map()
  def for_amount(amount) do
    %{amount: amount.amount, currency: amount.currency}
  end
end
```

---

### 2.1 — TS / Hono (Drizzle): read-port arg + `repo.save(_, tx)`

**Reading** — the pure namespace gains a **read-port parameter** (the
`AccountRepository` constructed on `tx`/`db`, exactly as the workflow builds it).
The `Repo.find` renders as the repo's real `byHolder` method:

```ts  // ⟦EXTRAPOLATED — pure shell (REAL) + read-port arg + repo.find⟧
export namespace Registration {
  // read-port threaded in (cf. the workflow building `new AccountRepository(tx, events)`)
  export async function isEmailAvailable(accounts: AccountRepository, holder: string): Promise<boolean> {
    return (await accounts.byHolder(holder)) == null;   // accounts.byHolder = the REAL find
  }
}
```
The orchestrator passes the same repo it loaded through:
```ts  // ⟦EXTRAPOLATED⟧  inside the workflow's db.transaction (REAL wrapper below)
const accounts = new AccountRepository(tx, events);
const ok = await Registration.isEmailAvailable(accounts, body.holder);
```

**Mutating** — the service mutates the **same `src` object** the workflow loaded;
no change-tracking, so the **orchestrator** writes each passed-in aggregate back
with `repo.save(_, tx)`. This is the workflow body **verbatim** (REAL), with
`src.withdraw / dst.deposit` moved behind `Transfer.run`:

```ts  // node_api/http/workflows.ts — REAL wrapper, ⟦EXTRAPOLATED⟧ service call line
await db.transaction(async (tx) => {
  const accounts = new AccountRepository(tx, events);
  const src = await accounts.getById(source);      // REAL — orchestrator LOADS
  const dst = await accounts.getById(dest);        // REAL
  Transfer.run(src, dst, amount);                  // ⟦EXTRAPOLATED⟧ mutates src,dst in place
  await accounts.save(src);                         // REAL — orchestrator PERSISTS the same instances
  await accounts.save(dst);                         // REAL
});
```
> **Liveness:** `src` is a plain JS object; `Transfer.run` mutates *that
> reference* (`src.withdraw` sets `src.balance`), and `accounts.save(src)` writes
> the mutated object. Works because the orchestrator holds and saves the **same
> reference** the service mutated — the no-change-tracking caveat (§4e).

---

### 2.2 — .NET / EF Core: DI'd read repo + `SaveChangesAsync` via change-tracking

**Reading** — EF can't keep a repo-touching service `static` (tracking needs the
scoped `DbContext`), so the declaration becomes a **DI'd service** with an
injected `IAccountRepository`. The pure body (REAL) is unchanged; only the shell
gains a ctor:

```csharp // ⟦EXTRAPOLATED — ctor/DI added; the GetByIdAsync/repo read shape is REAL from the workflow⟧
public sealed class Registration
{
    private readonly IAccountRepository _accounts;
    public Registration(IAccountRepository accounts) { _accounts = accounts; }

    public async Task<bool> IsEmailAvailableAsync(string holder, CancellationToken ct = default)
        => (await _accounts.ByHolderAsync(holder, ct)) is null;   // AsNoTracking read
}
```

**Mutating** — passed-in `src`/`dst` are **EF-tracked**; the service mutates them
in place; the orchestrator's single `SaveChangesAsync` flushes both. The
`MoveMoneyHandler` below is **REAL** — only the inner `src.Withdraw/dst.Deposit`
pair collapses into the injected `Transfer`:

```csharp // dotnet_api/Application/Workflows/MoveMoneyHandler.cs — REAL wrapper, ⟦EXTRAPOLATED⟧ Transfer line
await using var tx = await _db.Database.BeginTransactionAsync(cancellationToken);
try
{
    var src = await _accounts.GetByIdAsync(command.Source, cancellationToken)  // REAL
        ?? throw new AggregateNotFoundException($"Account {command.Source} not found");
    var dst = await _accounts.GetByIdAsync(command.Dest, cancellationToken)
        ?? throw new AggregateNotFoundException($"Account {command.Dest} not found");
    _transfer.Run(src, dst, command.Amount);     // ⟦EXTRAPOLATED⟧ mutates tracked entities
    await _accounts.SaveAsync(src, cancellationToken);   // REAL (SaveAsync → SaveChangesAsync)
    await _accounts.SaveAsync(dst, cancellationToken);   // REAL
    await tx.CommitAsync(cancellationToken);             // REAL — single commit
}
catch { await tx.RollbackAsync(cancellationToken); throw; }
```
> **Liveness:** `src`/`dst` are the **tracked** entities returned by
> `GetByIdAsync`; mutating them marks them dirty; `SaveChangesAsync` (inside
> `SaveAsync`) writes both. EF tracking makes the pass-in automatically the same
> managed instance — no extra `save` needed beyond the existing one.

---

### 2.3 — Java / Spring + JPA: `@Service` bean + dirty-checking at `@Transactional`

**Reading** — a `@Service` bean with a constructor-injected `AccountRepository`
(the `readOnly=true` idiom on the caller). The pure static body (REAL) moves
onto an instance method:

```java // ⟦EXTRAPOLATED — @Service + injected repo; getById/byHolder shape is REAL⟧
@Service
public class Registration {
    private final AccountRepository accountsRepository;
    public Registration(AccountRepository accountsRepository) { this.accountsRepository = accountsRepository; }

    @Transactional(readOnly = true)
    public boolean isEmailAvailable(String holder) {
        return accountsRepository.byHolder(holder) == null;   // byHolder = REAL find method
    }
}
```

**Mutating** — passed-in `src`/`dst` are **managed** entities; dirty-checking
flushes them at the `@Transactional` boundary. The `BankingWorkflows` bean below
is **REAL**; only the `src.withdraw/dst.deposit` pair becomes a `Transfer` call.
Note the **explicit `save`s are real today** and stay (covers newly-created
aggregates; harmless for managed ones):

```java // BankingWorkflows.java — REAL wrapper, ⟦EXTRAPOLATED⟧ Transfer line
@Service
@Transactional
public class BankingWorkflows {
    private final AccountRepository accountsRepository;
    private final Transfer transfer;   // ⟦EXTRAPOLATED⟧ injected mutating service
    // ctor …
    public void moveMoney(MoveMoneyRequest request) {
        var src = accountsRepository.getById(source);   // REAL — managed
        var dst = accountsRepository.getById(dest);     // REAL — managed
        transfer.run(src, dst, amount);                 // ⟦EXTRAPOLATED⟧ mutates managed entities
        accountsRepository.save(src);                   // REAL (explicit; required for NEW aggregates)
        accountsRepository.save(dst);                   // REAL — dirty-check would flush these anyway
    }   // @Transactional commit on method return
}
```
> **Liveness:** `src`/`dst` are JPA-**managed**; the service mutates the managed
> instances; the persistence context flushes them at commit. The explicit
> `save(...)` is redundant for these (managed) but the proposal keeps it as the
> uniform "new aggregate still needs save" rule (§persistence table, "+ explicit
> save for newly created").

---

### 2.4 — Python / SQLAlchemy: `session`/read-port param + `session.commit()`

**Reading** — the bare module function gains a `session`-or-repo parameter
(Cosmic-Python's explicit-UoW-argument). The pure body (REAL) is unchanged:

```python # ⟦EXTRAPOLATED — repo param added; by_holder read is REAL⟧
async def is_email_available(accounts: AccountRepository, holder: str) -> bool:
    return (await accounts.by_holder(holder)) is None     # by_holder = REAL find
```

**Mutating** — passed-in `src`/`dst` are **session-tracked**; the orchestrator's
single `session.commit()` (in `get_session`, REAL) persists both. The route is
**REAL**; only the `src.withdraw/dst.deposit` pair becomes `transfer.run`:

```python # python_api/app/http/workflows_routes.py — REAL, ⟦EXTRAPOLATED⟧ Transfer line
async def move_money_workflow(body: MoveMoneyRequest, session: SessionDep) -> Response:
    accounts = AccountRepository(session, NoopDomainEventDispatcher())
    src = await accounts.get_by_id(source)   # REAL — orchestrator LOADS
    dst = await accounts.get_by_id(dest)     # REAL
    transfer.run(src, dst, amount)           # ⟦EXTRAPOLATED⟧ mutates src,dst
    await accounts.save(src)                 # REAL — repo flushes
    await accounts.save(dst)                 # REAL
    return Response(status_code=204)
    # commit happens once in get_session() after the handler returns  (REAL)
```
> **Liveness:** like TS, `src` is a plain object the service mutates by reference;
> the orchestrator `save`s the same instance, and `get_session` commits once
> (`expire_on_commit=False`, REAL). The explicit per-aggregate `save` is what
> makes the mutation visible — see §4e.

---

### 2.5 — Elixir / Ecto: CONTEXT FUNCTION (ambient `Repo`), inline changeset + `Repo.transaction`

Per locked decision (B): a single-context reading/mutating service lowers to a
**context function**, not a `Domain.Services` module. The ambient `Repo` is the
read handle — **free**, no injection.

**Reading** — a `Banking` context function calling `Repo` directly. The read
shape (`Repo.all(from … where …)`) is **REAL** from the generated
`AccountRepository.by_holder`:

```elixir # ⟦EXTRAPOLATED placement: a fn ON the Banking context⟧  (Repo read shape is REAL)
defmodule ElixirApi.Banking do
  # … existing context functions …
  @spec email_available?(binary()) :: boolean()
  def email_available?(holder) do
    case by_holder_account(holder) do      # delegates to AccountRepository.by_holder (REAL)
      {:ok, []} -> true
      _ -> false
    end
  end
end
```
> Contrast with the **pure** `FeeQuote`, which **does** get a standalone
> `ElixirApi.Domain.Services.FeeQuote` module (REAL, §2.0). The tier is what
> decides module-vs-context-fn: pure → `Domain.Services` module; reading/mutating
> single-context → context fn.

**Mutating** — the orchestrator is a context fn wrapping `Repo.transaction`, and
the mutation flows through the **existing** `withdraw_account`/`deposit_account`
context fns, which build an **inline changeset + `Repo.update`** (via
`persist_change`). The `MoveMoney` workflow below is **REAL** — the service just
*is* the `with`-chain of context-fn calls:

```elixir # move_money.ex — REAL.  The "service" is the with-chain of context calls.
def run(params) when is_map(params) do
  Repo.transaction(fn -> commit_result(run_inner(params)) end)   # REAL — ambient Repo
end

defp run_inner(params) do
  %{"source" => source, "dest" => dest, "amount" => amount} = params
  with {:ok, src} <- Context.get_account(source),                       # REAL — Repo.get
       {:ok, dst} <- Context.get_account(dest),                         # REAL
       {:ok, _}   <- Context.withdraw_account(src, %{arg0: amount}),    # REAL — changeset + Repo.update
       {:ok, _}   <- Context.deposit_account(dst, %{arg0: amount}) do   # REAL
    {:ok, dst}
  end
end
```
And the persist idiom each mutation lowers to (REAL `withdraw_account`):
```elixir # banking.ex — REAL
def withdraw_account(%Account{} = record, params) do
  amount = Map.get(params, "amount")
  if not (Decimal.compare(record.balance.amount, amount.amount) in [:gt, :eq]),
    do: raise(ArgumentError, "Precondition failed: balance.amount >= amount.amount")
  record = %{record | balance: %{amount: Decimal.sub(record.balance.amount, amount.amount), currency: record.balance.currency}}
  record |> Ecto.Changeset.change(%{}) |> Ecto.Changeset.put_change(:balance, record.balance)
         |> AccountRepository.persist_change()   # → Repo.update, inside the orchestrator's Repo.transaction
end
```
> **Liveness:** Ecto structs are immutable — there is **no shared instance**. The
> orchestrator threads the **struct returned** by each context fn through the
> `with` chain; `persist_change` → `Repo.update` writes inside the single
> `Repo.transaction`. A `mutating` `Transfer.run` ⟦EXTRAPOLATED⟧ would lower to
> *exactly this with-chain* — there is nothing for the service to "hold" because
> the context functions already are the mutation+persist seam (§4d, §4e).

---

## 3. Behavioural sketch — `test e2e`

Against the Hono backend (api-tier e2e → vitest+fetch, dispatched automatically):

```ddd
test e2e "transfer moves funds" against nodeApi {
  // seed two accounts
  let a = POST /accounts { holder: "alice", balance: { amount: 100, currency: "USD" } }
  let b = POST /accounts { holder: "bob",   balance: { amount: 0,   currency: "USD" } }

  // run the orchestrator — load src/dst → Transfer.run mutates → one commit
  POST /workflows/move_money { source: a.id, dest: b.id, amount: { amount: 40, currency: "USD" } }
    => 204

  // read back: the commit persisted BOTH passed-in aggregates
  GET /accounts/{a.id} => 200 { balance: { amount: 60,  currency: "USD" } }
  GET /accounts/{b.id} => 200 { balance: { amount: 40,  currency: "USD" } }

  // insufficient-funds path: service returns the error variant, nothing commits
  POST /workflows/move_money { source: b.id, dest: a.id, amount: { amount: 999, currency: "USD" } }
    => 400   // InsufficientFunds → DomainError → 400; transaction rolled back
  GET /accounts/{b.id} => 200 { balance: { amount: 40, currency: "USD" } }   // unchanged
}
```
> ⟦EXTRAPOLATED⟧ — the `test e2e` body sugar is illustrative; the round-trip
> (load → service mutates → single commit → read back) and the 204/400 codes
> mirror the REAL `workflows.ts` `onError` mapping (`DomainError → 400`).

---

## 4. Open questions for the user

**(a) `from <Criterion>(args)` on a named service param (reading tier) — exact spelling.**
Applying a criterion to a *named parameter* (not implicit `this`/loaded candidate)
isn't shipped. Candidate spellings inside a `reading` body:
- `order from HighValue(threshold)` — postfix, reads as "order, as judged by HighValue".
- `HighValue(threshold).holds(order)` — predicate-object method form.
- `matches(order, HighValue(threshold))` — free function.
Which spelling? (The proposal names `from <Criterion>(args)` as the gap; confirm
the exact token order and whether it binds to one param or many.)

**(b) Read-handle shape per backend — confirm.** Proposed: **injected read-repo**
on EF (`IAccountRepository`) and JPA (`@Service` bean), **read-port parameter** on
Drizzle (`accounts: AccountRepository`) and Python (`accounts`/`session`), **ambient
`Repo`** on Elixir (context fn). Alternative for EF/JPA/Python: an *ambient
request-scoped accessor* (like the Python principal `ContextVar`) instead of a
param/ctor. Lean read-port for explicitness — confirm, or pick ambient for the
actor-style case (proposal OQ#1).

**(c) `mutating` service's `or`-union result — `?` propagation vs explicit `match`.**
`Transfer.run` returns `Transferred or InsufficientFunds`. In the orchestrator,
either:
- **explicit match** (proposal's calling example): `match r { Transferred t => {save; return t} InsufficientFunds e => return e }`, OR
- **`?` propagation**: `let t = Transfer.run(src, dst, amount)?` — the error
  variant short-circuits the handle (and, when `transactional`, rolls back).
The sim's §2 elided this (called `Transfer.run(...)` as a bare statement). Pin
one — `?` is terser and aligns the rollback with the transaction boundary, but
`match` is what the proposal's example shows. Which is canonical?

**(d) Elixir — confirm context-function placement + cross-context detection.**
Locked decision (B) says single-context → context fn (on `ElixirApi.Banking`),
standalone module only cross-context. Confirm: (i) the reading fn lands **on the
context module** (`ElixirApi.Banking.email_available?`), not under
`Domain.Services`; (ii) "cross-context" is detected from the operation's
**parameter modules** — if every `Account`/`Money` param resolves to one context,
it's a context fn; if params span two contexts, it's a standalone
`Domain.Services.<Name>` module taking explicit `Repo`/context args. Is
parameter-module-spread the right detector (proposal OQ#5)?

**(e) Pass-in liveness — backends where the passed aggregate is NOT the saved instance.**
- **EF / JPA**: pass-in **is** the tracked/managed instance → mutation auto-visible at commit. ✓ no special handling.
- **TS / Python**: `src` is a **plain object**; the service mutates it by
  reference, and the orchestrator `save`s **that same reference** — visible
  *because* the orchestrator holds and explicitly saves it. (If a future service
  returned a *new* object instead of mutating in place, the orchestrator would
  save the stale one — so the rule is **mutate-in-place only**, never
  return-a-copy.) Confirm the mutate-in-place constraint.
- **Elixir**: structs are **immutable — there is no shared instance**. Mutation
  is *return-a-new-struct* threaded through the `with` chain; `persist_change` →
  `Repo.update` writes it. So Elixir is the one backend where "the same instance"
  is structurally false — and the `mutating` lowering must thread the returned
  struct, not assume in-place mutation. Confirm this is acceptable (it's the REAL
  workflow idiom today), and that a `mutating` `Transfer.run` is therefore sugar
  for the `with`-chain of context-fn calls, emitting no separate service unit.

---

### Appendix — provenance of every fragment

| Fragment | Source | Real / Extrapolated |
|---|---|---|
| Pure `FeeQuote` (all 5) | `sys-pure.ddd` → generated | **REAL** |
| TS `db.transaction` + `getById` + `save` | `node_api/http/workflows.ts` | **REAL** wrapper; service call line extrapolated |
| EF `BeginTransactionAsync`/`GetByIdAsync`/`SaveAsync`/`CommitAsync` | `MoveMoneyHandler.cs` | **REAL** wrapper; `Transfer.Run` line extrapolated |
| JPA `@Service @Transactional` + `getById`/`save` | `BankingWorkflows.java` | **REAL** wrapper; `transfer.run` line extrapolated |
| Python `SessionDep`/`get_by_id`/`save` + `get_session` commit | `workflows_routes.py`, `db/engine.py` | **REAL** wrapper; `transfer.run` line extrapolated |
| Elixir `Repo.transaction` + `with`-chain + `withdraw_account`/`persist_change`/`by_holder` | `move_money.ex`, `banking.ex`, `account_repository.ex` | **REAL** (the mutating service *is* this) |
| Reading-tier shells (read handle spliced into pure shell) | — | **⟦EXTRAPOLATED⟧** |
| `test e2e` body | — | **⟦EXTRAPOLATED⟧** sugar; codes mirror REAL `onError` |
