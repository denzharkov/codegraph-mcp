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

// symbol/call detail travels for the most-imported files only, so the map
// stays file-level on any repo size without a multi-megabyte payload
const DETAIL_CAP = 600;

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

  const nodes = [];
  const edges = []; // [from, to] = importer -> imported
  const fileCount = g.files.size;

  const clusterOf = computeClusters([...g.files.keys()]);
  // rank files by inbound degree; only the top DETAIL_CAP carry symbol detail
  const detailSet = new Set(
    [...g.files.keys()]
      .sort((a, b) => (reverse.get(b)?.size || 0) - (reverse.get(a)?.size || 0))
      .slice(0, DETAIL_CAP)
  );
  for (const [file, rec] of g.files) {
    const withDetail = detailSet.has(file);
    const syms = rec.symbols.filter((s) => !s.parent);
    // intra-file call pairs between named symbols, for the symbol level
    const callPairs = [];
    if (withDetail) {
      const names = new Set(rec.symbols.map((s) => s.name));
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
      syms: withDetail
        ? rec.symbols.slice(0, 40).map((s) => ({ n: s.name, k: s.kind, l: s.startLine, e: s.exported ? 1 : 0, p: s.parent || null }))
        : [],
      calls: callPairs
    });
  }
  for (const [target, importers] of reverse) {
    for (const imp of importers) edges.push([imp, target]);
  }
  return { nodes, edges, fileCount, detailCapped: fileCount > DETAIL_CAP, root };
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

  // ---- directory view: one recursive renderer for every level ----
  // At any path it shows the IMMEDIATE children: subdirectory cards with
  // aggregated stats/edges plus the files that live right here. Arbitrary
  // nesting (app/esum/sub/...) keeps its shape instead of flattening.
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
  function dirnameOf(id) { var i = id.lastIndexOf('/'); return i === -1 ? '' : id.slice(0, i); }
  function dirExists(prefix) {
    return nodes.some(function (n) { return dirnameOf(n.id) === prefix || n.id.indexOf(prefix + '/') === 0; });
  }
  function layersPanelHtml() {
    var cOut = {};
    Object.keys(cAgg).forEach(function (key) {
      var parts = key.split(' ');
      (cOut[parts[0]] = cOut[parts[0]] || []).push(parts[1]);
    });
    var depthMemo = {};
    function cDepth(c, trail) {
      if (depthMemo[c] != null) return depthMemo[c];
      if (trail[c]) return 1;
      trail[c] = 1;
      var best = 1;
      (cOut[c] || []).forEach(function (t) { best = Math.max(best, 1 + cDepth(t, trail)); });
      delete trail[c];
      depthMemo[c] = best;
      return best;
    }
    var layered = {};
    var connected = clusterNames.filter(function (c) { return cOut[c] || Object.keys(cAgg).some(function (k) { return k.split(' ')[1] === c; }); });
    connected.forEach(function (c) { var d = cDepth(c, {}); (layered[d] = layered[d] || []).push(c); });
    var layerRows = Object.keys(layered).map(Number).sort(function (a, b) { return b - a; }).map(function (d) {
      var names = layered[d].map(function (c) {
        return '<span class="link" data-nav="#d=' + esc(c) + '">' + esc(cName(c)) + '</span>';
      }).join(', ');
      return '<li>' + names + '</li>';
    });
    var standalone = clusterNames.filter(function (c) { return connected.indexOf(c) < 0; });
    if (layerRows.length < 2) return '';
    return '<h3>Layers (top builds on bottom)</h3><ul>' + layerRows.join('') + '</ul>' +
      (standalone.length ? '<p class="hint">standalone: ' + standalone.map(cName).map(esc).join(', ') + '</p>' : '');
  }
  function startHereHtml() {
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
    return '<h3>Start here</h3><ul>' + (views.join('') || '<li class="hint">no import edges resolved</li>') + '</ul>';
  }

  function buildDir(prefix) {
    if (prefix && !dirExists(prefix)) { location.hash = ''; return; }
    // ---- collect immediate children ----
    var files = [];
    var dirs = {};
    nodes.forEach(function (n) {
      if (prefix && n.id.indexOf(prefix + '/') !== 0) { if (dirnameOf(n.id) !== prefix) return; }
      var rest = prefix ? n.id.slice(prefix.length + 1) : n.id;
      if (prefix && dirnameOf(n.id) === prefix) { files.push(n); return; }
      var i = rest.indexOf('/');
      if (i === -1) { if (!prefix) files.push(n); return; }
      var seg = rest.slice(0, i);
      var d = dirs[seg] = dirs[seg] || { seg: seg, path: prefix ? prefix + '/' + seg : seg, files: 0, symbols: 0 };
      d.files++;
      d.symbols += n.symbols;
    });
    var dirList = Object.keys(dirs).sort().map(function (k) { return dirs[k]; });
    // skip-through wrapper folders: a dir with no files and a single child
    // collapses into one card ('src' becomes 'src/announcement_bot')
    function immediateOf(pref) {
      var fcount = 0, segs = {};
      nodes.forEach(function (n) {
        if (n.id.indexOf(pref + '/') !== 0 && dirnameOf(n.id) !== pref) return;
        if (dirnameOf(n.id) === pref) { fcount++; return; }
        var rest = n.id.slice(pref.length + 1);
        segs[rest.slice(0, rest.indexOf('/'))] = 1;
      });
      return { files: fcount, segs: Object.keys(segs) };
    }
    dirList.forEach(function (d) {
      d.label = d.seg;
      for (var guard = 0; guard < 4; guard++) {
        var im = immediateOf(d.path);
        if (im.files === 0 && im.segs.length === 1) {
          d.path = d.path + '/' + im.segs[0];
          d.label = d.label + '/' + im.segs[0];
        } else break;
      }
    });
    var inside = prefix + '/';
    var accent = function (i) { return 'var(--c' + (i < 8 ? i + 1 : 0) + ')'; };
    // stable color slot per child, by sorted child name
    var childNames = dirList.map(function (d) { return d.seg; }).concat(files.map(function (n) { return shortName(n.id); })).sort();
    var slotOf = function (name) { var i = childNames.indexOf(name); return accent(i >= 0 ? i % 9 : 8); };

    // ---- representative for any file id in this view ----
    function rep(id) {
      if (!prefix || id.indexOf(inside) === 0 || dirnameOf(id) === prefix) {
        if (dirnameOf(id) === prefix || (!prefix && id.indexOf('/') === -1)) return 'f:' + id;
        var rest = prefix ? id.slice(prefix.length + 1) : id;
        return 'd:' + rest.slice(0, rest.indexOf('/'));
      }
      return 'x:' + (byId[id] ? byId[id].cluster : '?');
    }

    // ---- items with sizes for the force layout ----
    var items = [];
    files.forEach(function (n) {
      items.push({ key: 'f:' + n.id, kind: 'file', node: n, label: truncate(shortName(n.id), 24), h: 26,
        w: Math.max(64, Math.min(190, truncate(shortName(n.id), 24).length * 6.6 + 34)), deg: n.deg });
    });
    dirList.forEach(function (d) {
      items.push({ key: 'd:' + d.seg, kind: 'dir', dir: d, label: d.seg, h: 62, w: 184, deg: d.files });
    });
    var byKey = {}; items.forEach(function (it) { byKey[it.key] = it; });

    // ---- aggregate edges to view representatives ----
    var agg = {};
    edges.forEach(function (e) {
      var a = rep(e[0]), b = rep(e[1]);
      if (a === b) return;
      var k = a + '' + b;
      (agg[k] = agg[k] || { from: a, to: b, weight: 0, orig: [] });
      agg[k].weight++;
      if (agg[k].orig.length < 400) agg[k].orig.push(e);
    });

    // externals present in aggregated edges
    var extKeys = {};
    Object.keys(agg).forEach(function (k) {
      [agg[k].from, agg[k].to].forEach(function (r) { if (r.indexOf('x:') === 0) extKeys[r.slice(2)] = 1; });
    });

    // ---- force layout over files + dir cards ----
    var sim = items;
    var R = 90 + sim.length * 14;
    sim.forEach(function (it, i) {
      var a = (i / Math.max(sim.length, 1)) * 6.283 + hash(it.key) * 0.8;
      var r = R * (0.35 + 0.65 * hash(it.key + 'r'));
      it.fx = Math.cos(a) * r; it.fy = Math.sin(a) * r;
    });
    var springPairs = [];
    Object.keys(agg).forEach(function (k) {
      var a = agg[k];
      if (byKey[a.from] && byKey[a.to]) springPairs.push([byKey[a.from], byKey[a.to]]);
    });
    var iters = sim.length > 120 ? 90 : 240;
    for (var t = 0; t < iters; t++) {
      for (var i = 0; i < sim.length; i++) for (var j = i + 1; j < sim.length; j++) {
        var A = sim[i], B = sim[j];
        var dx = B.fx - A.fx, dy = (B.fy - A.fy) * 2.0;
        var d2 = dx * dx + dy * dy + 1;
        var min = (A.w + B.w) / 2 + 60;
        var f = Math.min(4, (min * min) / d2);
        var d = Math.sqrt(d2);
        A.fx -= dx / d * f; A.fy -= dy / d * f * 0.6;
        B.fx += dx / d * f; B.fy += dy / d * f * 0.6;
      }
      springPairs.forEach(function (p) {
        var dx = p[1].fx - p[0].fx, dy = p[1].fy - p[0].fy;
        var d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 210) / d * 0.03;
        p[0].fx += dx * f; p[0].fy += dy * f; p[1].fx -= dx * f; p[1].fy -= dy * f;
      });
      sim.forEach(function (it) {
        var g = 0.006 + it.deg * 0.003;
        it.fx -= it.fx * g; it.fy -= it.fy * g;
      });
    }
    for (var p2 = 0; p2 < 30; p2++) {
      var bumped = false;
      for (var i2 = 0; i2 < sim.length; i2++) for (var j2 = i2 + 1; j2 < sim.length; j2++) {
        var A2 = sim[i2], B2 = sim[j2];
        var ox = (A2.w + B2.w) / 2 + 26 - Math.abs(A2.fx - B2.fx);
        var oy = (A2.h + B2.h) / 2 + 20 - Math.abs(A2.fy - B2.fy);
        if (ox > 0 && oy > 0) {
          bumped = true;
          if (ox < oy) { var s = (A2.fx < B2.fx ? -1 : 1) * ox / 2; A2.fx += s; B2.fx -= s; }
          else { var s2 = (A2.fy < B2.fy ? -1 : 1) * oy / 2; A2.fy += s2; B2.fy -= s2; }
        }
      }
      if (!bumped) break;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    sim.forEach(function (it) {
      minX = Math.min(minX, it.fx - it.w / 2); maxX = Math.max(maxX, it.fx + it.w / 2);
      minY = Math.min(minY, it.fy - it.h / 2); maxY = Math.max(maxY, it.fy + it.h / 2);
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 200; maxY = 100; }
    var PADB = 30, header = prefix ? 24 : 0;
    var boxW = maxX - minX + PADB * 2, boxH = maxY - minY + PADB * 2 + header;
    if (prefix) {
      var box = el('rect', 'clusterbox');
      box.setAttribute('x', 0); box.setAttribute('y', 0); box.setAttribute('width', boxW); box.setAttribute('height', boxH); box.setAttribute('rx', 12);
      var lbl = el('text', 'clusterlabel'); lbl.setAttribute('x', 14); lbl.setAttribute('y', 18);
      lbl.textContent = prefix + ' · ' + files.length + ' files · ' + dirList.length + ' dirs';
      grow(0, 0, boxW, boxH);
    }
    var rect = {};
    sim.forEach(function (it) {
      rect[it.key] = { x: it.fx - minX + PADB - it.w / 2, y: it.fy - minY + PADB + header - it.h / 2, w: it.w, h: it.h };
    });
    // external clusters in a right-hand column
    var nx = boxW + 90, ny = 10;
    Object.keys(extKeys).sort().forEach(function (c) {
      rect['x:' + c] = { x: nx, y: ny, w: 160, h: 26 };
      chip(nx, ny, 160, truncate(cName(c), 22), clusterFiles(c).length, colorVar(c), function () { location.hash = '#d=' + encodeURIComponent(c); }, 'open ' + c);
      ny += 40;
    });

    // ---- draw edges then items ----
    var edgeRefs = [];
    var labels = [];
    Object.keys(agg).forEach(function (k) {
      var a = agg[k];
      var ra = rect[a.from], rb = rect[a.to];
      if (!ra || !rb) return;
      var hasReverse = agg[a.to + '' + a.from] != null;
      var sign = hasReverse ? (a.from < a.to ? 1 : -1) : 1;
      var r = curve(ra, rb, {
        cls: a.weight > 6 ? 'w3' : a.weight > 2 ? 'w2' : '',
        label: a.weight > 1 ? String(a.weight) : null,
        labelT: 0.35,
        bend: sign * (a.from.indexOf('f:') === 0 && a.to.indexOf('f:') === 0 ? 0.5 : 1)
      });
      labels.push(r.labelEl);
      edgeRefs.push({ orig: a.orig, path: r.path });
    });
    spreadLabels(labels);
    setTimeout(function () { labels.filter(Boolean).forEach(function (l) { scene.appendChild(l); }); }, 0);

    var chips = {};
    files.forEach(function (n) {
      var r = rect['f:' + n.id];
      chips['f:' + n.id] = chip(r.x, r.y, r.w, truncate(shortName(n.id), 24), n.symbols, slotOf(shortName(n.id)), function () {
        if (selected === n.id) { location.hash = '#f=' + n.id; return; }
        selectInDir(n, chips, edgeRefs, prefix);
      }, n.id);
    });
    dirList.forEach(function (d) {
      var r = rect['d:' + d.seg];
      var g = el('g', 'bigcard');
      var body = el('rect', 'body', g);
      body.setAttribute('x', r.x); body.setAttribute('y', r.y); body.setAttribute('width', r.w); body.setAttribute('height', r.h); body.setAttribute('rx', 10);
      var acc = el('rect', null, g);
      acc.setAttribute('x', r.x + 12); acc.setAttribute('y', r.y + 12); acc.setAttribute('width', 8); acc.setAttribute('height', 8); acc.setAttribute('rx', 2);
      acc.setAttribute('fill', slotOf(d.seg));
      var title = el('text', 'title', g);
      title.setAttribute('x', r.x + 26); title.setAttribute('y', r.y + 20); title.textContent = truncate(d.label || d.seg, 22);
      var sub = el('text', 'sub', g);
      sub.setAttribute('x', r.x + 12); sub.setAttribute('y', r.y + 39); sub.textContent = d.files + ' files · ' + d.symbols + ' symbols';
      var open = el('text', 'mini', g);
      open.setAttribute('x', r.x + 12); open.setAttribute('y', r.y + 54); open.textContent = 'open →';
      var tt = el('title', null, g); tt.textContent = d.path;
      g.addEventListener('click', function (ev) { ev.stopPropagation(); if (!moved) location.hash = '#d=' + encodeURIComponent(d.path); });
      chips['d:' + d.seg] = g;
      grow(r.x, r.y, r.w, r.h);
    });

    // ---- panel ----
    var dirRows = dirList.map(function (d) {
      return '<li class="link" data-nav="#d=' + esc(d.path) + '">' + esc(d.label || d.seg) + ' — ' + d.files + ' files</li>';
    }).join('');
    if (!prefix) {
      setPanel(
        '<h2>' + esc(DATA.root) + '</h2>' +
        '<p class="meta">' + DATA.fileCount + ' files · ' + edges.length + ' import edges</p>' +
        layersPanelHtml() +
        startHereHtml() +
        '<h3>How to read</h3><p class="hint">Cards are folders (numbers count imports between them), chips are files at this level. Click a folder to descend — any depth. Click a file to trace, twice to open symbols. Search <span class="kbd">/</span> · up <span class="kbd">Esc</span>.</p>'
      );
    } else {
      setPanel(
        '<h2>' + esc(prefix) + '</h2>' +
        '<p class="meta">' + files.length + ' files here · ' + dirList.length + ' subfolders</p>' +
        (dirRows ? '<h3>Subfolders</h3><ul>' + dirRows + '</ul>' : '') +
        '<p class="hint">Click a file to trace its imports; click it again to open its symbols. Right-hand chips lead outside this folder.</p>'
      );
    }
  }
  function selectInDir(n, chips, edgeRefs, prefix) {
    selected = n.id;
    var up = reach(n.id, inb), down = reach(n.id, outb);
    var subtreeHits = function (dirPath) {
      var p = dirPath + '/';
      return Object.keys(up).concat(Object.keys(down)).some(function (id) { return id.indexOf(p) === 0; });
    };
    Object.keys(chips).forEach(function (key) {
      if (key.indexOf('f:') === 0) {
        var id = key.slice(2);
        chips[key].setAttribute('class', 'node' + (id === n.id ? ' sel' : (up[id] || down[id]) ? '' : ' dim'));
      } else if (key.indexOf('d:') === 0) {
        var dirPath = (prefix ? prefix + '/' : '') + key.slice(2);
        chips[key].setAttribute('class', 'bigcard' + (subtreeHits(dirPath) ? '' : ' dim'));
      }
    });
    edgeRefs.forEach(function (er) {
      var isUp = false, isDown = false;
      er.orig.forEach(function (e) {
        if (e[1] === n.id || (reachAll && up[e[1]] && up[e[0]])) isUp = true;
        if (e[0] === n.id || (reachAll && down[e[0]] && down[e[1]])) isDown = true;
      });
      er.path.setAttribute('class', 'edge' + (isUp ? ' up' : isDown ? ' down' : ' dim'));
      er.path.setAttribute('marker-end', 'url(#' + (isUp ? 'arr-up' : isDown ? 'arr-down' : 'arr') + ')');
    });
    var li = function (s) { return '<li class="link" data-nav="#f=' + esc(s) + '">' + esc(s) + '</li>'; };
    var ups = Object.keys(up).sort(), dns = Object.keys(down).sort();
    setPanel(
      '<h2>' + esc(n.id) + '</h2>' +
      '<p class="meta">' + esc(n.lang) + ' · ' + n.symbols + ' symbols · <span class="link" data-nav="#f=' + esc(n.id) + '">open symbols →</span></p>' +
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
    var elided = (!n.syms || n.syms.length === 0) && n.symbols > 0;
    if (elided) {
      var note = el('text', 'clusterlabel');
      note.setAttribute('x', midX); note.setAttribute('y', colY + 14);
      note.textContent = 'symbol detail elided on this repo size — ask the agent for file_skeleton';
      grow(midX, colY, 430, 20);
    }
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
      (elided
        ? '<p class="hint">Symbol detail is embedded only for the ' + ${DETAIL_CAP} + ' most-imported files on large repos; importers and imports are still complete.</p>'
        : '<h3>Kinds</h3><ul>' + Object.keys(kinds).sort().map(function (k) { return '<li>' + esc(k) + ' — ' + kinds[k] + '</li>'; }).join('') + '</ul>') +
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
    function dirCrumbs(pathStr) {
      var items = [{ label: 'repo', hash: '' }];
      var acc = '';
      (pathStr ? pathStr.split('/') : []).forEach(function (seg) {
        acc = acc ? acc + '/' + seg : seg;
        items.push({ label: seg, hash: '#d=' + acc });
      });
      return items;
    }
    if (h.indexOf('#f=') === 0 && byId[h.slice(3)]) {
      var f = h.slice(3);
      var cr = dirCrumbs(dirnameOf(f));
      cr.push({ label: f.split('/').pop() });
      crumbs(cr);
      buildFile(f);
    } else if ((h.indexOf('#d=') === 0 || h.indexOf('#c=') === 0) && dirExists(h.slice(3))) {
      var dp = h.slice(3);
      crumbs(dirCrumbs(dp));
      buildDir(dp);
    } else {
      crumbs([{ label: 'repo' }]);
      buildDir('');
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
      if (h.indexOf('#f=') === 0) {
        var d0 = dirnameOf(decodeURIComponent(h.slice(3)));
        location.hash = d0 ? '#d=' + d0 : '';
      } else if (h.indexOf('#d=') === 0 || h.indexOf('#c=') === 0) {
        var up0 = dirnameOf(decodeURIComponent(h.slice(3)));
        location.hash = up0 ? '#d=' + up0 : '';
      }
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
