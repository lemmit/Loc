import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${cli} ${args.join(" ")}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loom-new-"));
}

const platforms = ["node", "dotnet", "elixir", "java"] as const;
const templates = ["blank", "crud"] as const;
const backendPort: Record<string, number> = { node: 3000, dotnet: 8080, elixir: 4000, java: 8081 };

describe("ddd new — scaffold matrix", () => {
  for (const platform of platforms) {
    for (const template of templates) {
      it(`scaffolds + validates ${platform}/${template}`, () => {
        const tmp = tmpdir();
        const out = path.join(tmp, "proj");
        const r = runCli([
          "new",
          "myApp",
          "-o",
          out,
          "--platform",
          platform,
          "--template",
          template,
        ]);
        expect(r.status).toBe(0);

        // The three starter files exist.
        const ddd = path.join(out, "main.ddd");
        expect(fs.existsSync(ddd)).toBe(true);
        expect(fs.existsSync(path.join(out, "README.md"))).toBe(true);
        expect(fs.existsSync(path.join(out, ".loomignore"))).toBe(true);

        // The model wires to the chosen backend + port.
        const src = fs.readFileSync(ddd, "utf8");
        expect(src).toContain(`platform: ${platform}`);
        expect(src).toContain(`port: ${backendPort[platform]}`);

        // Drift guard: the scaffolded model must pass full generation.
        const gen = runCli(["generate", "system", ddd, "--json"]);
        expect(gen.status).toBe(0);
        const report = JSON.parse(gen.stdout) as {
          ok: boolean;
          deployables: { name: string; platform: string; port: number }[];
        };
        expect(report.ok).toBe(true);
        expect(report.deployables.some((d) => d.platform === platform)).toBe(true);

        fs.rmSync(tmp, { recursive: true });
      });
    }
  }
});

describe("ddd new — platform/frontend wiring", () => {
  it("node scaffolds a separate React frontend (default mantine)", () => {
    const tmp = tmpdir();
    const out = path.join(tmp, "p");
    runCli(["new", "app", "-o", out]); // node is the default platform
    const src = fs.readFileSync(path.join(out, "main.ddd"), "utf8");
    expect(src).toContain("platform: react");
    expect(src).toContain("design: mantine");
    fs.rmSync(tmp, { recursive: true });
  });

  it("elixir defaults to a LiveView fullstack (daisyui, no react deployable)", () => {
    const tmp = tmpdir();
    const out = path.join(tmp, "p");
    runCli(["new", "app", "-o", out, "--platform", "elixir"]);
    const src = fs.readFileSync(path.join(out, "main.ddd"), "utf8");
    expect(src).toContain("design: daisyui");
    expect(src).not.toContain("platform: react");
    fs.rmSync(tmp, { recursive: true });
  });

  it("elixir + a React pack scaffolds backend + React frontend", () => {
    const tmp = tmpdir();
    const out = path.join(tmp, "p");
    runCli(["new", "app", "-o", out, "--platform", "elixir", "--design", "shadcn"]);
    const src = fs.readFileSync(path.join(out, "main.ddd"), "utf8");
    expect(src).toContain("platform: elixir");
    expect(src).toContain("platform: react");
    expect(src).toContain("design: shadcn");
    fs.rmSync(tmp, { recursive: true });
  });

  it("a vue pack scaffolds a `platform: vue` frontend (design implies platform)", () => {
    const tmp = tmpdir();
    const out = path.join(tmp, "p");
    runCli(["new", "app", "-o", out, "--design", "vuetify"]);
    const src = fs.readFileSync(path.join(out, "main.ddd"), "utf8");
    expect(src).toContain("platform: vue");
    expect(src).toContain("design: vuetify");
    expect(src).toContain("port: 3003");
    expect(src).not.toContain("platform: react");
    fs.rmSync(tmp, { recursive: true });
  });

  it("shadcnVue scaffolds a vue frontend on a dotnet backend", () => {
    const tmp = tmpdir();
    const out = path.join(tmp, "p");
    runCli(["new", "app", "-o", out, "--platform", "dotnet", "--design", "shadcnVue"]);
    const src = fs.readFileSync(path.join(out, "main.ddd"), "utf8");
    expect(src).toContain("platform: dotnet");
    expect(src).toContain("platform: vue");
    expect(src).toContain("design: shadcnVue");
    fs.rmSync(tmp, { recursive: true });
  });
});

describe("ddd new — guards and ergonomics", () => {
  it("prints the platform hint when --platform is defaulted", () => {
    const tmp = tmpdir();
    const r = runCli(["new", "app", "-o", path.join(tmp, "p")]);
    expect(r.stdout).toContain("platform: node (default)");
    fs.rmSync(tmp, { recursive: true });
  });

  it("rejects --design daisyui with a non-elixir platform", () => {
    const tmp = tmpdir();
    const r = runCli([
      "new",
      "app",
      "-o",
      path.join(tmp, "p"),
      "--platform",
      "node",
      "--design",
      "daisyui",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("daisyui requires --platform elixir");
    expect(fs.existsSync(path.join(tmp, "p"))).toBe(false);
    fs.rmSync(tmp, { recursive: true });
  });

  it("rejects an unknown platform", () => {
    const tmp = tmpdir();
    const r = runCli(["new", "app", "-o", path.join(tmp, "p"), "--platform", "rust"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown --platform "rust"');
    fs.rmSync(tmp, { recursive: true });
  });

  it("refuses a non-empty directory without --force, then accepts it with --force", () => {
    const tmp = tmpdir();
    const out = path.join(tmp, "p");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "keep.txt"), "x", "utf8");

    const refused = runCli(["new", "app", "-o", out]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("directory not empty");
    expect(fs.existsSync(path.join(out, "main.ddd"))).toBe(false);

    const forced = runCli(["new", "app", "-o", out, "--force"]);
    expect(forced.status).toBe(0);
    expect(fs.existsSync(path.join(out, "main.ddd"))).toBe(true);
    expect(fs.existsSync(path.join(out, "keep.txt"))).toBe(true); // pre-existing file untouched
    fs.rmSync(tmp, { recursive: true });
  });
});
