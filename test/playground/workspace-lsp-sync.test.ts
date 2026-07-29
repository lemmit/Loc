import { describe, expect, it } from "vitest";
import type { LspModelHost, SyncedModel } from "../../web/src/lsp/model-host.js";
import { modelUriFor, syncWorkspaceToLsp } from "../../web/src/lsp/workspace-lsp-sync.js";
import type {
  WorkspaceSourcesController,
  WorkspaceSourcesSnapshot,
} from "../../web/src/workspace/workspace-sources.js";

// ---------------------------------------------------------------------------
// `syncWorkspaceToLsp` — the workspace → Monaco-model sync that gives the
// Langium worker its view of every `.ddd` file, not just the edited one.
//
// The correctness-critical half is model LIFETIME: a model that outlives its
// deleted file keeps the file's declarations in the LSP's global scope, so
// re-adding the same declarations under a new name yields duplicate-symbol
// errors — and any error count suppresses the playground's auto-generate.
// Before adoption, models the EDITOR had created (for whatever file happened
// to be active at the time) were updated by the sync but never owned by it,
// so the delete pass silently skipped them.
//
// Monaco is DOM-only, so the sync talks to the narrow `LspModelHost` seam
// (`web/src/lsp/model-host.ts`) and this suite passes a fake registry — the
// same shape of substitution `legacy-idb.test.ts` makes for IndexedDB.
// ---------------------------------------------------------------------------

class FakeModel implements SyncedModel {
  disposed = false;
  constructor(
    readonly uri: string,
    private value: string,
    private readonly host: FakeHost,
  ) {}
  getValue(): string {
    return this.value;
  }
  setValue(v: string): void {
    if (this.disposed) throw new Error(`setValue on disposed model ${this.uri}`);
    this.value = v;
  }
  dispose(): void {
    this.disposed = true;
    // Monaco drops a disposed model from the registry — mirror that, or a
    // later `getModel` would hand the sync a corpse.
    this.host.models.delete(this.uri);
  }
}

class FakeHost implements LspModelHost {
  readonly models = new Map<string, FakeModel>();
  /** Every model ever created here, disposed ones included. */
  readonly created: FakeModel[] = [];
  getModel(uri: string): SyncedModel | null {
    return this.models.get(uri) ?? null;
  }
  createModel(content: string, uri: string): SyncedModel {
    const m = new FakeModel(uri, content, this);
    this.models.set(uri, m);
    this.created.push(m);
    return m;
  }
  /** Stand in for `LoomEditor`, which creates the active file's model
   *  itself and deliberately keeps it alive across its own remounts. */
  editorCreates(path: string, content: string): FakeModel {
    return this.createModel(content, modelUriFor(path)) as FakeModel;
  }
  find(path: string): FakeModel | undefined {
    return this.created.find((m) => m.uri === modelUriFor(path));
  }
  live(): string[] {
    return [...this.models.keys()].sort();
  }
}

/** Minimal stand-in for `WorkspaceSourcesController`: the sync only reads
 *  `snapshot()` and `subscribe()`. Mutators here mimic the real controller's
 *  emit sequence, which is what the active-file cases hinge on. */
class FakeController {
  readonly files = new Map<string, string>();
  activePath = "/workspace/main.ddd";
  private readonly listeners = new Set<(s: WorkspaceSourcesSnapshot) => void>();

  snapshot(): WorkspaceSourcesSnapshot {
    // The sync reads only `files` / `activePath`; the rest are filled to
    // satisfy the snapshot shape.
    return {
      files: this.files,
      emptyFolders: new Set<string>(),
      activePath: this.activePath,
      epoch: 0,
      hydrated: true,
      persistent: true,
      lastError: null,
    };
  }
  subscribe(l: (s: WorkspaceSourcesSnapshot) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  emit(): void {
    const snap = this.snapshot();
    for (const l of [...this.listeners]) l(snap);
  }
  write(path: string, content: string): void {
    this.files.set(path, content);
    this.emit();
  }
  /** Mirrors `WorkspaceSourcesController.delete`: drop the file and emit,
   *  then — if it was the active one — re-point `activePath` to the fallback
   *  and emit a second time. */
  delete(path: string, fallback?: string): void {
    const wasActive = this.activePath === path;
    this.files.delete(path);
    this.emit();
    if (wasActive) {
      const next = fallback ?? [...this.files.keys()].sort()[0] ?? "/workspace/main.ddd";
      if (next !== this.activePath) {
        this.activePath = next;
        this.emit();
      }
    }
  }
  setActivePath(path: string): void {
    if (this.activePath === path) return;
    this.activePath = path;
    this.emit();
  }
  as(): WorkspaceSourcesController {
    return this as unknown as WorkspaceSourcesController;
  }
}

function start(ctrl: FakeController, host: FakeHost): () => void {
  return syncWorkspaceToLsp(ctrl.as(), { getActivePath: () => ctrl.activePath, host });
}

describe("modelUriFor", () => {
  it("maps a workspace path to the `inmemory:///` URI LoomEditor also uses", () => {
    expect(modelUriFor("/workspace/main.ddd")).toBe("inmemory:///workspace/main.ddd");
    expect(modelUriFor("/workspace/shared/money.ddd")).toBe(
      "inmemory:///workspace/shared/money.ddd",
    );
  });
});

describe("syncWorkspaceToLsp — seeding and content", () => {
  it("creates a model per inactive file and leaves the active file to the editor", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.files.set("/workspace/main.ddd", "main v1");
    ctrl.files.set("/workspace/shared/money.ddd", "money v1");
    start(ctrl, host);

    expect(host.live()).toEqual(["inmemory:///workspace/shared/money.ddd"]);
    expect(host.find("/workspace/shared/money.ddd")?.getValue()).toBe("money v1");
  });

  it("pushes VFS content into inactive models but never writes the active one", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    const editorModel = host.editorCreates("/workspace/main.ddd", "editor buffer");
    ctrl.files.set("/workspace/main.ddd", "stale on disk");
    ctrl.files.set("/workspace/shared/money.ddd", "money v1");
    start(ctrl, host);
    ctrl.write("/workspace/shared/money.ddd", "money v2");

    expect(host.find("/workspace/shared/money.ddd")?.getValue()).toBe("money v2");
    expect(editorModel.getValue()).toBe("editor buffer");
  });
});

describe("syncWorkspaceToLsp — delete disposes models", () => {
  it("disposes a model it created when the file leaves the workspace", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "money");
    start(ctrl, host);
    const owned = host.find("/workspace/shared/money.ddd");

    ctrl.delete("/workspace/shared/money.ddd");

    expect(owned?.disposed).toBe(true);
    expect(host.live()).toEqual([]);
  });

  it("ADOPTS a pre-existing model and disposes it on delete (defect #11)", () => {
    // The editor created `shared/money.ddd`'s model while that file was the
    // active one; the user then switched back to main.ddd. The sync must take
    // over the model it merely found, or the delete below leaves the file's
    // declarations in the LSP forever.
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.activePath = "/workspace/shared/money.ddd";
    const editorModel = host.editorCreates("/workspace/shared/money.ddd", "money");
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "money");
    start(ctrl, host);
    ctrl.setActivePath("/workspace/main.ddd"); // switch away — sync adopts it

    ctrl.delete("/workspace/shared/money.ddd");

    expect(editorModel.disposed).toBe(true);
    expect(host.live()).toEqual(["inmemory:///workspace/main.ddd"]);
  });

  it("re-adding the deleted declarations under a new name reuses no stale model", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.activePath = "/workspace/shared/money.ddd";
    host.editorCreates("/workspace/shared/money.ddd", "valueobject Money {}");
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "valueobject Money {}");
    start(ctrl, host);
    ctrl.setActivePath("/workspace/main.ddd");
    ctrl.delete("/workspace/shared/money.ddd");
    ctrl.write("/workspace/shared/cash.ddd", "valueobject Money {}");

    // Only the renamed file is live — the old one no longer contributes a
    // duplicate `Money` to Langium's global scope.
    expect(host.live()).toEqual([
      "inmemory:///workspace/main.ddd",
      "inmemory:///workspace/shared/cash.ddd",
    ]);
  });
});

describe("syncWorkspaceToLsp — the active file's model", () => {
  it("does not dispose the model while the editor is still showing it", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.activePath = "/workspace/shared/money.ddd";
    const editorModel = host.editorCreates("/workspace/shared/money.ddd", "money");
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "money");
    start(ctrl, host);

    // First emit of `controller.delete`: file gone, activePath not yet moved.
    ctrl.files.delete("/workspace/shared/money.ddd");
    ctrl.emit();
    expect(editorModel.disposed).toBe(false);

    // Second emit: activePath re-pointed to the fallback → parked model drains.
    ctrl.activePath = "/workspace/main.ddd";
    ctrl.emit();
    expect(editorModel.disposed).toBe(true);
  });

  it("disposes the active file's model across the real two-emit delete", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.activePath = "/workspace/shared/money.ddd";
    const editorModel = host.editorCreates("/workspace/shared/money.ddd", "money");
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "money");
    start(ctrl, host);

    ctrl.delete("/workspace/shared/money.ddd");

    expect(editorModel.disposed).toBe(true);
    expect(ctrl.activePath).toBe("/workspace/main.ddd");
  });

  it("keeps the model when the deleted file stays active (last file standing)", () => {
    // Deleting the only file leaves `activePath` on the fallback, which IS
    // the deleted path — the editor is still displaying that buffer, so
    // disposing it would blank the editor with no remount to recover.
    const ctrl = new FakeController();
    const host = new FakeHost();
    const editorModel = host.editorCreates("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/main.ddd", "main");
    start(ctrl, host);

    ctrl.delete("/workspace/main.ddd");

    expect(editorModel.disposed).toBe(false);
    expect(host.live()).toEqual(["inmemory:///workspace/main.ddd"]);
  });

  it("un-parks the model when the file comes back before it drains", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    const editorModel = host.editorCreates("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/main.ddd", "main");
    start(ctrl, host);
    ctrl.delete("/workspace/main.ddd"); // parks it (still active)

    ctrl.write("/workspace/main.ddd", "main again");

    expect(editorModel.disposed).toBe(false);
    expect(host.created.filter((m) => m.uri === modelUriFor("/workspace/main.ddd"))).toHaveLength(
      1,
    );
  });
});

describe("syncWorkspaceToLsp — rename", () => {
  it("disposes the old path's model and creates the new one (write + delete)", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "money");
    start(ctrl, host);
    const oldModel = host.find("/workspace/shared/money.ddd");

    // `App.renameSourceFile`: write(new) then delete(old).
    ctrl.write("/workspace/shared/cash.ddd", "money");
    ctrl.delete("/workspace/shared/money.ddd");

    expect(oldModel?.disposed).toBe(true);
    expect(host.live()).toEqual(["inmemory:///workspace/shared/cash.ddd"]);
    expect(host.find("/workspace/shared/cash.ddd")?.getValue()).toBe("money");
  });

  it("follows the active file across a rename of the file being edited", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    ctrl.activePath = "/workspace/shared/money.ddd";
    const editorModel = host.editorCreates("/workspace/shared/money.ddd", "money");
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "money");
    start(ctrl, host);

    ctrl.write("/workspace/shared/cash.ddd", "money");
    ctrl.delete("/workspace/shared/money.ddd");
    ctrl.setActivePath("/workspace/shared/cash.ddd");

    expect(editorModel.disposed).toBe(true);
    expect(host.live()).toEqual([
      "inmemory:///workspace/main.ddd",
      "inmemory:///workspace/shared/cash.ddd",
    ]);
  });
});

describe("syncWorkspaceToLsp — teardown", () => {
  it("disposes tracked models but leaves the one the editor is attached to", () => {
    const ctrl = new FakeController();
    const host = new FakeHost();
    const editorModel = host.editorCreates("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/main.ddd", "main");
    ctrl.files.set("/workspace/shared/money.ddd", "money");
    const dispose = start(ctrl, host);
    const inactive = host.find("/workspace/shared/money.ddd");

    dispose();

    expect(inactive?.disposed).toBe(true);
    expect(editorModel.disposed).toBe(false);
    // Unsubscribed: later workspace churn must not touch models any more.
    ctrl.write("/workspace/shared/other.ddd", "other");
    expect(host.live()).toEqual(["inmemory:///workspace/main.ddd"]);
  });
});
