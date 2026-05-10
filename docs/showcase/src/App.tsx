// ---------------------------------------------------------------------------
// Loom UI showcase — sidebar of stories + side-by-side iframes
// rendering the same source through both built-in design packs.
//
// Stories are described in `stories/registry.ts` (the single
// source of truth shared with the build script).  At deploy time
// `web/scripts/build-showcase.mjs` reads the registry, generates
// + bundles each (story × pack) pair, writes the static iframes
// to `iframes/<story>/<pack>/index.html`, and emits a
// `manifest.json` listing every entry.  This app fetches that
// manifest at runtime and renders.
//
// The catalogue stays data-driven on purpose: adding a story is a
// single-file edit (registry.ts) plus a re-run of the build
// script — no app code changes.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";

interface ManifestStory {
  id: string;
  label: string;
  group: string;
  blurb: string;
  packs: Record<string, string>;
}

interface Manifest {
  stories: ManifestStory[];
}

type LoadState =
  | { status: "loading" }
  | { status: "ok"; manifest: Manifest }
  | { status: "error"; message: string };

export function App() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        // The manifest sits at the showcase root next to this app's
        // own bundle.  Relative fetch resolves correctly under any
        // deploy base (GitHub Pages sub-path, local preview, etc.).
        const res = await fetch("./manifest.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`manifest fetch ${res.status}`);
        const manifest = (await res.json()) as Manifest;
        setLoad({ status: "ok", manifest });
        if (manifest.stories.length > 0) {
          setSelectedId(manifest.stories[0].id);
        }
      } catch (err) {
        setLoad({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    if (load.status !== "ok") return [] as Array<{ group: string; stories: ManifestStory[] }>;
    const map = new Map<string, ManifestStory[]>();
    for (const s of load.manifest.stories) {
      const arr = map.get(s.group) ?? [];
      arr.push(s);
      map.set(s.group, arr);
    }
    return Array.from(map, ([group, stories]) => ({ group, stories }));
  }, [load]);

  if (load.status === "loading") {
    return <div className="status">Loading manifest…</div>;
  }
  if (load.status === "error") {
    return (
      <div className="status error">
        Failed to load showcase manifest: {load.message}
        <br />
        <small>
          If you're running locally, run <code>node web/scripts/build-showcase.mjs</code> from the
          repo root first.
        </small>
      </div>
    );
  }

  const selected = load.manifest.stories.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="layout">
      <aside className="sidebar">
        <header>
          <h1>Loom UI Showcase</h1>
          <p className="subtitle">
            Same DDL, two packs.  Pick a story to see how each design system renders the same
            scaffold side-by-side.
          </p>
        </header>
        <nav>
          {grouped.map(({ group, stories }) => (
            <section key={group}>
              <h2>{group}</h2>
              <ul>
                {stories.map((s) => (
                  <li key={s.id}>
                    <button
                      className={s.id === selectedId ? "active" : ""}
                      onClick={() => setSelectedId(s.id)}
                    >
                      {s.label}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <footer>
          <a href="../playground/" target="_blank" rel="noreferrer">
            ↗ Open the playground
          </a>
        </footer>
      </aside>
      <main className="main">
        {selected ? <StoryPane story={selected} /> : <p>Select a story.</p>}
      </main>
    </div>
  );
}

interface StoryPaneProps {
  story: ManifestStory;
}

function StoryPane({ story }: StoryPaneProps) {
  const packIds = Object.keys(story.packs).sort();
  return (
    <div className="story">
      <header>
        <h2>{story.label}</h2>
        <p>{story.blurb}</p>
      </header>
      <div className="iframes">
        {packIds.map((pack) => (
          <PackIframe key={pack} pack={pack} src={story.packs[pack]} />
        ))}
      </div>
    </div>
  );
}

interface PackIframeProps {
  pack: string;
  src: string;
}

function PackIframe({ pack, src }: PackIframeProps) {
  // `key` on the iframe (story.id-derived via parent) ensures
  // the iframe remounts on story switch — otherwise a stale
  // page renders briefly before the new src is fetched.
  return (
    <div className="iframe-wrap">
      <header>
        <span className="pack-name">{pack}</span>
        <a href={src} target="_blank" rel="noreferrer" title="Open in new tab">
          ↗
        </a>
      </header>
      <iframe src={src} title={`${pack} preview`} />
    </div>
  );
}
