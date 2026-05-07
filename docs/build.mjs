#!/usr/bin/env node
// Render docs/*.md → docs/_site/*.html using a template that matches
// the landing page styling. Copies docs/index.html with .md→.html
// link rewrites, and copies the shared stylesheet.

import { readFile, writeFile, readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { marked } from 'marked';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT  = join(HERE, '_site');

const NAV = [
  { label: 'Language',     href: 'language.html' },
  { label: 'Generators',   href: 'generators.html' },
  { label: 'Architecture', href: 'technical.html' },
  { label: 'Tools',        href: 'tools.html' },
];

// rewrite ./foo.md or foo.md (with optional #anchor) → foo.html
const MD_LINK = /^(?:\.\/)?([a-zA-Z0-9_\-]+)\.md(#.*)?$/;

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

const extractTitle = (md, fallback) => {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/^Loom\s+[—–-]\s+/, '') : fallback;
};

const navLinks = (currentHref) =>
  NAV.map(({ label, href }) =>
    `<a href="${href}"${href === currentHref ? ' class="current"' : ''}>${label}</a>`
  ).join('\n        ');

const header = (currentHref) => `<header class="site">
  <div class="container nav">
    <a class="brand" href="index.html">
      <svg class="logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <defs><linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b58cff"/><stop offset="1" stop-color="#6fd1ff"/></linearGradient></defs>
        <rect x="2" y="2" width="28" height="28" rx="7" stroke="url(#lg)" stroke-width="2"/>
        <path d="M7 10 L25 22 M7 16 L25 16 M7 22 L25 10" stroke="url(#lg)" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="brand-name">Loom</span>
    </a>
    <nav class="nav-links" aria-label="Primary">
        ${navLinks(currentHref)}
        <a class="btn" href="https://github.com/lemmit/loc" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>`;

const footer = `<footer class="site">
  <div class="container row">
    <div>© Loom contributors · FSL-1.1-Apache-2.0</div>
    <div class="links">
      ${NAV.map(({ label, href }) => `<a href="${href}">${label}</a>`).join('\n      ')}
      <a href="https://github.com/lemmit/loc" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>
</footer>`;

const page = ({ title, body, currentHref }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Loom</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css">
<link rel="stylesheet" href="style.css">
</head>
<body>
${header(currentHref)}
<main class="container prose">
  <a class="back" href="index.html">← Back to home</a>
  ${body}
</main>
${footer}
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
<script>document.addEventListener('DOMContentLoaded', () => window.hljs && window.hljs.highlightAll());</script>
</body>
</html>
`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const entries = await readdir(HERE);

  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const src = await readFile(join(HERE, f), 'utf8');
    const title = extractTitle(src, basename(f, '.md'));
    const body = marked.parse(src);
    const outName = f.replace(/\.md$/, '.html');
    await writeFile(join(OUT, outName), page({ title, body, currentHref: outName }));
    console.log(`rendered  ${f} → ${outName}`);
  }

  // Copy the landing page, rewriting .md links → .html links
  const indexSrc = await readFile(join(HERE, 'index.html'), 'utf8');
  const indexOut = indexSrc.replace(
    /href="(?:\.\/)?([a-zA-Z0-9_\-]+)\.md(#[^"]*)?"/g,
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
