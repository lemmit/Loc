// `textDocument/implementation` — "go to generated code" (M6 phase 3,
// forward direction only). Resolves the cursor's construct id(s) via
// `generated-nav.ts`, discovers the nearest `.loom/sourcemap.json` on
// disk, and turns the matching regions into `LocationLink[]` pointing at
// the generated output. Mirrors the `ddd-code-actions.ts` /
// `unfold-macro.ts` split: this file is the LSP-facing provider, all pure
// construct-id / region logic lives in `generated-nav.ts`.

import {
  CstUtils,
  type FileSystemNode,
  type FileSystemProvider,
  type LangiumDocument,
  type URI,
  UriUtils,
} from "langium";
import type { ImplementationProvider, LangiumServices } from "langium/lsp";
import {
  type CancellationToken,
  type ImplementationParams,
  LocationLink,
  type Range,
} from "vscode-languageserver";
import type { SourceMap } from "../../trace/index.js";
import { matchPath } from "../../trace/index.js";
import { constructIdAt, regionsForConstruct } from "./generated-nav.js";

/** How far up the directory tree map discovery walks from the document's
 *  own directory before giving up — a generous bound for realistic `.ddd`
 *  nesting relative to an out-dir sibling. Discovery also stops early at
 *  the filesystem root. */
const MAX_ANCESTOR_LEVELS = 5;

export class DddImplementationProvider implements ImplementationProvider {
  private readonly fileSystemProvider: FileSystemProvider;

  constructor(services: LangiumServices) {
    this.fileSystemProvider = services.shared.workspace.FileSystemProvider;
  }

  async getImplementation(
    document: LangiumDocument,
    params: ImplementationParams,
    _cancelToken?: CancellationToken,
  ): Promise<LocationLink[] | undefined> {
    const rootCst = document.parseResult?.value?.$cstNode;
    if (!rootCst) return undefined;
    const offset = document.textDocument.offsetAt(params.position);
    const ids = constructIdAt(document, offset);
    if (!ids) return undefined;

    const docPath = document.uri.path;
    const discovered = await this.discoverMap(document.uri, docPath);
    if (!discovered) return undefined;

    const hits = regionsForConstruct(discovered.map, ids, docPath);
    if (hits.length === 0) return undefined;

    const originSelectionRange = CstUtils.findLeafNodeAtOffset(rootCst, offset)?.range;
    return hits.map((hit) => {
      const targetUri = UriUtils.joinPath(discovered.root, ...hit.file.split("/")).toString();
      const range = targetRangeFor(hit.target);
      return LocationLink.create(targetUri, range, range, originSelectionRange);
    });
  }

  /** Walk up from the document's directory (at most `MAX_ANCESTOR_LEVELS`,
   *  or until the filesystem root), checking at each ancestor `D`, in
   *  order: `D/.loom/sourcemap.json`, then every immediate child
   *  directory `C`'s `C/.loom/sourcemap.json` (skipping dotfiles and
   *  `node_modules`). The first map whose `sources` contains a path
   *  matching the document's own path wins; its ROOT (the directory
   *  containing `.loom/`) anchors the output Location URIs.
   *
   *  Reads go through `FileSystemProvider` only (never `node:fs`) so
   *  `EmptyFileSystem` (browser, no backing fs) degrades to "no result"
   *  rather than throwing. No caching in this slice — maps are small and
   *  read fresh per request; a future slice may cache by root + mtime
   *  once this becomes a hot path. */
  private async discoverMap(
    docUri: URI,
    docPath: string,
  ): Promise<{ map: SourceMap; root: URI } | undefined> {
    let dir = UriUtils.dirname(docUri);
    for (let level = 0; level <= MAX_ANCESTOR_LEVELS; level++) {
      const direct = await this.tryLoadMap(dir, docPath);
      if (direct) return direct;

      let children: readonly FileSystemNode[] = [];
      try {
        children = await this.fileSystemProvider.readDirectory(dir);
      } catch {
        children = [];
      }
      for (const child of children) {
        if (!child.isDirectory) continue;
        const name = UriUtils.basename(child.uri);
        if (name.startsWith(".") || name === "node_modules") continue;
        const childMap = await this.tryLoadMap(child.uri, docPath);
        if (childMap) return childMap;
      }

      const parent = UriUtils.dirname(dir);
      if (parent.toString() === dir.toString()) break; // reached the filesystem root
      dir = parent;
    }
    return undefined;
  }

  private async tryLoadMap(
    dir: URI,
    docPath: string,
  ): Promise<{ map: SourceMap; root: URI } | undefined> {
    const mapUri = UriUtils.joinPath(dir, ".loom", "sourcemap.json");
    try {
      const text = await this.fileSystemProvider.readFile(mapUri);
      const map = JSON.parse(text) as SourceMap;
      if (!Array.isArray(map.sources) || matchPath(docPath, map.sources) === undefined) {
        return undefined;
      }
      return { map, root: dir };
    } catch {
      return undefined;
    }
  }
}

/** `target` is a 1-based inclusive [startLine, endLine] range (the
 *  `.loom/sourcemap.json` wire shape). LSP ranges are 0-based, end
 *  exclusive; the simplest correct conversion spans from the start of the
 *  first target line to the start of the line after the last one, so the
 *  whole target range — including its final line — is covered without
 *  guessing at column widths. */
function targetRangeFor([start, end]: [number, number]): Range {
  return {
    start: { line: start - 1, character: 0 },
    end: { line: end, character: 0 },
  };
}
