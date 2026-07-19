import type { BoundedContextIR, EventIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { realtimeEventTypes } from "../../../ir/util/channels.js";
import { lines } from "../../../util/code-builder.js";

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
// v1 topology is single-hop broadcast-to-all: no rooms, no edge relay, no
// policy-derived router (channels.md "Realtime topology").  The authorized
// read stays the gate — clients refetch through the API.
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
  else if (inner.kind === "primitive" && inner.name === "money") base = `${access}.toPlainString()`;
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
 *  carries an event (byte-identical wire-free output). */
export function renderJavaRealtimeController(
  ctx: BoundedContextIR,
  basePkg: string,
): string | null {
  const types = [...realtimeEventTypes(ctx)].sort();
  if (types.length === 0) return null;
  const events = types
    .map((t) => ctx.events.find((e) => e.name === t))
    .filter((e): e is EventIR => e != null);
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
