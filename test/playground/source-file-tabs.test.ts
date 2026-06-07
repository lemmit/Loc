import { describe, expect, it } from "vitest";
import {
  fileInFolderPath,
  joinWorkspace,
  newFolderSeedPath,
  normaliseNewFilePath,
  parentRelOf,
  renameTargetPath,
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
