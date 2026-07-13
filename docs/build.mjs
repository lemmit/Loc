#!/usr/bin/env node
// Render docs/*.md → docs/_site/*.html using a template that matches
// the landing page styling. Recurses into plans/ and audits/ subdirs
// so cross-doc links into the historical material still resolve on the
// deployed site, and emits an index.html for each rendered subdir so
// the README's directory links resolve (GitHub Pages does not
// auto-index).  Copies docs/index.html with .md→.html link rewrites,
// and copies the shared stylesheet.

import { readFile, writeFile, readdir, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, relative } from 'node:path';
import { marked } from 'marked';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT  = join(HERE, '_site');

// Subdirs whose .md content is also rendered so links from reference
// docs into the plan/audit corpus don't 404.  Nested paths are
// supported (depth derived from the path).  old/proposals ships too
// now that new-plan/ links into it as the archived design record.
const RENDERED_SUBDIRS = ['new-plan', 'old/plans', 'old/proposals', 'audits', 'language-reference'];

// Nav surfaces the top-level reading order — keep in sync with
// docs/README.md's "Start here" table and docs/index.html's footer.
const NAV = [
  { label: 'All docs',     href: 'README.html' },
  { label: 'Reference',    href: 'language-reference/README.html' },
  { label: 'Language',     href: 'language.html' },
  { label: 'Pages',        href: 'page-metamodel.html' },
  { label: 'System',       href: 'architecture.html' },
  { label: 'Generators',   href: 'generators.html' },
  { label: 'Tools',        href: 'tools.html' },
  { label: 'Internals',    href: 'technical.html' },
];

// rewrite ./foo.md, ../foo.md, foo.md or sub/foo.md (with optional #anchor) → .html
const MD_LINK = /^((?:\.\.?\/)*(?:[a-zA-Z0-9_\-]+\/)*[a-zA-Z0-9_\-]+)\.md(#.*)?$/;

marked.use({
  gfm: true,
  walkTokens(token) {
    if (token.type === 'link' && typeof token.href === 'string') {
      const m = token.href.match(MD_LINK);
      if (m) token.href = `${m[1]}.html${m[2] ?? ''}`;
    }
  },
});

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
}[c]));
const escapeAttr = (s) => escapeHtml(String(s));

// Platform-tabs block extension.  Authoring syntax (also degrades
// readably on GitHub, which just shows the markers as text but still
// renders the inner code fences):
//
//   ::: tabs backend
//   == node
//   ```ts
//   ...generated output...
//   ```
//   == dotnet
//   ```csharp
//   ...
//   ```
//   ::: end
//
// The optional word after `tabs` is the *group*: every tab group on a
// page sharing a group name switches together (pick "node" once, every
// backend group follows), persisted in localStorage.  Inner content of
// each `== <name>` segment is full markdown (so a tab can hold prose +
// multiple code blocks), rendered with highlight.js client-side.
const platformTabs = {
  name: 'platformTabs',
  level: 'block',
  start(src) {
    const i = src.indexOf('::: tabs');
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^::: tabs[ \t]*([^\n]*)\n([\s\S]*?)\n::: end[ \t]*(?:\n|$)/.exec(src);
    if (!m) return undefined;
    const group = (m[1] || 'platform').trim() || 'platform';
    const segments = m[2].split(/^==[ \t]+/m).filter((s) => s.trim().length);
    const tabs = segments.map((seg) => {
      const nl = seg.indexOf('\n');
      const name = (nl < 0 ? seg : seg.slice(0, nl)).trim();
      const inner = nl < 0 ? '' : seg.slice(nl + 1);
      return { name, tokens: this.lexer.blockTokens(inner.trim()) };
    });
    return { type: 'platformTabs', raw: m[0], group, tabs };
  },
  renderer(token) {
    const btns = token.tabs.map((t, i) =>
      `<button class="lt-tab${i === 0 ? ' active' : ''}" type="button" role="tab" data-tab="${escapeAttr(t.name)}">${escapeHtml(t.name)}</button>`,
    ).join('');
    const panels = token.tabs.map((t, i) =>
      `<div class="lt-panel${i === 0 ? ' active' : ''}" role="tabpanel" data-tab="${escapeAttr(t.name)}">${this.parser.parse(t.tokens)}</div>`,
    ).join('');
    return `<div class="lt-tabs" data-group="${escapeAttr(token.group)}"><div class="lt-tablist" role="tablist">${btns}</div>${panels}</div>`;
  },
};

marked.use({ extensions: [platformTabs] });

const extractTitle = (md, fallback) => {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/^Loom\s+[—–-]\s+/, '') : fallback;
};

// Per-page nav: a doc rendered into a subdir needs `../` on every link.
const navLinks = (currentHref, depth) => {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  return NAV.map(({ label, href }) =>
    `<a href="${prefix}${href}"${href === currentHref ? ' class="current"' : ''}>${label}</a>`
  ).join('\n        ');
};

const header = (currentHref, depth) => {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  return `<header class="site">
  <div class="container nav">
    <a class="brand" href="${prefix}index.html">
      <svg class="logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <defs><linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b58cff"/><stop offset="1" stop-color="#6fd1ff"/></linearGradient></defs>
        <rect x="2" y="2" width="28" height="28" rx="7" stroke="url(#lg)" stroke-width="2"/>
        <path d="M7 10 L25 22 M7 16 L25 16 M7 22 L25 10" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="brand-name">Loom</span>
    </a>
    <nav class="nav-links" aria-label="Primary">
        ${navLinks(currentHref, depth)}
        <a class="btn" href="https://github.com/lemmit/loc" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>`;
};

const footer = (depth) => {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  return `<footer class="site">
  <div class="container row">
    <div>© Loom contributors · FSL-1.1-Apache-2.0</div>
    <div class="links">
      ${NAV.map(({ label, href }) => `<a href="${prefix}${href}">${label}</a>`).join('\n      ')}
      <a href="https://github.com/lemmit/loc" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</footer>`;
};

// Self-contained styling + behaviour for the platform-tabs widget,
// injected once per page so the reference's lowering examples render as
// a tabbed picker (node/dotnet/java/python/elixir, react/vue/svelte/…).
const TAB_STYLE = `<style>
.lt-tabs{margin:1.25rem 0;border:1px solid rgba(255,255,255,.10);border-radius:10px;overflow:hidden;background:rgba(255,255,255,.02)}
.lt-tablist{display:flex;flex-wrap:wrap;gap:2px;padding:6px 6px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.lt-tab{appearance:none;background:transparent;border:0;color:#9aa4b2;font:600 .82rem/1.4 'Inter',system-ui,sans-serif;padding:.45rem .8rem;border-radius:7px 7px 0 0;cursor:pointer}
.lt-tab:hover{color:#cdd6e3;background:rgba(255,255,255,.04)}
.lt-tab.active{color:#0d1117;background:linear-gradient(135deg,#b58cff,#6fd1ff)}
.lt-panel{display:none;padding:.25rem 1rem 1rem}
.lt-panel.active{display:block}
.lt-panel pre{margin:.75rem 0}
</style>`;
const TAB_SCRIPT = `<script>
(function(){
  function apply(group,name){
    document.querySelectorAll('.lt-tabs[data-group="'+group+'"]').forEach(function(box){
      var hit=box.querySelector('.lt-tab[data-tab="'+name+'"]');
      if(!hit)return;
      box.querySelectorAll('.lt-tab').forEach(function(b){b.classList.toggle('active',b.dataset.tab===name)});
      box.querySelectorAll('.lt-panel').forEach(function(p){p.classList.toggle('active',p.dataset.tab===name)});
    });
  }
  document.addEventListener('DOMContentLoaded',function(){
    document.querySelectorAll('.lt-tabs').forEach(function(box){
      var group=box.dataset.group||'platform';
      try{var saved=localStorage.getItem('lt-'+group);if(saved)apply(group,saved);}catch(e){}
      box.querySelectorAll('.lt-tab').forEach(function(btn){
        btn.addEventListener('click',function(){
          apply(group,btn.dataset.tab);
          try{localStorage.setItem('lt-'+group,btn.dataset.tab);}catch(e){}
        });
      });
    });
  });
})();
</script>`;

const page = ({ title, body, currentHref, depth, styleHref }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Loom</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css">
<link rel="stylesheet" href="${styleHref}">
${TAB_STYLE}
</head>
<body>
${header(currentHref, depth)}
<main class="container prose">
  <a class="back" href="${depth > 0 ? '../'.repeat(depth) : ''}index.html">← Back to home</a>
  ${body}
</main>
${footer(depth)}
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
<script>document.addEventListener('DOMContentLoaded', () => window.hljs && window.hljs.highlightAll());</script>
${TAB_SCRIPT}
</body>
</html>
`;

async function renderMdFile(srcPath, depth) {
  const src = await readFile(srcPath, 'utf8');
  const rel = relative(HERE, srcPath);
  const title = extractTitle(src, basename(srcPath, '.md'));
  const body = marked.parse(src);
  const outRel = rel.replace(/\.md$/, '.html');
  const outPath = join(OUT, outRel);
  await mkdir(dirname(outPath), { recursive: true });
  const styleHref = depth > 0 ? `${'../'.repeat(depth)}style.css` : 'style.css';
  await writeFile(outPath, page({ title, body, currentHref: outRel, depth, styleHref }));
  console.log(`rendered  ${rel} → ${outRel}`);
  return { title, outRel };
}

// Build an index.html for a rendered subdir.  GitHub Pages serves
// `dir/` as `dir/index.html`, so generating these makes README's
// `[plans/](plans/)` etc. resolve to a real listing instead of a 404.
// Entries are alphabetised by title; one bullet per file, linking to
// the rendered .html with the page's `# H1` as link text.
function buildIndexBody(subdir, entries) {
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  const items = sorted.map(
    ({ title, outRel }) =>
      `  <li><a href="${basename(outRel)}">${escapeHtml(title)}</a></li>`,
  );
  return `<h1>${escapeHtml(subdir)}/</h1>
<p>${escapeHtml(`${entries.length} document${entries.length === 1 ? '' : 's'}`)} in <code>docs/${subdir}/</code>.</p>
<ul>
${items.join('\n')}
</ul>`;
}

async function writeSubdirIndex(subdir, entries) {
  if (entries.length === 0) return;
  const body = buildIndexBody(subdir, entries);
  const outPath = join(OUT, subdir, 'index.html');
  const depth = subdir.split('/').length;
  const styleHref = `${'../'.repeat(depth)}style.css`;
  await writeFile(
    outPath,
    page({
      title: `${subdir}/`,
      body,
      currentHref: `${subdir}/index.html`,
      depth,
      styleHref,
    }),
  );
  console.log(`emitted   ${subdir}/index.html (${entries.length} entries)`);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Top-level .md files.
  const topEntries = await readdir(HERE);
  for (const f of topEntries) {
    if (!f.endsWith('.md')) continue;
    await renderMdFile(join(HERE, f), 0);
  }

  // Rendered subdirs (nested paths supported; depth = path segments).
  for (const sub of RENDERED_SUBDIRS) {
    const subDir = join(HERE, sub);
    const depth = sub.split('/').length;
    let subEntries;
    try {
      subEntries = await readdir(subDir);
    } catch {
      continue;
    }
    const rendered = [];
    for (const f of subEntries) {
      if (!f.endsWith('.md')) continue;
      const full = join(subDir, f);
      const s = await stat(full);
      if (!s.isFile()) continue;
      rendered.push(await renderMdFile(full, depth));
    }
    await writeSubdirIndex(sub, rendered);
  }

  // Copy the landing page, rewriting .md links → .html links (incl. subdirs).
  const indexSrc = await readFile(join(HERE, 'index.html'), 'utf8');
  const indexOut = indexSrc.replace(
    /href="((?:\.\.?\/)*(?:[a-zA-Z0-9_\-]+\/)?[a-zA-Z0-9_\-]+)\.md(#[^"]*)?"/g,
    'href="$1.html$2"',
  );
  await writeFile(join(OUT, 'index.html'), indexOut);
  console.log('copied    index.html (links rewritten)');

  await copyFile(join(HERE, '_template/style.css'), join(OUT, 'style.css'));
  console.log('copied    style.css');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
