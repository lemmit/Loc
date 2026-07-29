import { describe, expect, it } from "vitest";
import {
  fileInFolderPath,
  joinWorkspace,
  newFolderSeedPath,
  normaliseNewFilePath,
  parentRelOf,
  renameTargetPath,
  siblingFolders,
  validateNewFileBasename,
  validateNewFileInFolder,
  validateNewFolderName,
  validateRename,
} from "../../web/src/layout/source-file-tabs-validation.js";

describe("SourceFileTabs — new-file basename validation", () => {
  it("normaliseNewFilePath rejects nothing and shapes into a /workspace/*.ddd path", () => {
    expect(normaliseNewFilePath("orders")).toBe("/workspace/orders.ddd");
    expect(normaliseNewFilePath("orders.ddd")).toBe("/workspace/orders.ddd");
    expect(normaliseNewFilePath("shared/money")).toBe("/workspace/shared/money.ddd");
    expect(normaliseNewFilePath("shared/money.ddd")).toBe("/workspace/shared/money.ddd");
    // Leading slashes are stripped so users typing "/orders.ddd" still
    // land under /workspace/.
    expect(normaliseNewFilePath("/orders.ddd")).toBe("/workspace/orders.ddd");
    // Whitespace around the basename is trimmed before normalisation.
    expect(normaliseNewFilePath("  orders  ")).toBe("/workspace/orders.ddd");
  });

  describe("validateNewFileBasename", () => {
    const existing = new Set([
      "/workspace/main.ddd",
      "/workspace/orders.ddd",
      "/workspace/shared/money.ddd",
    ]);

    it("accepts a fresh, simple identifier", () => {
      expect(validateNewFileBasename("shipping", existing)).toBeUndefined();
      expect(validateNewFileBasename("shipping.ddd", existing)).toBeUndefined();
    });

    it("accepts one level of nesting", () => {
      expect(validateNewFileBasename("billing/invoices", existing)).toBeUndefined();
      expect(validateNewFileBasename("billing/invoices.ddd", existing)).toBeUndefined();
    });

    it("rejects empty input", () => {
      expect(validateNewFileBasename("", existing)).toMatch(/required/i);
      expect(validateNewFileBasename("   ", existing)).toMatch(/required/i);
    });

    it("rejects a name that collides with an existing file", () => {
      expect(validateNewFileBasename("main", existing)).toMatch(/already exists/);
      expect(validateNewFileBasename("orders.ddd", existing)).toMatch(/already exists/);
      expect(validateNewFileBasename("shared/money", existing)).toMatch(/already exists/);
    });

    it("rejects illegal characters", () => {
      expect(validateNewFileBasename("orders space", existing)).toMatch(/letters, digits/);
      expect(validateNewFileBasename("../etc/passwd", existing)).toMatch(/letters, digits/);
      expect(validateNewFileBasename("a/b/c", existing)).toMatch(/letters, digits/);
      expect(validateNewFileBasename("a$b", existing)).toMatch(/letters, digits/);
    });

    it("accepts dash, underscore, and dot inside the basename", () => {
      expect(validateNewFileBasename("my-feature", existing)).toBeUndefined();
      expect(validateNewFileBasename("my_feature", existing)).toBeUndefined();
      expect(validateNewFileBasename("v1.draft", existing)).toBeUndefined();
    });
  });

  describe("validateNewFolderName", () => {
    const existing = new Set([
      "/workspace/main.ddd",
      "/workspace/shared/money.ddd",
      "/workspace/shared/currency.ddd",
    ]);

    it("accepts a fresh single-segment folder name", () => {
      expect(validateNewFolderName("billing", existing)).toBeUndefined();
      expect(validateNewFolderName("audit-log", existing)).toBeUndefined();
      // Trailing slashes are stripped — `shared/` would mean "make
      // a folder called shared" but shared/ already exists, so we
      // still reject; an empty-segment-only `/` is rejected too.
      expect(validateNewFolderName("billing/", existing)).toBeUndefined();
    });

    it("rejects empty input", () => {
      expect(validateNewFolderName("", existing)).toMatch(/required/i);
      expect(validateNewFolderName("   ", existing)).toMatch(/required/i);
    });

    it("rejects nesting via slashes — folders are one segment in the create UI", () => {
      expect(validateNewFolderName("a/b", existing)).toMatch(/No slashes/);
      expect(validateNewFolderName("/leading", existing)).toMatch(/No slashes/);
    });

    it("rejects illegal characters", () => {
      expect(validateNewFolderName("with space", existing)).toMatch(/letters, digits/);
      expect(validateNewFolderName("a$b", existing)).toMatch(/letters, digits/);
    });

    it("rejects a folder that already exists at the root level", () => {
      expect(validateNewFolderName("shared", existing)).toMatch(/already exists/);
    });

    // The duplicate check used to inspect only the FIRST segment of every
    // root-relative path, which was wrong in both directions.
    describe("duplicates are checked among the actual siblings", () => {
      it("a root-level folder does not block the same name inside another folder", () => {
        // False positive: `shared` exists at the root, so creating
        // `audit/shared` was rejected even though nothing lives there.
        expect(validateNewFolderName("shared", existing, "audit")).toBeUndefined();
      });

      it("rejects a duplicate nested folder (mkdir is idempotent — it would silently do nothing)", () => {
        // False negative: `audit/shared` already exists, and the root-only
        // scan never saw it, so the create slipped through as a no-op.
        const nested = new Set(["/workspace/main.ddd", "/workspace/audit/shared/log.ddd"]);
        expect(validateNewFolderName("shared", nested, "audit")).toMatch(/already exists/);
      });

      it("names the folder-qualified path in the message", () => {
        const nested = new Set(["/workspace/audit/shared/log.ddd"]);
        expect(validateNewFolderName("shared", nested, "audit")).toMatch(/audit\/shared/);
      });

      it("counts EXPLICIT empty folders, which no file path reveals", () => {
        const emptyFolders = new Set(["audit/shared", "billing"]);
        expect(validateNewFolderName("shared", new Set(), "audit", emptyFolders)).toMatch(
          /already exists/,
        );
        expect(validateNewFolderName("billing", new Set(), "", emptyFolders)).toMatch(
          /already exists/,
        );
        // …and an empty folder nested elsewhere still doesn't block the root.
        expect(validateNewFolderName("shared", new Set(), "", emptyFolders)).toBeUndefined();
      });

      it("a deeper descendant does not count as a direct sibling", () => {
        const deep = new Set(["/workspace/a/b/c/d.ddd"]);
        expect(validateNewFolderName("c", deep, "a")).toBeUndefined();
        expect(validateNewFolderName("b", deep, "a")).toMatch(/already exists/);
      });
    });
  });

  describe("siblingFolders", () => {
    const existing = new Set([
      "/workspace/main.ddd",
      "/workspace/shared/money.ddd",
      "/workspace/audit/log/entry.ddd",
    ]);

    it("lists the folders directly inside a parent", () => {
      expect([...siblingFolders("", existing)].sort()).toEqual(["audit", "shared"]);
      expect([...siblingFolders("audit", existing)]).toEqual(["log"]);
      expect([...siblingFolders("shared", existing)]).toEqual([]);
    });

    it("merges the explicit empty-folder set", () => {
      const empties = new Set(["audit/archive", "scratch"]);
      expect([...siblingFolders("", existing, empties)].sort()).toEqual([
        "audit",
        "scratch",
        "shared",
      ]);
      expect([...siblingFolders("audit", existing, empties)].sort()).toEqual(["archive", "log"]);
    });

    it("ignores paths outside /workspace/", () => {
      expect([...siblingFolders("", new Set(["/elsewhere/other/x.ddd"]))]).toEqual([]);
    });
  });

  describe("newFolderSeedPath", () => {
    it("seeds an `untitled.ddd` inside the new folder", () => {
      const existing = new Set(["/workspace/main.ddd"]);
      expect(newFolderSeedPath("billing", existing)).toBe("/workspace/billing/untitled.ddd");
    });

    it("strips leading + trailing slashes from the folder name", () => {
      const existing = new Set(["/workspace/main.ddd"]);
      expect(newFolderSeedPath("/audit/", existing)).toBe("/workspace/audit/untitled.ddd");
    });

    it("disambiguates when `untitled.ddd` is already taken", () => {
      const existing = new Set([
        "/workspace/billing/untitled.ddd",
        "/workspace/billing/untitled-2.ddd",
      ]);
      expect(newFolderSeedPath("billing", existing)).toBe("/workspace/billing/untitled-3.ddd");
    });
  });

  // The context-menu create/rename helpers (right-click file management).
  describe("context-menu file ops", () => {
    it("joinWorkspace handles root and nested parents", () => {
      expect(joinWorkspace("", "main.ddd")).toBe("/workspace/main.ddd");
      expect(joinWorkspace("shared", "money.ddd")).toBe("/workspace/shared/money.ddd");
      expect(joinWorkspace("/a/b/", "c.ddd")).toBe("/workspace/a/b/c.ddd");
    });

    it("fileInFolderPath qualifies a new file with its parent folder", () => {
      expect(fileInFolderPath("shared", "money")).toBe("/workspace/shared/money.ddd");
      expect(fileInFolderPath("", "orders.ddd")).toBe("/workspace/orders.ddd");
    });

    it("validateNewFileInFolder rejects duplicates within the target folder", () => {
      const existing = new Set(["/workspace/shared/money.ddd"]);
      expect(validateNewFileInFolder("money", existing, "shared")).toMatch(/already exists/);
      // Same leaf in a different folder is fine.
      expect(validateNewFileInFolder("money", existing, "billing")).toBeUndefined();
    });

    it("parentRelOf returns the folder a file lives in", () => {
      expect(parentRelOf("/workspace/main.ddd")).toBe("");
      expect(parentRelOf("/workspace/shared/money.ddd")).toBe("shared");
      expect(parentRelOf("/workspace/a/b/c.ddd")).toBe("a/b");
    });

    it("renameTargetPath keeps the file in its folder", () => {
      expect(renameTargetPath("/workspace/shared/money.ddd", "currency")).toBe(
        "/workspace/shared/currency.ddd",
      );
      expect(renameTargetPath("/workspace/orders.ddd", "sales.ddd")).toBe("/workspace/sales.ddd");
    });

    it("validateRename allows a no-op and rejects a clash", () => {
      const existing = new Set(["/workspace/shared/money.ddd", "/workspace/shared/currency.ddd"]);
      // Unchanged name → allowed.
      expect(validateRename("money", existing, "/workspace/shared/money.ddd")).toBeUndefined();
      // Collides with the sibling → rejected.
      expect(validateRename("currency", existing, "/workspace/shared/money.ddd")).toMatch(
        /already exists/,
      );
      // Slashes aren't allowed in a rename leaf.
      expect(validateRename("a/b", existing, "/workspace/shared/money.ddd")).toMatch(/No slashes/);
    });
  });
});
