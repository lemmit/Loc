import { Button, Group, Modal, TextInput } from "@mantine/core";
import { Spotlight, type SpotlightActionData, type SpotlightActionGroupData, spotlight } from "@mantine/spotlight";
import { useState } from "react";
import { defaultExample } from "../examples";
import { confirmSites, requestConfirm } from "../util/confirm";
import { MOD_LABEL } from "../util/hotkeys";
import type { DockTab, LayoutCtx, MobileTab } from "./ctx";
import { HELP, PALETTE, PANE, RUN, STAGE } from "./vocabulary";

// The ⌘K command palette (M-T8.18 slice 2, audit M14): `@mantine/spotlight`
// over every action the ctx exposes — run stages, centre views, dock tabs,
// workspace new / rename / delete (delete through the shared confirm, so the
// palette cannot skip the type-to-confirm the switcher asks for), export,
// share, help.  The shortcut itself is installed by App's hotkeys (one map,
// one place), so `shortcut={null}` here; `openPalette` on the ctx calls
// `spotlight.open()`.

interface Props {
  ctx: LayoutCtx;
}

export function CommandPalette({ ctx }: Props): JSX.Element {
  const [naming, setNaming] = useState<null | "new" | "rename">(null);
  const [name, setName] = useState("");
  const { isDesktop, workspace } = ctx;

  const showPane = (id: string, desktop: () => void, mobile: () => void): SpotlightActionData => ({
    id: `view-${id}`,
    label: PALETTE.show(idLabel(id)),
    group: PALETTE.group.view,
    onClick: () => (isDesktop ? desktop() : mobile()),
  });
  const dock = (tab: DockTab, label: string, mobileTab: MobileTab): SpotlightActionData => ({
    id: `dock-${tab}`,
    label: PALETTE.show(label),
    group: PALETTE.group.dock,
    onClick: () => (isDesktop ? ctx.setDockTab(tab) : ctx.setActiveTab(mobileTab)),
  });

  const groups: SpotlightActionGroupData[] = [
    {
      group: PALETTE.group.run,
      actions: [
        {
          id: "run-validate",
          label: PALETTE.run(STAGE.validate),
          description: `${PANE.output} → Problems`,
          onClick: () => {
            ctx.setOutputStream("problems");
            if (isDesktop) ctx.setDockTab("output");
            else ctx.setActiveTab("output");
          },
        },
        {
          id: "run-generate",
          label: PALETTE.run(STAGE.generate),
          rightSection: <Hint keys={`${MOD_LABEL}↵`} />,
          keywords: ["generate", "build"],
          onClick: () => ctx.runGenerate(),
        },
        { id: "run-bundle", label: PALETTE.run(STAGE.bundle), onClick: () => ctx.runBundle() },
        { id: "run-boot", label: PALETTE.run(STAGE.boot), onClick: () => ctx.runBoot() },
        {
          id: "run-full",
          label: PALETTE.runFull,
          rightSection: <Hint keys={`${MOD_LABEL}⇧↵`} />,
          keywords: [RUN, "run"],
          onClick: () => ctx.runFull(),
        },
      ],
    },
    {
      group: PALETTE.group.view,
      actions: [
        showPane("source", () => ctx.setCenterView("source"), () => {
          ctx.setActiveTab("code");
          ctx.setCodeView("source");
        }),
        showPane("builder", () => ctx.setCenterView("builder"), () => {
          ctx.setActiveTab("code");
          ctx.setCodeView("builder");
        }),
        showPane("model", () => ctx.setCenterView("model"), () => {
          ctx.setActiveTab("code");
          ctx.setCodeView("model");
        }),
        showPane("requirements", () => ctx.setCenterView("requirements"), () => {
          ctx.setActiveTab("code");
          ctx.setCodeView("requirements");
        }),
        showPane("generated", () => ctx.setExplorerMode("generated"), () => {
          ctx.setActiveTab("code");
          ctx.setCodeView("generated");
        }),
        showPane("preview", () => undefined, () => ctx.setActiveTab("preview")),
        { id: "view-examples", label: PALETTE.show(PANE.examples), group: PALETTE.group.view, onClick: () => ctx.openExamples() },
      ],
    },
    {
      group: PALETTE.group.dock,
      actions: [
        dock("output", PANE.output, "output"),
        dock("agent", PANE.agent, "agent"),
        dock("backend", PANE.runtime, "backend"),
        dock("tests", PANE.tests, "tests"),
        dock("migrations", PANE.migrations, "migrations"),
        dock("history", PANE.history, "history"),
        dock("auth", PANE.auth, "auth"),
      ],
    },
    {
      group: PALETTE.group.workspace,
      actions: [
        {
          id: "ws-new",
          label: PALETTE.newWorkspace,
          onClick: () => {
            setName("");
            setNaming("new");
          },
        },
        {
          id: "ws-rename",
          label: PALETTE.renameWorkspace,
          onClick: () => {
            setName(workspace.activeName);
            setNaming("rename");
          },
        },
        {
          id: "ws-delete",
          label: PALETTE.deleteWorkspace,
          onClick: () => {
            if (workspace.workspaces.length <= 1) return;
            void requestConfirm(confirmSites.workspaceDelete(workspace.activeName, null), {
              base: "workspace-delete",
            }).then((ok) => {
              if (ok) workspace.deleteWorkspace(workspace.activeId);
            });
          },
        },
      ],
    },
    {
      group: PALETTE.group.share,
      actions: [
        { id: "share-link", label: PALETTE.share, onClick: () => ctx.copyShareLink() },
        { id: "export-zip", label: PALETTE.exportZip, onClick: () => ctx.runDownloadZip() },
      ],
    },
    {
      group: PALETTE.group.help,
      actions: [
        { id: "help-shortcuts", label: HELP.shortcuts, rightSection: <Hint keys="?" />, onClick: () => ctx.setShortcutSheetOpen(true) },
        { id: "help-docs", label: HELP.docs, onClick: () => window.open(HELP.docsUrl, "_blank", "noreferrer") },
        { id: "help-reference", label: HELP.reference, onClick: () => window.open(HELP.referenceUrl, "_blank", "noreferrer") },
      ],
    },
  ];

  const submitName = (): void => {
    const trimmed = name.trim();
    if (naming === "new") {
      ctx.createWorkspaceFromExample(trimmed || defaultExample.label, defaultExample.id);
    } else if (naming === "rename" && trimmed && trimmed !== workspace.activeName) {
      workspace.renameWorkspace(workspace.activeId, trimmed);
    }
    setNaming(null);
  };

  return (
    <>
      <Spotlight
        actions={groups}
        shortcut={null}
        nothingFound={PALETTE.nothingFound}
        highlightQuery
        scrollable
        maxHeight={420}
        searchProps={{ placeholder: PALETTE.placeholder, "aria-label": PALETTE.title }}
        data-testid="command-palette"
      />
      <Modal
        opened={naming !== null}
        onClose={() => setNaming(null)}
        title={naming === "new" ? PALETTE.newWorkspace : PALETTE.renameWorkspace}
        centered
        size="sm"
        data-testid="palette-name-modal"
      >
        <TextInput
          size="sm"
          label={PALETTE.workspaceName}
          value={name}
          autoFocus
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitName();
          }}
          data-testid="palette-name-input"
        />
        <Group justify="flex-end" mt="sm">
          <Button size="xs" onClick={submitName} data-testid="palette-name-submit">
            {naming === "new" ? PALETTE.create : PALETTE.rename}
          </Button>
        </Group>
      </Modal>
    </>
  );
}

function idLabel(id: string): string {
  switch (id) {
    case "source":
      return PANE.source;
    case "builder":
      return PANE.builder;
    case "model":
      return PANE.model;
    case "requirements":
      return PANE.requirements;
    case "generated":
      return PANE.generated;
    case "preview":
      return PANE.preview;
    default:
      return id;
  }
}

function Hint({ keys }: { keys: string }): JSX.Element {
  return <span style={{ fontSize: 11, opacity: 0.7 }}>{keys}</span>;
}

/** The ctx's `openPalette` implementation. */
export const openPalette = (): void => spotlight.open();
