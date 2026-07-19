// Regression pin for the Swoosh boot fix (M-T4.6).
//
// Swoosh initialises its default API client (Hackney) when the `:swoosh`
// application starts — even for the SMTP adapter, which sends through
// gen_smtp and needs no HTTP client.  The smtp mailer pulls `swoosh` +
// `gen_smtp` but NOT `hackney`, so without disabling the api_client the
// generated Phoenix app crashes at boot with "missing hackney dependency".
// (The compile gate can't catch this — it's a boot-time failure; the
// mailer-smtp-elixir-e2e leg caught it.)  config/config.exs must therefore
// carry `config :swoosh, :api_client, false` for an smtp-only mailer.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

function src(mailerType: "smtp" | "ses" | "sendgrid" | null): string {
  const storage =
    mailerType === null
      ? ""
      : `storage mailServer { type: ${mailerType}, config: { from: "no-reply@acme.test" } }`;
  const resource =
    mailerType === null ? "" : `resource mail { for: Sales, kind: mailer, use: mailServer }`;
  const dataSources = mailerType === null ? "[salesState]" : "[salesState, mail]";
  const body = mailerType === null ? "" : `mail.send("to@acme.test", "Hi", "Body")`;
  return `
system Sys {
  subdomain D {
    context Sales {
      aggregate Order with crudish { name: string }
      repository Orders for Order { }
      workflow notify { create(name: string) { ${body} } }
    }
  }
  api A from D
  storage pg { type: postgres }
  ${storage}
  resource salesState { for: Sales, kind: state, use: pg }
  ${resource}
  deployable api {
    platform: elixir
    contexts: [Sales]
    dataSources: ${dataSources}
    serves: A
    port: 4000
  }
}`;
}

const config = (files: Map<string, string>): string =>
  [...files].find(([k]) => k.endsWith("config/config.exs"))?.[1] ?? "";

describe("vanilla Phoenix — Swoosh api_client boot config", () => {
  it("smtp mailer → config/config.exs disables the Swoosh api_client", async () => {
    const { files } = generateSystems(await parseValid(src("smtp")));
    expect(config(files)).toMatch(/config :swoosh, :api_client, false/);
  });

  it("no mailer → no Swoosh api_client config (byte-identical shell)", async () => {
    const { files } = generateSystems(await parseValid(src(null)));
    expect(config(files)).not.toMatch(/swoosh/);
  });

  it("ses/sendgrid mailer keeps the default api_client (hackney is a dep)", async () => {
    for (const t of ["ses", "sendgrid"] as const) {
      const { files } = generateSystems(await parseValid(src(t)));
      // The HTTP adapters need Swoosh's api_client, so it must NOT be disabled.
      expect(config(files)).not.toMatch(/config :swoosh, :api_client, false/);
    }
  });
});
