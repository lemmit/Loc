// `loom.create-server-field` / `loom.create-unknown-field` — the aggregate
// factory twin of `loom.unknown-construction-field`.  `Agg.create({ … })` may
// only name fields on the aggregate's create-input contract: declared
// `Property` members whose access is NOT `managed`/`token`/`internal`.  A
// server-owned field or a typo compiles the .ddd but fails the emitted
// project's own tsc (the field isn't on the generated factory input).

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (body: string) => `
system Demo {
  subdomain S {
    context C {
      enum Status { Open, Done }
      aggregate Task with crudish {
        title: string
        status: Status
        createdAt: datetime managed
        ${body}
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
}`;

async function codes(body: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(body), { validate: true });
  return codesOf(diagnostics);
}

const SERVER = "loom.create-server-field";
const UNKNOWN = "loom.create-unknown-field";

describe("loom.create-server-field / -unknown-field (factory input contract)", () => {
  it("rejects a server-owned (managed) field passed to .create()", async () => {
    const c = await codes(
      'test "t" { let x = Task.create({ title: "a", status: Open, createdAt: now() }) }',
    );
    expect(c).toContain(SERVER);
    expect(c).not.toContain(UNKNOWN);
  });

  it("rejects a field the aggregate doesn't declare", async () => {
    const c = await codes(
      'test "t" { let x = Task.create({ title: "a", status: Open, bogus: 3 }) }',
    );
    expect(c).toContain(UNKNOWN);
    expect(c).not.toContain(SERVER);
  });

  it("is CLEAN when every key is on the create-input contract", async () => {
    const c = await codes('test "t" { let x = Task.create({ title: "a", status: Open }) }');
    expect(c).not.toContain(SERVER);
    expect(c).not.toContain(UNKNOWN);
  });

  it("does not fire on a UI-side api-client create (head is not an aggregate)", async () => {
    const uiSys = `
system Demo {
  subdomain S {
    context C {
      aggregate Task with crudish { title: string }
    }
  }
  api Api from S
  ui Web {
    api Work: Api
    page Home {
      route: "/"
      state { d: int = 0 }
      action go() { let r = Work.Task.create({ title: "a", bogus: 3 }) }
      body: Button { "go", onClick: go }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: Api port: 3000 }
  deployable web { platform: react targets: api ui: Web { Work: api } port: 3001 }
}`;
    const c = codesOf((await parseString(uiSys, { validate: true })).diagnostics);
    // `Work.Task.create(...)` head is the `Work` api handle, not a bare
    // aggregate NameRef, so the factory gate must not fire here.
    expect(c).not.toContain(SERVER);
    expect(c).not.toContain(UNKNOWN);
  });
});
