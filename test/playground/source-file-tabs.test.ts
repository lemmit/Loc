import { describe, expect, it } from "vitest";
import {
  normaliseNewFilePath,
  validateNewFileBasename,
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
});
