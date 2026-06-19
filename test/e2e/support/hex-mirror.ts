import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// LOOM_HEX_MIRROR — run the Dockerised Elixir/Phoenix e2e suites behind an
// egress proxy that allowlists by TLS fingerprint.
//
// Such proxies accept the system OpenSSL fingerprint (curl / .NET / Gradle /
// Python's stdlib `ssl`) but reject Erlang/OTP's `:ssl` with a bare HTTP 503,
// so `mix local.hex` / `mix deps.get` can't reach hex.pm from inside the
// container.  `scripts/hex-mirror.py` is a loopback TLS-terminating mirror
// that re-originates hex.pm traffic with Python's stdlib `ssl` (the accepted
// fingerprint); this helper starts it and produces the `docker run` glue.
//
// Opt-in: when `LOOM_HEX_MIRROR=1`, `startHexMirror()` generates a throwaway
// CA + `*.hex.pm` cert, launches the mirror on :443, and returns the docker
// args (`--network host`, `--add-host {builds,repo,hex}.hex.pm:127.0.0.1`, CA
// mount) plus a shell prefix that refreshes the in-container CA store.  Unset
// (the default, and every CI runner with direct hex.pm access) → no-op.
//
// Requires python3 + openssl on PATH and the privilege to bind :443 (Hex
// always talks to hex.pm on 443 and `--add-host` cannot rewrite the port).
// See docs/tools.md → "Compiling generated backends in Docker".
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const mirrorScript = path.join(repoRoot, "scripts", "hex-mirror.py");

/** hex.pm hostnames the container must resolve to the loopback mirror. */
const HEX_HOSTS = ["builds.hex.pm", "repo.hex.pm", "hex.pm"];
const MIRROR_PORT = 443;

export interface HexMirror {
  /** `docker run` args to splice in (host network + hex.pm overrides + CA mount). */
  dockerArgs: string[];
  /** Shell snippet to prepend inside `bash -c` so the container trusts the mirror CA. */
  shellPrefix: string;
  /** Stop the mirror and remove its temp dir. Safe to call more than once. */
  stop(): void;
}

export function hexMirrorEnabled(): boolean {
  return process.env.LOOM_HEX_MIRROR === "1";
}

/**
 * Start the hex mirror when `LOOM_HEX_MIRROR=1`, otherwise return `undefined`
 * (the caller then runs docker exactly as before — direct hex.pm access).
 */
export async function startHexMirror(): Promise<HexMirror | undefined> {
  if (!hexMirrorEnabled()) return undefined;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-hex-mirror-"));
  const caCert = path.join(dir, "ca.crt");
  const fullchain = path.join(dir, "fullchain.crt");
  const srvKey = path.join(dir, "srv.key");
  generateCerts(dir, caCert, fullchain, srvKey);

  const child = spawn("python3", [mirrorScript], {
    env: { ...process.env, CERT: fullchain, KEY: srvKey, PORT: String(MIRROR_PORT) },
    stdio: ["ignore", "inherit", "pipe"],
  });

  await waitForListen(child);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };

  return {
    dockerArgs: [
      "--network",
      "host",
      ...HEX_HOSTS.flatMap((h) => ["--add-host", `${h}:127.0.0.1`]),
      "-v",
      `${caCert}:/usr/local/share/ca-certificates/loom-hex-mirror.crt:ro`,
    ],
    // Refresh the OS trust store (now carrying the mirror CA) AND point Hex at
    // it — `mix deps.get` uses Hex's own CA bundle, not the OS store, so
    // without HEX_CACERTS_PATH it rejects the mirror cert with "Unknown CA".
    shellPrefix:
      "update-ca-certificates >/dev/null 2>&1 && " +
      "export HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt && ",
    stop,
  };
}

function generateCerts(dir: string, caCert: string, fullchain: string, srvKey: string): void {
  const caKey = path.join(dir, "ca.key");
  const csr = path.join(dir, "srv.csr");
  const srvCert = path.join(dir, "srv.crt");
  const ext = path.join(dir, "san.cnf");
  fs.writeFileSync(
    ext,
    `[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=${HEX_HOSTS.map(
      (h) => `DNS:${h}`,
    ).join(",")},DNS:*.hex.pm\n`,
  );

  const ssl = (args: string[]) => {
    const r = spawnSync("openssl", args, { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`openssl ${args[0]} failed: ${r.stderr ?? ""}`);
    }
  };

  ssl(["genrsa", "-out", caKey, "2048"]);
  ssl([
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    caKey,
    "-sha256",
    "-days",
    "30",
    "-subj",
    "/CN=Loom Local Hex CA",
    "-out",
    caCert,
  ]);
  ssl(["genrsa", "-out", srvKey, "2048"]);
  ssl(["req", "-new", "-key", srvKey, "-subj", "/CN=hex.pm", "-out", csr]);
  ssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    srvCert,
    "-days",
    "30",
    "-sha256",
    "-extfile",
    ext,
    "-extensions",
    "v3",
  ]);

  fs.writeFileSync(fullchain, fs.readFileSync(srvCert) + fs.readFileSync(caCert));
}

function waitForListen(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("hex-mirror did not start within 15s")),
      15_000,
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      if (chunk.toString().includes("hex-mirror listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`hex-mirror exited early (code ${code})`));
    });
  });
}
