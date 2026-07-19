// Phoenix ResourceAdapter — Elixir helper modules for the non-persistence
// infrastructure kinds (objectStore / queue / api).  Sibling of the hono
// and .NET resource-clients adapters; emits one module per sourceType at
// `lib/<app>/resources/<source_type>.ex`, with one function per
// (resource, verb) the deployable's workflows use.  render-expr's
// resource-op case calls `<Module>.<resource>_<verb>(args)`.
//
// 4c-Phoenix parity: same closed verb vocabulary, vendor-neutral source
// → Elixir emission.  S3 via :ex_aws_s3, queue via :amqp, api via :req.

import type { DataSourceIR, StorageIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { supportsSurfaceKind } from "../../../util/source-types.js";

export interface PhoenixResourceAdapter {
  readonly name: string;
  /** Hex deps (name → `mix.exs` version string) merged into `deps/0`. */
  hexDeps(): Record<string, string>;
  /** A full Elixir helper module for the resources of this kind. */
  emitClientModule(
    resources: readonly DataSourceIR[],
    stores: readonly StorageIR[],
    appModule: string,
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

/** Fully-qualified Elixir module for a sourceType's helpers, e.g.
 *  `MyApp.Resources.S3`. */
export function resourceModuleName(appModule: string, sourceType: string): string {
  return `${appModule}.Resources.${upperFirst(sourceType)}`;
}

const s3PhoenixAdapter: PhoenixResourceAdapter = {
  name: "s3",
  hexDeps: () => ({ ex_aws: '"~> 2.5"', ex_aws_s3: '"~> 2.5"', hackney: '"~> 1.20"' }),
  emitClientModule(resources, stores, appModule): string {
    const lines: string[] = [
      "# Auto-generated.",
      `defmodule ${resourceModuleName(appModule, "s3")} do`,
    ];
    for (const r of resources) {
      const bucket = cfg(storeOf(r, stores), "bucket") ?? "";
      const fn = snake(r.name);
      lines.push(
        `  @${fn}_bucket System.get_env("${envVar(r.name)}_BUCKET") || ${JSON.stringify(bucket)}`,
        "",
        `  def ${fn}_put(key, body) do`,
        `    ExAws.S3.put_object(@${fn}_bucket, key, body, content_type: "application/json")`,
        "    |> ExAws.request!()",
        "    :ok",
        "  end",
        "",
        `  def ${fn}_get(key) do`,
        `    case ExAws.S3.get_object(@${fn}_bucket, key) |> ExAws.request() do`,
        "      {:ok, %{body: body}} -> body",
        "      {:error, _} -> nil",
        "    end",
        "  end",
        "",
        `  def ${fn}_list(prefix) do`,
        `    ExAws.S3.list_objects_v2(@${fn}_bucket, prefix: prefix)`,
        "    |> ExAws.request!()",
        "    |> get_in([:body, :contents])",
        "    |> Enum.map(& &1.key)",
        "  end",
        "",
        `  def ${fn}_signed_url(key) do`,
        "    {:ok, url} =",
        "      ExAws.Config.new(:s3)",
        `      |> ExAws.S3.presigned_url(:get, @${fn}_bucket, key, expires_in: 3600)`,
        "    url",
        "  end",
        "",
        `  def ${fn}_delete(key) do`,
        `    ExAws.S3.delete_object(@${fn}_bucket, key) |> ExAws.request!()`,
        "    :ok",
        "  end",
        "",
      );
    }
    lines.push("end", "");
    return lines.join("\n");
  },
};

const rabbitmqPhoenixAdapter: PhoenixResourceAdapter = {
  name: "rabbitmq",
  hexDeps: () => ({ amqp: '"~> 4.0"' }),
  emitClientModule(resources, _stores, appModule): string {
    const lines: string[] = [
      "# Auto-generated.",
      `defmodule ${resourceModuleName(appModule, "rabbitmq")} do`,
    ];
    for (const r of resources) {
      const fn = snake(r.name);
      lines.push(
        `  @${fn}_url System.get_env("${envVar(r.name)}") || "amqp://guest:guest@${r.name}:5672"`,
        "",
        `  defp ${fn}_channel do`,
        `    {:ok, conn} = AMQP.Connection.open(@${fn}_url)`,
        "    {:ok, chan} = AMQP.Channel.open(conn)",
        "    chan",
        "  end",
        "",
        `  def ${fn}_enqueue(message) do`,
        `    chan = ${fn}_channel()`,
        `    AMQP.Queue.declare(chan, "${r.name}", durable: true)`,
        `    AMQP.Basic.publish(chan, "", "${r.name}", message, persistent: true)`,
        "    :ok",
        "  end",
        "",
        `  def ${fn}_publish(topic, message) do`,
        `    chan = ${fn}_channel()`,
        `    AMQP.Exchange.declare(chan, "${r.name}", :topic, durable: true)`,
        `    AMQP.Basic.publish(chan, "${r.name}", topic, message, persistent: true)`,
        "    :ok",
        "  end",
        "",
      );
    }
    lines.push("end", "");
    return lines.join("\n");
  },
};

const restApiPhoenixAdapter: PhoenixResourceAdapter = {
  name: "restApi",
  hexDeps: () => ({ req: '"~> 0.5"' }),
  emitClientModule(resources, stores, appModule): string {
    const lines: string[] = [
      "# Auto-generated.",
      `defmodule ${resourceModuleName(appModule, "restApi")} do`,
    ];
    for (const r of resources) {
      const baseUrl = cfg(storeOf(r, stores), "baseUrl") ?? "";
      const fn = snake(r.name);
      lines.push(
        `  @${fn}_base_url System.get_env("${envVar(r.name)}") || ${JSON.stringify(baseUrl)}`,
        "",
        `  def ${fn}_get(path) do`,
        `    Req.get!(@${fn}_base_url <> path).body`,
        "  end",
        "",
        `  def ${fn}_post(path, body) do`,
        `    Req.post!(@${fn}_base_url <> path, json: body).body`,
        "  end",
        "",
      );
    }
    lines.push("end", "");
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

/** Shared prelude for a Swoosh mailer module: `import Swoosh.Email` and,
 *  per resource, the `@<fn>_from` attribute + a `<fn>_email/3` builder. */
function mailerEmailBuilders(
  resources: readonly DataSourceIR[],
  stores: readonly StorageIR[],
): string[] {
  return resources.flatMap((r) => {
    const fn = snake(r.name);
    return [
      `  @${fn}_from System.get_env("${envStem(r.name)}_FROM") || ${JSON.stringify(mailFrom(r, stores))}`,
      "",
      `  defp ${fn}_email(to, subject, body) do`,
      "    Swoosh.Email.new()",
      `    |> Swoosh.Email.from(@${fn}_from)`,
      "    |> Swoosh.Email.to(to)",
      "    |> Swoosh.Email.subject(subject)",
      "    |> Swoosh.Email.text_body(body)",
      "  end",
      "",
    ];
  });
}

const smtpPhoenixAdapter: PhoenixResourceAdapter = {
  name: "smtp",
  hexDeps: () => ({ swoosh: '"~> 1.17"', gen_smtp: '"~> 1.2"' }),
  emitClientModule(resources, stores, appModule): string {
    const lines: string[] = [
      "# Auto-generated.",
      `defmodule ${resourceModuleName(appModule, "smtp")} do`,
      ...mailerEmailBuilders(resources, stores),
    ];
    for (const r of resources) {
      const fn = snake(r.name);
      lines.push(
        `  def ${fn}_send(to, subject, body) do`,
        `    # Read MAIL_URL at RUNTIME (not a compile-time @attribute): the URL`,
        `    # carries per-environment credentials that aren't set when the module`,
        `    # is compiled.`,
        `    uri = URI.parse(System.get_env("${envVar(r.name)}") || "smtp://localhost:1025")`,
        "    base = [relay: uri.host, port: uri.port || 25]",
        "",
        "    opts =",
        "      case uri.userinfo do",
        "        nil ->",
        "          base ++ [auth: :never]",
        "",
        "        info ->",
        "          # Credentials in the connection URL (user:pass@host) → authenticate.",
        "          {user, pass} =",
        '            case String.split(info, ":", parts: 2) do',
        "              [u, p] -> {URI.decode_www_form(u), URI.decode_www_form(p)}",
        '              [u] -> {URI.decode_www_form(u), ""}',
        "            end",
        "",
        "          base ++",
        "            [",
        "              username: user,",
        "              password: pass,",
        "              auth: :always,",
        '              ssl: uri.scheme == "smtps",',
        '              tls: if(uri.scheme == "smtps", do: :never, else: :if_available)',
        "            ]",
        "      end",
        "",
        `    Swoosh.Adapters.SMTP.deliver(${fn}_email(to, subject, body), opts)`,
        "",
        "    :ok",
        "  end",
        "",
      );
    }
    lines.push("end", "");
    return lines.join("\n");
  },
};

const sesPhoenixAdapter: PhoenixResourceAdapter = {
  name: "ses",
  hexDeps: () => ({ swoosh: '"~> 1.17"', hackney: '"~> 1.20"' }),
  emitClientModule(resources, stores, appModule): string {
    const lines: string[] = [
      "# Auto-generated.",
      `defmodule ${resourceModuleName(appModule, "ses")} do`,
      ...mailerEmailBuilders(resources, stores),
    ];
    for (const r of resources) {
      const fn = snake(r.name);
      const region = cfg(storeOf(r, stores), "region") ?? "us-east-1";
      lines.push(
        `  @${fn}_region System.get_env("${envStem(r.name)}_REGION") || ${JSON.stringify(region)}`,
        "",
        `  def ${fn}_send(to, subject, body) do`,
        `    Swoosh.Adapters.AmazonSES.deliver(${fn}_email(to, subject, body),`,
        `      region: @${fn}_region,`,
        '      access_key: System.get_env("AWS_ACCESS_KEY_ID"),',
        '      secret: System.get_env("AWS_SECRET_ACCESS_KEY")',
        "    )",
        "",
        "    :ok",
        "  end",
        "",
      );
    }
    lines.push("end", "");
    return lines.join("\n");
  },
};

const sendgridPhoenixAdapter: PhoenixResourceAdapter = {
  name: "sendgrid",
  hexDeps: () => ({ swoosh: '"~> 1.17"', hackney: '"~> 1.20"' }),
  emitClientModule(resources, stores, appModule): string {
    const lines: string[] = [
      "# Auto-generated.",
      `defmodule ${resourceModuleName(appModule, "sendgrid")} do`,
      ...mailerEmailBuilders(resources, stores),
    ];
    for (const r of resources) {
      const fn = snake(r.name);
      lines.push(
        `  def ${fn}_send(to, subject, body) do`,
        `    Swoosh.Adapters.Sendgrid.deliver(${fn}_email(to, subject, body),`,
        '      api_key: System.get_env("SENDGRID_API_KEY")',
        "    )",
        "",
        "    :ok",
        "  end",
        "",
      );
    }
    lines.push("end", "");
    return lines.join("\n");
  },
};

const ADAPTERS: readonly PhoenixResourceAdapter[] = [
  s3PhoenixAdapter,
  rabbitmqPhoenixAdapter,
  restApiPhoenixAdapter,
  smtpPhoenixAdapter,
  sesPhoenixAdapter,
  sendgridPhoenixAdapter,
];

export function phoenixResourceAdapterFor(sourceType: string): PhoenixResourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === sourceType);
}

/** Emit `lib/<app>/resources/<source_type>.ex` modules + the union of
 *  Hex deps for every consumable resource in the system.  Empty when the
 *  deployable wires none. */
export function emitPhoenixResourceFiles(
  sys: { dataSources: readonly DataSourceIR[]; storages: readonly StorageIR[] } | undefined,
  appName: string,
  appModule: string,
): { files: Map<string, string>; hexDeps: Record<string, string> } {
  const files = new Map<string, string>();
  const hexDeps: Record<string, string> = {};
  if (!sys) return { files, hexDeps };
  const storeType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  const bySourceType = new Map<string, DataSourceIR[]>();
  for (const r of sys.dataSources) {
    if (r.kind !== "objectStore" && r.kind !== "queue" && r.kind !== "api" && r.kind !== "mailer")
      continue;
    const st = storeType.get(r.storageName);
    if (!st || !phoenixResourceAdapterFor(st)) continue;
    const group = bySourceType.get(st);
    if (group) group.push(r);
    else bySourceType.set(st, [r]);
  }
  for (const [sourceType, group] of bySourceType) {
    const adapter = phoenixResourceAdapterFor(sourceType)!;
    files.set(
      `lib/${appName}/resources/${snake(sourceType)}.ex`,
      adapter.emitClientModule(group, sys.storages, appModule),
    );
    Object.assign(hexDeps, adapter.hexDeps());
  }
  return { files, hexDeps };
}

/** resourceName → fully-qualified helper module, for routing resource-op
 *  call sites in workflow bodies. */
export function buildPhoenixResourceModules(
  sys: { dataSources: readonly DataSourceIR[]; storages: readonly StorageIR[] } | undefined,
  appModule: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!sys) return out;
  const storeType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const r of sys.dataSources) {
    const st = storeType.get(r.storageName);
    if (st && phoenixResourceAdapterFor(st)) {
      out.set(r.name, resourceModuleName(appModule, st));
    }
  }
  return out;
}

/** Does any Phoenix adapter realize `(sourceType, kind)`? */
export function phoenixSupportsResource(sourceType: string, kind: DataSourceIR["kind"]): boolean {
  return !!phoenixResourceAdapterFor(sourceType) && supportsSurfaceKind(sourceType, kind);
}
