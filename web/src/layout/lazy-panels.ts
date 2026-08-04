import { lazy } from "react";

// The ONE place the Monaco-bound components are reached.
//
// `editor/LoomEditor.tsx`, `preview/FileViewer.tsx` and
// `backend/JsonBodyEditor.tsx` each carry a static `monaco-editor` import;
// `lsp/model-host.ts` does too.  A single static import of any of them from a
// module the entry reaches puts 9.56 MB of editor — 75% of eager JS, plus the
// `extensionHost` / `editor` / `ddd-server` worker realms — onto the eager
// path for BOTH surfaces, including a phone that will never show an editor.
//
// Routing them through `lazy(() => import(...))` here means:
//   - desktop pays for Monaco right after first paint (it renders the editor
//     immediately), which is what it wants anyway;
//   - mobile never fetches it at all, because mobile renders the plain
//     counterparts (`PlainEditor` / `PlainFileViewer` / a textarea).
//
// `scripts/check-eager-chunks.mjs` fails the build if the boundary is ever
// crossed again by accident — this class of regression (a "lazy" chunk pulled
// eager by one careless static import) has shipped three times already.
// See M-T8.15.
export const LazyLoomEditor = lazy(() =>
  import("../editor/LoomEditor").then((m) => ({ default: m.LoomEditor })),
);

export const LazyFileViewer = lazy(() =>
  import("../preview/FileViewer").then((m) => ({ default: m.FileViewer })),
);

export const LazyJsonBodyEditor = lazy(() =>
  import("../backend/JsonBodyEditor").then((m) => ({ default: m.JsonBodyEditor })),
);
