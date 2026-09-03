import type { BoundedContextIR, EventIR, SystemIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../../ir/util/channels.js";
import { type RealtimeRoomPlan, realtimeRoomPlan } from "../../../ir/util/realtime-rooms.js";
import { lines } from "../../../util/code-builder.js";
import { numericEncode } from "../../_numeric/target.js";
import { JAVA_NUMERIC } from "../numeric-codec.js";

// ---------------------------------------------------------------------------
// Realtime SSE wire — `<base>/api/RealtimeController.java` (channels.md,
// Part I).  Events carried by a `delivery: broadcast` channel stream to
// connected browsers at GET /api/realtime/events; the frontend `EventSource`
// client consumes the SAME wire the Hono backend serves — `event: <EventType>`
// frames + camelCase JSON data, a 15s keep-alive ping.
//
// The tee is a native Spring @EventListener on the always-present domain-event
// bus: every aggregate service publishes its drained events through
// `ApplicationEventPublisher` (service.ts, unconditional), so this listener
// sees every domain event — no parallel dispatch path.  A thread-safe
// CopyOnWriteArrayList holds the live SseEmitters; a single-thread scheduler
// pings every 15s so proxies don't idle the stream out.
//
// Two topologies (channels.md "Realtime topology" — rooms + policy-derived
// routing v1), mirroring the Hono backend: an untenanted context is
// broadcast-to-all (byte-identical); a tenant-owned context scopes delivery by
// the tenant DataKey (`currentUser.<claim>`, the bound `tenancy by
// user.<claim>` — NOT the row column `tenantId`), so a tenant-scoped event
// reaches only subscribers in the emitter's tenant room — never cross-tenant.  A
// connection derives its room from the verified principal at connect (never a
// client value); an unauthenticated connection joins no room.  The authorized
// read stays the gate either way — clients refetch through the API.
// ---------------------------------------------------------------------------

/** One SSE data field's value as a Java expression: ids unwrap to their bare
 *  value, datetime / money to their canonical wire string (mirrors
 *  `wire.ts`'s `domainToWire`); scalars, enums (name = wire) and VOs pass
 *  through for Jackson to serialize camelCase — matching the Hono wire. */
function javaRealtimeValue(access: string, t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  const opt = t.kind === "optional";
  let base = access;
  if (inner.kind === "id") base = `${access}.value()`;
  else if (inner.kind === "primitive" && inner.name === "datetime") base = `${access}.toString()`;
  // money pins the FIXED wire scale (RS-12) — a bare `toPlainString()` echoes
  // whatever scale the domain `BigDecimal` happens to carry rather than the
  // canonical 4dp every other read path (REST, channels) now applies (see
  // `emit/channels.ts`'s `toDataExpr` — the same F-class fix, #2549's class).
  else if (inner.kind === "primitive" && inner.name === "money")
    base = numericEncode(JAVA_NUMERIC, "money", "dto-map", access);
  // decimal → a JSON NUMBER at double width (RS-24 / M-T6.46).  Handing Jackson
  // the raw `BigDecimal` shipped the domain value's full precision — up to the
  // 34 significant digits `MathContext.DECIMAL128` produces — on the SSE frame
  // while the REST response (and every other backend's frame) carries a double.
  else if (inner.kind === "primitive" && inner.name === "decimal")
    base = numericEncode(JAVA_NUMERIC, "decimal", "dto-map", access);
  if (opt && base !== access) return `${access} == null ? null : ${base}`;
  return base;
}

function wireMapArm(ev: EventIR): string[] {
  const out = [
    `        if (event instanceof ${ev.name} e) {`,
    `            var m = new LinkedHashMap<String, Object>();`,
    `            m.put("type", "${ev.name}");`,
  ];
  for (const f of ev.fields) {
    out.push(`            m.put("${f.name}", ${javaRealtimeValue(`e.${f.name}()`, f.type)});`);
  }
  out.push(`            return m;`, `        }`);
  return out;
}

/** The realtime controller, or null when no `delivery: broadcast` channel
 *  carries an event (byte-identical wire-free output).  A tenant-owned context
 *  emits the room-scoped controller; otherwise the v1 broadcast-to-all one. */
export function renderJavaRealtimeController(
  ctx: BoundedContextIR,
  basePkg: string,
  sys: Pick<SystemIR, "tenancy"> | undefined,
): string | null {
  const types = [...realtimeEventTypes(ctx)].sort();
  if (types.length === 0) return null;
  const events = types
    .map((t) => ctx.events.find((e) => e.name === t))
    .filter((e): e is EventIR => e != null);
  const plan = realtimeRoomPlan(ctx, sys);
  return plan.tenantScoped
    ? renderRoomScopedController(events, types, plan, basePkg)
    : renderBroadcastController(events, types, basePkg);
}

/** v1 broadcast-to-all controller — kept byte-identical for untenanted contexts. */
function renderBroadcastController(events: EventIR[], types: string[], basePkg: string): string {
  const typeSet = types.map((t) => `"${t}"`).join(", ");

  return lines(
    `package ${basePkg}.api;`,
    ``,
    `import java.io.IOException;`,
    `import java.util.LinkedHashMap;`,
    `import java.util.Map;`,
    `import java.util.Set;`,
    `import java.util.concurrent.CopyOnWriteArrayList;`,
    `import java.util.concurrent.Executors;`,
    `import java.util.concurrent.ScheduledExecutorService;`,
    `import java.util.concurrent.TimeUnit;`,
    ``,
    `import io.swagger.v3.oas.annotations.Hidden;`,
    ``,
    `import org.springframework.context.event.EventListener;`,
    `import org.springframework.http.MediaType;`,
    `import org.springframework.web.bind.annotation.GetMapping;`,
    `import org.springframework.web.bind.annotation.RestController;`,
    `import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;`,
    ``,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `/** Realtime SSE wire (channels.md Part I): broadcast-channel events stream`,
    ` *  to connected browsers at GET /api/realtime/events.  v1 is`,
    ` *  broadcast-to-all; the authorized read remains the gate.  @Hidden keeps`,
    ` *  the SSE stream out of the springdoc OpenAPI document — it is transport`,
    ` *  plumbing, not a REST operation (the cross-backend parity contract). */`,
    `@Hidden`,
    `@RestController`,
    `public class RealtimeController {`,
    `    /** Events carried by a broadcast channel — the UI-observable set. */`,
    `    private static final Set<String> REALTIME_EVENT_TYPES = Set.of(${typeSet});`,
    ``,
    `    private final CopyOnWriteArrayList<SseEmitter> emitters = new CopyOnWriteArrayList<>();`,
    `    private final ScheduledExecutorService pings = Executors.newSingleThreadScheduledExecutor(r -> {`,
    `        var t = new Thread(r, "realtime-ping");`,
    `        t.setDaemon(true);`,
    `        return t;`,
    `    });`,
    ``,
    `    public RealtimeController() {`,
    `        // Comment-only ping every 15s keeps proxies from idling the stream out.`,
    `        pings.scheduleAtFixedRate(this::ping, 15, 15, TimeUnit.SECONDS);`,
    `    }`,
    ``,
    `    @GetMapping("/api/realtime/events")`,
    `    public SseEmitter events() {`,
    `        var emitter = new SseEmitter(0L);`,
    `        emitter.onCompletion(() -> emitters.remove(emitter));`,
    `        emitter.onTimeout(() -> emitters.remove(emitter));`,
    `        emitter.onError(err -> emitters.remove(emitter));`,
    `        emitters.add(emitter);`,
    `        return emitter;`,
    `    }`,
    ``,
    `    /** Tee off the in-process domain-event bus: every published event`,
    `     *  (service.ts always publishes drained events) reaches here; carried`,
    `     *  ones fan out to the live streams. */`,
    `    @EventListener`,
    `    public void onDomainEvent(DomainEvent event) {`,
    `        if (!REALTIME_EVENT_TYPES.contains(event.getClass().getSimpleName())) return;`,
    `        var type = event.getClass().getSimpleName();`,
    `        var data = wire(event);`,
    `        for (var emitter : emitters) {`,
    `            try {`,
    `                emitter.send(SseEmitter.event().name(type).data(data, MediaType.APPLICATION_JSON));`,
    `            } catch (IOException | IllegalStateException ex) {`,
    `                emitters.remove(emitter);`,
    `            }`,
    `        }`,
    `    }`,
    ``,
    `    private void ping() {`,
    `        for (var emitter : emitters) {`,
    `            try {`,
    `                emitter.send(SseEmitter.event().name("ping").data(""));`,
    `            } catch (IOException | IllegalStateException ex) {`,
    `                emitters.remove(emitter);`,
    `            }`,
    `        }`,
    `    }`,
    ``,
    `    /** The camelCase wire payload for a carried event: \`type\` + each field`,
    `     *  in the same shape the Hono / React backends serialize. */`,
    `    private static Map<String, Object> wire(DomainEvent event) {`,
    ...events.flatMap(wireMapArm),
    `        return Map.<String, Object>of("type", event.getClass().getSimpleName());`,
    `    }`,
    `}`,
    ``,
  );
}

/** Tenant-scoped controller (channels.md rooms + policy-derived routing v1):
 *  the SseEmitter registry is keyed by the tenant DataKey; tenant-scoped events
 *  reach only the emitter's tenant room, never cross-tenant. */
function renderRoomScopedController(
  events: EventIR[],
  types: string[],
  plan: RealtimeRoomPlan,
  basePkg: string,
): string {
  const typeSet = types.map((t) => `"${t}"`).join(", ");
  const tenantTypes = [...plan.tenantEventTypes].sort();
  const tenantSet = tenantTypes.map((t) => `"${t}"`).join(", ");
  // The `User` record accessor holding the room key — the bound `tenancy by
  // user.<claim>`.  `emit/auth.ts` declares record components under the
  // field's own name, so the accessor is the claim verbatim.
  const claim = plan.tenantClaimField;
  const idFieldEntries = tenantTypes
    .map((t) => {
      const fields = plan.eventIdFields.get(t) ?? [];
      return `        Map.entry("${t}", List.of(${fields.map((f) => `"${f}"`).join(", ")}))`;
    })
    .join(",\n");

  return lines(
    `package ${basePkg}.api;`,
    ``,
    `import java.io.IOException;`,
    `import java.util.LinkedHashMap;`,
    `import java.util.List;`,
    `import java.util.Map;`,
    `import java.util.Set;`,
    `import java.util.concurrent.ConcurrentHashMap;`,
    `import java.util.concurrent.CopyOnWriteArrayList;`,
    `import java.util.concurrent.Executors;`,
    `import java.util.concurrent.ScheduledExecutorService;`,
    `import java.util.concurrent.TimeUnit;`,
    ``,
    `import io.swagger.v3.oas.annotations.Hidden;`,
    ``,
    `import org.springframework.context.event.EventListener;`,
    `import org.springframework.http.MediaType;`,
    `import org.springframework.web.bind.annotation.GetMapping;`,
    `import org.springframework.web.bind.annotation.RestController;`,
    `import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;`,
    ``,
    `import ${basePkg}.auth.CurrentUserAccessor;`,
    `import ${basePkg}.auth.User;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ``,
    `/** Realtime SSE wire (channels.md rooms + policy-derived routing v1):`,
    ` *  broadcast-channel events stream to connected browsers at`,
    ` *  GET /api/realtime/events.  This context hosts tenant-owned aggregates,`,
    ` *  so delivery is scoped by the tenant DataKey (\`currentUser.${claim}\`): a`,
    ` *  tenant-scoped event reaches only subscribers in the emitter's tenant`,
    ` *  room — never cross-tenant.  The authorized read remains the gate.`,
    ` *  @Hidden keeps the SSE stream out of the springdoc OpenAPI document. */`,
    `@Hidden`,
    `@RestController`,
    `public class RealtimeController {`,
    `    /** Events carried by a broadcast channel — the UI-observable set. */`,
    `    private static final Set<String> REALTIME_EVENT_TYPES = Set.of(${typeSet});`,
    ``,
    `    /** Events this tenant-owned context routes to the emitter's tenant room`,
    `     *  only, never broadcast cross-tenant — everything it carries except the`,
    `     *  events provably about \`crossTenant\` (shared) data. */`,
    `    private static final Set<String> TENANT_SCOPED_EVENT_TYPES = Set.of(${tenantSet});`,
    ``,
    `    /** Id-reference (\`<Agg> id\`) fields kept when a tenant-scoped event`,
    `     *  can't be tenant-routed (dispatched with no ambient request — outbox`,
    `     *  relay drain / timer scheduler): it degrades to a refetch ticket (type`,
    `     *  + ids, no scalar payload) and the authorized read re-gates on refetch. */`,
    `    private static final Map<String, List<String>> EVENT_ID_FIELDS = Map.ofEntries(`,
    idFieldEntries,
    `    );`,
    ``,
    `    /** Every live connection — receives tenant-agnostic (global) events and`,
    `     *  any broadcast refetch ticket. */`,
    `    private final CopyOnWriteArrayList<SseEmitter> emitters = new CopyOnWriteArrayList<>();`,
    `    /** Per-tenant rooms (key = \`currentUser.${claim}\`, the bound tenancy`,
    `     *  claim) — a connection joins its own tenant's room at connect. */`,
    `    private final ConcurrentHashMap<String, CopyOnWriteArrayList<SseEmitter>> rooms = new ConcurrentHashMap<>();`,
    `    /** Each connection's joined tenant, so cleanup can leave its room. */`,
    `    private final ConcurrentHashMap<SseEmitter, String> emitterTenant = new ConcurrentHashMap<>();`,
    `    private final ScheduledExecutorService pings = Executors.newSingleThreadScheduledExecutor(r -> {`,
    `        var t = new Thread(r, "realtime-ping");`,
    `        t.setDaemon(true);`,
    `        return t;`,
    `    });`,
    ``,
    `    public RealtimeController() {`,
    `        // Comment-only ping every 15s keeps proxies from idling the stream out.`,
    `        pings.scheduleAtFixedRate(this::ping, 15, 15, TimeUnit.SECONDS);`,
    `    }`,
    ``,
    `    @GetMapping("/api/realtime/events")`,
    `    public SseEmitter events() {`,
    `        var emitter = new SseEmitter(0L);`,
    `        // The connection joins its tenant's room, derived from the verified`,
    `        // principal on the request (never a client-supplied value); an`,
    `        // unauthenticated connection joins no room.`,
    `        var tenant = tenantOf(CurrentUserAccessor.currentOrNull());`,
    `        emitter.onCompletion(() -> remove(emitter));`,
    `        emitter.onTimeout(() -> remove(emitter));`,
    `        emitter.onError(err -> remove(emitter));`,
    `        emitters.add(emitter);`,
    `        if (tenant != null) {`,
    `            rooms.computeIfAbsent(tenant, k -> new CopyOnWriteArrayList<>()).add(emitter);`,
    `            emitterTenant.put(emitter, tenant);`,
    `        }`,
    `        return emitter;`,
    `    }`,
    ``,
    `    private void remove(SseEmitter emitter) {`,
    `        emitters.remove(emitter);`,
    `        var tenant = emitterTenant.remove(emitter);`,
    `        if (tenant != null) {`,
    `            var room = rooms.get(tenant);`,
    `            if (room != null) room.remove(emitter);`,
    `        }`,
    `    }`,
    ``,
    `    /** Tee off the in-process domain-event bus: every published event`,
    `     *  (service.ts always publishes drained events) reaches here.  A global`,
    `     *  event fans out to every connection; a tenant-scoped event to the`,
    `     *  emitter's tenant room only (full payload).  With no ambient tenant`,
    `     *  (outbox relay drain / timer thread) it degrades to a refetch ticket`,
    `     *  broadcast — over-delivery of a ticket is harmless, the authorized`,
    `     *  refetch re-gates. */`,
    `    @EventListener`,
    `    public void onDomainEvent(DomainEvent event) {`,
    `        var type = event.getClass().getSimpleName();`,
    `        if (!REALTIME_EVENT_TYPES.contains(type)) return;`,
    `        if (!TENANT_SCOPED_EVENT_TYPES.contains(type)) {`,
    `            fanOut(emitters, type, wire(event));`,
    `            return;`,
    `        }`,
    `        var tenant = tenantOf(CurrentUserAccessor.currentOrNull());`,
    `        if (tenant != null) {`,
    `            var room = rooms.get(tenant);`,
    `            if (room != null) fanOut(room, type, wire(event));`,
    `            return;`,
    `        }`,
    `        fanOut(emitters, type, ticket(event));`,
    `    }`,
    ``,
    `    private void fanOut(Iterable<SseEmitter> targets, String type, Map<String, Object> data) {`,
    `        for (var emitter : targets) {`,
    `            try {`,
    `                emitter.send(SseEmitter.event().name(type).data(data, MediaType.APPLICATION_JSON));`,
    `            } catch (IOException | IllegalStateException ex) {`,
    `                remove(emitter);`,
    `            }`,
    `        }`,
    `    }`,
    ``,
    `    private void ping() {`,
    `        for (var emitter : emitters) {`,
    `            try {`,
    `                emitter.send(SseEmitter.event().name("ping").data(""));`,
    `            } catch (IOException | IllegalStateException ex) {`,
    `                remove(emitter);`,
    `            }`,
    `        }`,
    `    }`,
    ``,
    `    /** The connecting/emitting principal's tenant room key (\`currentUser`,
    `     *  .${claim}\`, the bound tenancy claim), or null when there is no`,
    `     *  authenticated principal. */`,
    `    private static String tenantOf(User user) {`,
    `        return user == null || user.${claim}() == null ? null : String.valueOf(user.${claim}());`,
    `    }`,
    ``,
    `    /** Strip a tenant-scoped event to a refetch ticket — its \`type\` plus the`,
    `     *  \`<Agg> id\` reference fields, no other payload. */`,
    `    private static Map<String, Object> ticket(DomainEvent event) {`,
    `        var full = wire(event);`,
    `        var t = new LinkedHashMap<String, Object>();`,
    `        t.put("type", full.get("type"));`,
    `        for (var field : EVENT_ID_FIELDS.getOrDefault(event.getClass().getSimpleName(), List.of())) {`,
    `            if (full.containsKey(field)) t.put(field, full.get(field));`,
    `        }`,
    `        return t;`,
    `    }`,
    ``,
    `    /** The camelCase wire payload for a carried event: \`type\` + each field`,
    `     *  in the same shape the Hono / React backends serialize. */`,
    `    private static Map<String, Object> wire(DomainEvent event) {`,
    ...events.flatMap(wireMapArm),
    `        return Map.<String, Object>of("type", event.getClass().getSimpleName());`,
    `    }`,
    `}`,
    ``,
  );
}
