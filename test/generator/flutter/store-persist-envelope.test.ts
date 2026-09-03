import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// The persisted-store ON-DISK ENVELOPE (ledger F2-FFE-8).
//
// `LoomStorePersist.init` calls `SharedPreferences.setPrefix('')` explicitly so
// the key on web is the bare `loom.store.<Name>` the JS frontends write — an
// interop claim the runtime's own header states.  The PAYLOADS did not match:
// the JS frontends persist through zustand's `persist` middleware, whose on-disk
// shape is `{"state":{…},"version":0}`, while Flutter (and Feliz) wrote a FLAT
// object under the same key.  Served from one origin, each side read the other's
// blob, found none of its fields, silently fell back to defaults, and then
// overwrote the other's saved state on the next transition.
//
// Both halves are asserted: the write wraps, and the read unwraps (while still
// accepting a bare object, so a blob an older build wrote survives the upgrade).
// ---------------------------------------------------------------------------

const SRC = (platform: string) => `
system St {
  subdomain S { context C {
    aggregate Item { name: string }
    repository Items for Item { }
  } }
  ui App {
    store Prefs persist: local {
      state { mode: string = "light"  seen: int = 0 }
      action bump() { seen := seen + 1 }
    }
    page Home {
      route: "/"
      body: Stack { Text { Prefs.mode }, Text { string(Prefs.seen) }, Button { "b", onClick: Prefs.bump } }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
  deployable webapp { platform: ${platform} targets: api ui: App port: 3001 }
}
`;

describe("persisted-store envelope parity", () => {
  it("flutter writes and reads zustand's {state, version} envelope", async () => {
    const files = await generateSystemFiles(SRC("flutter"));
    const runtime = [...files.entries()].find(([k]) => k.endsWith("lib/store_persist.dart"))![1];
    // WRITE — wrapped, not the flat map it used to encode.
    expect(runtime).toContain("jsonEncode(<String, dynamic>{'state': value, 'version': 0}),");
    expect(runtime).not.toContain("_prefs?.setString(key, jsonEncode(value));");
    // READ — unwraps the envelope, and still accepts a bare object.
    expect(runtime).toContain(
      "if (decoded is Map<String, dynamic> && decoded['state'] is Map<String, dynamic>) {",
    );
    // Same key as the JS frontends — the premise of the whole row.
    const stores = [...files.entries()].find(([k]) => k.endsWith("lib/stores.dart"))![1];
    expect(stores).toContain("'loom.store.Prefs'");
  });

  it("feliz writes and reads the same envelope", async () => {
    const files = await generateSystemFiles(SRC("feliz"));
    const app = [...files.entries()].find(([k]) => k.endsWith("src/App.fs"))![1];
    expect(app).toContain(
      '"{\\"state\\":{" + String.concat "," [ "\\"mode\\":" + jsonString model.PrefsMode; ' +
        '"\\"seen\\":" + string model.PrefsSeen ] + "},\\"version\\":0}"',
    );
    // The `[<Emit>]` reader steps into `.state` when present (never into an
    // array, so a store field literally named `state` is not mistaken for it).
    expect(app).toContain(
      "if(o&&o.state&&typeof o.state==='object'&&!Array.isArray(o.state))o=o.state;",
    );
  });

  it("the JS frontends really do write that envelope (the parity premise)", async () => {
    const files = await generateSystemFiles(SRC("react"));
    const store = [...files.entries()].find(([k]) => k.endsWith("src/stores/prefs.ts"))![1];
    // zustand `persist` + `createJSONStorage` — the middleware whose on-disk
    // shape is `{state, version}`, under the shared key.
    expect(store).toContain('name: "loom.store.Prefs",');
    expect(store).toContain("storage: createJSONStorage(() => localStorage),");
  });
});
