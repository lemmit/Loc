# Capability-stamp dedup — paper simulation

**Role:** simulator / paper-prototype. **No compiler code changed.** This doc pairs today's REAL generated output ("before") with a hand-written proposed output ("after") so a human can sign off before any emitter is touched.

**Design under simulation — "let the persistence layer be the friend; the marker interface is a pure tag":**
- A **pure marker interface** per capability (`IAuditable` in .NET, `Auditable` in Java) with **zero members** — runtime type identity only.
- **.NET:** one generic `SaveChangesInterceptor` loop over `ChangeTracker.Entries()` filtering `entry.Entity is IAuditable`, writing fields via EF's own metadata (`entry.Property("CreatedAt").CurrentValue = …`). No per-type `switch` arm, no `internal set`, no method on the entity. **Timing unchanged** (still SaveChanges).
- **Java:** drop `_stampOnCreate/_stampOnUpdate` from the entity; replace with idiomatic Spring Data JPA auditing (`@CreatedDate/@LastModifiedDate/@CreatedBy/@LastModifiedBy` + `@EntityListeners(AuditingEntityListener.class)` + once-per-app `@EnableJpaAuditing` + an `AuditorAware<UUID>` bean). **Timing moves operation-time → persist-time.**

Both backends generated from the committed fixtures:
- `.NET`: `test/e2e/fixtures/dotnet-build/auditable.ddd` → `node bin/cli.js generate system … -o /tmp/sim-dotnet`
- `Java`: `test/e2e/fixtures/java-build/auditable.ddd` → `… -o /tmp/sim-java`

Both fixtures are identical except `platform: dotnet`/`platform: java`:

```ddd
system PS {
  user { id: guid  name: string }
  subdomain D {
    context Shop {
      aggregate Order with auditable {
        code: string
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api { platform: dotnet, contexts: [Shop], dataSources: [st], serves: A, port: 8081, auth: required }
}
```

---

## 0. Where the stamp comes from (the shared IR)

`with auditable` is the built-in `capability auditable` declared in **`src/macros/prelude.ts:52-66`**:

```ts
return capability("auditable", [
  field("createdAt", primType("datetime"), { access: "managed" }),
  field("updatedAt", primType("datetime"), { access: "managed" }),
  field("createdBy", idRef(PRINCIPAL_TYPE_NAME), { access: "managed" }),
  field("updatedBy", idRef(PRINCIPAL_TYPE_NAME), { access: "managed" }),
  stamp({
    onCreate: [ { field: "createdAt", value: nowExpr() },
                { field: "createdBy", value: nameRef("currentUser") } ],
    onUpdate: [ … ],
  }),
]);
```

It lowers (`src/ir/lower/lower.ts`) to **`AggregateIR.contextStamps: ContextStampIR[]`** (`src/ir/types/loom-ir.ts:499`, type at `:599-611`):

```ts
export interface ContextStampIR { event: "create" | "update"; assignments: ContextStampAssignmentIR[]; }
export interface ContextStampAssignmentIR { field: string; value: ExprIR; }
```

**Key for §5 (derive, don't stamp):** *"is this aggregate auditable?"* is already fully derivable — `(agg.contextStamps ?? []).length > 0`. There is already a helper `aggregateStampUsesPrincipal(agg)` at `loom-ir.ts:2883`. **No new IR field is needed.** The marker interface and the JPA annotations are both pure functions of `contextStamps`.

Note `createdBy/updatedBy` are typed `User id` (the principal), which lowers to the **scalar** (`Guid` / `UUID`), never a `UserId` strong-id — visible below.

---

## 1. .NET — BEFORE (real output)

### 1a. `Order` entity — audit fields get `internal set` (`/tmp/sim-dotnet/api/Domain/Orders/Order.cs`)

```csharp
public sealed class Order
{
    public OrderId Id { get; private set; }
    public string Code { get; private set; } = default!;
    public DateTime CreatedAt { get; internal set; } = default!;   // widened private→internal
    public DateTime UpdatedAt { get; internal set; } = default!;   // so the interceptor (same
    public Guid CreatedBy { get; internal set; } = default!;       // assembly) can assign it
    public Guid UpdatedBy { get; internal set; } = default!;
    …
}
```

The widening is deliberate: **`src/generator/dotnet/emit/entity.ts:114-122,181`** — non-stamped fields stay `private set`; the stamped field names (collected from `entity.contextStamps`) are widened to `internal set` because a `private set` would be unreachable from the interceptor (CS0272).

### 1b. The interceptor — one `switch` arm per auditable aggregate (`/tmp/sim-dotnet/api/Infrastructure/Persistence/AuditableInterceptor.cs`)

```csharp
public sealed class AuditableInterceptor : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    { Stamp(eventData); return base.SavingChanges(eventData, result); }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(…)
    { Stamp(eventData); return base.SavingChangesAsync(eventData, result, cancellationToken); }

    private static void Stamp(DbContextEventData eventData)
    {
        var ctx = eventData.Context;
        if (ctx is null) return;
        foreach (var entry in ctx.ChangeTracker.Entries())
        {
            if (entry.State != EntityState.Added && entry.State != EntityState.Modified) continue;
            switch (entry.Entity)
            {
                case Order e:                                            // ← one arm PER auditable aggregate
                    if (entry.State == EntityState.Added)
                    {
                        e.CreatedAt = DateTime.UtcNow;                   // ← cast + internal-set write
                        e.CreatedBy = RequestContext.Current!.CurrentUser!.Id;
                    }
                    if (entry.State == EntityState.Added || entry.State == EntityState.Modified)
                    {
                        e.UpdatedAt = DateTime.UtcNow;
                        e.UpdatedBy = RequestContext.Current!.CurrentUser!.Id;
                    }
                    break;
                default: break;
            }
        }
    }
}
```

Emitted by **`src/generator/dotnet/emit/auditable-interceptor.tpl.ts`** — `renderAuditableInterceptor` (`:28`) maps each auditable aggregate to a `renderArm` (`:46`, `:132`). Already a single loop; the per-aggregate cost is the `case <Agg> e:` arm + the cast + the `internal-set` widening on the entity.

`OrderConfiguration.cs` maps every audit field as a real EF property (`builder.Property(x => x.CreatedAt).HasColumnName("created_at")`) — **this is what makes §3's `CurrentValues` path work.** Wiring lives in `Program.cs:53,57` (`AddScoped<AuditableInterceptor>` + `opts.AddInterceptors(...)`).

---

## 2. .NET — AFTER (proposed, hand-written)

### 2a. Pure marker interface (new file, e.g. `api/Domain/Common/IAuditable.cs`)

```csharp
namespace Api.Domain.Common;

/// <summary>Pure tag: "stamp my audit columns at SaveChanges". Zero members.</summary>
internal interface IAuditable { }
```

`internal` keeps it off the public API surface (it is an infra concern, not a domain contract).

### 2b. `Order` entity — `private set`, no `internal`, implements the tag

```csharp
using Api.Domain.Common;

public sealed class Order : IAuditable          // ← tag only
{
    public OrderId Id { get; private set; }
    public string Code { get; private set; } = default!;
    public DateTime CreatedAt { get; private set; } = default!;   // back to private set
    public DateTime UpdatedAt { get; private set; } = default!;
    public Guid CreatedBy { get; private set; } = default!;
    public Guid UpdatedBy { get; private set; } = default!;
    …                                                            // no method, no internal leak
}
```

### 2c. The interceptor — ONE generic loop, no per-type arm

This is the dedup payoff. Show **two** auditable aggregates (`Order`, `Invoice`) — the before would be **two** `switch` arms; the after is **unchanged**:

```csharp
public sealed class AuditableInterceptor : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    { Stamp(eventData); return base.SavingChanges(eventData, result); }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(…)
    { Stamp(eventData); return base.SavingChangesAsync(eventData, result, cancellationToken); }

    private static void Stamp(DbContextEventData eventData)
    {
        var ctx = eventData.Context;
        if (ctx is null) return;
        var now = DateTime.UtcNow;
        var actor = RequestContext.Current!.CurrentUser!.Id;        // Guid (principal scalar)
        foreach (var entry in ctx.ChangeTracker.Entries())
        {
            if (entry.Entity is not IAuditable) continue;            // ← filter by tag, no cast
            if (entry.State == EntityState.Added)
            {
                entry.Property("CreatedAt").CurrentValue = now;      // ← write through EF metadata
                entry.Property("CreatedBy").CurrentValue = actor;
            }
            if (entry.State == EntityState.Added || entry.State == EntityState.Modified)
            {
                entry.Property("UpdatedAt").CurrentValue = now;
                entry.Property("UpdatedBy").CurrentValue = actor;
            }
        }
    }
}
```

> **N→1.** For N auditable aggregates the before emits N `case` arms (and N entities widened to `internal set`); the after emits this **one** loop and N entities each gaining `: IAuditable`. The interceptor body no longer depends on N at all.

> **Subtlety — column-name vs property-name.** The field names in the stamp (`CreatedAt`, …) are CLR property names, which is exactly what `entry.Property("…")` expects. The capability fields are uniform across all auditable aggregates (always `createdAt/updatedAt/createdBy/updatedBy`), so the four `Property(...)` calls are constant — they need **not** be re-derived per aggregate. If a future capability stamps aggregate-specific fields, the generic loop would need a per-tag field list (e.g. `IAuditable` exposes nothing, but the interceptor still hardcodes the four canonical audit columns — fine, because the audit field set is fixed by the capability). This holds for `auditable`; a non-uniform capability would reopen the question.

---

## 3. Verifying the .NET mechanism is real (not wishful)

**Claim:** `entry.Property("CreatedAt").CurrentValue = value` writes a property whose CLR setter is `private` (or absent), inside a `SaveChangesInterceptor`.

**Verdict: REAL.** EF Core's `EntityEntry.Property(name).CurrentValue` (and `entry.CurrentValues["name"]`) operate at the **change-tracking metadata level**, through EF's own property accessor — *not* through the CLR public setter. Microsoft's own example iterates `context.Entry(blog).Properties` and assigns `propertyEntry.CurrentValue = DateTime.Now;` with no requirement on setter visibility ([Accessing Tracked Entities](https://learn.microsoft.com/en-us/ef/core/change-tracking/entity-entries)). EF resolves property reads/writes via its configured **property access mode**, which by default uses the backing field where one exists and otherwise the property — it does not depend on a *public* setter. A `private set` (and even no setter, with a discoverable backing field) is writable this way. Community confirmation of the exact "set private-setter property from a SaveChangesInterceptor" pattern: [Milan Jovanović — EF Core Interceptors](https://www.milanjovanovic.tech/blog/how-to-use-ef-core-interceptors).

**`SaveChangesInterceptor` is the right hook:** `SavingChanges`/`SavingChangesAsync` fire after change detection and before the SQL is issued, with `eventData.Context.ChangeTracker.Entries()` populated — the canonical place to stamp ([EF Core Interceptors](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)). Timing is identical to today (the before already stamps in `SavingChanges`).

**Honest caveats:**
1. **Property must be a mapped EF property.** It is — `OrderConfiguration.cs` emits `builder.Property(x => x.CreatedAt)…` for all four (§1b). If a future change made an audit field shadow/unmapped, `entry.Property("CreatedAt")` would throw `InvalidOperationException`. Mitigation: keep the four audit columns mapped (already true) — or guard with `entry.Metadata.FindProperty("CreatedAt") is not null`.
2. **`entry.Property("X")` is string-keyed** — a typo is a runtime throw, not a compile error (the `switch`-arm before had the same property-name string-free path via the property accessor `e.CreatedAt`, which *was* compile-checked). The generator emits these strings from the canonical capability field list, so the names are generator-controlled, not user-typed — acceptable, but it trades one compile-time check for a generator invariant.
3. **`CurrentValue` marks the property modified** only if the value differs (per the docs) — fine for stamping; on `Added` everything is written anyway.

No adjustment needed; the private-set + `CurrentValue` path is supported. (If we wanted belt-and-suspenders, `builder.Property(x => x.CreatedAt).UsePropertyAccessMode(PropertyAccessMode.Field)` forces field access — not required here.)

---

## 4. Java — BEFORE (real output)

### 4a. `Order` entity — infra `_stampOn*` methods on the domain class (`/tmp/sim-java/.../orders/Order.java`)

```java
@Entity
@Table(name = "orders", schema = "shop")
@org.jmolecules.ddd.annotation.AggregateRoot
public class Order {
    @EmbeddedId @AttributeOverride(name = "value", column = @Column(name = "id")) OrderId id;
    @Column(name = "code") String code;
    @Column(name = "created_at") Instant createdAt;
    @Column(name = "updated_at") Instant updatedAt;
    @Column(name = "created_by") UUID createdBy;       // principal scalar, not a UserId
    @Column(name = "updated_by") UUID updatedBy;
    …
    void _stampOnCreate(User currentUser) {            // ← infra method LEAKED onto the entity
        this.createdAt = Instant.now();
        this.createdBy = currentUser.id();
    }
    void _stampOnUpdate(User currentUser) {
        this.updatedAt = Instant.now();
        this.updatedBy = currentUser.id();
    }
    public static Order create(String code) { … }
}
```

Emitted by **`src/generator/java/emit/entity.ts:605-640`** (`stampMethod` builds `_stampOn${Create|Update}` from `entity.contextStamps`; a `currentUser` value renders `currentUser.id()`).

### 4b. The call site — service stamps at OPERATION time (`/tmp/sim-java/.../orders/OrderService.java`)

```java
public OrderId createOrder(CreateOrderRequest request) {
    var code = request.code();
    var currentUser = currentUserAccessor.user();
    var aggregate = Order.create(code);
    aggregate._stampOnCreate(currentUser);          // ← stamped in the operation body, BEFORE save
    repository.save(aggregate);
    publishEvents(aggregate);
    return aggregate.id();
}
```

Emitted by **`src/generator/java/emit/service.ts:74-85`**. This is the timing the proposal moves.

`CurrentUserAccessor` is a request-scoped `ThreadLocal<User>` (`/tmp/sim-java/.../auth/CurrentUserAccessor.java`); `User` is `record User(UUID id, String name)` (`/tmp/sim-java/.../auth/User.java`).

---

## 5. Java — AFTER (proposed, hand-written)

### 5a. Pure marker interface (new file, `…/domain/common/Auditable.java`)

```java
package com.loom.api.domain.common;

/** Pure tag: this aggregate carries audit columns. Zero members. */
public interface Auditable { }
```

(Useful as a tag/marker even though JPA auditing keys off the annotations, not the interface — keeps parity with .NET and gives a join point for future cross-cutting logic.)

### 5b. `Order` entity — annotated fields, listener composed, NO method

```java
@Entity
@Table(name = "orders", schema = "shop")
@EntityListeners(AuditingEntityListener.class)             // ← composes; no @MappedSuperclass needed
@org.jmolecules.ddd.annotation.AggregateRoot
public class Order implements Auditable {                  // ← tag
    @EmbeddedId @AttributeOverride(name = "value", column = @Column(name = "id")) OrderId id;
    @Column(name = "code") String code;

    @CreatedDate      @Column(name = "created_at", updatable = false) Instant createdAt;
    @LastModifiedDate @Column(name = "updated_at")                    Instant updatedAt;
    @CreatedBy        @Column(name = "created_by", updatable = false) UUID createdBy;
    @LastModifiedBy   @Column(name = "updated_by")                    UUID updatedBy;
    …
    // NO _stampOnCreate / _stampOnUpdate — gone.
    public static Order create(String code) { var e = new Order(); e.id = OrderId.newId(); e.code = code; e._assertInvariants(); return e; }
}
```

Imports added: `org.springframework.data.annotation.{CreatedDate,LastModifiedDate,CreatedBy,LastModifiedBy}`, `org.springframework.data.jpa.domain.support.AuditingEntityListener`, `jakarta.persistence.EntityListeners`.

> `@EntityListeners` **composes with inheritance** — it does not require a `@MappedSuperclass` base, so it does not collide with Loom's abstract-aggregate (`extends`) inheritance. Each concrete `@Entity` simply annotates itself; listeners stack.

### 5c. Service — stamping disappears from the operation body

```java
public OrderId createOrder(CreateOrderRequest request) {
    var code = request.code();
    var aggregate = Order.create(code);
    repository.save(aggregate);                  // ← AuditingEntityListener stamps at persist
    publishEvents(aggregate);
    return aggregate.id();
}
```

(`currentUserAccessor.user()` is no longer needed here for stamping — it stays only if the operation body itself references `currentUser`.)

### 5d. Once-per-app wiring — `@EnableJpaAuditing` + `AuditorAware<UUID>` (e.g. `…/config/JpaAuditingConfig.java`)

```java
package com.loom.api.config;

import java.util.Optional; import java.util.UUID;
import org.springframework.context.annotation.*;
import org.springframework.data.domain.AuditorAware;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;
import com.loom.api.auth.CurrentUserAccessor;

@Configuration
@EnableJpaAuditing(auditorAwareRef = "auditorProvider")
public class JpaAuditingConfig {
    @Bean
    public AuditorAware<UUID> auditorProvider(CurrentUserAccessor accessor) {
        return () -> Optional.ofNullable(accessor.user()).map(u -> u.id());   // → @CreatedBy/@LastModifiedBy
    }
}
```

`@CreatedDate`/`@LastModifiedDate` are filled by the framework clock; `@CreatedBy`/`@LastModifiedBy` resolve through this `AuditorAware<UUID>`. The principal scalar (`UUID`) matches the field types — no `UserId` strong-id, consistent with the before.

> **Two-aggregate dedup (Java):** for N auditable aggregates the before emits **2N** `_stampOn*` methods (and N×2 call sites in the services). The after emits the annotations per entity (still per-entity, since the columns live on the entity) but **zero** infra methods and **zero** service call sites, plus **one** `JpaAuditingConfig` for the whole app. The per-aggregate infra-method/call-site cost is eliminated.

---

## 6. Verifying the Java mechanism is real

**Verdict: REAL and idiomatic.** Spring Data JPA's documented auditing stack is exactly: annotate fields with `@CreatedDate/@LastModifiedDate/@CreatedBy/@LastModifiedBy`, register `AuditingEntityListener` via `@EntityListeners`, enable with `@EnableJpaAuditing`, and supply principal identity via an `AuditorAware<T>` bean ([Spring Data JPA — Auditing](https://docs.spring.io/spring-data/jpa/reference/auditing.html); [Baeldung](https://www.baeldung.com/database-auditing-jpa)).

- **`@EntityListeners` composes with inheritance.** The base-class pattern (`@MappedSuperclass` + `@EntityListeners`) is *one* option, but the annotation is equally valid placed directly on each concrete `@Entity`. So it does not conflict with Loom's `extends` inheritance — confirmed by the docs and the standard pattern.
- **`@CreatedBy`/`@LastModifiedBy` resolve via `AuditorAware`.** Per the docs: *"In case you use either @CreatedBy or @LastModifiedBy, the auditing infrastructure somehow needs to become aware of the current principal … we provide an AuditorAware<T> SPI."* The `<T>` matches the field type — here `UUID`.
- **Classpath:** `@CreatedDate/@CreatedBy` live in `spring-data-commons`; `AuditingEntityListener` in `spring-data-jpa`. **Both are already on the generated classpath** — `/tmp/sim-java/api/build.gradle.kts:23` emits `implementation("org.springframework.boot:spring-boot-starter-data-jpa")` (which pulls `spring-data-jpa` + `spring-data-commons`). The generated repo already imports `org.springframework.data.jpa.repository.JpaRepository`. **No new dependency required.**

**Honest caveat — the timing change (the one genuine consequence):**
JPA auditing fires at **persist/flush time** (the entity listener runs on `@PrePersist`/`@PreUpdate`), not when `Order.create(...)` or the operation body runs. Today's `_stampOnCreate` runs **operation-time** (before `repository.save`). Therefore: **a workflow/operation that READS a stamped field within the same operation that triggers the stamp would see it unset (null) before flush.** With the before, the field is already set by the time `repository.save` returns / the body continues.

For the simulated fixture this is harmless (`createOrder` never reads `createdAt`/`createdBy` after stamping). But it is a real semantic shift the human must accept.

### 6-ALT. Alternative that keeps operation-time semantics

If the timing shift is unacceptable, keep stamping at operation time but **remove the leak from the entity**: move `_stampOnCreate/_stampOnUpdate` into a **same-package stamper** invoked by the repository (or service) rather than a method on the aggregate.

```java
// …/orders/OrderStamper.java  (package-private; not on the domain entity's public API)
final class OrderStamper {
    static void onCreate(Order e, User u) { e.createdAt = Instant.now(); e.createdBy = u.id(); }
    static void onUpdate(Order e, User u) { e.updatedAt = Instant.now(); e.updatedBy = u.id(); }
}
```

- Pros: timing identical to today; no §6 caveat; no `@EnableJpaAuditing` / `AuditorAware` wiring.
- Cons: still per-aggregate (one stamper class + two methods each) — **less dedup** than 5; the field writes need package-private field access (already the case — fields are package-private). Marker interface `Auditable` still added as a tag, but does no work.

**Sign-off fork:** §5 (persist-time + a §7 validator) is the elegant/idiomatic path and the recommended default; §6-ALT is the conservative path that preserves today's exact timing at the cost of keeping the dedup partial.

---

## 7. IR / emit impact sketch (paper only — do NOT implement)

**No new IR field.** "Is auditable" is `(agg.contextStamps ?? []).length > 0`, already derivable (`loom-ir.ts:499`, helper `aggregateStampUsesPrincipal` at `:2883`). This honours the repo's *derive-don't-stamp* convention — the marker interface and annotations are pure functions of `contextStamps`.

| Backend | File | Change |
|---|---|---|
| .NET | `src/generator/dotnet/emit/auditable-interceptor.tpl.ts` | Replace `renderArm`-per-aggregate (`:46,:132`) with one generic `is IAuditable` loop using `entry.Property("…").CurrentValue`. |
| .NET | `src/generator/dotnet/emit/entity.ts` | (a) Drop the `internal set` widening (`:114-122,:181`) — stamped fields revert to `private set`. (b) Add `: IAuditable` to the class declaration when `contextStamps.length > 0`. |
| .NET | new emit + an orchestrator slot (e.g. `src/generator/dotnet/emit.ts` / `by-layer-layout.ts`) | Emit `IAuditable.cs` **once** per project (guard: any auditable aggregate exists). |
| Java | `src/generator/java/emit/entity.ts` | (a) Delete `stampMethod`/`stampLines` (`:612-640`). (b) Annotate the stamped fields (`@CreatedDate` etc.) — needs a small map from `contextStamps` field/event → annotation. (c) Add `@EntityListeners(AuditingEntityListener.class)` + `implements Auditable` when auditable. |
| Java | `src/generator/java/emit/service.ts` | Delete the `aggregate._stampOn*(...)` call-site emission (`:74-85`). |
| Java | new emit (config) | Emit `JpaAuditingConfig` (`@EnableJpaAuditing` + `AuditorAware<UUID>`) **once** when any auditable aggregate exists. `build.gradle.kts` unchanged (dep already present). |
| Java (ALT) | as above minus config | Emit `OrderStamper` per auditable aggregate; repository/service calls it. |

**Marker-interface emission slot:** alongside the other once-per-project common types (.NET `Domain/Common`, Java `domain/common`), gated on "any auditable aggregate in this deployable's contexts."

**§7 validator (recommended with §5 only) — `src/ir/validate/checks/`:** a new check (natural home `domain-service-checks.ts`, or a new `capability-checks.ts`) that, for any aggregate with `contextStamps`, **rejects reading a stamped field inside the operation/workflow body that triggers the stamp** (create-stamp fields read in the create op; update-stamp fields read in an update op). Walk operation/workflow `ExprIR`/`StmtIR` for a `member`/`ref` to a stamped field name within the triggering action. New `loom.*` diagnostic code (e.g. `loom.stamp-read-before-flush`). This is what makes the persist-time move safe — it converts the silent semantic gap into a compile error. **Not needed for §6-ALT** (operation-time keeps the value readable in-body).

**Wire shape / frontend impact:** **none.** `wireShape` is computed from declared fields + containments + derived (CLAUDE.md §enrich); the audit fields are unchanged declared fields. DTOs, OpenAPI, React/Vue output are byte-identical. The change is purely *how* the four columns get written, not *what* they are.

---

## 8. Risk ledger + recommendation

| Risk | Severity | Notes |
|---|---|---|
| **Java timing: operation-time → persist-time** | **Medium** (the one genuine consequence) | Only bites if an op reads a field it just stamped before flush. Mitigated by the §7 validator. §6-ALT avoids it entirely. |
| EF `CurrentValue` writes a `private set` | **Low** | Verified real (§3). EF writes via metadata/access-mode, not the CLR setter. Requires the field stay a mapped EF property (it is). |
| String-keyed `entry.Property("CreatedAt")` typo | **Low** | Generator-controlled strings from the canonical capability field list; trades a compile check for a generator invariant. Optional `FindProperty` guard. |
| Spring Data JPA dependency | **None** | Already on the classpath (`spring-boot-starter-data-jpa`, `build.gradle.kts:23`). |
| `@EnableJpaAuditing` global side-effect | **Low** | Once-per-app; standard. Inert if no auditable entity. |
| Frontend / wire-shape drift | **None** | Wire shape unchanged; DTO/OpenAPI/UI byte-identical. |
| **Payoff with only ONE capability today** | **Latent** | `auditable` is the only stamping capability. The N→1 dedup payoff is real but small at N=1 (one switch arm, one pair of methods). The bigger *immediate* win is **removing the infra leaks**: .NET drops the `internal set` widening; Java drops the `_stampOn*` methods off the domain entity (a genuine cleanliness gain even at N=1). The dedup compounds when capability #2 (e.g. a `versioned`/`tenant-stamped` capability) lands. |

### Recommendation

**Adopt the elegant design (§2 + §5) with these qualifications:**

1. **.NET — adopt now, low risk.** Timing unchanged, mechanism verified, removes the `internal set` leak and the per-aggregate `switch` arm. Net win even at N=1.
2. **Java — adopt the §5 persist-time path PAIRED WITH the §7 validator.** The validator is the price of the timing move; without it the move is unsafe. This is the idiomatic Spring stack and removes the entity leak. **If the team is uneasy about the timing shift at sign-off, fall back to §6-ALT** (operation-time, same-package stamper) — it still removes the entity leak, just keeps the dedup partial and skips the persist-time semantics entirely.
3. **No new IR field** — derive "is auditable" from `contextStamps` (derive-don't-stamp).
4. Land the **marker interface + once-per-app wiring as a single slice per backend**, gated on "any auditable aggregate," and add the two-auditable-aggregate test so the N→1 (interceptor) / leak-removal is regression-pinned.

**Where the mechanism did NOT turn out free:** the Java persist-time move is a *true behavioral change*, not a pure refactor — it is the only place the proposal trades semantics, and it forces the §7 validator into scope. Everything else (.NET, wire shape, dependencies) is a clean, verified, behavior-preserving refactor.
