// Transactional-outbox tier (dispatch-delivery-semantics.md): a channel with
// `retention: log | work` makes its carried events durable — createApp's
// default dispatcher records them in `__loom_outbox` (instead of dispatching
// inline) and index.ts starts a polling relay that drains undispatched rows
// through the in-process dispatcher (at-least-once; dead-letter after N
// attempts via the `event_dead_lettered` catalog event).  An `ephemeral`
// channel keeps the at-most-once inline path byte-identically.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateTypeScript } from "../../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../../src/platform/hono/v4/pins.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");

async function generate(file: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(root, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  expect(
    errors.map((d) => d.message),
    "fixture validation errors",
  ).toEqual([]);
  return generateTypeScript(doc.parseResult.value as Model, BACKEND_PINS);
}

describe("transactional outbox emission (retention: log)", () => {
  it("emits the __loom_outbox table, the outbox dispatcher, and the relay", async () => {
    const files = await generate("test/fixtures/outbox-sample.ddd");
    const schema = files.get("db/schema.ts") ?? "";
    expect(schema).toContain('export const loomOutbox = pgTable("__loom_outbox", {');
    expect(schema).toContain('dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),');

    const wf = files.get("http/workflows.ts") ?? "";
    expect(wf).toContain(
      'export const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set(["OrderPlaced", "ShipmentRequested"]);',
    );
    expect(wf).toContain("export function createOutboxDispatcher(");
    expect(wf).toContain(
      "await db.insert(schema.loomOutbox).values({ type: event.type, payload: event });",
    );
    expect(wf).toContain("export function startOutboxRelay(");
    expect(wf).toContain(
      "and(isNull(schema.loomOutbox.dispatchedAt), lt(schema.loomOutbox.attempts, maxAttempts))",
    );
    expect(wf).toContain('event: "event_dead_lettered"');
  });

  it("createApp defaults to the outbox-wrapped dispatcher; index starts/stops the relay", async () => {
    const files = await generate("test/fixtures/outbox-sample.ddd");
    const idx = files.get("http/index.ts") ?? "";
    expect(idx).toContain(
      "events: DomainEventDispatcher = createOutboxDispatcher(db, createInProcessDispatcher(db)),",
    );
    const boot = files.get("index.ts") ?? "";
    expect(boot).toContain("const inProcessEvents = createInProcessDispatcher(db);");
    expect(boot).toContain("const stopOutboxRelay = startOutboxRelay(db, inProcessEvents);");
    expect(boot).toContain("stopOutboxRelay();");
  });

  it("an ephemeral channel keeps the inline at-most-once path (no outbox)", async () => {
    const files = await generate("test/fixtures/dispatch-sample.ddd");
    expect(files.get("db/schema.ts") ?? "").not.toContain("__loom_outbox");
    expect(files.get("http/workflows.ts") ?? "").not.toContain("createOutboxDispatcher");
    expect(files.get("http/index.ts") ?? "").toContain(
      "events: DomainEventDispatcher = createInProcessDispatcher(db),",
    );
    expect(files.get("index.ts") ?? "").not.toContain("startOutboxRelay");
  });
});

// ─── .NET slice (T3.8 slice 2) ──────────────────────────────────────────────
import { generateDotnet } from "../../_helpers/generate.js";

describe("transactional outbox emission — .NET (retention: log)", () => {
  async function dotnetFiles(file: string): Promise<Map<string, string>> {
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(path.join(root, file)),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
    return generateDotnet(doc.parseResult.value as Model);
  }

  it("emits the OutboxMessage entity, dispatcher, relay, DbSet, and registrations", async () => {
    const files = await dotnetFiles("test/fixtures/outbox-sample.ddd");
    expect(files.get("Infrastructure/Persistence/OutboxMessage.cs")).toContain(
      'builder.ToTable("__loom_outbox");',
    );
    const disp = files.get("Infrastructure/Events/OutboxDomainEventDispatcher.cs") ?? "";
    expect(disp).toContain(
      'private static readonly HashSet<string> DurableEventTypes = new() { "OrderPlaced", "ShipmentRequested" };',
    );
    expect(disp).toContain("_db.LoomOutbox.Add(new OutboxMessage");
    const relay = files.get("Infrastructure/Events/OutboxRelayService.cs") ?? "";
    expect(relay).toContain("public sealed class OutboxRelayService : BackgroundService");
    expect(relay).toContain('"OrderPlaced" => JsonSerializer.Deserialize<OrderPlaced>(payload),');
    expect(relay).toContain('"event_dead_lettered"');
    expect(files.get("Infrastructure/Persistence/AppDbContext.cs")).toContain(
      "DbSet<OutboxMessage> LoomOutbox",
    );
    const prog = files.get("Program.cs") ?? "";
    expect(prog).toContain(
      "builder.Services.AddScoped<IDomainEventDispatcher, OutboxDomainEventDispatcher>();",
    );
    expect(prog).toContain("builder.Services.AddHostedService<OutboxRelayService>();");
  });

  it("an ephemeral channel keeps the plain in-process registration (no outbox)", async () => {
    const files = await dotnetFiles("test/fixtures/dispatch-sample.ddd");
    expect(files.has("Infrastructure/Events/OutboxDomainEventDispatcher.cs")).toBe(false);
    expect(files.get("Program.cs") ?? "").toContain(
      "builder.Services.AddScoped<IDomainEventDispatcher, InProcessDomainEventDispatcher>();",
    );
  });
});
