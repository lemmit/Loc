// -------------------------------------------------------------------------
// System-wide shape checks: aggregate reachability, `docker-compose.yml`
// port/slug uniqueness, and channel wiring / relay-target subscription.
// Split out of system-checks.ts by packet 2.6 (wave-2) — mechanical move,
// no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { platformOwnsBackend } from "../../../language/validators/data/platform-rules.js";
import { snake } from "../../../util/naming.js";
import type { BoundedContextIR, DeployableIR, SubdomainIR, SystemIR } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { validateE2ETest } from "./test-checks.js";

export function validateSystem(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const modulesByName = new Map<string, SubdomainIR>();
  for (const m of sys.subdomains) modulesByName.set(m.name, m);
  for (const t of sys.e2eTests) {
    validateE2ETest(t, sys, modulesByName, diags);
  }
}

// ---------------------------------------------------------------------------
// Compose uniqueness — the generated `docker-compose.yml` publishes each
// deployable's `port` on the host and keys every service by its
// `serviceSlug(name)` (= `naming.snake`).  Two deployables sharing a host
// port (e.g. both defaulted to 3000) make
// `docker compose up` abort with a port-in-use error; two deployables whose
// names slug to the same key (`SalesApi2` / `salesApi2` → `sales_api2`)
// silently merge into one output directory + one compose service.  Both are
// deploy-time breakage the IR can catch here (finding 20 / B24).
// ---------------------------------------------------------------------------

export function validateComposeUniqueness(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Host-port collisions across deployables (plus the bundled Keycloak port).
  const ownersByPort = new Map<number, string[]>();
  const addOwner = (port: number, owner: string): void => {
    const list = ownersByPort.get(port);
    if (list) list.push(owner);
    else ownersByPort.set(port, [owner]);
  };
  for (const d of sys.deployables) addOwner(d.port, `deployable '${d.name}'`);
  // The bundled Keycloak never collides: the emitter (`keycloakHostPort` in
  // src/system/index.ts) publishes it on the first free port >= 8081,
  // stepping past any port a deployable claims.
  for (const [port, owners] of ownersByPort) {
    if (owners.length < 2) continue;
    diags.push({
      severity: "error",
      code: "loom.duplicate-host-port",
      message: diagMessage("loom.duplicate-host-port", { port, owners: owners.join(", ") }),
      source: sys.name,
    });
  }

  // Service-slug collisions across deployables (case-variant names merge dirs).
  const namesBySlug = new Map<string, string[]>();
  for (const d of sys.deployables) {
    const slug = snake(d.name);
    const list = namesBySlug.get(slug);
    if (list) list.push(d.name);
    else namesBySlug.set(slug, [d.name]);
  }
  for (const [slug, names] of namesBySlug) {
    if (names.length < 2) continue;
    diags.push({
      severity: "error",
      code: "loom.duplicate-service-slug",
      message: diagMessage("loom.duplicate-service-slug", {
        names: names.map((n) => `'${n}'`).join(", "),
        slug,
      }),
      source: sys.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Channel wiring (channels.md §"Surface — transport binding").
// Cross-file/system-level twins of the AST-level channelSource matrix checks:
//
//   - `loom.channelsource-unbound` (warning) — a channelSource no deployable
//     lists in `channels:`.  Declared but inert: no broker is provisioned and
//     no client emitted for it.  Only fires when the system declares
//     deployables at all (legacy single-project generation has nowhere to
//     wire a binding).
//   - `loom.deployable-channel-unrelated` (warning) — a deployable lists a
//     channelSource but neither hosts the channel's owning context (producer
//     side) nor consumes any carried event via a reactor / event-triggered
//     create / projection fold in a hosted context.  Dead wiring.
//   - `loom.channel-consumer-unwired` (error) — a deployable consumes a
//     channel's events, some deployable binds that channel to a broker, but
//     this consumer doesn't list the binding: once the channel's traffic
//     rides the broker, this consumer would silently never receive it.
//     (The producer side stays a local re-entry fallback, so only the
//     consumer gap is a delivery hole — M-T4.4 design §5.)
// ---------------------------------------------------------------------------

export function validateChannelWiring(sys: SystemIR, diags: LoomDiagnostic[]): void {
  if ((sys.channelSources ?? []).length === 0) return;
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  // channel name -> owning context (channels are context members; bare names
  // are system-unique per the channelSource resolution rule).
  const channelOwner = new Map<string, { ctxName: string; carries: string[] }>();
  for (const m of sys.subdomains)
    for (const c of m.contexts)
      for (const ch of c.channels ?? [])
        channelOwner.set(ch.name, { ctxName: c.name, carries: ch.carries });
  const csByName = new Map(sys.channelSources.map((cs) => [cs.name, cs]));

  // The event names a deployable's hosted contexts consume (reactor `on`,
  // event-triggered `create … by`, projection folds) — the same trigger set
  // `deriveEventSubscriptions` wires for in-process dispatch.
  const consumedEventsOf = (dep: DeployableIR): Set<string> => {
    const consumed = new Set<string>();
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const wf of ctx.workflows ?? []) {
        for (const on of wf.subscriptions ?? []) consumed.add(on.event);
        for (const create of wf.creates ?? []) {
          if (create.triggerKind === "event" && create.eventRef) consumed.add(create.eventRef);
        }
      }
      for (const proj of ctx.projections ?? [])
        for (const on of proj.handlers) consumed.add(on.event);
    }
    return consumed;
  };

  // 1. Unbound channelSource.
  if (sys.deployables.length > 0) {
    const wired = new Set(sys.deployables.flatMap((d) => d.channelSourceNames ?? []));
    for (const cs of sys.channelSources) {
      if (wired.has(cs.name)) continue;
      diags.push({
        severity: "warning",
        code: "loom.channelsource-unbound",
        message: diagMessage("loom.channelsource-unbound", {
          name: cs.name,
          channelName: cs.channelName,
        }),
        source: `${sys.name}/${cs.name}`,
      });
    }
  }

  // channel name -> the channelSource names some deployable actually wires.
  const activeBindings = new Map<string, string[]>();
  for (const dep of sys.deployables) {
    for (const csName of dep.channelSourceNames ?? []) {
      const cs = csByName.get(csName);
      if (!cs) continue;
      const list = activeBindings.get(cs.channelName) ?? [];
      if (!list.includes(cs.name)) list.push(cs.name);
      activeBindings.set(cs.channelName, list);
    }
  }

  for (const dep of sys.deployables) {
    const consumed = consumedEventsOf(dep);
    const hosted = new Set(dep.contextNames);
    const listed = new Set(dep.channelSourceNames ?? []);

    // 2. Unrelated listing.
    for (const csName of dep.channelSourceNames ?? []) {
      const cs = csByName.get(csName);
      if (!cs) continue;
      const owner = channelOwner.get(cs.channelName);
      if (!owner) continue; // unresolved channel name — AST/linker reports it
      const produces = hosted.has(owner.ctxName);
      const consumes = owner.carries.some((e) => consumed.has(e));
      if (!produces && !consumes) {
        diags.push({
          severity: "warning",
          code: "loom.deployable-channel-unrelated",
          message: diagMessage("loom.deployable-channel-unrelated", {
            name: dep.name,
            csName: cs.name,
            channelName: cs.channelName,
            ctxName: owner.ctxName,
            carries: owner.carries.join(", ") || "none",
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }

    // 3. Consumer unwired while the channel is broker-bound elsewhere.
    if (!platformOwnsBackend(dep.platform)) continue; // frontends consume via M-T1.10 realtime
    for (const [chName, csNames] of activeBindings) {
      const owner = channelOwner.get(chName);
      if (!owner) continue;
      if (!owner.carries.some((e) => consumed.has(e))) continue;
      if (csNames.some((n) => listed.has(n))) continue;
      diags.push({
        severity: "error",
        code: "loom.channel-consumer-unwired",
        message: diagMessage("loom.channel-consumer-unwired", {
          name: dep.name,
          chName,
          carries: owner.carries.filter((e) => consumed.has(e)).join(", "),
          csNames: csNames[0],
        }),
        source: `${sys.name}/${dep.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Realtime relay obligation (channels.md — "the edge relay").  A browser
// speaks SSE only to the backend its frontend `targets:`, so for that backend
// to relay a channel to the UI it must itself SUBSCRIBE the channel — either
// by hosting the channel's owning context (today's single-hop wire) or by
// wiring a `channelSource` binding for it (the broker relay, M-T4.4 redis
// bindings).  A UI whose target does neither can't legally be served the
// events, so the `on <channel>.<Event>` handlers would silently receive
// nothing — error rather than drop.
//
// This is the frontend-relay half `validateChannelWiring` explicitly defers
// (its `loom.channel-consumer-unwired` skips frontends "consume via M-T1.10
// realtime").

export function validateRelayTargetNotSubscribed(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const byName = new Map(sys.deployables.map((d) => [d.name, d]));
  // channel name -> owning context (channels are context members; bare names
  // are system-unique per the channelSource resolution rule).
  const channelOwner = new Map<string, string>();
  for (const m of sys.subdomains)
    for (const c of m.contexts)
      for (const ch of c.channels ?? []) channelOwner.set(ch.name, c.name);
  const csByName = new Map((sys.channelSources ?? []).map((cs) => [cs.name, cs]));

  for (const d of sys.deployables) {
    const uiNames = d.hostedUiNames.length > 0 ? d.hostedUiNames : d.uiName ? [d.uiName] : [];
    for (const uiName of uiNames) {
      const ui = sys.uis.find((u) => u.name === uiName);
      if (!ui) continue;
      // Only channels the ui actually consumes via an `on <chan>.<Event>`
      // handler impose the relay obligation — a bare `channel` param that no
      // handler reads routes nothing.
      const consumed = new Set((ui.notifications ?? []).map((n) => n.paramName));
      const subscribed = (ui.channelParams ?? []).filter((p) => consumed.has(p.name));
      if (subscribed.length === 0) continue;
      // The relay is the target backend (a `static` frontend), or the
      // deployable itself when a backend hosts its own ui (dotnet/phoenix).
      const relay = (d.targetName ? byName.get(d.targetName) : undefined) ?? d;
      const relayHosts = new Set(relay.contextNames);
      const relayBinds = new Set<string>();
      for (const csName of relay.channelSourceNames ?? []) {
        const cs = csByName.get(csName);
        if (cs) relayBinds.add(cs.channelName);
      }
      for (const p of subscribed) {
        const owner = channelOwner.get(p.channelName) ?? p.contextName;
        if (relayHosts.has(owner) || relayBinds.has(p.channelName)) continue;
        diags.push({
          severity: "error",
          code: "loom.relay-target-not-subscribed",
          message: diagMessage("loom.relay-target-not-subscribed", {
            name: d.name,
            uiName,
            channelName: p.channelName,
            owner,
            pName: p.name,
            relayName: relay.name,
          }),
          source: d.name,
        });
      }
    }
  }
}
