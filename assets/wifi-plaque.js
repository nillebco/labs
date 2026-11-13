/* WiFi plaque generator — everything runs in this browser tab; the password is never sent anywhere. */
(() => {
  "use strict";

  // ---------- 2D geometry (mm, y up) ----------
  const area = (l) => { let a = 0; for (let i = 0, n = l.length; i < n; i++) { const p = l[i], q = l[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  const inside = (pt, l) => {
    let c = false;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const [xi, yi] = l[i], [xj, yj] = l[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };

  // Even-odd fill of non-crossing loops -> [{outer (CCW), holes (CW)}]
  // Drop duplicate and collinear points: earcut skips them in the faces, so the walls must too
  function clean(l) {
    let pts = l.slice(), changed = true;
    while (changed && pts.length >= 3) {
      changed = false;
      for (let i = 0; i < pts.length && pts.length >= 3; i++) {
        const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-7 || Math.abs(cross) < 1e-9) { pts.splice(i, 1); i--; changed = true; }
      }
    }
    return pts;
  }

  function fill(loops) {
    loops = loops.map(clean).filter((l) => l.length >= 3 && Math.abs(area(l)) > 1e-6);
    const probe = loops.map((l) => [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2]);
    const parents = loops.map((_, i) => loops.map((l, j) => (j !== i && inside(probe[i], l) ? j : -1)).filter((j) => j >= 0));
    const depth = parents.map((p) => p.length);
    const polys = new Map();
    loops.forEach((l, i) => {
      if (depth[i] % 2 === 0) polys.set(i, { outer: area(l) > 0 ? l : l.slice().reverse(), holes: [] });
    });
    loops.forEach((l, i) => {
      if (depth[i] % 2 === 1) {
        const parent = parents[i].find((j) => depth[j] === depth[i] - 1);
        polys.get(parent).holes.push(area(l) < 0 ? l : l.slice().reverse());
      }
    });
    return [...polys.values()];
  }

  function roundRect(w, h, r, seg = 10) {
    const pts = [], c = [[w - r, r, -90], [w - r, h - r, 0], [r, h - r, 90], [r, r, 180]];
    for (const [cx, cy, a0] of c)
      for (let k = 0; k <= seg; k++) { const a = ((a0 + (90 * k) / seg) * Math.PI) / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return pts;
  }
  const circle = (cx, cy, r, seg = 40) => Array.from({ length: seg }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / seg), cy + r * Math.sin((2 * Math.PI * k) / seg)]);

  // Text outline loops, scaled so capital letters are `cap` mm tall; baseline at y=0, left at x=0
  function textLoops(font, text, cap) {
    const capRatio = (font.tables.os2.sCapHeight || font.unitsPerEm * 0.73) / font.unitsPerEm;
    const path = font.getPath(text, 0, 0, cap / capRatio);
    const loops = []; let cur = null, px = 0, py = 0;
    const add = (x, y) => { cur.push([x, -y]); px = x; py = y; };
    const SEG = 8;
    for (const c of path.commands) {
      if (c.type === "M") { cur = []; loops.push(cur); add(c.x, c.y); }
      else if (c.type === "L") add(c.x, c.y);
      else if (c.type === "Q") { const x0 = px, y0 = py; for (let k = 1; k <= SEG; k++) { const t = k / SEG, u = 1 - t; add(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y); } }
      else if (c.type === "C") { const x0 = px, y0 = py; for (let k = 1; k <= SEG; k++) { const t = k / SEG, u = 1 - t; add(u*u*u*x0 + 3*u*u*t*c.x1 + 3*u*t*t*c.x2 + t*t*t*c.x, u*u*u*y0 + 3*u*u*t*c.y1 + 3*u*t*t*c.y2 + t*t*t*c.y); } }
    }
    for (const l of loops) {
      const a = l[0], b = l[l.length - 1];
      if (l.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) l.pop();
    }
    return loops.filter((l) => l.length >= 3);
  }

  function bounds(loops) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of loops) for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }
  const transform = (loops, s, dx, dy) => loops.map((l) => l.map(([x, y]) => [x * s + dx, y * s + dy]));

  // QR modules -> merged outline loops (diagonal neighbours stay separate)
  function qrLoops(matrix, size, x0, y0) {
    const n = matrix.length, m = size / n, edges = new Map(), key = (a, b) => a + "," + b;
    const addEdge = (a, b) => { const r = key(b, a), f = key(a, b); if (edges.has(r)) edges.delete(r); else edges.set(f, [a, b]); };
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      const j = n - 1 - r, p = (x, y) => x + ":" + y;
      addEdge(p(c, j), p(c + 1, j)); addEdge(p(c + 1, j), p(c + 1, j + 1)); addEdge(p(c + 1, j + 1), p(c, j + 1)); addEdge(p(c, j + 1), p(c, j));
    }
    const out = new Map();
    for (const [k, [a, b]] of edges) { if (!out.has(a)) out.set(a, []); out.get(a).push(k); }
    const xy = (v) => v.split(":").map(Number), loops = [];
    while (edges.size) {
      let [k0, [a, b]] = edges.entries().next().value;
      const start = a, loop = [];
      let k = k0;
      for (;;) {
        [a, b] = edges.get(k); edges.delete(k); out.get(a).splice(out.get(a).indexOf(k), 1);
        loop.push(xy(a));
        if (b === start) break;
        const [ax, ay] = xy(a), [bx, by] = xy(b), d = [bx - ax, by - ay];
        const cands = out.get(b), pref = [[-d[1], d[0]], d, [d[1], -d[0]]]; // left, straight, right
        k = null;
        for (const [dx, dy] of pref) { const t = cands.find((ck) => { const [cx, cy] = xy(edges.get(ck)[1]); return cx - bx === dx && cy - by === dy; }); if (t) { k = t; break; } }
        if (!k) break;
      }
      loops.push(loop);
    }
    // Cells touching only at a corner would share a zero-width edge: pull each corner 0.01 mm into its own cell
    const uses = new Map();
    for (const l of loops) for (const [x, y] of l) uses.set(x + ":" + y, (uses.get(x + ":" + y) || 0) + 1);
    const eps = 0.01 / m;
    return loops.map((l) => l.map(([x, y], i) => {
      if (uses.get(x + ":" + y) < 2) return [x0 + x * m, y0 + y * m];
      const p = l[(i - 1 + l.length) % l.length], q = l[(i + 1) % l.length];
      const d1 = [Math.sign(x - p[0]), Math.sign(y - p[1])], d2 = [Math.sign(q[0] - x), Math.sign(q[1] - y)];
      return [x0 + (x + eps * (d2[0] - d1[0])) * m, y0 + (y + eps * (d2[1] - d1[1])) * m];
    }));
  }

  // ---------- 3D ----------
  function extrude(polys, z0, z1) {
    const t = [];
    const tri = (a, b, c) => t.push(...a, ...b, ...c);
    for (const { outer, holes } of polys) {
      const flat = [], holeIdx = [], ring = [outer, ...holes];
      ring.forEach((l, i) => { if (i) holeIdx.push(flat.length / 2); for (const [x, y] of l) flat.push(x, y); });
      const idx = earcut(flat, holeIdx), pt = (k) => [flat[2 * k], flat[2 * k + 1]], directed = new Set();
      for (let i = 0; i < idx.length; i += 3) {
        let [ia, ib, ic] = [idx[i], idx[i + 1], idx[i + 2]];
        const [a, b, c] = [ia, ib, ic].map(pt);
        if ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]) < 0) [ib, ic] = [ic, ib];
        [[ia, ib], [ib, ic], [ic, ia]].forEach(([p, q]) => directed.add(p + ">" + q));
        const [A, B, C] = [ia, ib, ic].map(pt);
        tri([...A, z1], [...B, z1], [...C, z1]);
        tri([...A, z0], [...C, z0], [...B, z0]);
      }
      // walls along the face's real boundary (earcut may drop points, and hole bridges appear in both directions)
      for (const e of directed) {
        const [p, q] = e.split(">");
        if (directed.has(q + ">" + p)) continue;
        const a = pt(+p), b = pt(+q);
        tri([...a, z0], [...b, z0], [...b, z1]);
        tri([...a, z0], [...b, z1], [...a, z1]);
      }
    }
    return new Float32Array(t);
  }
  const concat = (...arrs) => { const o = new Float32Array(arrs.reduce((s, a) => s + a.length, 0)); let k = 0; for (const a of arrs) { o.set(a, k); k += a.length; } return o; };

  // ---------- model ----------
  const esc = (s) => s.replace(/([\\;,:"])/g, "\\$1");
  function payload(o) {
    let s = `WIFI:T:${o.security};S:${esc(o.ssid)};`;
    if (o.security !== "nopass") s += `P:${esc(o.password)};`;
    if (o.hidden) s += "H:true;";
    return s + ";";
  }

  function build(o, fonts) {
    const qr = qrcode(0, "M");
    qr.addData(unescape(encodeURIComponent(payload(o))), "Byte");
    qr.make();
    const n = qr.getModuleCount(), matrix = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
    const margin = 6, gap = 5, inner = o.width - 2 * margin, cx = o.width / 2;
    const qrSize = Math.min(o.qr, inner), mod = qrSize / n, quiet = 2 * mod;

    const label = (txt, font, cap) => {
      const l = textLoops(font, txt, cap); const b = bounds(l);
      const s = b.w > inner ? inner / b.w : 1;
      return transform(l, s, 0, 0);
    };
    let y = margin, ink = [];
    const place = (loops, after) => {
      if (!loops.length) return;
      const b = bounds(loops);
      ink.push(...transform(loops, 1, cx - (b.x0 + b.x1) / 2, y - b.y0));
      y += b.h + after;
    };
    if (o.security !== "nopass" && o.password && o.showPassword) {
      place(label(o.password, fonts.mono, o.text), 2.4);
      place(label(o.passLabel, fonts.sans, o.text * 0.55), gap);
    }
    if (o.showSsid && o.ssid) place(label(o.ssid, fonts.sans, o.text), gap);
    y += quiet;
    ink.push(...qrLoops(matrix, qrSize, cx - qrSize / 2, y));
    y += qrSize + quiet + gap;
    if (o.title) place(label(o.title, fonts.sans, o.titleSize), 0); else y -= gap;
    const holeR = 2.6, top = y + margin + (o.hole ? holeR * 2 + 3 : 0);
    const plate = roundRect(o.width, top, Math.min(o.radius, o.width / 2 - 0.1, top / 2 - 0.1) || 0.01);
    const plateLoops = [plate, ...(o.hole ? [circle(cx, top - margin / 2 - holeR - 1, holeR)] : [])];

    let parts;
    if (o.style === "flush") {
      const zSplit = o.base - o.ink;
      parts = [
        { name: "plate", mesh: extrude(fill(plateLoops), 0, zSplit), extruder: 1 },
        { name: "plate top", mesh: extrude(fill([...plateLoops, ...ink]), zSplit, o.base), extruder: 1 },
        { name: "code and text", mesh: extrude(fill(ink), zSplit, o.base), extruder: 2 },
      ];
    } else {
      parts = [
        { name: "plate", mesh: extrude(fill(plateLoops), 0, o.base), extruder: 1 },
        { name: "code and text", mesh: extrude(fill(ink), o.base, o.base + o.ink), extruder: 2 },
      ];
    }
    const of = (e) => concat(...parts.filter((p) => p.extruder === e).map((p) => p.mesh));
    return { parts, base: of(1), ink: of(2), plateLoops, inkLoops: ink, w: o.width, h: top, n, mod, payload: payload(o) };
  }

  // ---------- writers ----------
  function stl(tris) {
    const n = tris.length / 9, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
    dv.setUint32(80, n, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50, p = tris.subarray(i * 9, i * 9 + 9);
      const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
      [nx / l, ny / l, nz / l, ...p].forEach((v, k) => dv.setFloat32(o + k * 4, v, true));
    }
    return new Blob([buf], { type: "model/stl" });
  }

  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) { // stored (uncompressed) zip
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const [name, text] of files) {
      const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
      parts.push(h, nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
      central.push(c, nb);
      off += 30 + nb.length + data.length;
    }
    const size = central.reduce((s, p) => s + p.byteLength, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, e], { type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" });
  }

  // PrusaSlicer 3MF: one object, two parts (base -> extruder 1, ink -> extruder 2)
  function threeMF(model, name) {
    const verts = [], index = new Map(), tris = [];
    const vid = (x, y, z) => { const k = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`; let i = index.get(k); if (i === undefined) { i = verts.length; index.set(k, i); verts.push(k); } return i; };
    const ranges = [];
    for (const { mesh: m } of model.parts) {
      const first = tris.length;
      for (let i = 0; i < m.length; i += 9) {
        const a = vid(m[i], m[i + 1], m[i + 2]), b = vid(m[i + 3], m[i + 4], m[i + 5]), c = vid(m[i + 6], m[i + 7], m[i + 8]);
        if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
      }
      ranges.push([first, tris.length - 1]);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${name}</metadata>
<resources><object id="1" type="model"><mesh><vertices>
${verts.map((k) => { const [x, y, z] = k.split(","); return `<vertex x="${x}" y="${y}" z="${z}"/>`; }).join("\n")}
</vertices><triangles>
${tris.join("\n")}
</triangles></mesh></object></resources>
<build><item objectid="1"/></build>
</model>`;
    const cfg = `<?xml version="1.0" encoding="UTF-8"?>
<config>
<object id="1" instances_count="1">
<metadata type="object" key="name" value="${name}"/>
${model.parts.map((p, i) => `<volume firstid="${ranges[i][0]}" lastid="${ranges[i][1]}">
<metadata type="volume" key="name" value="${p.name}"/>
<metadata type="volume" key="volume_type" value="ModelPart"/>
<metadata type="volume" key="extruder" value="${p.extruder}"/>
</volume>`).join("\n")}
</object>
</config>`;
    return zip([
      ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>`],
      ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`],
      ["3D/3dmodel.model", xml],
      ["Metadata/Slic3r_PE_model.config", cfg],
    ]);
  }

  // ---------- 2D render (preview fallback + scan check) ----------
  function drawLoops(ctx, loops, s, h, pad) {
    ctx.beginPath();
    for (const l of loops) l.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, pad + x * s, pad + (h - y) * s));
    ctx.fill("evenodd");
  }
  function scanCheck(model) {
    const s = 8, pad = 20, c = document.createElement("canvas");
    c.width = Math.ceil(model.w * s + 2 * pad); c.height = Math.ceil(model.h * s + 2 * pad);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#000"; drawLoops(ctx, model.inkLoops, s, model.h, pad);
    const img = ctx.getImageData(0, 0, c.width, c.height), r = jsQR(img.data, c.width, c.height);
    if (!r) return null;
    try { return decodeURIComponent(escape(String.fromCharCode(...r.binaryData))); } catch { return r.data; }
  }

  window.WifiPlaque = { build, stl, threeMF, scanCheck, payload };
})();
