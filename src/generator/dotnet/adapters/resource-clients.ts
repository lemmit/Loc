// .NET ResourceAdapter — C# client classes for the non-persistence
// infrastructure kinds (objectStore / queue / api).  Sibling of the
// hono `resource-clients.ts`; emits one static class per sourceType
// under `Resources/<SourceType>.cs`, with one async method per
// (resource, verb) the deployable's workflows use.  The render layer
// (`render-expr.ts` resource-op case) calls `<Resource>Resources.<Verb>`.
//
// 4c is hono-parity: same closed verb vocabulary, vendor-neutral source
// → C# emission.  `supports()` delegates to the sourceType registry.

import type { DataSourceIR, StorageIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { supportsSurfaceKind } from "../../../util/source-types.js";

export interface DotnetResourceAdapter {
  readonly name: string;
  /** NuGet `<PackageReference>` lines (id → version) merged into the csproj. */
  nugetDeps(): Record<string, string>;
  /** A C# static helper class (full file body) for the resources of this
   *  kind the deployable wires.  `ns` is the project root namespace. */
  emitClientClass(
    resources: readonly DataSourceIR[],
    stores: readonly StorageIR[],
    ns: string,
  ): string;
}

function cfg(store: StorageIR | undefined, key: string): string | undefined {
  const entry = store?.config?.find((c) => c.key === key);
  return entry && entry.value.kind === "string" ? entry.value.value : undefined;
}

function envVar(resourceName: string): string {
  return `${resourceName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_URL`;
}

function storeOf(resource: DataSourceIR, stores: readonly StorageIR[]): StorageIR | undefined {
  return stores.find((s) => s.name === resource.storageName);
}

/** Class name for a sourceType's resource helpers, e.g. `S3Resources`. */
export function resourceClassName(sourceType: string): string {
  return `${upperFirst(sourceType)}Resources`;
}

const s3DotnetAdapter: DotnetResourceAdapter = {
  name: "s3",
  nugetDeps: () => ({ "AWSSDK.S3": "3.7.405.4" }),
  emitClientClass(resources, stores, ns): string {
    const lines: string[] = [
      "// Auto-generated.",
      "using System;",
      "using System.IO;",
      "using System.Collections.Generic;",
      "using System.Threading.Tasks;",
      "using Amazon.S3;",
      "using Amazon.S3.Model;",
      "",
      `namespace ${ns}.Resources;`,
      "",
      "public static class S3Resources",
      "{",
    ];
    for (const r of resources) {
      const store = storeOf(r, stores);
      const bucket = cfg(store, "bucket") ?? "";
      const cls = upperFirst(r.name);
      lines.push(
        `    private static readonly string ${cls}Bucket =`,
        `        Environment.GetEnvironmentVariable("${envVar(r.name)}_BUCKET") ?? ${JSON.stringify(bucket)};`,
        `    private static readonly AmazonS3Client ${cls}Client = new AmazonS3Client();`,
        "",
        `    public static async Task ${cls}_Put(string key, string body)`,
        "    {",
        `        await ${cls}Client.PutObjectAsync(new PutObjectRequest`,
        "        {",
        `            BucketName = ${cls}Bucket,`,
        "            Key = key,",
        "            ContentBody = body,",
        '            ContentType = "application/json",',
        "        });",
        "    }",
        "",
        `    public static async Task<string?> ${cls}_Get(string key)`,
        "    {",
        "        try",
        "        {",
        `            using var res = await ${cls}Client.GetObjectAsync(${cls}Bucket, key);`,
        "            using var reader = new StreamReader(res.ResponseStream);",
        "            return await reader.ReadToEndAsync();",
        "        }",
        "        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)",
        "        {",
        "            return null;",
        "        }",
        "    }",
        "",
        `    public static async Task<IReadOnlyList<string>> ${cls}_List(string prefix)`,
        "    {",
        `        var res = await ${cls}Client.ListObjectsV2Async(new ListObjectsV2Request { BucketName = ${cls}Bucket, Prefix = prefix });`,
        "        var keys = new List<string>();",
        "        foreach (var o in res.S3Objects) keys.Add(o.Key);",
        "        return keys;",
        "    }",
        "",
        `    public static Task<string> ${cls}_SignedUrl(string key)`,
        "    {",
        `        var url = ${cls}Client.GetPreSignedURL(new GetPreSignedUrlRequest`,
        "        {",
        `            BucketName = ${cls}Bucket,`,
        "            Key = key,",
        "            Expires = DateTime.UtcNow.AddHours(1),",
        "        });",
        "        return Task.FromResult(url);",
        "    }",
        "",
        `    public static async Task ${cls}_Delete(string key)`,
        "    {",
        `        await ${cls}Client.DeleteObjectAsync(${cls}Bucket, key);`,
        "    }",
        "",
      );
    }
    lines.push("}", "");
    return lines.join("\n");
  },
};

const rabbitmqDotnetAdapter: DotnetResourceAdapter = {
  name: "rabbitmq",
  nugetDeps: () => ({ "RabbitMQ.Client": "7.0.0" }),
  emitClientClass(resources, _stores, ns): string {
    const lines: string[] = [
      "// Auto-generated.",
      "using System;",
      "using System.Text;",
      "using System.Threading.Tasks;",
      "using RabbitMQ.Client;",
      "",
      `namespace ${ns}.Resources;`,
      "",
      "public static class RabbitmqResources",
      "{",
    ];
    for (const r of resources) {
      const cls = upperFirst(r.name);
      lines.push(
        `    private static readonly string ${cls}Url =`,
        `        Environment.GetEnvironmentVariable("${envVar(r.name)}") ?? "amqp://guest:guest@${r.name}:5672";`,
        `    private static IConnection? _${cls}Conn;`,
        `    private static IChannel? _${cls}Channel;`,
        "",
        `    private static async Task<IChannel> ${cls}_Channel()`,
        "    {",
        `        if (_${cls}Channel is { IsOpen: true }) return _${cls}Channel;`,
        `        var factory = new ConnectionFactory { Uri = new Uri(${cls}Url) };`,
        `        _${cls}Conn = await factory.CreateConnectionAsync();`,
        `        _${cls}Channel = await _${cls}Conn.CreateChannelAsync();`,
        `        return _${cls}Channel;`,
        "    }",
        "",
        `    public static async Task ${cls}_Enqueue(string message)`,
        "    {",
        `        var ch = await ${cls}_Channel();`,
        `        await ch.QueueDeclareAsync(queue: "${r.name}", durable: true, exclusive: false, autoDelete: false, arguments: null);`,
        "        var props = new BasicProperties { Persistent = true };",
        `        await ch.BasicPublishAsync(exchange: "", routingKey: "${r.name}", mandatory: false, basicProperties: props, body: Encoding.UTF8.GetBytes(message));`,
        "    }",
        "",
        `    public static async Task ${cls}_Publish(string topic, string message)`,
        "    {",
        `        var ch = await ${cls}_Channel();`,
        `        await ch.ExchangeDeclareAsync(exchange: "${r.name}", type: "topic", durable: true);`,
        "        var props = new BasicProperties { Persistent = true };",
        `        await ch.BasicPublishAsync(exchange: "${r.name}", routingKey: topic, mandatory: false, basicProperties: props, body: Encoding.UTF8.GetBytes(message));`,
        "    }",
        "",
      );
    }
    lines.push("}", "");
    return lines.join("\n");
  },
};

const restApiDotnetAdapter: DotnetResourceAdapter = {
  name: "restApi",
  nugetDeps: () => ({}),
  emitClientClass(resources, stores, ns): string {
    const lines: string[] = [
      "// Auto-generated.",
      "using System;",
      "using System.Net.Http;",
      "using System.Text;",
      "using System.Threading.Tasks;",
      "",
      `namespace ${ns}.Resources;`,
      "",
      "public static class RestApiResources",
      "{",
      "    private static readonly HttpClient Http = new HttpClient();",
      "",
    ];
    for (const r of resources) {
      const baseUrl = cfg(storeOf(r, stores), "baseUrl") ?? "";
      const cls = upperFirst(r.name);
      lines.push(
        `    private static readonly string ${cls}BaseUrl =`,
        `        Environment.GetEnvironmentVariable("${envVar(r.name)}") ?? ${JSON.stringify(baseUrl)};`,
        "",
        `    public static async Task<string> ${cls}_Get(string path)`,
        "    {",
        `        var res = await Http.GetAsync(new Uri(new Uri(${cls}BaseUrl), path));`,
        "        res.EnsureSuccessStatusCode();",
        "        return await res.Content.ReadAsStringAsync();",
        "    }",
        "",
        `    public static async Task<string> ${cls}_Post(string path, string body)`,
        "    {",
        '        var content = new StringContent(body, Encoding.UTF8, "application/json");',
        `        var res = await Http.PostAsync(new Uri(new Uri(${cls}BaseUrl), path), content);`,
        "        res.EnsureSuccessStatusCode();",
        "        return await res.Content.ReadAsStringAsync();",
        "    }",
        "",
      );
    }
    lines.push("}", "");
    return lines.join("\n");
  },
};

function mailFrom(r: DataSourceIR, stores: readonly StorageIR[]): string {
  return cfg(storeOf(r, stores), "from") ?? "no-reply@example.test";
}

/** SCREAMING_SNAKE env stem without the `_URL` suffix. */
function envStem(resourceName: string): string {
  return envVar(resourceName).replace(/_URL$/, "");
}

const smtpDotnetAdapter: DotnetResourceAdapter = {
  name: "smtp",
  nugetDeps: () => ({ MailKit: "4.8.0" }),
  emitClientClass(resources, stores, ns): string {
    const lines: string[] = [
      "// Auto-generated.",
      "using System;",
      "using System.Threading.Tasks;",
      "using MailKit.Net.Smtp;",
      "using MailKit.Security;",
      "using MimeKit;",
      "",
      `namespace ${ns}.Resources;`,
      "",
      "public static class SmtpResources",
      "{",
    ];
    for (const r of resources) {
      const cls = upperFirst(r.name);
      lines.push(
        `    private static readonly string ${cls}Url =`,
        `        Environment.GetEnvironmentVariable("${envVar(r.name)}") ?? "smtp://localhost:1025";`,
        `    private static readonly string ${cls}From =`,
        `        Environment.GetEnvironmentVariable("${envStem(r.name)}_FROM") ?? ${JSON.stringify(mailFrom(r, stores))};`,
        "",
        `    public static async Task ${cls}_Send(string to, string subject, string body)`,
        "    {",
        `        var uri = new Uri(${cls}Url);`,
        "        var message = new MimeMessage();",
        `        message.From.Add(MailboxAddress.Parse(${cls}From));`,
        "        message.To.Add(MailboxAddress.Parse(to));",
        "        message.Subject = subject;",
        '        message.Body = new TextPart("plain") { Text = body };',
        "        using var client = new SmtpClient();",
        '        var tls = uri.Scheme == "smtps"',
        "            ? SecureSocketOptions.SslOnConnect",
        "            : (string.IsNullOrEmpty(uri.UserInfo) ? SecureSocketOptions.None : SecureSocketOptions.StartTlsWhenAvailable);",
        "        await client.ConnectAsync(uri.Host, uri.Port < 0 ? 25 : uri.Port, tls);",
        "        if (!string.IsNullOrEmpty(uri.UserInfo))",
        "        {",
        "            // Credentials in the connection URL (user:pass@host) → authenticate.",
        "            var creds = uri.UserInfo.Split(':', 2);",
        '            await client.AuthenticateAsync(Uri.UnescapeDataString(creds[0]), creds.Length > 1 ? Uri.UnescapeDataString(creds[1]) : "");',
        "        }",
        "        await client.SendAsync(message);",
        "        await client.DisconnectAsync(true);",
        "    }",
        "",
      );
    }
    lines.push("}", "");
    return lines.join("\n");
  },
};

const sesDotnetAdapter: DotnetResourceAdapter = {
  name: "ses",
  nugetDeps: () => ({ "AWSSDK.SimpleEmail": "3.7.400.108" }),
  emitClientClass(resources, stores, ns): string {
    const lines: string[] = [
      "// Auto-generated.",
      "using System;",
      "using System.Collections.Generic;",
      "using System.Threading.Tasks;",
      "using Amazon.SimpleEmail;",
      "using Amazon.SimpleEmail.Model;",
      "",
      `namespace ${ns}.Resources;`,
      "",
      "public static class SesResources",
      "{",
    ];
    for (const r of resources) {
      const cls = upperFirst(r.name);
      lines.push(
        `    private static readonly AmazonSimpleEmailServiceClient ${cls}Client = new AmazonSimpleEmailServiceClient();`,
        `    private static readonly string ${cls}From =`,
        `        Environment.GetEnvironmentVariable("${envStem(r.name)}_FROM") ?? ${JSON.stringify(mailFrom(r, stores))};`,
        "",
        `    public static async Task ${cls}_Send(string to, string subject, string body)`,
        "    {",
        `        await ${cls}Client.SendEmailAsync(new SendEmailRequest`,
        "        {",
        `            Source = ${cls}From,`,
        "            Destination = new Destination { ToAddresses = new List<string> { to } },",
        "            Message = new Message",
        "            {",
        "                Subject = new Content(subject),",
        "                Body = new Body { Text = new Content(body) },",
        "            },",
        "        });",
        "    }",
        "",
      );
    }
    lines.push("}", "");
    return lines.join("\n");
  },
};

const sendgridDotnetAdapter: DotnetResourceAdapter = {
  name: "sendgrid",
  nugetDeps: () => ({ SendGrid: "9.29.3" }),
  emitClientClass(resources, stores, ns): string {
    const lines: string[] = [
      "// Auto-generated.",
      "using System;",
      "using System.Threading.Tasks;",
      "using SendGrid;",
      "using SendGrid.Helpers.Mail;",
      "",
      `namespace ${ns}.Resources;`,
      "",
      "public static class SendgridResources",
      "{",
    ];
    for (const r of resources) {
      const cls = upperFirst(r.name);
      lines.push(
        `    private static readonly string ${cls}From =`,
        `        Environment.GetEnvironmentVariable("${envStem(r.name)}_FROM") ?? ${JSON.stringify(mailFrom(r, stores))};`,
        "",
        `    public static async Task ${cls}_Send(string to, string subject, string body)`,
        "    {",
        '        var client = new SendGridClient(Environment.GetEnvironmentVariable("SENDGRID_API_KEY") ?? "");',
        `        var msg = MailHelper.CreateSingleEmail(new EmailAddress(${cls}From), new EmailAddress(to), subject, body, body);`,
        "        await client.SendEmailAsync(msg);",
        "    }",
        "",
      );
    }
    lines.push("}", "");
    return lines.join("\n");
  },
};

const ADAPTERS: readonly DotnetResourceAdapter[] = [
  s3DotnetAdapter,
  rabbitmqDotnetAdapter,
  restApiDotnetAdapter,
  smtpDotnetAdapter,
  sesDotnetAdapter,
  sendgridDotnetAdapter,
];

/** The .NET ResourceAdapter realizing a sourceType, if any, and only
 *  when the registry agrees it supports the kind. */
export function dotnetResourceAdapterFor(sourceType: string): DotnetResourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === sourceType);
}

/** Does any .NET adapter support `(sourceType, kind)`? */
export function dotnetSupportsResource(sourceType: string, kind: DataSourceIR["kind"]): boolean {
  return !!dotnetResourceAdapterFor(sourceType) && supportsSurfaceKind(sourceType, kind);
}

/** Emit `Resources/<SourceType>.cs` helper classes for every consumable
 *  resource in the system, grouped by sourceType, plus the union of
 *  NuGet deps they need (id → version).  Only the new infra kinds
 *  (objectStore / queue / api) are emitted; persistence resources are
 *  ignored here.  Returns empty when the system wires none. */
export function emitDotnetResourceFiles(
  sys: { dataSources: readonly DataSourceIR[]; storages: readonly StorageIR[] } | undefined,
  ns: string,
): { files: Map<string, string>; nugetDeps: Record<string, string> } {
  const files = new Map<string, string>();
  const nugetDeps: Record<string, string> = {};
  if (!sys) return { files, nugetDeps };
  const storeType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  const bySourceType = new Map<string, DataSourceIR[]>();
  for (const r of sys.dataSources) {
    if (r.kind !== "objectStore" && r.kind !== "queue" && r.kind !== "api" && r.kind !== "mailer")
      continue;
    const st = storeType.get(r.storageName);
    if (!st || !dotnetResourceAdapterFor(st)) continue;
    const group = bySourceType.get(st);
    if (group) group.push(r);
    else bySourceType.set(st, [r]);
  }
  for (const [sourceType, group] of bySourceType) {
    const adapter = dotnetResourceAdapterFor(sourceType)!;
    files.set(
      `Resources/${resourceClassName(sourceType)}.cs`,
      adapter.emitClientClass(group, sys.storages, ns),
    );
    Object.assign(nugetDeps, adapter.nugetDeps());
  }
  return { files, nugetDeps };
}
