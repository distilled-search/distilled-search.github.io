// "How DISCO Works": a step-by-step animation of the algorithm. On the right, Algorithm 1 from the paper with the lines
// of the current step highlighted; it cycles through the steps on its own and repeats, and a click on a line or a step
// dot jumps there. On the left, an abstract search graph (circles and arrows, no pictures) that changes with each step:
// batched expansion simulated in parallel, value scoring, value-guided rollouts, backup, UCB selection, parallel
// descents, progressive widening, then many task trees whose edges are cut out into a dataset and distilled into the
// policy and value function. The graph is a keyed scene: every step returns a list of items and the renderer tweens
// items that persist, grows new ones from where they come from, and fades out the rest.
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const W = 640, H = 400, R = 14, TWEEN_MS = 650, AUTO_MS = 2800;

  // ----------------------------------------------------------------- the example search tree (task 1)
  const POS = {
    A: [320, 40],
    B1: [190, 112], B2: [320, 112], B3: [450, 112], B4: [570, 112],
    C1: [250, 186], C2: [320, 186], C3: [385, 186],
    D1: [300, 262], D2: [355, 262],
    E1: [132, 186], E2: [186, 186],
    F1: [428, 186], F2: [492, 186],
    G1: [196, 262], G2: [248, 262],
    K1: [490, 262], K2: [490, 340],
  };
  const PARENT = {
    B1: "A", B2: "A", B3: "A", B4: "A", C1: "B2", C2: "B2", C3: "B2", D1: "C2", D2: "C2",
    E1: "B1", E2: "B1", F1: "B3", F2: "B3", G1: "C1", G2: "C1", K1: "F2", K2: "K1",
  };
  const Q = {
    B1: 0.35, B2: 0.8, B3: 0.6, B4: 0.65, C1: 0.5, C2: 0.7, C3: 0.45, D1: 0.75, E1: 0.3, E2: 0.4,
    F1: 0.55, F2: 0.9, G1: 0, G2: 0.5, K1: 0.95, K2: 1,
  };

  const STEPS = [
    { title: "Start", lines: [1], ms: 700, text: "A new task: only the start state s₀ is known." },
    { title: "Expand", lines: [4, 5], text: "The policy π proposes a batch of actions from s₀." },
    { title: "Simulate in parallel", lines: [5], text: "All proposed actions run at once in GPU simulation; each yields a new state." },
    { title: "Score", lines: [5], text: "The value function Qφ rates every new state." },
    { title: "Roll out", lines: [7], text: "Keep expanding, and follow the highest-value action until the task ends." },
    { title: "Back up", lines: [8], text: "The progress reached flows back up, updating each state's visits N and value Q." },
    { title: "Select", lines: [3], text: "Next iteration: descend by UCB, trading off high Q against few visits." },
    { title: "Parallel descents", lines: [3, 4, 5], text: "Many descents run at once; their leaves are expanded together in one batch." },
    { title: "Progressive widening", lines: [4, 5], text: "A state visited often gets new actions while |children| < k·N^α." },
    { title: "Plan found", lines: [9], text: "A rollout reaches the goal: the path from s₀ is a complete plan." },
    { title: "Many tasks", lines: [2], text: "The same search runs on every training task, growing one tree per task." },
    { title: "Collect edges", lines: [10, 11], text: "Every feasible edge, state → action → next state, is cut out as a training sample." },
    { title: "Distill", lines: [11], text: "π learns to propose these actions; Qφ learns how much progress they lead to." },
    { title: "Repeat", lines: [12, 2], text: "Trees are reset; the improved π and Qφ guide the next round of search." },
    { title: "Deploy", lines: [15], text: "At test time π and Qφ act directly: no search, no simulator." },
  ];

  // Algorithm 1 from the paper (Sec. 4.2), line by line: [indent, html].
  const PI = "π<sub>θ</sub>", QF = "Q<sub>ϕ</sub>";
  const ALGO = [
    [0, `Initialize <i>G</i> = ⟨<i>V</i>, <i>E</i>⟩ with root <i>v</i><sub>0</sub>, <i>V</i><sub>succ</sub> ← ∅`],
    [0, `<b>while</b> search is running <b>do</b>`],
    [1, `<i>v</i> ← <span class="al-fn">UCBSelect</span>(<i>G</i>)`],
    [1, `<b>if</b> |children(<i>v</i>)| &lt; <i>k</i><i>N</i>(<i>v</i>)<sup>α</sup> <b>then</b>`],
    [2, `<i>G</i> ← <span class="al-fn">Expand</span>(<i>G</i>, <i>v</i>, ${PI}, <i>f</i><sub>sim</sub>)`],
    [1, `<b>end</b>`],
    [1, `<i>R</i> ← <span class="al-fn">Rollout</span>(<i>v</i>, ${PI}, ${QF}, <i>r</i>, <i>G</i>)`],
    [1, `<i>G</i> ← <span class="al-fn">Backpropagate</span>(<i>G</i>, <i>v</i>, <i>R</i>)`],
    [1, `<i>V</i><sub>succ</sub> ← <i>V</i><sub>succ</sub> ∪ {<i>v</i> ∈ <i>V</i> | <i>G</i>(<i>s<sub>v</sub></i>) = 1}`],
    [1, `<b>if</b> distillation interval reached <b>then</b>`],
    [2, `(${PI}, ${QF}) ← <span class="al-fn">Distill</span>(<i>G</i>, <i>V</i><sub>succ</sub>)`],
    [2, `Reset <i>G</i> to root <i>v</i><sub>0</sub>, <i>V</i><sub>succ</sub> ← ∅`],
    [1, `<b>end</b>`],
    [0, `<b>end</b>`],
    [0, `<b>return</b> ${PI}, ${QF}`],
  ];

  // ----------------------------------------------------------------- scene builders
  // A tree snapshot: node ids with per-node classes/labels and per-edge classes. Returns scene items.
  function tree(ids, o = {}) {
    const items = [];
    const at = o.at || ((id) => POS[id]);
    const r = o.r || R;
    for (const id of ids) {
      const [x, y] = at(id);
      const cls = (o.cls && o.cls[id]) || "state";
      items.push({ k: id, t: "node", x, y, r, cls, q: o.q && o.q[id], label: o.label && o.label[id], from: PARENT[id] });
      if (PARENT[id] && ids.includes(PARENT[id])) {
        items.push({ k: `${PARENT[id]}>${id}`, t: "edge", a: PARENT[id], b: id, cls: (o.ecls && o.ecls[id]) || "exec" });
      }
    }
    return items;
  }
  const qs = (ids) => Object.fromEntries(ids.map((id) => [id, Q[id]]));
  const qLabels = (ids) => Object.fromEntries(ids.map((id) => [id, `Qφ ${Q[id].toFixed(2)}`]));
  const all = (ids, v) => Object.fromEntries(ids.map((id) => [id, v]));
  const caption = (text) => ({ k: "caption", t: "text", x: 16, y: H - 12, text, cls: "al-caption", anchor: "start" });

  const IT1 = ["A", "B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2"];
  const IT2 = [...IT1, "E1", "E2", "F1", "F2", "G1", "G2"];
  const N1 = { A: "N1 · Q .75", B2: "N1 · Q .75", C2: "N1 · Q .75", D1: "N1 · Q .75" };

  // Small "other task" trees for the distillation part: a few hand-made shapes, drawn in a 2x2 grid.
  const CELL = (c) => [[18, 24], [222, 24], [18, 196], [222, 196]][c];
  const MINI = 0.36;
  const miniAt = (c) => (id) => { const [x, y] = POS[id], [ox, oy] = CELL(c); return [ox + (x - 120) * MINI, oy + (y - 20) * MINI]; };
  const OTHER = [
    null,
    ["A", "B1", "B2", "B3", "C1", "C2", "E1", "E2", "F1", "F2", "K1"],
    ["A", "B2", "B3", "B4", "C2", "C3", "D1", "F2", "K1", "K2"],
    ["A", "B1", "B2", "C1", "C2", "C3", "E2", "G1", "G2", "D2"],
  ];
  const FINAL = [...IT2, "B4", "K1", "K2"];
  function manyTrees(o = {}) {
    const items = [];
    const sets = [FINAL, ...OTHER.slice(1)];
    sets.forEach((ids, c) => {
      const pre = c ? `t${c}:` : "";
      const at = miniAt(c);
      for (const id of ids) {
        const [x, y] = at(id);
        const failed = id === "D2" || id === "G1";
        const cls = id === "K2" ? "goal" : failed ? "failed" : "state";
        items.push({ k: pre + id, t: "node", x, y, r: 6, cls: o.dim ? cls + " dim" : cls,
          from: c ? miniAt(0)(id) : undefined });
        if (PARENT[id] && ids.includes(PARENT[id])) {
          items.push({ k: `${pre}${PARENT[id]}>${id}`, t: "edge", a: pre + PARENT[id], b: pre + id,
            cls: (failed ? "failed" : "exec") + (o.cut && !failed ? " cut" : o.dim ? " dim" : "") });
        }
      }
      const [ox, oy] = CELL(c);
      items.push({ k: `task${c}`, t: "text", x: ox + 78, y: oy + 152, text: `task ${c + 1}${c === 3 ? " … 50" : ""}`, cls: "al-task" + (o.dim ? " dim" : "") });
    });
    return items;
  }
  // Training samples: (state, action, next state) cut out of the trees, stacked in one column.
  const COL_X = 470, COL_Y = 30, ROW = 27;
  function samples(o = {}) {
    const items = [];
    const src = [];
    [FINAL, ...OTHER.slice(1)].forEach((ids, c) => {
      for (const id of ids) {
        if (!PARENT[id] || !ids.includes(PARENT[id]) || id === "D2" || id === "G1") continue;
        const a = miniAt(c)(PARENT[id]), b = miniAt(c)(id);
        src.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    });
    const n = 9;
    for (let i = 0; i < n; i++) {
      const s = src[Math.floor((i * src.length) / n)];
      const x = o.into ? (i % 2 ? 572 : 498) : COL_X, y = o.into ? 160 : COL_Y + i * ROW;
      items.push({ k: `d${i}`, t: "sample", x, y, from: s, cls: o.into ? "into" : "" });
    }
    if (!o.into) items.push({ k: "dmore", t: "text", x: COL_X + 72, y: COL_Y + n * ROW + 6, text: "+ every other feasible edge", cls: "al-more" });
    items.push({ k: "dhead", t: "text", x: COL_X + 72, y: 14, text: "s → a → s′", cls: "al-colhead" });
    return items;
  }
  const models = (o = {}) => [
    { k: "pi", t: "box", x: 488, y: 150, w: 66, h: 48, text: "π", sub: "policy", cls: o.glow ? "glow" : "" },
    { k: "qf", t: "box", x: 564, y: 150, w: 66, h: 48, text: "Qφ", sub: "value", cls: o.glow ? "glow" : "" },
  ];

  function scene(i) {
    switch (i) {
      case 0: return [...tree(["A"]), caption("s₀: the start state")];
      case 1: return [...tree(["A", "B1", "B2", "B3"], { cls: all(["B1", "B2", "B3"], "proposed"), ecls: all(["B1", "B2", "B3"], "proposed") }),
        caption("dashed: actions proposed by π")];
      case 2: return [...tree(["A", "B1", "B2", "B3"], { ecls: all(["B1", "B2", "B3"], "sim") }), caption("3 simulations in parallel")];
      case 3: return [...tree(["A", "B1", "B2", "B3"], { q: qs(["B1", "B2", "B3"]), label: qLabels(["B1", "B2", "B3"]) }),
        caption("shade = value Qφ")];
      case 4: return [...tree(IT1, {
        q: qs(IT1.slice(1)), label: { ...qLabels(["B1", "B2", "B3", "C1", "C2", "C3"]), D1: "ends: 3/4", D2: "failed" },
        cls: { B2: "path", C2: "path", D1: "path end", D2: "failed" }, ecls: { B2: "path", C2: "path", D1: "path", D2: "failed" },
      }), caption("greedy by Qφ, batch-expanding at every step")];
      case 5: return [...tree(IT1, {
        q: qs(IT1.slice(1)), label: { ...N1, B1: "Qφ .35", B3: "Qφ .60", C1: "Qφ .50", C3: "Qφ .45", D2: "failed" },
        cls: { A: "up", B2: "up", C2: "up", D1: "up end", D2: "failed" }, ecls: { B2: "up", C2: "up", D1: "up", D2: "failed" },
      }), caption("return R = 0.75 (3 of 4 objects placed)")];
      case 6: return [...tree(IT1, {
        q: qs(IT1.slice(1)), label: { A: "N1", B1: "UCB 1.60", B2: "UCB 1.63", B3: "UCB 1.85 ✓", C2: "N1 · Q .75", D1: "N1 · Q .75", D2: "failed" },
        cls: { A: "sel", B3: "sel", D1: "end", D2: "failed" }, ecls: { B3: "path", D2: "failed" },
      }), caption("UCB = Q + C·√(ln N / (1 + n))")];
      case 7: return [...tree(IT2, {
        q: qs(IT2.slice(1)), label: { ...N1, G1: "failed", D2: "failed" },
        cls: { B1: "sel", B3: "sel", C1: "sel", E1: "fresh", E2: "fresh", F1: "fresh", F2: "fresh", G1: "failed fresh", G2: "fresh", D1: "end", D2: "failed" },
        ecls: { B1: "path", B3: "path", B2: "path", C1: "path", E1: "sim", E2: "sim", F1: "sim", F2: "sim", G1: "failed", G2: "sim", D2: "failed" },
      }), caption("3 leaves expanded in one batch")];
      case 8: return [...tree([...IT2, "B4"], {
        q: qs([...IT2.slice(1), "B4"]), label: { A: "N 4:  3 < 2·4^0.3 ≈ 3.03", B4: "new action", G1: "failed", D2: "failed" },
        cls: { A: "widen", B4: "fresh", G1: "failed", D1: "end", D2: "failed" }, ecls: { B4: "sim", G1: "failed", D2: "failed" },
      }), caption("progressive widening adds an action at s₀")];
      case 9: return [...tree(FINAL, {
        q: qs(FINAL.slice(1)), label: { K2: "goal ★", G1: "failed", D2: "failed" },
        cls: { A: "path", B3: "path", F2: "path", K1: "path", K2: "goal", G1: "failed", D1: "end", D2: "failed" },
        ecls: { B3: "path", F2: "path", K1: "path", K2: "path", G1: "failed", D2: "failed" },
      }), caption("plan: s₀ → … → goal")];
      case 10: return [...manyTrees(), caption("one search tree per training task")];
      case 11: return [...manyTrees({ dim: true, cut: true }), ...samples(), caption("node → edge → node, cut out and stacked")];
      case 12: return [...manyTrees({ dim: true }), ...samples({ into: true }), ...models({ glow: true }), caption("supervised learning on the stacked edges")];
      case 13: return [...manyTrees(), ...models(),
        { k: "loop", t: "path", d: "M 520 202 C 515 268, 440 280, 395 230", cls: "al-loop" },
        { k: "looplab", t: "text", x: 500, y: 290, text: "guides the next search", cls: "al-looptext" },
        caption("search and distillation alternate")];
      case 14: {
        const chain = [["s0", 120], ["s1", 250], ["s2", 380], ["s3", 510]];
        const items = chain.map(([k, x], n) => ({ k: `x${k}`, t: "node", x, y: 170, r: R + 2, cls: n === 3 ? "goal" : "state", label: n === 3 ? "goal ★" : k.replace("s", "s") }));
        for (let n = 1; n < chain.length; n++) items.push({ k: `xe${n}`, t: "edge", a: `x${chain[n - 1][0]}`, b: `x${chain[n][0]}`, cls: "path", label: "π" });
        return [...items, ...models().map((m) => ({ ...m, y: 280, x: m.k === "pi" ? 250 : 330 })), caption("one action per step, straight from π")];
      }
      default: return [];
    }
  }

  // ----------------------------------------------------------------- renderer
  const ease = (u) => 1 - Math.pow(1 - u, 3);
  const lerp = (a, b, u) => a + (b - a) * u;
  const mk = (tag, attrs, ...kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const c of kids) e.append(c);
    return e;
  };
  const shade = (q) => {  // light grey → DISCO green
    const a = [226, 232, 240], b = [34, 197, 94], u = Math.max(0, Math.min(1, q));
    return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], u))).join(",")})`;
  };

  const ARROW = { grey: "#94a3b8", green: "#15803d", amber: "#f59e0b", red: "#dc2626", blue: "#38bdf8" };
  const arrowFor = (cls) => (/path|cut/.test(cls) ? "green" : /up/.test(cls) ? "amber" : /failed/.test(cls) ? "red" : /sim/.test(cls) ? "blue" : "grey");

  class Scene {
    constructor(svgEl, uid) {
      this.svg = svgEl;
      this.uid = uid;
      this.layers = { edge: mk("g"), node: mk("g"), over: mk("g") };
      this.svg.append(
        mk("defs", {}, ...Object.entries(ARROW).map(([name, color]) =>
          mk("marker", { id: `al-arrow-${uid}-${name}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9,
            markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, mk("path", { d: "M 0 1 L 9 5 L 0 9 z", fill: color })))),
        this.layers.edge, this.layers.node, this.layers.over);
      this.els = new Map();   // key -> { spec, el, cur }
    }

    pos(key) { const e = this.els.get(key); return e ? e.cur : null; }

    show(items, animate) {
      cancelAnimationFrame(this.raf);
      const want = new Map(items.map((s) => [s.k, s]));
      // remove what is gone
      for (const [k, e] of this.els) {
        if (want.has(k)) continue;
        e.el.classList.add("al-out");
        const el = e.el;
        setTimeout(() => el.remove(), 380);
        this.els.delete(k);
      }
      // create or update
      for (const s of items) {
        let e = this.els.get(s.k);
        if (!e) {
          e = { el: this.create(s), spec: s };
          let from = s.from;
          if (typeof from === "string") { const p = this.pos(from); from = p ? [p.x, p.y] : null; }
          e.cur = from ? { x: from[0], y: from[1], r: (s.r || R) * 0.4, o: 0 } : { x: s.x, y: s.y, r: (s.r || R) * 0.4, o: 0 };
          this.els.set(s.k, e);
        }
        e.spec = s;
        e.start = { ...e.cur };
        e.goal = { x: s.x ?? 0, y: s.y ?? 0, r: s.r || R, o: 1 };
        this.style(e);
      }
      const t0 = performance.now(), dur = animate ? TWEEN_MS : 0;
      const frame = (now) => {
        const u = dur ? ease(Math.min(1, (now - t0) / dur)) : 1;
        for (const e of this.els.values()) {
          for (const k of ["x", "y", "r", "o"]) e.cur[k] = lerp(e.start[k], e.goal[k], u);
          this.place(e);
        }
        if (u < 1) this.raf = requestAnimationFrame(frame);
      };
      if (dur) this.raf = requestAnimationFrame(frame); else frame(t0);
      this.snap = setTimeout(() => frame(t0 + dur), dur + 40);  // finish even when frames are throttled
    }

    create(s) {
      let el;
      if (s.t === "node") {
        el = mk("g", { class: "al-node" }, mk("circle", { class: "al-halo" }), mk("circle", { class: "al-dot" }),
          mk("text", { class: "al-mark", "text-anchor": "middle", "dominant-baseline": "central" }),
          mk("text", { class: "al-label", "text-anchor": "middle" }));
        this.layers.node.append(el);
      } else if (s.t === "edge") {
        el = mk("g", { class: "al-edge" }, mk("line"),
          mk("text", { class: "al-elabel", "text-anchor": "middle" }));
        this.layers.edge.append(el);
      } else if (s.t === "text") {
        el = mk("text", { "text-anchor": s.anchor || "middle" });
        this.layers.over.append(el);
      } else if (s.t === "box") {
        el = mk("g", { class: "al-box" }, mk("rect", { rx: 10 }), mk("text", { class: "al-box-t", "text-anchor": "middle" }),
          mk("text", { class: "al-box-s", "text-anchor": "middle" }));
        this.layers.over.append(el);
      } else if (s.t === "sample") {
        el = mk("g", { class: "al-sample" }, mk("rect", { x: -10, y: -10, width: 164, height: 20, rx: 10 }),
          mk("circle", { cx: 8, cy: 0, r: 6 }), mk("line", { x1: 17, y1: 0, x2: 128, y2: 0, "marker-end": `url(#al-arrow-${this.uid}-green)` }),
          mk("text", { x: 72, y: -3, "text-anchor": "middle", class: "al-sample-a" }), mk("circle", { cx: 138, cy: 0, r: 6 }));
        el.querySelector("text").textContent = "a";
        this.layers.over.append(el);
      } else if (s.t === "path") {
        el = mk("path", { "marker-end": `url(#al-arrow-${this.uid}-green)` });
        this.layers.over.append(el);
      }
      return el;
    }

    style(e) {
      const s = e.spec, el = e.el;
      el.classList.remove("al-out");
      if (s.t === "node") {
        el.setAttribute("class", "al-node " + s.cls.split(" ").map((c) => "is-" + c).join(" "));
        el.querySelector(".al-dot").style.fill = s.q !== undefined && !/failed|goal|proposed/.test(s.cls) ? shade(s.q) : "";
        el.querySelector(".al-mark").textContent = /failed/.test(s.cls) ? "✕" : /goal/.test(s.cls) ? "★" : "";
        el.querySelector(".al-label").textContent = s.label || "";
      } else if (s.t === "edge") {
        el.setAttribute("class", "al-edge " + s.cls.split(" ").map((c) => "is-" + c).join(" "));
        el.querySelector("line").setAttribute("marker-end", `url(#al-arrow-${this.uid}-${arrowFor(s.cls)})`);
        el.querySelector(".al-elabel").textContent = s.label || "";
      } else if (s.t === "text") {
        el.setAttribute("class", s.cls || "");
        el.textContent = s.text;
      } else if (s.t === "box") {
        el.setAttribute("class", "al-box " + (s.cls ? "is-" + s.cls : ""));
        el.querySelector(".al-box-t").textContent = s.text;
        el.querySelector(".al-box-s").textContent = s.sub;
      } else if (s.t === "sample") {
        el.setAttribute("class", "al-sample " + (s.cls ? "is-" + s.cls : ""));
      } else if (s.t === "path") {
        el.setAttribute("class", s.cls);
        el.setAttribute("d", s.d);
      }
    }

    place(e) {
      const s = e.spec, c = e.cur, el = e.el;
      if (s.t === "node") {
        el.setAttribute("transform", `translate(${c.x},${c.y})`);
        el.style.opacity = c.o;
        el.querySelector(".al-dot").setAttribute("r", c.r);
        el.querySelector(".al-halo").setAttribute("r", c.r + 6);
        const lab = el.querySelector(".al-label");
        lab.setAttribute("y", c.r + 13);
        lab.style.display = c.r < 9 ? "none" : "";
        el.querySelector(".al-mark").style.fontSize = `${Math.max(7, c.r * 0.9)}px`;
      } else if (s.t === "edge") {
        const a = this.pos(s.a), b = this.pos(s.b);
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
        const line = el.querySelector("line");
        line.setAttribute("x1", a.x + ux * (a.r + 1));
        line.setAttribute("y1", a.y + uy * (a.r + 1));
        line.setAttribute("x2", b.x - ux * (b.r + 3));
        line.setAttribute("y2", b.y - uy * (b.r + 3));
        el.style.opacity = Math.min(a.o, b.o, c.o);
        const lab = el.querySelector(".al-elabel");
        lab.setAttribute("x", (a.x + b.x) / 2);
        lab.setAttribute("y", (a.y + b.y) / 2 - 8);
      } else if (s.t === "text") {
        el.setAttribute("x", c.x);
        el.setAttribute("y", c.y);
        el.style.opacity = c.o;
      } else if (s.t === "box") {
        el.setAttribute("transform", `translate(${c.x},${c.y})`);
        el.style.opacity = c.o;
        const rect = el.querySelector("rect");
        rect.setAttribute("width", s.w);
        rect.setAttribute("height", s.h);
        el.querySelector(".al-box-t").setAttribute("x", s.w / 2);
        el.querySelector(".al-box-t").setAttribute("y", s.h / 2 + 2);
        el.querySelector(".al-box-s").setAttribute("x", s.w / 2);
        el.querySelector(".al-box-s").setAttribute("y", s.h - 6);
      } else if (s.t === "sample") {
        const k = s.cls === "into" ? 0.35 : 1;
        el.setAttribute("transform", `translate(${c.x},${c.y}) scale(${lerp(0.3, k, c.o)})`);
        el.style.opacity = s.cls === "into" ? 1 - c.o * 0.85 : c.o;
      } else if (s.t === "path") {
        el.style.opacity = c.o;
      }
    }
  }

  // ----------------------------------------------------------------- widget
  let uid = 0;
  function mount(root) {
    const svgEl = mk("svg", { class: "al-graph", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Animated diagram of the DISCO algorithm" });
    const sceneObj = new Scene(svgEl, uid++);
    const stage = document.createElement("div");
    stage.className = "al-stage";
    stage.append(svgEl);

    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
    const head = el("div", "al-algo-head", `<b>Algorithm 1:</b> DISCO`);
    const io = el("div", "al-algo-io", `<b>Input:</b> ${PI}, ${QF}, <i>f</i><sub>sim</sub>, <i>r</i>, <i>G</i>, (<i>k</i>, α)<br><b>Output:</b> updated ${PI}, updated ${QF}`);
    const code = el("ol", "al-code");
    ALGO.forEach(([ind, html], n) => {
      const li = el("li", "al-line");
      li.style.setProperty("--ind", ind);
      li.dataset.line = n + 1;
      li.innerHTML = `<span class="al-ln">${n + 1}</span><span class="al-src">${html}</span>`;
      const first = STEPS.findIndex((st) => st.lines.includes(n + 1));
      if (first >= 0) { li.classList.add("is-link"); li.title = `Show: ${STEPS[first].title}`; li.addEventListener("click", () => go(first, true)); }
      code.append(li);
    });
    const card = el("div", "al-card");
    const cardHead = el("div", "al-card-head"), cardText = el("p", "al-card-text");
    card.append(cardHead, cardText);
    const dots = el("div", "al-dots");
    STEPS.forEach((st, n) => {
      const d = el("button", "al-dot-btn");
      d.type = "button";
      d.title = `${n + 1}. ${st.title}`;
      d.setAttribute("aria-label", `Step ${n + 1}: ${st.title}`);
      d.addEventListener("click", () => go(n, true));
      dots.append(d);
    });
    const pause = el("button", "al-pause");
    pause.type = "button";
    const progress = el("div", "al-progress", "<span></span>");
    const bottom = el("div", "al-bottom");
    bottom.append(dots, pause);
    const side = el("div", "al-side");
    side.append(head, io, code, card, bottom, progress);
    root.append(stage, side);

    // Cycles through the steps forever; a click jumps to a step and the cycle continues from there.
    let i = 0, paused = false, visible = false, elapsed = 0, last = performance.now();
    const bar = progress.firstChild;
    function go(k, user) {
      i = (k + STEPS.length) % STEPS.length;
      elapsed = 0;
      sceneObj.show(scene(i), true);
      const lines = new Set(STEPS[i].lines);
      for (const li of code.children) li.classList.toggle("is-hl", lines.has(Number(li.dataset.line)));
      [...dots.children].forEach((d, n) => { d.classList.toggle("is-on", n === i); d.classList.toggle("is-done", n < i); });
      cardHead.innerHTML = `<span class="al-card-num">Step ${i + 1} / ${STEPS.length}</span> ${STEPS[i].title}`;
      cardText.textContent = STEPS[i].text;
    }
    const stepMs = () => STEPS[i].ms || AUTO_MS;  // "Start" shows only s0, so it moves on almost at once
    function tick(now) {
      const dt = now - last;
      last = now;
      if (visible && !paused) {
        elapsed += dt;
        if (elapsed >= stepMs()) go(i + 1);
      }
      bar.style.width = `${Math.min(elapsed / stepMs(), 1) * 100}%`;
      requestAnimationFrame(tick);
    }
    const setPause = () => { pause.textContent = paused ? "▶ Play" : "❚❚ Pause"; pause.setAttribute("aria-pressed", String(paused)); };
    pause.addEventListener("click", () => { paused = !paused; setPause(); });
    root.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1, true); }
      if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1, true); }
    });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }, { threshold: 0.35 }).observe(root);
    } else visible = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) paused = true;
    setPause();
    go(0);
    requestAnimationFrame(tick);
  }

  function boot() { document.querySelectorAll("[data-algo]").forEach((r) => { if (!r.alMounted) { r.alMounted = true; mount(r); } }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
