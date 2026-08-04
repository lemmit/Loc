import { type CodePanelProps, PlainCodePanel } from "./code-panel";
import { DocOrCode } from "./doc-viewers";

// The MOBILE generated-file viewer: same markdown/mermaid dispatcher as
// desktop, over a plain monospace code panel instead of Monaco.
//
// Nothing here imports `monaco-editor`, which is the point — see
// `code-panel.tsx` for why a phone gets no editor, and M-T8.15 for the memory
// budget that forces the question.
export function PlainFileViewer({ path, content }: CodePanelProps): JSX.Element {
  return <DocOrCode path={path} content={content} CodePanel={PlainCodePanel} />;
}
