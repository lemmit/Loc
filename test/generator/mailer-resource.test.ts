// M-T4.6 email slice — `kind: mailer` (surface) → infra kind `email`, a
// resource consumed from a workflow through the single `send` verb.  Each
// backend's ResourceAdapter emits a `<resource> send` helper for the bound
// sourceType (smtp / ses / sendgrid); the resource-op call site renders
// through the existing verb-name-generic dispatch on all five backends.
//
// In-memory (`generateSystems`, no compile) — the shape gate.  Compiling
// the emitted vendor clients is each backend's build-gate job (4.6-email-b).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

/** A one-context system whose workflow calls `mail.send(...)`, parameterised
 *  by target platform and mailer sourceType. */
function src(platform: string, type: "smtp" | "ses" | "sendgrid"): string {
  return `
system Sys {
  subdomain D {
    context Sales {
      aggregate Order with crudish { customerEmail: string }
      repository Orders for Order { }
      workflow notify {
        create(customerEmail: string) {
          mail.send(customerEmail, "Order received", "Thanks for your order.")
        }
      }
    }
  }
  api A from D
  storage pg { type: postgres }
  storage mailServer { type: ${type}, config: { from: "no-reply@acme.test" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource mail { for: Sales, kind: mailer, use: mailServer }
  deployable d {
    platform: ${platform}
    contexts: [Sales]
    dataSources: [salesState, mail]
    serves: A
    port: 4000
  }
}
`;
}

const find = (files: Map<string, string>, re: RegExp): string | undefined =>
  [...files].find(([k]) => re.test(k))?.[1];

describe("mailer resource — hono/node", () => {
  it("emits an smtp client module with a mail$send helper + nodemailer dep", async () => {
    const { files } = generateSystems(await parseValid(src("node", "smtp")));
    const mod = files.get("d/resources/smtp.ts")!;
    expect(mod).toMatch(/import nodemailer from "nodemailer";/);
    expect(mod).toMatch(/mailFrom = process\.env\.MAIL_FROM \?\? "no-reply@acme.test"/);
    expect(mod).toMatch(
      /export async function mail\$send\(to: string, subject: string, body: string\)/,
    );
    expect(mod).toMatch(/sendMail\(\{ from: mailFrom, to, subject, text: body \}\)/);
    expect(files.get("d/package.json")!).toMatch(/"nodemailer"/);
  });

  it("renders the resource-op call site awaited inline", async () => {
    const { files } = generateSystems(await parseValid(src("node", "smtp")));
    const wf = find(files, /workflows\.ts$/)!;
    expect(wf).toMatch(/import \{ mail\$send \} from "\.\.\/resources\/smtp"/);
    expect(wf).toMatch(
      /await mail\$send\(customerEmail, "Order received", "Thanks for your order."\)/,
    );
  });

  it("ses uses the SES SDK; sendgrid uses @sendgrid/mail", async () => {
    const ses = generateSystems(await parseValid(src("node", "ses"))).files.get(
      "d/resources/ses.ts",
    )!;
    expect(ses).toMatch(/@aws-sdk\/client-ses/);
    expect(ses).toMatch(/new SendEmailCommand/);
    const sg = generateSystems(await parseValid(src("node", "sendgrid"))).files.get(
      "d/resources/sendgrid.ts",
    )!;
    expect(sg).toMatch(/import sgMail from "@sendgrid\/mail";/);
    expect(sg).toMatch(/sgMail\.send\(\{ to, from: mailFrom, subject, text: body \}\)/);
  });
});

describe("mailer resource — cross-backend emission", () => {
  it("dotnet emits SmtpResources.Mail_Send via MailKit + the call site", async () => {
    const { files } = generateSystems(await parseValid(src("dotnet", "smtp")));
    const mod = find(files, /Resources\/SmtpResources\.cs$/)!;
    expect(mod).toMatch(/using MailKit\.Net\.Smtp;/);
    expect(mod).toMatch(
      /public static async Task Mail_Send\(string to, string subject, string body\)/,
    );
    expect(find(files, /NotifyHandler\.cs$/)!).toMatch(/await SmtpResources\.Mail_Send\(/);
  });

  it("dotnet csproj carries MailKit + suppresses its transitive NU1902 advisory", async () => {
    const { files } = generateSystems(await parseValid(src("dotnet", "smtp")));
    const csproj = find(files, /\.csproj$/)!;
    expect(csproj).toMatch(/<PackageReference Include="MailKit" Version="[\d.]+" \/>/);
    // The suppress keeps `dotnet build /warnaserror` (NuGet audit → NU1902)
    // green against MailKit/MimeKit's moderate BouncyCastle advisory.
    expect(csproj).toMatch(
      /<NuGetAuditSuppress Include="https:\/\/github\.com\/advisories\/GHSA-9j88-vvj5-vhgr" \/>/,
    );
    expect(csproj).toMatch(
      /<NuGetAuditSuppress Include="https:\/\/github\.com\/advisories\/GHSA-g7hc-96xr-gvvx" \/>/,
    );
  });

  it("dotnet csproj emits no NuGetAuditSuppress when no mailer is consumed", async () => {
    const { files } = generateSystems(
      await parseValid(`
system Sys {
  subdomain D { context Sales {
    aggregate Order with crudish { name: string }
    repository Orders for Order { }
  } }
  api A from D
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable d { platform: dotnet, contexts: [Sales], dataSources: [salesState], serves: A, port: 4000 }
}`),
    );
    expect(find(files, /\.csproj$/)!).not.toMatch(/NuGetAuditSuppress/);
  });

  it("java emits SmtpResources.mailSend via Jakarta Mail + the call site", async () => {
    const { files } = generateSystems(await parseValid(src("java", "smtp")));
    const mod = find(files, /SmtpResources\.java$/)!;
    expect(mod).toMatch(/import jakarta\.mail\.Transport;/);
    expect(mod).toMatch(/public static void mailSend\(String to, String subject, String body\)/);
    expect(find(files, /SalesWorkflows\.java$/)!).toMatch(/SmtpResources\.mailSend\(/);
  });

  it("python emits mail_send via aiosmtplib + the awaited call site", async () => {
    const { files } = generateSystems(await parseValid(src("python", "smtp")));
    const mod = find(files, /resources\/smtp\.py$/)!;
    expect(mod).toMatch(/import aiosmtplib/);
    expect(mod).toMatch(/async def mail_send\(to: str, subject: str, body: str\) -> None:/);
    expect(find(files, /workflows_routes\.py$/)!).toMatch(/await mail_send\(customer_email,/);
  });

  it("phoenix emits mail_send via Swoosh + the call site", async () => {
    const { files } = generateSystems(await parseValid(src("elixir", "smtp")));
    const mod = find(files, /resources\/smtp\.ex$/)!;
    expect(mod).toMatch(/Swoosh\.Adapters\.SMTP\.deliver/);
    expect(mod).toMatch(/def mail_send\(to, subject, body\)/);
    expect(find(files, /notify\.ex$/)!).toMatch(/D\.Resources\.Smtp\.mail_send\(/);
  });
});

// SMTP credentials ride the connection URL (smtp://user:pass@host) — never the
// `.ddd` source — so every backend must authenticate when userinfo is present.
// nodemailer parses the URL itself; the other four decode + authenticate.
describe("mailer resource — smtp auth from the connection URL", () => {
  it("python passes username/password from the parsed URL", async () => {
    const mod = find(
      generateSystems(await parseValid(src("python", "smtp"))).files,
      /resources\/smtp\.py$/,
    )!;
    expect(mod).toMatch(/username=parsed\.username or None/);
    expect(mod).toMatch(/password=parsed\.password or None/);
    expect(mod).toMatch(/use_tls=parsed\.scheme == "smtps"/);
  });

  it("java installs an Authenticator + starttls/ssl when the URL carries credentials", async () => {
    const mod = find(
      generateSystems(await parseValid(src("java", "smtp"))).files,
      /SmtpResources\.java$/,
    )!;
    expect(mod).toMatch(/uri\.getUserInfo\(\)/);
    expect(mod).toMatch(/mail\.smtp\.auth/);
    expect(mod).toMatch(/new Authenticator\(\)/);
    expect(mod).toMatch(/mail\.smtp\.starttls\.enable/);
  });

  it("dotnet authenticates + picks SecureSocketOptions from the URL", async () => {
    const mod = find(
      generateSystems(await parseValid(src("dotnet", "smtp"))).files,
      /Resources\/SmtpResources\.cs$/,
    )!;
    expect(mod).toMatch(/uri\.UserInfo/);
    expect(mod).toMatch(/AuthenticateAsync/);
    expect(mod).toMatch(/SecureSocketOptions\.StartTlsWhenAvailable/);
    expect(mod).toMatch(/SecureSocketOptions\.SslOnConnect/);
  });

  it("phoenix passes username/password/auth/tls when the URL carries credentials", async () => {
    const mod = find(
      generateSystems(await parseValid(src("elixir", "smtp"))).files,
      /resources\/smtp\.ex$/,
    )!;
    expect(mod).toMatch(/uri\.userinfo/);
    expect(mod).toMatch(/username: user/);
    expect(mod).toMatch(/auth: :always/);
    expect(mod).toMatch(/tls: if\(uri\.scheme == "smtps"/);
  });
});

describe("mailer resource — dev compose sidecar", () => {
  it("smtp storage emits a Mailpit sidecar; ses/sendgrid emit none", async () => {
    const smtp = generateSystems(await parseValid(src("node", "smtp"))).files.get(
      "docker-compose.yml",
    )!;
    expect(smtp).toMatch(/image: axllent\/mailpit:latest/);
    expect(smtp).toMatch(/MP_SMTP_AUTH_ACCEPT_ANY: 1/);

    const ses = generateSystems(await parseValid(src("node", "ses"))).files.get(
      "docker-compose.yml",
    )!;
    expect(ses).not.toMatch(/mailpit/);
  });
});
