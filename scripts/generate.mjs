// Generates the animated SVGs in assets/ and refreshes the dynamic parts of README.md.
// Only PUBLIC repositories are read: the /users/{user}/repos endpoint never returns private ones,
// and every repo is checked again for `private === false` before it is used.
//
// Usage: GITHUB_TOKEN=... node scripts/generate.mjs

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
const config = JSON.parse(await readFile(join(ROOT, 'scripts', 'projects.config.json'), 'utf8'));
const USER = config.user;
const NOW = new Date();

// ---------- themes ----------
const THEMES = {
  light: {
    bg: '#ffffff', fg: '#1f2328', muted: '#59636e', border: '#d1d9e0', subtle: '#f6f8fa', link: '#0969da',
    violet: '#6C63FF', teal: '#0EA5A4', navy: '#1F4E79', pac: '#f2b705',  },
  dark: {
    bg: '#0d1117', fg: '#f0f6fc', muted: '#9198a1', border: '#3d444d', subtle: '#151b23', link: '#4493f8',
    violet: '#8b84ff', teal: '#2cc5c3', navy: '#5b8fc4', pac: '#ffd43b',  },
};
const LANG_COLORS = {
  'C#': '#178600', Swift: '#F05138', Python: '#3572A5', Java: '#b07219', JavaScript: '#f1e05a', TypeScript: '#3178c6',
  HTML: '#e34c26', CSS: '#663399', Shell: '#89e051', PowerShell: '#012456', C: '#555555', 'C++': '#f34b7d',
  Kotlin: '#A97BFF', Go: '#00ADD8', Rust: '#dea584', VHDL: '#adb2cb', Other: '#8b949e',
};
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace`;
const REDUCED = `@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`;

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textWidth = (s, size) => s.length * size * 0.56; // rough average for sans-serif
function wrap(text, maxChars, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}
function ago(date) {
  const days = Math.floor((NOW - new Date(date)) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}
const fmtDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const svg = (w, h, body, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>\n`;
async function save(name, content) { await writeFile(join(OUT, name), content, 'utf8'); }
async function saveThemed(base, render) {
  for (const t of Object.keys(THEMES)) await save(`${base}-${t}.svg`, render(THEMES[t], t));
}

// ---------- GitHub API ----------
async function gh(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'profile-readme-generator' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404 || res.status === 409) return null; // no releases / empty repo
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function loadRepos() {
  const all = await gh(`/users/${USER}/repos?type=owner&per_page=100&sort=pushed`);
  // Only the repositories listed in scripts/projects.txt are shown (one name per line, # for comments).
  const wanted = (await readFile(join(ROOT, 'scripts', 'projects.txt'), 'utf8'))
    .split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const wantedLower = new Set(wanted.map((n) => n.toLowerCase()));
  const repos = all.filter((r) => !r.private && r.visibility === 'public' && !r.fork && !config.exclude.includes(r.name)
    && wantedLower.has(r.name.toLowerCase()));
  const found = new Set(repos.map((r) => r.name.toLowerCase()));
  for (const n of wanted) if (!found.has(n.toLowerCase())) console.warn(`Skipped "${n}": not a public, non-fork repository of ${USER}`);
  for (const r of repos) {
    const o = config.overrides[r.name] || {};
    r.displayName = o.name || r.name;
    // The repository's own description and topics win; projects.config.json is only a fallback.
    r.desc = r.description || o.description || '';
    r.tags = r.topics?.length ? r.topics : o.topics || [];
    r.languagesBytes = (await gh(`/repos/${USER}/${r.name}/languages`)) || {};
    const releases = (await gh(`/repos/${USER}/${r.name}/releases?per_page=100`)) || [];
    const published = releases.filter((x) => !x.draft);
    r.latestTag = published.find((x) => !x.prerelease)?.tag_name || published[0]?.tag_name || null;
    r.downloads = published.reduce((n, x) => n + x.assets.reduce((m, a) => m + a.download_count, 0), 0);
    const commits = await gh(`/repos/${USER}/${r.name}/commits?per_page=1`);
    r.lastCommit = commits?.[0]?.commit?.message?.split('\n')[0] || '';
  }
  repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
  return repos;
}

// ---------- shared pieces ----------
// Gradient bar on top of a card, clipped to the card's rounded shape (static: the chomp dividers are the main motion).
const topBar = (t, w, id) => `
  <defs>
    <linearGradient id="${id}g" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${t.violet}"/><stop offset="0.25" stop-color="${t.teal}"/><stop offset="0.5" stop-color="${t.violet}"/>
      <stop offset="0.75" stop-color="${t.teal}"/><stop offset="1" stop-color="${t.violet}"/>
    </linearGradient>
    <clipPath id="${id}c"><rect x="0.5" y="0.5" width="${w - 1}" height="100%" rx="12"/></clipPath>
  </defs>
  <g clip-path="url(#${id}c)"><rect x="0" y="0" width="${w * 2}" height="3" fill="url(#${id}g)"/></g>`;
const barStyle = () => '';

// ---------- header ----------
function header(t) {
  return svg(900, 200, `
  <style>
    .w1 { animation: drift 9s ease-in-out infinite alternate; }
    .w2 { animation: drift 7s ease-in-out infinite alternate-reverse; }
    @keyframes drift { from { transform: translateX(-60px); } to { transform: translateX(0); } }
    ${REDUCED}
  </style>
  <defs>
    <linearGradient id="hg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#6C63FF"/><stop offset="1" stop-color="#0EA5A4"/></linearGradient>
    <clipPath id="hc"><rect width="900" height="200" rx="14"/></clipPath>
  </defs>
  <g clip-path="url(#hc)">
    <rect width="900" height="200" fill="url(#hg)"/>
    <path class="w1" fill="#fff" fill-opacity="0.12" d="M-60 150 Q 90 110 240 150 T 540 150 T 840 150 T 1140 150 V 200 H -60 Z"/>
    <path class="w2" fill="#fff" fill-opacity="0.18" d="M-60 170 Q 75 140 210 170 T 480 170 T 750 170 T 1020 170 V 200 H -60 Z"/>
    <text x="450" y="92" text-anchor="middle" fill="#fff" font-family="${FONT}" font-weight="700" font-size="46">Hi, I'm Tommaso 👋</text>
    <text x="450" y="130" text-anchor="middle" fill="#fff" fill-opacity="0.88" font-family="${FONT}" font-weight="500" font-size="20">Computer Science and Engineering @ Politecnico di Milano</text>
  </g>`, "Hi, I'm Tommaso");
}

// ---------- footer wave ----------
function footer(t) {
  return svg(900, 120, `
  <style>
    .w1 { animation: drift 9s ease-in-out infinite alternate; }
    .w2 { animation: drift 7s ease-in-out infinite alternate-reverse; }
    @keyframes drift { from { transform: translateX(-60px); } to { transform: translateX(0); } }
    ${REDUCED}
  </style>
  <defs>
    <linearGradient id="fg" x1="0" x2="1" y1="1" y2="0"><stop offset="0" stop-color="#0EA5A4"/><stop offset="1" stop-color="#6C63FF"/></linearGradient>
    <clipPath id="fc"><rect width="900" height="120" rx="14"/></clipPath>
  </defs>
  <g clip-path="url(#fc)">
    <path class="w2" fill="url(#fg)" fill-opacity="0.45" d="M-60 40 Q 75 10 210 40 T 480 40 T 750 40 T 1020 40 V 120 H -60 Z"/>
    <path class="w1" fill="url(#fg)" d="M-60 60 Q 90 25 240 60 T 540 60 T 840 60 T 1140 60 V 120 H -60 Z"/>
    <text x="450" y="98" text-anchor="middle" fill="#fff" font-family="${FONT}" font-weight="600" font-size="17">Thanks for stopping by</text>
  </g>`, 'Thanks for stopping by');
}

// ---------- chomp dividers ----------
// A yellow character with an opening and closing mouth crosses each divider, eating the dots.
// Each divider is its own image; divider i starts after i * SLOT seconds and runs in the opposite
// direction of the previous one, so together they look like one character zigzagging down the page.
const DIVIDERS = 4, SLOT = 4, CYCLE = DIVIDERS * SLOT, START = -120, END = 1020;
function chomp(t, i) {
  const left = i % 2 === 1;
  const pct = ((SLOT / CYCLE) * 100).toFixed(3);
  let dots = '';
  for (let x = 15; x < 900; x += 30) {
    const at = ((x + 2 - START) / (END - START)) * SLOT + i * SLOT;
    const big = x % 150 === 135;
    dots += `<circle class="p" cx="${x}" cy="12" r="${big ? 4.5 : 3}" fill="${(x / 30) % 2 < 1 ? t.violet : t.teal}" style="animation-delay:${at.toFixed(2)}s"/>`;
  }
  const body = `<g transform="translate(-12 12)">
      <g class="jt"><path d="M0 0 L10 0 A10 10 0 0 0 -10 0 Z" fill="${t.pac}"/><circle cx="1.5" cy="-5.5" r="1.6" fill="#1f2328"/></g>
      <path class="jb" d="M0 0 L10 0 A10 10 0 0 1 -10 0 Z" fill="${t.pac}"/>
    </g>`;
  return svg(900, 24, `
  <style>
    .s { transform: translateX(${START}px); animation: move ${CYCLE}s linear ${(i * SLOT).toFixed(2)}s infinite; }
    @keyframes move { 0% { transform: translateX(${START}px); } ${pct}% { transform: translateX(${END}px); } 100% { transform: translateX(${END}px); } }
    .jt { animation: jt .35s ease-in-out infinite alternate; } @keyframes jt { to { transform: rotate(-38deg); } }
    .jb { animation: jb .35s ease-in-out infinite alternate; } @keyframes jb { to { transform: rotate(38deg); } }
    .p { transform-box: fill-box; transform-origin: center; animation: eat ${CYCLE}s linear infinite; }
    @keyframes eat { 0% { opacity: 0; transform: scale(.2); } 62% { opacity: 0; transform: scale(.2); } 72%, 100% { opacity: 1; transform: scale(1); } }
    ${REDUCED}
  </style>
  <g${left ? ' transform="translate(900 0) scale(-1 1)"' : ''}>${dots}<g class="s">${body}</g></g>`, 'Divider');
}

// ---------- about me ----------
const ABOUT = [
  { key: 'Degree path', value: 'BSc 2023–2026 → MSc 2026–2028', color: 'violet',
    icon: `<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/><path class="swing" d="M22 9v6"/>` },
  { key: 'Based in', value: 'Italy', color: 'teal',
    icon: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><ellipse class="spin" cx="12" cy="12" rx="4" ry="9"/>` },
  { key: 'Building', value: "Tools I'd use myself: desktop widgets, study planners, dashboards", color: 'navy',
    icon: `<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path class="blink" d="M13.5 5l-3 14"/>` },
  { key: 'Curious about', value: 'New languages, frameworks and how things work under the hood', color: 'teal',
    icon: `<path d="M12 21v-9"/><path class="grow" d="M12 12c0-4 3-6 7-6c0 4-3 6-7 6z"/><path class="grow g2" d="M12 14c0-3-2.5-5-6-5c0 3 2.5 5 6 5z"/>` },
];
function about(t) {
  const W = 900, CW = 441, CH = 92, GAP = 18;
  const cards = ABOUT.map((a, i) => {
    const x = (i % 2) * (CW + GAP), y = Math.floor(i / 2) * (CH + 14);
    const c = t[a.color];
    const lines = wrap(a.value, 50, 2);
    return `<g transform="translate(${x} ${y})">
      <rect x="0.5" y="0.5" width="${CW - 1}" height="${CH - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
      <g transform="translate(0 0)">${topBar(t, CW, `a${i}`).replace('height="100%"', `height="${CH - 1}"`)}</g>
      <rect x="16" y="18" width="40" height="40" rx="10" fill="${c}" fill-opacity="0.14"/>
      <g transform="translate(25 27)" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${a.icon}</g>
      <text x="72" y="33" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${t.muted}">${esc(a.key)}</text>
      ${lines.map((l, j) => `<text x="72" y="${53 + j * 19}" font-family="${FONT}" font-size="14" fill="${t.fg}">${esc(l)}</text>`).join('')}
    </g>`;
  }).join('');
  return svg(W, 2 * CH + 14, `
  <style>
    ${barStyle(CW)}
    /* each icon plays once on load, then rests */
    .swing { transform-origin: 22px 9px; animation: swing 1.2s ease-in-out 2; }
    @keyframes swing { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(18deg); } }
    .spin { transform-origin: 12px 12px; animation: spin 2s ease-in-out 1; }
    @keyframes spin { 0%, 100% { transform: scaleX(1); } 50% { transform: scaleX(0.15); } }
    .blink { animation: blink 1.2s steps(1) 3; } @keyframes blink { 50% { opacity: 0; } }
    .grow { transform-origin: 12px 13px; animation: grow 1.5s ease-in-out 1; } .g2 { animation-delay: .4s; }
    @keyframes grow { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.15); } }
    ${REDUCED}
  </style>${cards}`, 'About me');
}

// ---------- currently working on ----------
function now(t, repo) {
  const msg = repo.lastCommit.length > 90 ? repo.lastCommit.slice(0, 89) + '…' : repo.lastCommit;
  // Same look as the About me cards (border, top bar, tinted icon box), full width; the dot pulses.
  const W = 900, H = 92;
  return svg(W, H, `
  <style>
    .ring { transform-origin: 36px 38px; animation: pulse 2s ease-out infinite; }
    @keyframes pulse { 0% { transform: scale(1); opacity: .6; } 100% { transform: scale(2.6); opacity: 0; } }
    ${REDUCED}
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  ${topBar(t, W, 'n').replace('height="100%"', `height="${H - 1}"`)}
  <rect x="16" y="18" width="40" height="40" rx="10" fill="${t.teal}" fill-opacity="0.14"/>
  <circle class="ring" cx="36" cy="38" r="5" fill="${t.teal}"/>
  <circle cx="36" cy="38" r="5" fill="${t.teal}"/>
  <text x="72" y="33" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${t.muted}">Currently working on</text>
  <text x="72" y="53" font-family="${FONT}" font-size="14" fill="${t.fg}"><tspan font-weight="700" fill="${t.link}">${esc(repo.displayName)}</tspan><tspan fill="${t.muted}"> · last push ${esc(ago(repo.pushed_at))}</tspan></text>
  <text x="72" y="72" font-family="${MONO}" font-size="12.5" fill="${t.muted}">“${esc(msg)}”</text>`, `Currently working on ${repo.displayName}`);
}

// ---------- project card ----------
function card(t, r, idx) {
  const W = 440, H = 188;
  const ver = r.latestTag || 'no release';
  const verW = ver.length * 6.8 + 16;
  const lines = wrap(r.desc, 58, 3);
  let tx = 20, topics = '';
  for (const tag of r.tags) {
    const w = textWidth(tag, 11) + 18;
    if (tx + w > W - 20) break;
    topics += `<rect x="${tx}" y="122" width="${w}" height="20" rx="10" fill="${t.link}" fill-opacity="0.12"/>
      <text x="${tx + w / 2}" y="136" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="500" fill="${t.link}">${esc(tag)}</text>`;
    tx += w + 6;
  }
  const parts = [`★ ${r.stargazers_count}`];
  if (r.downloads) parts.push(`⤓ ${r.downloads} downloads`);
  parts.push(`updated ${ago(r.pushed_at)}`);
  const langW = textWidth(r.language || 'Code', 12) + 36;
  return svg(W, H, `
  <style>${barStyle(W)} ${REDUCED}</style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  ${topBar(t, W, `c${idx}`).replace('height="100%"', `height="${H - 1}"`)}
  <text x="20" y="40" font-family="${FONT}" font-size="18" font-weight="700" fill="${t.fg}">${esc(r.displayName)}</text>
  <rect x="${W - 20 - verW}" y="24" width="${verW}" height="20" rx="10" fill="none" stroke="${r.latestTag ? t.teal : t.border}"/>
  <text x="${W - 20 - verW / 2}" y="38" text-anchor="middle" font-family="${MONO}" font-size="11" fill="${r.latestTag ? t.teal : t.muted}">${esc(ver)}</text>
  ${lines.map((l, j) => `<text x="20" y="${68 + j * 18}" font-family="${FONT}" font-size="13" fill="${t.muted}">${esc(l)}</text>`).join('')}
  ${topics}
  <circle cx="25" cy="166" r="5" fill="${LANG_COLORS[r.language] || LANG_COLORS.Other}"/>
  <text x="36" y="170" font-family="${FONT}" font-size="12" fill="${t.muted}">${esc(r.language || 'Code')}</text>
  <text x="${20 + langW}" y="170" font-family="${FONT}" font-size="12" fill="${t.muted}">${esc(parts.join('   ·   '))}</text>`, `${r.displayName} project card`);
}

// ---------- stats ----------
function languages(t, langs) {
  const W = 900, H = 160;
  let x = 20, bar = '';
  const barW = W - 40;
  langs.forEach(([l, p], i) => {
    const w = Math.max(1, (barW - (langs.length - 1) * 2) * p / 100);
    bar += `<rect x="${x.toFixed(1)}" y="54" width="${w.toFixed(1)}" height="10" fill="${LANG_COLORS[l] || LANG_COLORS.Other}"/>`;
    x += w + 2;
  });
  const list = langs.map(([l, p], i) => {
    const cx = 20 + (i % 4) * 215, cy = 98 + Math.floor(i / 4) * 28;
    return `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${LANG_COLORS[l] || LANG_COLORS.Other}"/>
      <text x="${cx + 16}" y="${cy}" font-family="${FONT}" font-size="12.5" fill="${t.fg}">${esc(l)} <tspan fill="${t.muted}">${p.toFixed(1)}%</tspan></text>`;
  }).join('');
  return svg(W, H, `
  <style>.grow { transform-origin: 20px 59px; animation: grow 1.2s ease-out both; } @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } } ${REDUCED}</style>
  <defs><clipPath id="lb"><rect x="20" y="54" width="${barW}" height="10" rx="5"/></clipPath></defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  <text x="20" y="34" font-family="${FONT}" font-size="15" font-weight="700" fill="${t.violet}">Most used languages</text>
  <g clip-path="url(#lb)"><g class="grow">${bar}</g></g>
  ${list}`, 'Most used languages');
}
// ---------- README ----------
const picture = (base, alt, width) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="./assets/${base}-dark.svg"><img src="./assets/${base}-light.svg" alt="${esc(alt)}"${width ? ` width="${width}"` : ''}></picture>`;
function replaceBlock(md, key, content) {
  const re = new RegExp(`(<!-- ${key}:START -->)[\\s\\S]*?(<!-- ${key}:END -->)`);
  if (!re.test(md)) throw new Error(`Marker ${key} missing in README.md`);
  return md.replace(re, `$1\n${content}\n$2`);
}

// ---------- main ----------
await mkdir(OUT, { recursive: true });
const repos = await loadRepos();
if (!repos.length) throw new Error('No public repositories found');

await saveThemed('header', header);
await saveThemed('footer', footer);
await saveThemed('about', about);for (let i = 0; i < DIVIDERS; i++) await saveThemed(`divider-${i}`, (t) => chomp(t, i));
await saveThemed('now', (t) => now(t, repos[0]));

const slug = (r) => r.name.toLowerCase();
for (const [i, r] of repos.entries()) await saveThemed(`card-${slug(r)}`, (t) => card(t, r, i));
// Remove cards of projects no longer listed in projects.txt.
const keep = new Set(repos.flatMap((r) => Object.keys(THEMES).map((t) => `card-${slug(r)}-${t}.svg`)));
for (const f of await readdir(OUT)) if (f.startsWith('card-') && !keep.has(f)) await unlink(join(OUT, f));

const bytes = {};
for (const r of repos) for (const [l, b] of Object.entries(r.languagesBytes)) bytes[l] = (bytes[l] || 0) + b;
const total = Object.values(bytes).reduce((a, b) => a + b, 0);
const sorted = Object.entries(bytes).sort((a, b) => b[1] - a[1]);
const top = sorted.slice(0, 7).map(([l, b]) => [l, (b / total) * 100]);
const rest = sorted.slice(7).reduce((a, [, b]) => a + b, 0);
if (rest) top.push(['Other', (rest / total) * 100]);
await saveThemed('languages', (t) => languages(t, top));

let md = await readFile(join(ROOT, 'README.md'), 'utf8');
md = replaceBlock(md, 'NOW', `<p align="center">\n  <a href="${repos[0].html_url}">${picture('now', `Currently working on ${repos[0].displayName}`, '100%')}</a>\n</p>`);
// Cards go two per row; each row is its own line, so an odd last card ends up centered on its own.
const cardLinks = repos.map((r) => `<a href="${r.html_url}">${picture(`card-${slug(r)}`, r.displayName, '49%')}</a>`);
const rows = [];
for (let i = 0; i < cardLinks.length; i += 2) rows.push('  ' + cardLinks.slice(i, i + 2).join('\n  '));
md = replaceBlock(md, 'PROJECTS', `<p align="center">\n${rows.join('\n  <br>\n')}\n</p>`);
md = replaceBlock(md, 'UPDATED', `<p align="center"><sub>Updated automatically every night · last run ${fmtDate(NOW)}</sub></p>`);
await writeFile(join(ROOT, 'README.md'), md, 'utf8');

console.log(`Generated assets for ${repos.length} public repos: ${repos.map((r) => r.name).join(', ')}`);
