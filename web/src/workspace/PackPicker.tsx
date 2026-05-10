// ---------------------------------------------------------------------------
// PackPicker — small UI for importing a custom design pack into the
// playground workspace.  Two paths share the same outcome:
//   - File System Access API (Chrome/Edge): button click opens
//     `showDirectoryPicker`.
//   - `<input type="file" webkitdirectory>` (Safari/Firefox): the
//     same button delegates to a hidden input.
//
// Either way, the picked directory's files land in the workspace
// VFS at `/workspace/design/<packname>/...` and are simultaneously
// pushed to the build worker via the mutate-RPC, so generation
// against `design: "./design/<packname>"` works on the next run.
// ---------------------------------------------------------------------------

import { Button, Group } from "@mantine/core";
import { useRef, useState } from "react";
import {
  packToVfsEntries,
  pickPackFromFileList,
  pickPackViaFSAccess,
  supportsDirectoryPicker,
  validatePickedPack,
  type PickedPack,
} from "./pack-picker.js";
import type { LoomBuildClient } from "../build/client.js";
import type { IdbVfs } from "../vfs/idb-vfs.js";

interface Props {
  /** Workspace VFS — picked pack files persist here so they
   *  survive reload (Phase 3). */
  workspaceVfs: IdbVfs | null;
  /** Build worker client — picked pack files also push here so
   *  the next `generateFromPath` can resolve `design: "./design/X"`
   *  immediately, without waiting for a worker restart to re-seed
   *  from the workspace. */
  buildClient: LoomBuildClient | null;
  /** Called after a successful import — gives the parent a chance
   *  to kick off auto-generate so a pre-existing
   *  `design: "./design/X"` in the editor renders straight away. */
  onImported?(pack: PickedPack): void;
  /** Called on any import error (validation, IO, walk).  The
   *  parent decides how to surface it (toast, modal, etc.). */
  onError?(err: Error): void;
}

export function PackPicker({
  workspaceVfs,
  buildClient,
  onImported,
  onError,
}: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const fallbackInputRef = useRef<HTMLInputElement | null>(null);

  async function importPack(pack: PickedPack): Promise<void> {
    validatePickedPack(pack);
    const entries = packToVfsEntries(pack);
    // Persist to workspace VFS first so a worker crash mid-flight
    // doesn't lose the import — the next reload re-replays it.
    if (workspaceVfs) {
      for (const { path, content } of entries) {
        workspaceVfs.write(path, content);
      }
    }
    // Push to build worker so generation resolves the pack on the
    // very next run.  Awaiting the ACK preserves write-then-generate
    // ordering (see protocol.ts).
    if (buildClient) {
      await buildClient.vfsWrite(entries);
    }
    onImported?.(pack);
  }

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (supportsDirectoryPicker()) {
        const pack = await pickPackViaFSAccess();
        if (pack) await importPack(pack);
      } else {
        // Trigger the hidden `<input webkitdirectory>` — its
        // onChange handles the rest.
        fallbackInputRef.current?.click();
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function handleFallbackChange(
    ev: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const pack = await pickPackFromFileList(ev.target.files);
      if (pack) await importPack(pack);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
      // Reset so picking the same folder twice fires onChange.
      ev.target.value = "";
    }
  }

  return (
    <Group gap="xs">
      <Button
        size="xs"
        variant="light"
        onClick={handleClick}
        loading={busy}
        data-testid="btn-import-pack"
      >
        Import design pack
      </Button>
      {/* Fallback hidden input — used on browsers without
          showDirectoryPicker.  Both `webkitdirectory` and
          `directory` attributes set so Safari/Firefox accept it. */}
      <input
        ref={fallbackInputRef}
        type="file"
        // @ts-expect-error - webkitdirectory is a non-standard but widely-supported
        // attribute that React's typings don't expose.
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: "none" }}
        onChange={handleFallbackChange}
        data-testid="input-import-pack"
      />
    </Group>
  );
}
