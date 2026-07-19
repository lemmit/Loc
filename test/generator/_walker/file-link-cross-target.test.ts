// ---------------------------------------------------------------------------
// FileLink display primitive — cross-frontend render gate (M-T1.2 slice 4b).
//
// A `File` field in a scaffolded list/detail cell renders through the closed
// `FileLink` primitive: a plain HTML download anchor (`<a href={ref.url}
// download>{ref.key}</a>`), null-guarded so an optional `File?` that is unset
// shows an em-dash.  Deliberately NOT a design-system component (a file
// download is a native anchor), so the JSX/markup frontends build it inline via
// the target markup seams (no per-pack template); Feliz forks to F# `Html.a`
// and Phoenix/HEEx to its parallel-walker renderer.
//
// This proves the anchor + null-guard actually render end-to-end on React, Vue,
// Svelte, Angular, Feliz (F#) and Phoenix (HEEx) — a scaffolded aggregate with
// BOTH a required `File` and an optional `File?`, generated through each real
// generator.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** A scaffolded aggregate with a required `File` (`blob`) and an optional
 *  `File?` (`thumbnail`), hosted on `platform`. */
const scaffoldFileSystem = (platform: string): string => `
  system FileDemo {
    subdomain Media {
      context Docs {
        aggregate Attachment with crudish {
          title: string
          blob: File
          thumbnail: File?
        }
        repository Attachments for Attachment { }
      }
    }
    ui Web with scaffold(subdomains: [Media]) { }
    api DocsApi from Media
    storage primary { type: postgres }
    storage uploads { type: localDisk }
    resource docsState { for: Docs, kind: state, use: primary }
    resource docsFiles { for: Docs, kind: objectStore, use: uploads }
    deployable api {
      platform: node, contexts: [Docs], dataSources: [docsState, docsFiles],
      serves: DocsApi, port: 4300
    }
    deployable web { platform: ${platform}, targets: api, hosts: Web }
  }
`;

/** Elixir needs the api served over the deployable + a display-deriving
 *  aggregate; a distinct shape keeps the Phoenix host valid. */
const phoenixFileSystem = (): string => `
  system FileDemo {
    subdomain Media {
      context Docs {
        aggregate Attachment with crudish {
          title: string
          blob: File
          thumbnail: File?
        }
        repository Attachments for Attachment { }
      }
    }
    ui Web with scaffold(subdomains: [Media]) { }
    api DocsApi from Media
    storage primary { type: postgres }
    storage uploads { type: localDisk }
    resource docsState { for: Docs, kind: state, use: primary }
    resource docsFiles { for: Docs, kind: objectStore, use: uploads }
    deployable phoenixApp {
      platform: elixir, contexts: [Docs], dataSources: [docsState, docsFiles],
      serves: DocsApi, ui: Web, port: 4000
    }
  }
`;

/** Concatenate every generated file so the assertions stay path-agnostic. */
function allFiles(files: Map<string, string>): string {
  let all = "";
  for (const content of files.values()) all += `\n${content}`;
  return all;
}

describe("FileLink — JSX/markup frontends render a null-guarded download anchor", () => {
  // React + Svelte share JSX's `href={…}`/`{…}`; Vue + Angular bind + interpolate.
  const JSX_FAMILY: ReadonlyArray<{ target: string; href: RegExp; label: RegExp }> = [
    {
      target: "react",
      href: /<a href=\{[\w.]+\.blob\.url\} download>/,
      label: /\{[\w.]+\.blob\.key\}<\/a>/,
    },
    {
      target: "svelte",
      href: /<a href=\{[\w.]+\.blob\.url\} download>/,
      label: /\{[\w.]+\.blob\.key\}<\/a>/,
    },
    {
      target: "vue",
      href: /<a :href="[\w.]+\.blob\.url" download>/,
      label: /\{\{ [\w.]+\.blob\.key \}\}<\/a>/,
    },
    {
      target: "angular",
      href: /<a \[href\]="[\w.]+\.blob\.url" download>/,
      label: /\{\{ [\w.]+\.blob\.key \}\}<\/a>/,
    },
  ];

  for (const { target, href, label } of JSX_FAMILY) {
    it(`${target}: the required File renders a download anchor`, async () => {
      const out = allFiles(await generateSystemFiles(scaffoldFileSystem(target)));
      expect(out).toMatch(href);
      expect(out).toMatch(label);
      // The em-dash null placeholder rides a bare <span> (covers both fields).
      expect(out).toContain("<span>—</span>");
      // The optional File? cell is NOT skipped — it renders its own anchor.
      expect(out).toContain("thumbnail.url");
      expect(out).toContain("thumbnail.key");
    });
  }
});

describe("FileLink — Feliz forks to an F# anchor with a Some/None guard", () => {
  it("emits `Html.a` labelled by the FileRef key, guarded by a match", async () => {
    const out = allFiles(await generateSystemFiles(scaffoldFileSystem("feliz")));
    // Required + optional File both decode to `FileRef option` and match.
    expect(out).toContain("blob: FileRef option");
    expect(out).toContain("thumbnail: FileRef option");
    expect(out).toMatch(
      /match [\w.]+\.blob with Some __f -> Html\.a \[ prop\.className "link link-primary"; prop\.href __f\.url; prop\.download __f\.key; prop\.text __f\.key \] \| None -> Html\.text "—"/,
    );
    // The FileRef record + decoder ship (before the domain decoders reference it).
    expect(out).toContain("type FileRef =");
    expect(out).toContain('get.Optional.Field "blob" fileRefDecoder');
  });
});

describe("FileLink — Phoenix/HEEx renders a null-guarded anchor", () => {
  it("emits an `<a href download>` guarded by an EEx `if`", async () => {
    const out = allFiles(await generateSystemFiles(phoenixFileSystem()));
    // Required File cell — a plain download anchor over the FileRef map.
    expect(out).toMatch(/<%= if [\w.@]+\.blob do %><a href=\{[\w.@]+\.blob\["url"\]\} download>/);
    expect(out).toContain('.blob["key"] %></a>');
    // Optional File? cell is not skipped.
    expect(out).toContain('.thumbnail["url"]');
  });
});
