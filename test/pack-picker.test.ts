import { describe, expect, it } from "vitest";

import {
  type PickedPack,
  packToVfsEntries,
  pickPackFromFileList,
  validatePickedPack,
} from "../web/src/workspace/pack-picker.js";

// ---------------------------------------------------------------------------
// Pure unit tests for the framework-agnostic picker helpers.  The
// File System Access API code path needs a real browser, so it's
// covered by the playwright spec (`web/e2e/pack-import.spec.ts`).
// ---------------------------------------------------------------------------

/** Shape-compatible mock for the `<input webkitdirectory>` FileList,
 *  used by `pickPackFromFileList`.  We only need `length`, indexer,
 *  `webkitRelativePath`, and `text()`. */
function fakeFileList(files: ReadonlyArray<{ relativePath: string; content: string }>): FileList {
  const arr = files.map(({ relativePath, content }) => ({
    webkitRelativePath: relativePath,
    text: () => Promise.resolve(content),
  }));
  return Object.assign(arr, {
    length: arr.length,
    item: (i: number) => arr[i],
  }) as unknown as FileList;
}

describe("pickPackFromFileList", () => {
  it("derives the pack name from the leading webkitRelativePath segment", async () => {
    const list = fakeFileList([
      { relativePath: "my-pack/pack.json", content: "{}" },
      { relativePath: "my-pack/page-list.hbs", content: "..." },
    ]);
    const pack = await pickPackFromFileList(list);
    expect(pack?.name).toBe("my-pack");
    expect(pack?.files).toHaveLength(2);
    expect(pack?.files.find(([p]) => p === "pack.json")?.[1]).toBe("{}");
  });

  it("preserves nested directory paths inside the pack", async () => {
    const list = fakeFileList([
      { relativePath: "p/pack.json", content: "{}" },
      { relativePath: "p/cells/cell-id.hbs", content: "X" },
      { relativePath: "p/fields/field-string.hbs", content: "Y" },
    ]);
    const pack = await pickPackFromFileList(list);
    expect(pack?.files.map(([p]) => p).sort()).toEqual([
      "cells/cell-id.hbs",
      "fields/field-string.hbs",
      "pack.json",
    ]);
  });

  it("returns null for an empty FileList (cancelled dialog)", async () => {
    const list = fakeFileList([]);
    expect(await pickPackFromFileList(list)).toBeNull();
    expect(await pickPackFromFileList(null)).toBeNull();
  });

  it("rejects files that escape the pack root", async () => {
    const list = fakeFileList([
      { relativePath: "p/pack.json", content: "{}" },
      { relativePath: "elsewhere/file.txt", content: "" },
    ]);
    await expect(pickPackFromFileList(list)).rejects.toThrow(/outside chosen directory/);
  });
});

describe("validatePickedPack", () => {
  it("rejects packs with no pack.json", () => {
    const p: PickedPack = {
      name: "foo",
      files: [["page-list.hbs", "..."]],
    };
    expect(() => validatePickedPack(p)).toThrow(/no pack\.json/);
  });

  it("rejects empty pack name", () => {
    const p: PickedPack = { name: "", files: [["pack.json", "{}"]] };
    expect(() => validatePickedPack(p)).toThrow(/no name/);
  });

  it("rejects built-in pack names (mantine / shadcn)", () => {
    expect(() => validatePickedPack({ name: "mantine", files: [["pack.json", "{}"]] })).toThrow(
      /built-in pack name/,
    );
    expect(() => validatePickedPack({ name: "shadcn", files: [["pack.json", "{}"]] })).toThrow(
      /built-in pack name/,
    );
  });

  it("accepts a valid pack", () => {
    expect(() =>
      validatePickedPack({
        name: "my-pack",
        files: [
          ["pack.json", "{}"],
          ["page-list.hbs", "..."],
        ],
      }),
    ).not.toThrow();
  });
});

describe("packToVfsEntries", () => {
  it("namespaces every file under /workspace/design/<name>/...", () => {
    const entries = packToVfsEntries({
      name: "foo",
      files: [
        ["pack.json", "{}"],
        ["page-list.hbs", "X"],
        ["cells/cell-id.hbs", "Y"],
      ],
    });
    expect(entries).toEqual([
      { path: "/workspace/design/foo/pack.json", content: "{}" },
      { path: "/workspace/design/foo/page-list.hbs", content: "X" },
      { path: "/workspace/design/foo/cells/cell-id.hbs", content: "Y" },
    ]);
  });
});
