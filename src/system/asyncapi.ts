import type { SystemIR } from "../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// `.loom/asyncapi.yaml` — a derived AsyncAPI 3.0 view of the system's
// `channel` declarations (channels.md, Slice 1).  Realises the
// bounded-context-model's "events as channels" placeholder: one AsyncAPI
// channel object per `channel`, its carried events as messages, the
// `delivery`/`retention`/`key` knobs and the `channelSource` binding under
// `x-loom`.
//
// Like every other `.loom/` artifact (`mermaid.ts`, `wire-spec.ts`,
// `datasources.ts`, …) this is a derived view, not a contract — no DSL
// keyword controls it.  It exists for diff-based contract-change detection:
// a reviewer sees a channel's events or delivery profile change in the PR
// diff without crawling individual declarations.
// ---------------------------------------------------------------------------

const yamlStr = (s: string): string => JSON.stringify(s); // safe double-quoted scalar

export function renderAsyncApi(sys: SystemIR): string {
  const out: string[] = [];
  out.push("asyncapi: 3.0.0");
  out.push("info:");
  out.push(`  title: ${yamlStr(`${sys.name} channels`)}`);
  out.push("  version: 0.0.0");

  // channelSource bindings, indexed by channel name (Slice 1: bare names).
  const bindingByChannel = new Map<string, string>();
  for (const cs of sys.channelSources) {
    if (cs.channelName) bindingByChannel.set(cs.channelName, cs.storageName);
  }

  const contexts = sys.subdomains.flatMap((s) => s.contexts);
  const channelEntries = contexts.flatMap((ctx) =>
    ctx.channels.map((ch) => ({ ctx: ctx.name, ch })),
  );

  // Workflow `on(e: Event) [by …]` reactors surface as AsyncAPI `receive`
  // operations (workflow-and-applier.md A2).  A reviewer sees "this workflow
  // now reacts to PaymentReceived" in the PR diff.  Gated on existence so a
  // channel-only system's output stays byte-identical.
  const subscriptionEntries = contexts.flatMap((ctx) =>
    (ctx.workflows ?? []).flatMap((wf) =>
      (wf.subscriptions ?? []).map((sub) => ({ ctx: ctx.name, wf: wf.name, sub })),
    ),
  );

  if (channelEntries.length === 0 && subscriptionEntries.length === 0) {
    out.push("channels: {}");
    return `${out.join("\n")}\n`;
  }

  out.push(channelEntries.length === 0 ? "channels: {}" : "channels:");
  for (const { ctx, ch } of channelEntries) {
    const address = `${ctx}.${ch.name}`;
    out.push(`  ${yamlStr(address)}:`);
    out.push(`    address: ${yamlStr(address)}`);
    if (ch.carries.length > 0) {
      out.push("    messages:");
      for (const ev of ch.carries) {
        out.push(`      ${yamlStr(ev)}:`);
        out.push(`        name: ${yamlStr(ev)}`);
      }
    } else {
      out.push("    messages: {}");
    }
    out.push("    x-loom:");
    out.push(`      delivery: ${ch.delivery}`);
    out.push(`      retention: ${ch.retention}`);
    if (ch.key) out.push(`      key: ${yamlStr(ch.key)}`);
    const storage = bindingByChannel.get(ch.name);
    out.push(`      transport: ${storage ? yamlStr(storage) : "in-process"}`);
    // Honesty flag: a `channelSource` binding names a broker/cache, but no
    // backend emits a client for it and compose provisions none — the
    // transport is DECLARED, not wired.  Say so until brokers actually land,
    // rather than implying `transport: hotCache` is a live redis hop.
    if (storage) out.push('      transportStatus: "declared, not provisioned"');
  }

  if (subscriptionEntries.length > 0) {
    out.push("operations:");
    for (const { ctx, wf, sub } of subscriptionEntries) {
      const opName = `${ctx}.${wf}.on.${sub.event}`;
      out.push(`  ${yamlStr(opName)}:`);
      out.push("    action: receive");
      out.push("    x-loom:");
      out.push(`      workflow: ${yamlStr(`${ctx}.${wf}`)}`);
      out.push(`      event: ${yamlStr(sub.event)}`);
      if (sub.correlation) out.push("      correlated: true");
    }
  }
  return `${out.join("\n")}\n`;
}
