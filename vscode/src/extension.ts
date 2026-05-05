import * as path from "node:path";
import {
  workspace,
  type ExtensionContext,
  commands,
  window,
} from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  // The LSP server lives at <ext>/server/language/main.js — copied at
  // build time from ../../out/language/main.js (the parent project's
  // tsc output).  Resolving via context.asAbsolutePath keeps the path
  // stable across dev (loaded from source) and packaged (loaded from
  // the .vsix's installed location) modes.
  const serverModule = context.asAbsolutePath(
    path.join("server", "language", "main.js"),
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "ddd" }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.ddd"),
    },
  };

  client = new LanguageClient(
    "loom-ddd",
    "Loom DDD",
    serverOptions,
    clientOptions,
  );
  client.start();

  context.subscriptions.push(
    commands.registerCommand("loom.generate", () => generateCurrentFile(context)),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

// ---------------------------------------------------------------------------
// "Loom: Generate from current file" command — runs the bundled CLI
// against the active editor's file.  Output streams to a dedicated
// OutputChannel so the user can see what was written.
// ---------------------------------------------------------------------------

const LAST_OUTDIR_KEY = "loom.lastOutDir";

async function generateCurrentFile(context: ExtensionContext): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor || editor.document.languageId !== "ddd") {
    window.showErrorMessage("Loom: open a .ddd file first.");
    return;
  }
  const filePath = editor.document.uri.fsPath;
  const defaultOutDir =
    context.globalState.get<string>(LAST_OUTDIR_KEY) ??
    path.join(path.dirname(filePath), "generated");
  const outDir = await window.showInputBox({
    prompt: "Output directory for generated code",
    value: defaultOutDir,
  });
  if (!outDir) return;
  await context.globalState.update(LAST_OUTDIR_KEY, outDir);

  // The CLI binary ships at <ext>/server/cli.js (copied alongside the
  // language server by the build script).
  const cliPath = context.asAbsolutePath(path.join("server", "cli.js"));
  const channel = window.createOutputChannel("Loom");
  channel.show(true);
  channel.appendLine(`> ddd generate system ${filePath} -o ${outDir}`);

  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [cliPath, "generate", "system", filePath, "-o", outDir],
    { cwd: path.dirname(filePath) },
  );
  child.stdout.on("data", (b: Buffer) => channel.append(b.toString()));
  child.stderr.on("data", (b: Buffer) => channel.append(b.toString()));
  child.on("close", (code) => {
    channel.appendLine(`\n> exited with code ${code ?? 0}`);
  });
  child.on("error", (err) => {
    window.showErrorMessage(`Loom: failed to launch CLI — ${err.message}`);
  });
}
