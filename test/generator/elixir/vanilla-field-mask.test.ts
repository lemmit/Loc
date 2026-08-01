import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Vanilla (plain Ecto/Phoenix) read-mask redaction (`mask unless`,
// authorization.md §5, M-T3.2 item 6). A masked aggregate's `serialize/1`
// becomes the REDACTING serializer: it delegates to `serialize_unmasked/1`
// (the raw map, which audit snapshots use), then nils each masked key unless
// the ambient principal — `Process.get(:loom_current_user)`, stashed by the
// Auth plug — satisfies the field's predicate (fail-closed). Compile-verified
// separately (mix --warnings-as-errors); this pins the emit shape.

const SOURCE = `
system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish, auditable {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
      }
    }
  }
  api Api from C
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: Api
    port: 4000
    auth: required
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla mask unless — read redaction", () => {
  it("makes serialize/1 redact fail-closed, delegating to an unmasked serialize_unmasked/1", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/p_controller.ex");
    // serialize/1 reads the ambient principal and delegates to the raw map.
    expect(ctrl).toContain("current_user = Process.get(:loom_current_user)");
    expect(ctrl).toContain("wire = serialize_unmasked(record)");
    // fail-closed redaction: nil principal OR failed predicate → nil the key.
    expect(ctrl).toContain(
      'wire = if current_user != nil and (Enum.member?(current_user.permissions, "m.unmask")), do: wire, else: Map.put(wire, "salary", nil)',
    );
    // the unmasked map carries the real value (audit projects through it).
    expect(ctrl).toContain("defp serialize_unmasked(record) do");
    // (`salary` is a `decimal`, so it carries the RS-24 number coercion.)
    expect(ctrl).toContain('"salary" => __decimal_num(record.salary)');
  });

  it("the Auth plug stashes the principal in the process dictionary", async () => {
    const auth = file(await generateSystemFiles(SOURCE), "/auth.ex");
    expect(auth).toContain("Process.put(:loom_current_user, user)");
  });
});
