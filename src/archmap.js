// Layered interactive architecture map — C4-style semantic zoom over the
// repo's own index, all derived, nothing hand-authored:
//   L1 overview:  subsystem cards (top-level dirs) with weighted import edges
//   L2 cluster:   the files of one subsystem, plus collapsed neighbor cards
//   L3 file:      symbols with intra-file call edges, importers and imports
// Deep links: #c=<cluster> and #f=<file> address levels directly.
// Self-contained HTML, no external assets, no libraries.
import fs from 'node:fs';
import path from 'node:path';
import { Index } from './indexer.js';
import { buildReverseImports } from './imports.js';

const MAX_FILE_NODES = 400;

function topDir(relPath) {
  const i = relPath.indexOf('/');
  return i === -1 ? '.' : relPath.slice(0, i);
}

// Adaptive clustering: a directory that holds many files AND has its own
// subdirectories splits one level deeper (src-layout projects otherwise
// collapse into a single "src" bag that hides the real structure).
function computeClusters(paths) {
  const SPLIT = 12;
  const MAXDEPTH = 4;
  const out = new Map();
  const rec = (list, prefix, depth) => {
    const bySeg = new Map();
    const here = [];
    for (const p of list) {
      const rest = prefix ? p.slice(prefix.length + 1) : p;
      const i = rest.indexOf('/');
      if (i === -1) here.push(p);
      else {
        const seg = rest.slice(0, i);
        if (!bySeg.has(seg)) bySeg.set(seg, []);
        bySeg.get(seg).push(p);
      }
    }
    for (const p of here) out.set(p, prefix || '.');
    for (const [seg, sub] of bySeg) {
      const childPrefix = prefix ? prefix + '/' + seg : seg;
      const hasSubdirs = sub.some((p) => p.slice(childPrefix.length + 1).includes('/'));
      if (depth < MAXDEPTH && sub.length > SPLIT && hasSubdirs) rec(sub, childPrefix, depth + 1);
      else for (const p of sub) out.set(p, childPrefix);
    }
  };
  rec(paths, '', 1);
  return out;
}

export async function collectMapData(root, liveIndex = null) {
  const index = liveIndex ?? new Index(root);
  await index.ensure();
  const g = index.graph;
  const reverse = buildReverseImports(g); // target -> Set(importers)

  let nodes = [];
  let edges = []; // [from, to] = importer -> imported
  const fileCount = g.files.size;
  const aggregated = fileCount > MAX_FILE_NODES;

  if (!aggregated) {
    const clusterOf = computeClusters([...g.files.keys()]);
    for (const [file, rec] of g.files) {
      const syms = rec.symbols.filter((s) => !s.parent);
      // intra-file call pairs between named symbols, for the symbol level
      const names = new Set(rec.symbols.map((s) => s.name));
      const callPairs = [];
      const seenPair = new Set();
      for (const c of rec.calls) {
        if (c.caller < 0 || !names.has(c.callee)) continue;
        const from = rec.symbols[c.caller]?.name;
        if (!from || from === c.callee) continue;
        const key = from + ' ' + c.callee;
        if (seenPair.has(key) || callPairs.length >= 60) continue;
        seenPair.add(key);
        callPairs.push([from, c.callee]);
      }
      nodes.push({
        id: file,
        cluster: clusterOf.get(file) || topDir(file),
        lang: rec.lang,
        symbols: rec.symbols.length,
        top: syms
          .sort((a, b) => Number(b.exported) - Number(a.exported))
          .slice(0, 10)
          .map((s) => `${s.kind} ${s.name}${s.exported ? ' *' : ''}`),
        syms: rec.symbols
          .slice(0, 40)
          .map((s) => ({ n: s.name, k: s.kind, l: s.startLine, e: s.exported ? 1 : 0, p: s.parent || null })),
        calls: callPairs
      });
    }
    for (const [target, importers] of reverse) {
      for (const imp of importers) edges.push([imp, target]);
    }
  } else {
    const dirOf = (file) => (topDir(file) === '.' ? '.' : file.split('/').slice(0, 2).join('/'));
    const dirs = new Map();
    for (const [file, rec] of g.files) {
      const d = dirOf(file);
      if (!dirs.has(d)) dirs.set(d, { files: 0, symbols: 0, langs: new Set() });
      const e = dirs.get(d);
      e.files++;
      e.symbols += rec.symbols.length;
      e.langs.add(rec.lang);
    }
    const agg = new Map();
    for (const [target, importers] of reverse) {
      for (const imp of importers) {
        const a = dirOf(imp);
        const b = dirOf(target);
        if (a !== b) agg.set(a + ' ' + b, (agg.get(a + ' ' + b) || 0) + 1);
      }
    }
    nodes = [...dirs.entries()].map(([d, e]) => ({
      id: d,
      cluster: topDir(d),
      lang: [...e.langs].join(', '),
      symbols: e.symbols,
      top: [`${e.files} files`],
      syms: [],
      calls: []
    }));
    edges = [...agg.keys()].map((k) => k.split(' '));
  }
  return { nodes, edges, aggregated, fileCount, root };
}

export async function generateArchMap(root, liveIndex = null) {
  const data = await collectMapData(root, liveIndex);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<title>Codegraph Map</title>
<style>
  :root {
    color-scheme: light;
    --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --border:rgba(11,11,11,0.10); --edge:rgba(11,11,11,0.18); --dotgrid:rgba(11,11,11,0.06);
    --up:#2a78d6; --down:#d95926;
    --c1:#2a78d6; --c2:#eb6834; --c3:#1baf7a; --c4:#eda100; --c5:#e87ba4; --c6:#008300; --c7:#4a3aa7; --c8:#e34948; --c0:#898781;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --border:rgba(255,255,255,0.10); --edge:rgba(255,255,255,0.22); --dotgrid:rgba(255,255,255,0.07);
    --up:#3987e5; --down:#eb6834;
    --c1:#3987e5; --c2:#d95926; --c3:#199e70; --c4:#c98500; --c5:#d55181; --c6:#008300; --c7:#9085e9; --c8:#e66767; --c0:#898781;
  } }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --border:rgba(255,255,255,0.10); --edge:rgba(255,255,255,0.22); --dotgrid:rgba(255,255,255,0.07);
    --up:#3987e5; --down:#eb6834;
    --c1:#3987e5; --c2:#d95926; --c3:#199e70; --c4:#c98500; --c5:#d55181; --c6:#008300; --c7:#9085e9; --c8:#e66767; --c0:#898781;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--ink); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; overflow:hidden; }
  #bar { display:flex; gap:8px; align-items:center; padding:9px 14px; border-bottom:1px solid var(--grid); background:var(--surface); flex-wrap:wrap; }
  #bar h1 { font-size:14px; margin:0 2px 0 0; }
  #crumbs { display:flex; gap:4px; align-items:center; font-size:12.5px; color:var(--muted); }
  #crumbs a { color:var(--ink2); cursor:pointer; text-decoration:none; padding:2px 5px; border-radius:5px; }
  #crumbs a:hover { color:var(--ink); background:var(--page); }
  #crumbs .here { color:var(--ink); font-weight:600; padding:2px 5px; }
  #q { flex:0 1 210px; margin-left:auto; padding:5px 10px; border:1px solid var(--grid); border-radius:8px; background:var(--page); color:var(--ink); font:13px system-ui,sans-serif; }
  #q:focus { outline:2px solid var(--up); outline-offset:1px; }
  button { padding:5px 11px; border:1px solid var(--grid); border-radius:8px; background:var(--surface); color:var(--ink2); font:12.5px system-ui,sans-serif; cursor:pointer; }
  button:hover { color:var(--ink); border-color:var(--muted); }
  button.on { border-color:var(--up); color:var(--ink); }
  #wrap { display:flex; height:calc(100vh - 45px); }
  #svgbox { flex:1; }
  #svg { cursor:grab; display:block; }
  #svg.panning { cursor:grabbing; }
  #panel { width:312px; border-left:1px solid var(--grid); background:var(--surface); padding:14px 16px; overflow-y:auto; font-size:13px; }
  #panel h2 { font-size:13px; margin:0 0 2px; word-break:break-all; }
  #panel h3 { font-size:11px; margin:12px 0 4px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  #panel .meta { color:var(--ink2); font-size:12px; margin:0 0 4px; }
  #panel ul { margin:4px 0; padding-left:16px; color:var(--ink2); font-size:12.5px; }
  #panel li { margin:2px 0; word-break:break-all; }
  #panel li.link, #panel .link { cursor:pointer; }
  #panel li.link:hover, #panel .link:hover { color:var(--ink); text-decoration:underline; }
  #panel .hint { color:var(--muted); font-size:12px; line-height:1.5; }
  .kbd { border:1px solid var(--grid); border-radius:4px; padding:0 4px; font:11px ui-monospace,monospace; color:var(--ink2); }
  /* svg */
  .clusterbox { fill:var(--surface); stroke:var(--border); }
  .clusterlabel { font:600 10.5px system-ui,sans-serif; letter-spacing:.08em; text-transform:uppercase; fill:var(--muted); }
  .bigcard rect.body { fill:var(--surface); stroke:var(--border); }
  .bigcard text.title { font:600 13px system-ui,sans-serif; fill:var(--ink); }
  .bigcard text.sub { font:11px system-ui,sans-serif; fill:var(--ink2); }
  .bigcard text.mini { font:10.5px system-ui,sans-serif; fill:var(--muted); }
  .bigcard { cursor:pointer; }
  .bigcard:hover rect.body { stroke:var(--muted); }
  .node rect.body { fill:var(--page); stroke:var(--border); }
  .node text { font:11.5px system-ui,sans-serif; fill:var(--ink); pointer-events:none; }
  .node .sym { font:9.5px system-ui,sans-serif; fill:var(--muted); }
  .node { cursor:pointer; }
  .node:hover rect.body { stroke:var(--muted); }
  .node.sel rect.body { stroke:var(--ink); stroke-width:1.6; }
  .edge { fill:none; stroke:var(--edge); stroke-width:1; }
  .edge.w2 { stroke-width:1.6; }
  .edge.w3 { stroke-width:2.4; }
  .edge.up { stroke:var(--up); stroke-width:1.8; stroke-dasharray:6 5; animation:flow 1.1s linear infinite; }
  .edge.down { stroke:var(--down); stroke-width:1.8; stroke-dasharray:6 5; animation:flow 1.1s linear infinite; }
  @keyframes flow { to { stroke-dashoffset:-11; } }
  @media (prefers-reduced-motion: reduce) { .edge.up, .edge.down { animation:none; } }
  .elabel { font:10px system-ui,sans-serif; fill:var(--muted); paint-order:stroke; stroke:var(--page); stroke-width:3px; stroke-linejoin:round; }
  .dim { opacity:.13; }
</style>
<div id="bar">
  <h1>Codegraph Map</h1>
  <span id="crumbs"></span>
  <input id="q" type="search" placeholder="search ( / )" aria-label="Search">
  <button id="reach">reach: direct</button>
  <button id="fit">fit</button>
</div>
<div id="wrap">
  <div id="svgbox"><svg id="svg" width="100%" height="100%" role="img" aria-label="Repository architecture map">
    <defs>
      <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--dotgrid)"></circle></pattern>
      <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.6 L7.4,4 L0,7.4 Z" fill="var(--edge)"></path></marker>
      <marker id="arr-up" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.6 L7.4,4 L0,7.4 Z" fill="var(--up)"></path></marker>
      <marker id="arr-down" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.6 L7.4,4 L0,7.4 Z" fill="var(--down)"></path></marker>
    </defs>
    <g id="scene"></g>
  </svg></div>
  <aside id="panel"><div id="detail"></div></aside>
</div>
<script>
(function () {
  var DATA = ${json};
  var svg = document.getElementById('svg');
  var scene = document.getElementById('scene');
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, cls, parent) { var e = document.createElementNS(NS, tag); if (cls) e.setAttribute('class', cls); (parent || scene).appendChild(e); return e; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  var nodes = DATA.nodes, edges = DATA.edges;
  var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
  edges = edges.filter(function (e) { return byId[e[0]] && byId[e[1]] && e[0] !== e[1]; });
  var inb = {}, outb = {};
  edges.forEach(function (e) {
    (inb[e[1]] = inb[e[1]] || []).push(e[0]);
    (outb[e[0]] = outb[e[0]] || []).push(e[1]);
  });
  nodes.forEach(function (n) { n.deg = (inb[n.id] || []).length; });

  var clusterNames = []; nodes.forEach(function (n) { if (clusterNames.indexOf(n.cluster) < 0) clusterNames.push(n.cluster); });
  clusterNames.sort();
  function colorVar(cluster) { var i = clusterNames.indexOf(cluster); return 'var(--c' + (i < 8 ? i + 1 : 0) + ')'; }
  function clusterFiles(c) { return nodes.filter(function (n) { return n.cluster === c; }); }
  // display names: last path segment, widened to two segments on collisions
  var displayName = {};
  (function () {
    var lastSeg = function (c, n) { return c === '.' ? 'root' : c.split('/').slice(-n).join('/'); };
    var counts = {};
    clusterNames.forEach(function (c) { var k = lastSeg(c, 1); counts[k] = (counts[k] || 0) + 1; });
    clusterNames.forEach(function (c) { displayName[c] = lastSeg(c, counts[lastSeg(c, 1)] > 1 ? 2 : 1); });
  })();
  var cName = function (c) { return displayName[c] || c; };
  function shortName(id) {
    var parts = id.split('/');
    var base = parts[parts.length - 1];
    // __init__.py / index.js alone say nothing — include the package dir
    if (/^(__init__\.|index\.)/.test(base) && parts.length > 1) return parts[parts.length - 2] + '/' + base;
    return base;
  }

  // aggregated cluster->cluster weights
  var cAgg = {};
  edges.forEach(function (e) {
    var a = byId[e[0]].cluster, b = byId[e[1]].cluster;
    if (a === b) return;
    var k = a + '\\u0000' + b;
    cAgg[k] = (cAgg[k] || 0) + 1;
  });

  var reachAll = false, selected = null;
  function reach(start, map) {
    var seen = {}, q = [start];
    while (q.length) {
      var cur = q.shift();
      (map[cur] || []).forEach(function (nx) { if (!seen[nx]) { seen[nx] = 1; if (reachAll) q.push(nx); } });
    }
    return seen;
  }

  // ---- shared drawing ----
  var bounds;
  function grow(x, y, w, h) {
    bounds.x0 = Math.min(bounds.x0, x); bounds.y0 = Math.min(bounds.y0, y);
    bounds.x1 = Math.max(bounds.x1, x + w); bounds.y1 = Math.max(bounds.y1, y + h);
  }
  function anchor(r, tx, ty) {
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    var s = Math.min((r.w / 2) / Math.abs(dx || 1e-9), (r.h / 2) / Math.abs(dy || 1e-9));
    return [cx + dx * s, cy + dy * s];
  }
  function curve(ra, rb, opts) {
    opts = opts || {};
    var ac = [ra.x + ra.w / 2, ra.y + ra.h / 2], bc = [rb.x + rb.w / 2, rb.y + rb.h / 2];
    var p1 = anchor(ra, bc[0], bc[1]), p2 = anchor(rb, ac[0], ac[1]);
    var mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
    var dx = p2[0] - p1[0], dy = p2[1] - p1[1], d = Math.sqrt(dx * dx + dy * dy) || 1;
    var bend = Math.min(30, d * 0.14) * (opts.bend == null ? 1 : opts.bend);
    var ox = -dy / d * bend, oy = dx / d * bend;
    var cpx = mx + ox, cpy = my + oy;
    var p = el('path', 'edge' + (opts.cls ? ' ' + opts.cls : ''));
    p.setAttribute('d', 'M' + p1[0] + ',' + p1[1] + ' Q' + cpx + ',' + cpy + ' ' + p2[0] + ',' + p2[1]);
    p.setAttribute('marker-end', 'url(#arr)');
    var labelEl = null;
    if (opts.label) {
      // point on the quadratic at t — off-center placement spreads labels
      var lt = opts.labelT == null ? 0.5 : opts.labelT;
      var it = 1 - lt;
      var lx = it * it * p1[0] + 2 * it * lt * cpx + lt * lt * p2[0];
      var ly = it * it * p1[1] + 2 * it * lt * cpy + lt * lt * p2[1];
      labelEl = el('text', 'elabel');
      labelEl.setAttribute('x', lx); labelEl.setAttribute('y', ly - 3); labelEl.setAttribute('text-anchor', 'middle');
      labelEl.textContent = opts.label;
    }
    return { path: p, labelEl: labelEl };
  }
  // deterministic pass: push overlapping edge labels apart vertically
  function spreadLabels(labels) {
    labels = labels.filter(Boolean);
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < labels.length; i++) for (var j = i + 1; j < labels.length; j++) {
        var A = labels[i], B = labels[j];
        var ax = +A.getAttribute('x'), ay = +A.getAttribute('y');
        var bx = +B.getAttribute('x'), by = +B.getAttribute('y');
        var wHalf = (A.textContent.length + B.textContent.length) * 2.7;
        if (Math.abs(ax - bx) < wHalf && Math.abs(ay - by) < 13) {
          B.setAttribute('y', by + (by >= ay ? 14 : -14));
        }
      }
    }
  }
  function chip(x, y, w, label, count, accent, onClick, title) {
    var g = el('g', 'node');
    var r = el('rect', 'body', g);
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', 26); r.setAttribute('rx', 7);
    var a = el('rect', null, g);
    a.setAttribute('x', x); a.setAttribute('y', y + 5); a.setAttribute('width', 3); a.setAttribute('height', 16); a.setAttribute('rx', 1.5);
    a.setAttribute('fill', accent);
    var t = el('text', null, g);
    t.setAttribute('x', x + 10); t.setAttribute('y', y + 17); t.textContent = label;
    if (count !== null && count !== '') {
      var c = el('text', 'sym', g);
      c.setAttribute('x', x + w - 6); c.setAttribute('y', y + 17); c.setAttribute('text-anchor', 'end');
      c.textContent = count;
    }
    var tt = el('title', null, g); tt.textContent = title || label;
    if (onClick) g.addEventListener('click', function (ev) { ev.stopPropagation(); if (!moved) onClick(); });
    grow(x, y, w, 26);
    return g;
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ---- level 1: overview ----
  function buildOverview() {
    var cards = clusterNames.map(function (c) {
      var files = clusterFiles(c);
      var syms = files.reduce(function (s, n) { return s + n.symbols; }, 0);
      var tops = files.slice().sort(function (a, b) { return b.deg - a.deg; }).slice(0, 3).map(function (n) { return shortName(n.id); });
      return { c: c, files: files.length, syms: syms, tops: tops, w: 216, h: 100 };
    });
    var perRow = Math.max(2, Math.ceil(Math.sqrt(cards.length)));
    cards.forEach(function (k, i) {
      k.x = (i % perRow) * (k.w + 70);
      k.y = Math.floor(i / perRow) * (k.h + 90);
    });
    var rects = {};
    cards.forEach(function (k) { rects[k.c] = { x: k.x, y: k.y, w: k.w, h: k.h }; });
    var labels = [];
    Object.keys(cAgg).forEach(function (key) {
      var parts = key.split('\\u0000');
      if (!rects[parts[0]] || !rects[parts[1]]) return;
      var w = cAgg[key];
      // opposite-direction pairs bow to opposite sides so they don't merge
      var hasReverse = cAgg[parts[1] + '\\u0000' + parts[0]] != null;
      var sign = hasReverse ? (parts[0] < parts[1] ? 1 : -1) : 1;
      var r = curve(rects[parts[0]], rects[parts[1]], {
        cls: w > 6 ? 'w3' : w > 2 ? 'w2' : '',
        label: w + (w === 1 ? ' import' : ' imports'),
        labelT: 0.35,
        bend: sign
      });
      labels.push(r.labelEl);
    });
    spreadLabels(labels);
    // re-append labels after the cards render so they stay on top
    setTimeout(function () { labels.filter(Boolean).forEach(function (l) { scene.appendChild(l); }); }, 0);
    cards.forEach(function (k) {
      var g = el('g', 'bigcard');
      var body = el('rect', 'body', g);
      body.setAttribute('x', k.x); body.setAttribute('y', k.y); body.setAttribute('width', k.w); body.setAttribute('height', k.h); body.setAttribute('rx', 12);
      var acc = el('rect', null, g);
      acc.setAttribute('x', k.x + 16); acc.setAttribute('y', k.y + 16); acc.setAttribute('width', 9); acc.setAttribute('height', 9); acc.setAttribute('rx', 2);
      acc.setAttribute('fill', colorVar(k.c));
      var title = el('text', 'title', g);
      title.setAttribute('x', k.x + 32); title.setAttribute('y', k.y + 25); title.textContent = cName(k.c);
      var sub = el('text', 'sub', g);
      sub.setAttribute('x', k.x + 16); sub.setAttribute('y', k.y + 47); sub.textContent = k.files + ' files · ' + k.syms + ' symbols';
      var mini = el('text', 'mini', g);
      mini.setAttribute('x', k.x + 16); mini.setAttribute('y', k.y + 66); mini.textContent = truncate(k.tops.join(', '), 34);
      var open = el('text', 'mini', g);
      open.setAttribute('x', k.x + 16); open.setAttribute('y', k.y + 85); open.textContent = 'open \\u2192';
      g.addEventListener('click', function (ev) { ev.stopPropagation(); if (!moved) location.hash = '#c=' + encodeURIComponent(k.c); });
      grow(k.x, k.y, k.w, k.h);
    });
    // layering narrative: depth = longest chain of "imports" below a cluster,
    // so foundations sit at layer 1 and entry-facing code on top
    var cOut = {};
    Object.keys(cAgg).forEach(function (key) {
      var parts = key.split('\\u0000');
      (cOut[parts[0]] = cOut[parts[0]] || []).push(parts[1]);
    });
    var depthMemo = {};
    function cDepth(c, trail) {
      if (depthMemo[c] != null) return depthMemo[c];
      if (trail[c]) return 1; // cycle guard
      trail[c] = 1;
      var best = 1;
      (cOut[c] || []).forEach(function (t) { best = Math.max(best, 1 + cDepth(t, trail)); });
      delete trail[c];
      depthMemo[c] = best;
      return best;
    }
    var layered = {};
    var connected = clusterNames.filter(function (c) { return cOut[c] || Object.keys(cAgg).some(function (k) { return k.split('\\u0000')[1] === c; }); });
    connected.forEach(function (c) { var d = cDepth(c, {}); (layered[d] = layered[d] || []).push(c); });
    var layerRows = Object.keys(layered).map(Number).sort(function (a, b) { return b - a; }).map(function (d) {
      var names = layered[d].map(function (c) {
        return '<span class="link" data-nav="#c=' + esc(c) + '">' + esc(cName(c)) + '</span>';
      }).join(', ');
      return '<li>' + names + '</li>';
    });
    var standalone = clusterNames.filter(function (c) { return connected.indexOf(c) < 0; });

    // panel: project summary + derived guided views
    var hub = nodes.slice().sort(function (a, b) { return b.deg - a.deg; })[0];
    var entry = nodes.filter(function (n) { return n.deg === 0 && (outb[n.id] || []).length > 0; })
      .sort(function (a, b) { return (outb[b.id] || []).length - (outb[a.id] || []).length; })[0];
    var big = nodes.slice().sort(function (a, b) { return b.symbols - a.symbols; })[0];
    var view = function (label, target, note) {
      return '<li class="link" data-nav="' + esc(target) + '"><b>' + esc(label) + '</b> — ' + esc(note) + '</li>';
    };
    var views = [];
    if (hub && hub.deg > 0) views.push(view(shortName(hub.id), '#f=' + hub.id, 'hub: imported by ' + hub.deg + ' files'));
    if (entry) views.push(view(shortName(entry.id), '#f=' + entry.id, 'entry point: imports ' + (outb[entry.id] || []).length + ', imported by none'));
    if (big && big !== hub) views.push(view(shortName(big.id), '#f=' + big.id, 'largest: ' + big.symbols + ' symbols'));
    setPanel(
      '<h2>' + esc(DATA.root) + '</h2>' +
      '<p class="meta">' + DATA.fileCount + ' files · ' + edges.length + ' import edges' + (DATA.aggregated ? ' · aggregated (repo over ' + ${MAX_FILE_NODES} + ' files)' : '') + '</p>' +
      (layerRows.length > 1
        ? '<h3>Layers (top builds on bottom)</h3><ul>' + layerRows.join('') + '</ul>' +
          (standalone.length ? '<p class="hint">standalone: ' + standalone.map(cName).map(esc).join(', ') + '</p>' : '')
        : '') +
      '<h3>Start here</h3><ul>' + (views.join('') || '<li class="hint">no import edges resolved</li>') + '</ul>' +
      '<h3>How to read</h3><p class="hint">Cards are subsystems; edge labels count imports between them. Click a card to open its files, click a file twice to open its symbols. Search <span class="kbd">/</span> · back <span class="kbd">Esc</span>.</p>'
    );
  }

  // ---- level 2: one cluster (star layout: hubs center, leaves spread) ----
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
  function buildCluster(c) {
    var files = clusterFiles(c);
    if (files.length === 0) { location.hash = ''; return; }
    files.sort(function (a, b) { return b.deg - a.deg || b.symbols - a.symbols; });
    var nodeW = function (n) { return Math.max(64, Math.min(190, truncate(shortName(n.id), 24).length * 6.6 + 34)); };
    var intra = edges.filter(function (e) { return byId[e[0]].cluster === c && byId[e[1]].cluster === c; });

    // deterministic force layout: seeded ring start, spring edges, padded
    // repulsion so chips keep clear air between them
    var R = 80 + files.length * 16;
    files.forEach(function (n, i) {
      var a = (i / files.length) * 6.283 + hash(n.id) * 0.8;
      var r = R * (0.35 + 0.65 * hash(n.id + 'r'));
      n.fx = Math.cos(a) * r; n.fy = Math.sin(a) * r; n.w2 = nodeW(n);
    });
    var iters = files.length > 120 ? 90 : 240;
    for (var t = 0; t < iters; t++) {
      for (var i = 0; i < files.length; i++) for (var j = i + 1; j < files.length; j++) {
        var a1 = files[i], b1 = files[j];
        var dx = b1.fx - a1.fx, dy = (b1.fy - a1.fy) * 2.4; // widen vertical gaps
        var d2 = dx * dx + dy * dy + 1;
        var min = (a1.w2 + b1.w2) / 2 + 60;
        var f = Math.min(4, (min * min) / d2);
        var d = Math.sqrt(d2);
        a1.fx -= dx / d * f; a1.fy -= dy / d * f * 0.6;
        b1.fx += dx / d * f; b1.fy += dy / d * f * 0.6;
      }
      intra.forEach(function (e) {
        var a2 = byId[e[0]], b2 = byId[e[1]];
        var dx = b2.fx - a2.fx, dy = b2.fy - a2.fy;
        var d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 190) / d * 0.03;
        a2.fx += dx * f; a2.fy += dy * f; b2.fx -= dx * f; b2.fy -= dy * f;
      });
      files.forEach(function (n) {
        var g = 0.006 + n.deg * 0.004; // hubs gravitate to the star's center
        n.fx -= n.fx * g; n.fy -= n.fy * g;
      });
    }
    // resolve residual overlaps of padded chip rects
    for (var p = 0; p < 30; p++) {
      var moved2 = false;
      for (var i2 = 0; i2 < files.length; i2++) for (var j2 = i2 + 1; j2 < files.length; j2++) {
        var A = files[i2], B = files[j2];
        var ox = (A.w2 + B.w2) / 2 + 26 - Math.abs(A.fx - B.fx);
        var oy = 26 + 22 - Math.abs(A.fy - B.fy);
        if (ox > 0 && oy > 0) {
          moved2 = true;
          if (ox < oy) { var s = (A.fx < B.fx ? -1 : 1) * ox / 2; A.fx += s; B.fx -= s; }
          else { var s2 = (A.fy < B.fy ? -1 : 1) * oy / 2; A.fy += s2; B.fy -= s2; }
        }
      }
      if (!moved2) break;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    files.forEach(function (n) {
      minX = Math.min(minX, n.fx - n.w2 / 2); maxX = Math.max(maxX, n.fx + n.w2 / 2);
      minY = Math.min(minY, n.fy - 13); maxY = Math.max(maxY, n.fy + 13);
    });
    var PADB = 30, boxW = maxX - minX + PADB * 2, boxH = maxY - minY + PADB * 2 + 22;
    var box = el('rect', 'clusterbox');
    box.setAttribute('x', 0); box.setAttribute('y', 0); box.setAttribute('width', boxW); box.setAttribute('height', boxH); box.setAttribute('rx', 12);
    var sw = el('rect'); sw.setAttribute('x', 14); sw.setAttribute('y', 10); sw.setAttribute('width', 8); sw.setAttribute('height', 8); sw.setAttribute('rx', 2); sw.setAttribute('fill', colorVar(c));
    var lbl = el('text', 'clusterlabel'); lbl.setAttribute('x', 28); lbl.setAttribute('y', 18); lbl.textContent = cName(c) + ' · ' + files.length;
    grow(0, 0, boxW, boxH);

    var rect = {};
    files.forEach(function (n) {
      rect[n.id] = { x: n.fx - minX + PADB - n.w2 / 2, y: n.fy - minY + PADB + 22 - 13, w: n.w2, h: 26 };
    });
    // collapsed neighbor clusters on the right
    var neighbors = {};
    edges.forEach(function (e) {
      var a = byId[e[0]], b = byId[e[1]];
      if (a.cluster === c && b.cluster !== c) neighbors[b.cluster] = 1;
      if (b.cluster === c && a.cluster !== c) neighbors[a.cluster] = 1;
    });
    var nx = boxW + 90, ny = 10;
    Object.keys(neighbors).sort().forEach(function (nc) {
      rect['\\u0000' + nc] = { x: nx, y: ny, w: 150, h: 26 };
      chip(nx, ny, 150, cName(nc), clusterFiles(nc).length, colorVar(nc), function () { location.hash = '#c=' + encodeURIComponent(nc); }, 'open ' + cName(nc));
      ny += 40;
    });
    // edges: intra-cluster file->file, cross aggregated to neighbor chips
    var crossSeen = {};
    var edgeRefs = [];
    edges.forEach(function (e) {
      var a = byId[e[0]], b = byId[e[1]];
      var ra = a.cluster === c ? rect[a.id] : rect['\\u0000' + a.cluster];
      var rb = b.cluster === c ? rect[b.id] : rect['\\u0000' + b.cluster];
      if (!ra || !rb) return;
      if (a.cluster !== c || b.cluster !== c) {
        var k = (a.cluster === c ? a.id : '\\u0000' + a.cluster) + '>' + (b.cluster === c ? b.id : '\\u0000' + b.cluster);
        if (crossSeen[k]) return;
        crossSeen[k] = 1;
      }
      edgeRefs.push({ e: e, path: curve(ra, rb, { bend: a.cluster === c && b.cluster === c ? 0.5 : 1 }).path });
    });
    var chips = {};
    files.forEach(function (n) {
      var r = rect[n.id];
      chips[n.id] = chip(r.x, r.y, r.w, truncate(shortName(n.id), 24), n.symbols, colorVar(c), function () {
        if (selected === n.id) { location.hash = '#f=' + n.id; return; }
        selectFile(n, chips, edgeRefs);
      }, n.id);
    });
    setPanel(
      '<h2>' + esc(cName(c)) + '</h2>' +
      '<p class="meta">' + files.length + ' files · ' + files.reduce(function (s, n) { return s + n.symbols; }, 0) + ' symbols</p>' +
      '<p class="hint">Click a file to trace its imports; click it again to open its symbols. Right-hand chips are neighbor subsystems.</p>'
    );
  }
  function selectFile(n, chips, edgeRefs) {
    selected = n.id;
    var up = reach(n.id, inb), down = reach(n.id, outb);
    Object.keys(chips).forEach(function (id) {
      chips[id].setAttribute('class', 'node' + (id === n.id ? ' sel' : (up[id] || down[id]) ? '' : ' dim'));
    });
    edgeRefs.forEach(function (er) {
      var isUp = er.e[1] === n.id || (reachAll && up[er.e[1]] && up[er.e[0]]);
      var isDown = er.e[0] === n.id || (reachAll && down[er.e[0]] && down[er.e[1]]);
      er.path.setAttribute('class', 'edge' + (isUp ? ' up' : isDown ? ' down' : ' dim'));
      er.path.setAttribute('marker-end', 'url(#' + (isUp ? 'arr-up' : isDown ? 'arr-down' : 'arr') + ')');
    });
    var li = function (s) { return '<li class="link" data-nav="#f=' + esc(s) + '">' + esc(s) + '</li>'; };
    var ups = Object.keys(up).sort(), dns = Object.keys(down).sort();
    setPanel(
      '<h2>' + esc(n.id) + '</h2>' +
      '<p class="meta">' + esc(n.lang) + ' · ' + n.symbols + ' symbols · <span class="link" data-nav="#f=' + esc(n.id) + '">open symbols \\u2192</span></p>' +
      '<h3 style="color:var(--up)">Imported by · ' + ups.length + '</h3>' +
      (ups.length ? '<ul>' + ups.slice(0, 12).map(li).join('') + '</ul>' : '<p class="hint">nothing in-repo</p>') +
      '<h3 style="color:var(--down)">Imports · ' + dns.length + '</h3>' +
      (dns.length ? '<ul>' + dns.slice(0, 12).map(li).join('') + '</ul>' : '<p class="hint">nothing in-repo</p>')
    );
  }

  // ---- level 3: one file, symbol graph ----
  var KIND_COLOR = { 'function': 'var(--c1)', 'method': 'var(--c3)', 'class': 'var(--c7)', 'struct': 'var(--c7)', 'interface': 'var(--c7)', 'var': 'var(--c4)', 'const': 'var(--c4)', 'signal': 'var(--c5)' };
  function buildFile(id) {
    var n = byId[id];
    if (!n) { location.hash = ''; return; }
    var ups = (inb[id] || []).slice().sort(), dns = (outb[id] || []).slice().sort();
    var colY = 34;
    var lb = el('text', 'clusterlabel'); lb.setAttribute('x', 0); lb.setAttribute('y', 20); lb.textContent = 'imported by · ' + ups.length;
    ups.slice(0, 16).forEach(function (f, i) {
      chip(0, colY + i * 34, 170, truncate(shortName(f), 22), '', colorVar(byId[f].cluster), function () { location.hash = '#f=' + f; }, f);
    });
    var midX = 250;
    var lb2 = el('text', 'clusterlabel'); lb2.setAttribute('x', midX); lb2.setAttribute('y', 20); lb2.textContent = n.id + ' · ' + n.symbols + ' symbols';
    var symRect = {};
    var symW = 190, symCols = 2;
    (n.syms || []).forEach(function (s, i) {
      var label = truncate((s.p ? s.p + '.' : '') + s.n, 24);
      var x = midX + (i % symCols) * (symW + 46), y = colY + Math.floor(i / symCols) * 34;
      symRect[s.n] = { x: x, y: y, w: symW, h: 26 };
      chip(x, y, symW, label, s.l, KIND_COLOR[s.k] || 'var(--c0)', null, s.k + ' ' + s.n + (s.e ? ' (exported)' : '') + ' — line ' + s.l);
    });
    (n.calls || []).forEach(function (pair) {
      var ra = symRect[pair[0]], rb = symRect[pair[1]];
      if (ra && rb) curve(ra, rb, { bend: 1.4 });
    });
    var rx = midX + symCols * (symW + 46) + 60;
    var lb3 = el('text', 'clusterlabel'); lb3.setAttribute('x', rx); lb3.setAttribute('y', 20); lb3.textContent = 'imports · ' + dns.length;
    dns.slice(0, 16).forEach(function (f, i) {
      chip(rx, colY + i * 34, 170, truncate(shortName(f), 22), '', colorVar(byId[f].cluster), function () { location.hash = '#f=' + f; }, f);
    });
    var kinds = {};
    (n.syms || []).forEach(function (s) { kinds[s.k] = (kinds[s.k] || 0) + 1; });
    setPanel(
      '<h2>' + esc(n.id) + '</h2>' +
      '<p class="meta">' + esc(n.lang) + ' · ' + n.symbols + ' symbols · ' + (n.calls || []).length + ' internal call edges</p>' +
      '<h3>Kinds</h3><ul>' + Object.keys(kinds).sort().map(function (k) { return '<li>' + esc(k) + ' — ' + kinds[k] + '</li>'; }).join('') + '</ul>' +
      '<p class="hint">Chips are symbols (number = line); curved arrows are calls inside this file. Side columns navigate to neighbor files.</p>'
    );
  }

  // ---- router / chrome ----
  function setPanel(html) {
    var d = document.getElementById('detail');
    d.innerHTML = html;
    d.querySelectorAll('[data-nav]').forEach(function (a) {
      a.addEventListener('click', function () { location.hash = a.getAttribute('data-nav'); });
    });
  }
  function crumbs(items) {
    var c = document.getElementById('crumbs');
    c.innerHTML = items.map(function (it, i) {
      return i === items.length - 1
        ? '<span class="here">' + esc(it.label) + '</span>'
        : '<a data-h="' + esc(it.hash) + '">' + esc(it.label) + '</a><span>/</span>';
    }).join('');
    c.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { location.hash = a.getAttribute('data-h'); });
    });
  }
  function build() {
    while (scene.firstChild) scene.removeChild(scene.firstChild);
    bounds = { x0: -30, y0: -30, x1: 60, y1: 60 };
    selected = null;
    var bg = el('rect'); bg.setAttribute('fill', 'url(#dots)');
    bg.setAttribute('x', -4000); bg.setAttribute('y', -4000); bg.setAttribute('width', 12000); bg.setAttribute('height', 12000);
    var h = decodeURIComponent(location.hash || '');
    if (h.indexOf('#f=') === 0 && byId[h.slice(3)]) {
      var f = h.slice(3);
      crumbs([{ label: 'repo', hash: '' }, { label: cName(byId[f].cluster), hash: '#c=' + byId[f].cluster }, { label: f.split('/').pop() }]);
      buildFile(f);
    } else if (h.indexOf('#c=') === 0 && clusterNames.indexOf(h.slice(3)) >= 0) {
      crumbs([{ label: 'repo', hash: '' }, { label: cName(h.slice(3)) }]);
      buildCluster(h.slice(3));
    } else {
      crumbs([{ label: 'repo' }]);
      buildOverview();
    }
    fit();
  }
  window.addEventListener('hashchange', build);

  // ---- search ----
  var q = document.getElementById('q');
  q.addEventListener('input', function () {
    var v = q.value.toLowerCase();
    scene.querySelectorAll('.node, .bigcard').forEach(function (g) {
      var label = g.querySelector('title') ? g.querySelector('title').textContent : g.textContent;
      var on = !v || label.toLowerCase().indexOf(v) >= 0;
      g.setAttribute('class', g.getAttribute('class').replace(' dim', '') + (on ? '' : ' dim'));
    });
  });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var v = q.value.toLowerCase();
      var hit = nodes.filter(function (n) { return n.id.toLowerCase().indexOf(v) >= 0; })
        .sort(function (a, b) { return b.deg - a.deg; })[0];
      if (hit) { q.value = ''; location.hash = '#f=' + hit.id; }
    }
  });

  // ---- pan & zoom (drag threshold keeps clicks intact) ----
  var vb, moved = false, drag = null;
  function fit() {
    var bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
    var ar = svg.clientWidth / Math.max(svg.clientHeight, 1);
    var w = bw, h = bh;
    if (w / h < ar) w = h * ar; else h = w / ar;
    vb = { x: bounds.x0 - (w - bw) / 2, y: bounds.y0 - (h - bh) / 2, w: w, h: h };
    applyVB();
  }
  function applyVB() { svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h); }
  svg.addEventListener('mousedown', function (e) { drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; moved = false; });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) { moved = true; svg.classList.add('panning'); }
    if (!moved) return;
    var k = vb.w / svg.clientWidth;
    vb.x = drag.vx - (e.clientX - drag.x) * k;
    vb.y = drag.vy - (e.clientY - drag.y) * k;
    applyVB();
  });
  window.addEventListener('mouseup', function () { drag = null; svg.classList.remove('panning'); });
  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var k = e.deltaY > 0 ? 1.15 : 0.87;
    var mx = vb.x + (e.offsetX / svg.clientWidth) * vb.w, my = vb.y + (e.offsetY / svg.clientHeight) * vb.h;
    vb.w *= k; vb.h *= k; vb.x = mx - (mx - vb.x) * k; vb.y = my - (my - vb.y) * k; applyVB();
  }, { passive: false });

  document.getElementById('reach').addEventListener('click', function () {
    reachAll = !reachAll;
    this.textContent = 'reach: ' + (reachAll ? 'transitive' : 'direct');
    this.className = reachAll ? 'on' : '';
  });
  document.getElementById('fit').addEventListener('click', fit);
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape') {
      q.value = '';
      var h = location.hash;
      if (h.indexOf('#f=') === 0) location.hash = '#c=' + byId[decodeURIComponent(h.slice(3))].cluster;
      else if (h.indexOf('#c=') === 0) location.hash = '';
      else build();
    }
  });
  window.addEventListener('resize', fit);

  build();
})();
</script>
`;
}

export async function writeArchMap(root, liveIndex = null) {
  const html = await generateArchMap(root, liveIndex);
  const file = path.join(root, '.codegraph', 'map.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<!doctype html>\n<html><head><meta charset="utf-8">\n' + html + '</html>');
  return file;
}
