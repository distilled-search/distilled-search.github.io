// DISCO search replay: pick an environment and watch DISCO's MCTS grow its search tree, one iteration at a time.
// The replay runs the paper's algorithm over the saved tree (UCB selection with progressive widening, a value-guided
// rollout, backup of the progress reached) with a fixed seed, so every visitor sees the same search. A timeline with
// play/pause scrubs through the iterations. Nothing is simulated here; the search only walks the recorded tree.
// Mount: <div data-disco-search data-base="assets/tree_explorer/" data-reasons="assets/disco_game/dead_ends.json"></div>
(function () {
  "use strict";

  const R = 34;               // node radius, graph units
  const DX = 92, DY = 160;    // sibling and level spacing
  const TWEEN_MS = 420;
  const PAPER = { B: 3, k: 2.0, alpha: 0.3, C: 1.5 };  // paper, Table 4; B as in the game
  const MORE_WIDENING = { k: 4.0, alpha: 0.5 };
  const SEED = 7, MAX_ITERS = 400;
  const STEP_MS = 1500;       // one iteration per step at 1×
  const FAIL_LINGER_MS = 1100; // a failed action stays on the graph this long in the iteration that sampled it
  const FADE_MS = 400;

  const FAILURE_TEXT = {
    place_motion_plan: "No placement motion", place_execution: "Placement failed", grasp_execution: "Grasp slipped",
    knocked_base: "Knocked the base", no_contact_or_offset: "Missed the base", ik_infeasible: "Unreachable grasp",
    pick_failed: "Pick failed", grasp_motion_plan: "No grasp motion", pre_grasp_motion_plan: "No approach motion",
    expansion_crashed: "Simulation error",
  };
  let uid = 0;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
    return e;
  }
  function svg(tag, attrs, ...kids) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const k of kids) e.append(k);
    return e;
  }
  const ease = (u) => 1 - Math.pow(1 - u, 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (x) => x.toFixed(2);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const feasible = (n) => n.status !== "failed";
  const failName = (t) => FAILURE_TEXT[t] || String(t).replace(/_/g, " ");
  function rng(seed) {  // mulberry32: a small seeded generator, so the replay is the same for everyone
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Keep only branches that can actually be played. States the search never expanded are dropped, and so are branches
  // the search solved later but whose motions were not saved (nothing playable below them). Every remaining state where
  // play stops is a real dead end, with a reason in dead_ends.json.
  function prune(t) {
    const done = new Map();
    const kids = (n) => {
      if (done.has(n.id)) return done.get(n.id);
      const out = [];
      for (const c of n.children.map((id) => t.byId.get(id))) {
        if (c.status === "unexplored") continue;
        if (c.status === "solved_hidden" && !kids(c).some((k) => k.status !== "failed")) continue;
        out.push(c);
      }
      done.set(n.id, out);
      return out;
    };
    for (const n of t.nodes) n.kids = kids(n);
  }

  // =============================================================== the search, run once per environment
  // Returns one snapshot per iteration (index 0 is the start): what has been sampled and executed, visit counts and
  // values, the path of that iteration, and a log of its decisions.
  function replay(t, cfg) {
    const { B, k: K, alpha: A, C } = cfg, rand = rng(SEED);
    const node = (id) => t.byId.get(id);
    const revealed = new Set([0]), rolled = new Set([0]), N = new Map(), W = new Map(), exhausted = new Set();
    const plans = [];
    let sampled = 0, actions = 0;
    const draw = (list, n) => {
      const a = [...list];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a.slice(0, n);
    };
    const dead = (n) => n.parent !== null && n.status !== "goal" && feasible(n) && rolled.has(n.id) &&
      n.kids.every((c) => revealed.has(c.id) && !feasible(c));
    const markExhausted = (n) => {
      for (let v = n; v; v = v.parent === null ? null : node(v.parent)) {
        const done = rolled.has(v.id) && (v.status === "goal" ||
          v.kids.every((c) => revealed.has(c.id) && (!feasible(c) || exhausted.has(c.id))));
        if (!done) return;
        exhausted.add(v.id);
      }
    };
    const snap = (extra) => ({
      revealed: [...revealed], rolled: [...rolled], N: new Map(N), W: new Map(W), plans: [...plans],
      sampled, actions, ...extra,
    });
    const snaps = [snap({ path: [0], executed: [], added: [], end: 0, why: "start", log: [] })];

    for (let it = 1; it <= MAX_ITERS && !exhausted.has(0); it++) {
      const log = [], added = [], executed = [], widened = [];
      const sample = (v, kind, extra) => {
        const hidden = v.kids.filter((c) => !revealed.has(c.id));
        const got = draw(hidden, B);
        for (const c of got) { revealed.add(c.id); added.push(c.id); }
        sampled += got.length;
        const bad = got.filter((c) => !feasible(c)).length;
        log.push({ kind, text: `${extra} sample ${plural(got.length, "action")} with policy π` +
          (bad ? ` (${bad === got.length ? "all" : bad} failed).` : "."), node: v.id });
        return got;
      };
      // selection
      let path = null, leaf = null;
      for (let guard = 0; guard < 1000 && !leaf; guard++) {
        if (exhausted.has(0)) break;
        let v = node(0);
        path = [v];
        for (;;) {
          const n = N.get(v.id) || 0, shown = v.kids.filter((c) => revealed.has(c.id));
          const hidden = v.kids.length - shown.length, limit = K * Math.pow(Math.max(n, 1), A);
          let open = shown.filter((c) => feasible(c) && !exhausted.has(c.id));
          if (hidden && (shown.length < limit || !open.length)) {
            const why = !shown.length ? `Expand step ${v.depth}:`
              : shown.length < limit ? `Widen step ${v.depth}: |children| ${shown.length} < k·N^α = ${fmt(limit)}, so`
              : `Step ${v.depth}: no feasible sampled action left, so`;
            const isWiden = shown.length && shown.length < limit;
            const got = sample(v, isWiden ? "widen" : "expand", why);
            if (isWiden) widened.push({ node: v.id, kids: got.map((c) => c.id) });
            open = open.concat(got.filter(feasible));
          } else if (hidden) {
            log.push({ kind: "check", text: `Step ${v.depth}: |children| ${shown.length} ≥ k·N^α = ${fmt(limit)}, no widening.`, node: v.id });
          }
          if (!open.length) { markExhausted(v); break; }
          const lnN = Math.log(n + 1);
          let best = null;
          for (const c of open) {
            const nc = N.get(c.id) || 0, q = nc ? W.get(c.id) / nc : c.Q, ucb = q + C * Math.sqrt(lnN / (nc + 1));
            if (!best || ucb > best.ucb) best = { c, q, ucb, nc };
          }
          path.push(best.c);
          const what = best.nc ? `Q ${fmt(best.q)}` : `Qφ ${fmt(best.q)}`;
          if (!rolled.has(best.c.id)) {
            log.push({ kind: "exec", text: `Execute a new action by UCB ${fmt(best.ucb)} (${what} + explore ${fmt(best.ucb - best.q)}).`, node: best.c.id });
            leaf = best.c;
            break;
          }
          log.push({ kind: "select", text: `Select step ${best.c.depth} by UCB ${fmt(best.ucb)} (${what} + explore ${fmt(best.ucb - best.q)}).`, node: best.c.id });
          v = best.c;
        }
      }
      if (!leaf) break;
      // value-guided rollout
      let cur = leaf, why = "";
      for (;;) {
        rolled.add(cur.id);
        executed.push(cur.id);
        actions++;
        if (cur.status === "goal") { why = "goal"; break; }
        if (dead(cur)) { why = "dead"; break; }
        sample(cur, "rollout", `Rollout at step ${cur.depth}:`);
        const cand = cur.kids.filter((c) => revealed.has(c.id) && feasible(c) && !exhausted.has(c.id));
        if (!cand.length) { why = dead(cur) ? "dead" : "allfailed"; break; }
        const next = cand.reduce((a, b) => (b.Q > a.Q ? b : a));
        log.push({ kind: "exec", text: `Roll out: execute the feasible action with the highest Qφ (${fmt(next.Q)}).`, node: next.id });
        path.push(next);
        cur = next;
      }
      const ret = cur.status === "goal" ? 1 : (cur.progress ?? 0) / t.num_objects;
      for (const v of path) { N.set(v.id, (N.get(v.id) || 0) + 1); W.set(v.id, (W.get(v.id) || 0) + ret); }
      markExhausted(cur);
      const isNew = cur.status === "goal" && !plans.includes(cur.id);
      if (isNew) plans.push(cur.id);
      log.push({ kind: isNew ? "plan" : "backup", text: (isNew ? `Plan ${plans.length} found! ` : "") +
        `Back up R = ${fmt(ret)} along ${plural(path.length, "state")}.`, node: cur.id });
      snaps.push(snap({ path: path.map((v) => v.id), executed, added, widened, end: cur.id, why, log, newPlan: isNew }));
    }
    return snaps;
  }

  // =============================================================== the widget
  class Search {
    constructor(root) {
      this.root = root;
      this.base = (root.dataset.base || "./").replace(/\/?$/, "/");
      this.clipId = `ds-clip-${uid++}`;
      this.cache = {};
      this.reasons = {};
      this.speed = 1;
      this.cfg = { ...PAPER };
      this.build();
      if (root.dataset.reasons) fetch(root.dataset.reasons).then((r) => r.json()).then((j) => { this.reasons = j; this.render(false); }).catch(() => {});
      fetch(this.base + "data/games.json").then((r) => r.json()).then((games) => {
        this.games = games;
        this.tabs.replaceChildren(...games.map((g) =>
          el("button", { class: "ds-tab", role: "tab", "data-id": g.id, onclick: () => this.load(g.id) }, g.title)));
        this.load(games[0].id);
      });
    }

    build() {
      const r = this.root;
      r.classList.add("ds");
      this.tabs = el("div", { class: "ds-tabs", role: "tablist" });

      this.edgeLayer = svg("g");
      this.nodeLayer = svg("g");
      this.viewport = svg("g", {}, this.edgeLayer, this.nodeLayer);
      this.svg = svg("svg", { class: "ds-graph", role: "img", "aria-label": "DISCO's search tree" },
        svg("defs", {}, svg("clipPath", { id: this.clipId, clipPathUnits: "objectBoundingBox" },
          svg("circle", { cx: 0.5, cy: 0.5, r: 0.5 }))), this.viewport);
      const zoom = el("div", { class: "ds-zoom" },
        el("button", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => this.zoomBy(1.3) }, "+"),
        el("button", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => this.zoomBy(1 / 1.3) }, "−"),
        el("button", { title: "Fit the tree", "aria-label": "Fit the tree", onclick: () => { this.autoFit = true; this.fit(); } }, "⤢"));
      const legend = el("div", { class: "ds-legend" },
        ...[["path", "this iteration"], ["goal", "plan (goal)"], ["dead", "dead end"], ["failed", "failed action"]]
          .map(([c, t]) => el("span", { class: `ds-key ds-key-${c}` }, t)));
      const help = el("div", { class: "ds-graph-help" }, "Scroll or pinch to zoom · drag to pan · click a state to inspect it");
      this.graphWrap = el("div", { class: "ds-graph-wrap" }, this.svg, help, zoom, legend);

      this.stageImg = el("img", { alt: "" });
      this.stageTag = el("div", { class: "ds-stage-tag" });
      const stage = el("div", { class: "ds-stage" }, this.stageImg, this.stageTag);
      this.iterTitle = el("div", { class: "ds-iter-title" });
      this.outcome = el("div", { class: "ds-outcome" });
      this.stats = el("div", { class: "ds-stats" });
      this.log = el("ol", { class: "ds-log" });
      const viewer = el("div", { class: "ds-viewer" }, stage, this.iterTitle, this.outcome, this.stats, this.log);

      this.playBtn = el("button", { class: "ds-play", "aria-label": "Play", title: "Play (space)", onclick: () => this.toggle() });
      this.slider = el("input", { class: "ds-slider", type: "range", min: 0, max: 0, step: 1, value: 0, "aria-label": "Iteration",
        oninput: (e) => { this.pause(); this.go(Number(e.target.value), false); } });
      this.markers = el("div", { class: "ds-markers" });
      const track = el("div", { class: "ds-track" }, this.slider, this.markers);
      this.timeLabel = el("span", { class: "ds-time" });
      const speed = el("button", { class: "ds-speed", title: "Playback speed", onclick: (e) => {
        this.speed = this.speed === 4 ? 1 : this.speed * 2;
        e.currentTarget.textContent = `${this.speed}×`;
      } }, "1×");
      const timeline = el("div", { class: "ds-timeline" }, this.playBtn, track, this.timeLabel, speed);
      r.append(this.tabs, el("div", { class: "ds-main" }, this.graphWrap, viewer), timeline, this.buildSettings());
      this.setPlayIcon(false);
      this.bindPanZoom();
      new ResizeObserver(() => { if (this.t) { if (this.autoFit) this.fit(false); else this.applyView(); } }).observe(this.svg);
      r.addEventListener("keydown", (e) => {
        if (e.key === " " && e.target === r) { e.preventDefault(); this.toggle(); }
      });
      r.tabIndex = -1;
    }

    // Search settings under the timeline: changing any value re-runs the replay.
    buildSettings() {
      const inputs = {};
      let timer = null;
      const changed = () => { clearTimeout(timer); timer = setTimeout(() => this.rerun(), 250); };
      const field = (key, label, min, max, step, help) => {
        const out = key === "B" ? el("output", { class: "ds-set-val" }, String(this.cfg.B)) : null;
        inputs[key] = el("input", {
          type: key === "B" ? "range" : "number", min, max, step, value: this.cfg[key], "aria-label": help, title: help,
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isFinite(v)) return;
            this.cfg[key] = clamp(v, min, max);
            if (out) out.textContent = String(this.cfg.B);
            changed();
          },
        });
        return el("label", { class: `ds-set ds-set-${key}` }, el("span", { class: "ds-set-name", title: help }, label), inputs[key], out);
      };
      const preset = (vals) => {
        Object.assign(this.cfg, vals);
        for (const [k, inp] of Object.entries(inputs)) inp.value = this.cfg[k];
        inputs.B.nextSibling.textContent = String(this.cfg.B);
        this.rerun();
      };
      return el("div", { class: "ds-settings" },
        el("span", { class: "ds-settings-title" }, "Search settings"),
        field("B", "B", 1, 8, 1, "Actions sampled from π each time a state is expanded"),
        field("k", "k", 0.5, 8, 0.1, "Progressive-widening coefficient"),
        field("alpha", "α", 0.05, 1, 0.05, "Progressive-widening exponent"),
        field("C", "C", 0, 4, 0.1, "UCB exploration constant"),
        el("span", { class: "ds-settings-presets" },
          el("button", { type: "button", class: "ds-preset", onclick: () => preset(PAPER) }, "Paper values"),
          el("button", { type: "button", class: "ds-preset", onclick: () => preset(MORE_WIDENING) }, "More widening")));
    }

    // --------------------------------------------------------------- data
    async load(id) {
      this.pause();
      for (const b of this.tabs.children) b.setAttribute("aria-selected", b.dataset.id === id ? "true" : "false");
      if (!this.cache[id]) {
        const t = await (await fetch(`${this.base}data/${id}/tree.json`)).json();
        t.byId = new Map(t.nodes.map((n) => [n.id, n]));
        t.dir = `${this.base}data/${id}/`;
        prune(t);
        t.runs = {};
        this.cache[id] = t;
      }
      this.id = id;
      this.t = this.cache[id];
      this.rerun();
    }

    // Run (or reuse) the replay of the current task with the current settings, and start it from the beginning.
    rerun() {
      if (!this.t) return;
      this.pause();
      const c = this.cfg, key = `${c.B}|${c.k}|${c.alpha}|${c.C}`;
      if (!this.t.runs[key]) this.t.runs[key] = replay(this.t, c);
      this.t.snaps = this.t.runs[key];
      this.edgeLayer.replaceChildren();
      this.nodeLayer.replaceChildren();
      this.els = new Map();
      this.edges = new Map();
      this.pos = new Map();
      this.target = new Map();
      this.inspect = null;
      this.autoFit = true;
      const last = this.t.snaps.length - 1;
      this.slider.max = String(last);
      this.markers.replaceChildren(...this.t.snaps.map((s, i) => s.newPlan
        ? el("button", { class: "ds-marker", style: `left:${(i / Math.max(last, 1)) * 100}%`, title: `Plan ${s.plans.length} found in iteration ${i}`,
          "aria-label": `Jump to iteration ${i}: plan ${s.plans.length}`, onclick: () => { this.pause(); this.go(i, false); } })
        : null).filter(Boolean));
      this.i = 0;
      this.go(0, false);
    }

    node(id) { return this.t.byId.get(id); }
    src(rel) { return this.t.dir + rel; }

    // --------------------------------------------------------------- playback
    toggle() { if (this.timer) this.pause(); else this.play(); }

    play() {
      if (!this.t) return;
      if (this.i >= this.t.snaps.length - 1) this.go(0, false);
      this.setPlayIcon(true);
      const step = () => {
        if (this.i >= this.t.snaps.length - 1) { this.pause(); return; }
        this.go(this.i + 1, true);
        this.timer = setTimeout(step, STEP_MS / this.speed);
      };
      this.timer = setTimeout(step, 250);
    }

    pause() {
      clearTimeout(this.timer);
      this.timer = null;
      this.setPlayIcon(false);
    }

    setPlayIcon(playing) {
      this.playBtn.replaceChildren(playing
        ? svg("svg", { viewBox: "0 0 24 24", width: 22, height: 22 }, svg("rect", { x: 6, y: 5, width: 4, height: 14, rx: 1 }),
          svg("rect", { x: 14, y: 5, width: 4, height: 14, rx: 1 }))
        : svg("svg", { viewBox: "0 0 24 24", width: 22, height: 22 }, svg("path", { d: "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" })));
      this.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
      this.playBtn.title = playing ? "Pause (space)" : "Play (space)";
    }

    go(i, animate) {
      this.i = clamp(i, 0, this.t.snaps.length - 1);
      this.inspect = null;
      this.render(animate);
      for (const w of this.t.snaps[this.i].widened || []) this.widenFx(w.node, w.kids);
    }

    // --------------------------------------------------------------- drawing
    render(animate) {
      if (!this.t) return;
      const t = this.t, s = t.snaps[this.i], last = t.snaps.length - 1;
      this.revealed = new Set(s.revealed);
      this.rolled = new Set(s.rolled);
      const onPath = new Set(s.path), added = new Set(s.added), executed = new Set(s.executed);
      // Failed actions are drawn only in the iteration that sampled them, then fade out; dead-end marks still count them.
      const fresh = s.added.filter((id) => !feasible(this.node(id)));
      this.shown = new Set(s.revealed.filter((id) => feasible(this.node(id)) || added.has(id)));
      clearTimeout(this.fadeTimer);
      for (const id of this.shown) this.ensureEl(this.node(id));
      for (const [id, e] of this.els) {
        const show = this.shown.has(id);
        e.g.style.display = show ? "" : "none";
        e.g.classList.remove("ds-fading");
        const edge = this.edges.get(id);
        if (edge) { edge.style.display = show ? "" : "none"; edge.classList.remove("ds-fading"); }
      }
      for (const id of this.shown) this.styleNode(this.node(id), s, onPath, added, executed);
      this.relayout(animate);
      if (fresh.length) this.fadeOut(fresh);

      const pct = last ? (this.i / last) * 100 : 0;
      this.slider.value = String(this.i);
      this.slider.style.setProperty("--pct", `${pct}%`);
      this.timeLabel.textContent = `Iteration ${this.i} / ${last}`;
      this.showViewer(s);
    }

    ensureEl(n) {
      if (this.els.has(n.id)) return this.els.get(n.id);
      const ring = svg("circle", { class: "ds-ring", r: R + 1.5 });
      const halo = svg("circle", { class: "ds-halo", r: R + 8 });
      const img = svg("image", { x: -R, y: -R, width: 2 * R, height: 2 * R, "clip-path": `url(#${this.clipId})`, preserveAspectRatio: "xMidYMid slice" });
      const markBg = svg("circle", { class: "ds-mark-bg", cx: R * 0.74, cy: -R * 0.74, r: 11 });
      const mark = svg("text", { class: "ds-mark", x: R * 0.74, y: -R * 0.74 });
      const label = svg("text", { class: "ds-label", y: R + 17 });
      const stat = svg("text", { class: "ds-stat", y: R + 31 });
      const title = svg("title");
      const g = svg("g", { class: "ds-node", "data-id": n.id }, title, halo, ring, img, markBg, mark, label, stat);
      this.nodeLayer.append(g);
      const e = { g, img, mark, markBg, label, stat, title };
      this.els.set(n.id, e);
      if (n.parent !== null) {
        const path = svg("path", { class: "ds-edge" });
        this.edgeLayer.append(path);
        this.edges.set(n.id, path);
      }
      return e;
    }

    // Progressive widening: gold ripples from the state, a "widened +n" tag, and its new edges glow for a moment.
    widenFx(id, kids) {
      const e = this.els.get(id);
      if (!e) return;
      for (let k = 0; k < 3; k++) {
        const ring = svg("circle", { class: "ds-pw-ripple", r: R + 4, style: `animation-delay:${k * 0.22}s` });
        e.g.insertBefore(ring, e.g.children[1]);
        setTimeout(() => ring.remove(), 1400 + k * 220);
      }
      const tag = svg("text", { class: "ds-pw-tag", y: -R - 14 });
      tag.textContent = `widened +${kids.length}`;
      e.g.append(tag);
      setTimeout(() => tag.remove(), 1900);
      for (const kid of kids) {
        const edge = this.edges.get(kid);
        if (!edge) continue;
        edge.classList.add("ds-pw-edge");
        setTimeout(() => edge.classList.remove("ds-pw-edge"), 1700);
      }
    }

    fadeOut(ids) {
      const i = this.i;
      this.fadeTimer = setTimeout(() => {
        if (this.i !== i) return;
        for (const id of ids) { this.els.get(id)?.g.classList.add("ds-fading"); this.edges.get(id)?.classList.add("ds-fading"); }
        this.fadeTimer = setTimeout(() => {
          if (this.i !== i) return;
          for (const id of ids) {
            this.shown.delete(id);
            this.els.get(id).g.style.display = "none";
            const edge = this.edges.get(id);
            if (edge) edge.style.display = "none";
          }
          this.relayout(true);
        }, FADE_MS);
      }, FAIL_LINGER_MS / this.speed);
    }

    isDead(n) {
      return n.parent !== null && n.status !== "goal" && feasible(n) && this.rolled.has(n.id) &&
        n.kids.every((c) => this.revealed.has(c.id) && !feasible(c));
    }

    styleNode(n, s, onPath, added, executed) {
      const e = this.els.get(n.id), rolled = this.rolled.has(n.id), failed = !feasible(n);
      const outcome = failed ? "failed" : rolled && n.status === "goal" ? "goal" : this.isDead(n) ? "dead" : "";
      e.g.dataset.outcome = outcome;
      e.g.classList.toggle("ds-sampled", !rolled && !failed);
      e.g.classList.toggle("ds-on-path", onPath.has(n.id));
      e.g.classList.toggle("ds-new", added.has(n.id));
      e.g.classList.toggle("ds-executed", executed.has(n.id));
      e.g.classList.toggle("ds-end", s.end === n.id && this.i > 0);
      e.g.classList.toggle("ds-inspected", this.inspect === n.id);
      const href = failed ? n.outcome_thumb || n.thumb : rolled ? n.thumb : n.card || n.thumb;
      if (e.img.getAttribute("href") !== this.src(href)) e.img.setAttribute("href", this.src(href));
      const markText = { goal: "★", failed: "✕", dead: "⊘" }[outcome] || "";
      e.mark.textContent = markText;
      e.mark.style.fill = outcome === "goal" ? "var(--ds-goal)" : "var(--ds-failed)";
      e.mark.style.display = e.markBg.style.display = markText ? "" : "none";
      e.label.textContent = failed ? "failed" : rolled && n.progress !== null ? `${n.progress}/${this.t.num_objects}` : "";
      const N = s.N.get(n.id) || 0;
      e.stat.textContent = failed ? "" : N ? `N ${N} · Q ${fmt(s.W.get(n.id) / N)}` : n.id === 0 ? "" : `Qφ ${fmt(n.Q)}`;
      e.title.textContent = n.id === 0 ? "Start" : failed ? `Failed action: ${failName(n.failure_type)}`
        : !rolled ? "Sampled from π, not executed yet" : outcome === "dead" ? "Dead end" : `Step ${n.depth}`;
      const edge = this.edges.get(n.id);
      if (edge) {
        edge.classList.toggle("ds-edge-sampled", !rolled && !failed);
        edge.classList.toggle("ds-edge-failed", failed);
        edge.classList.toggle("ds-edge-path", onPath.has(n.id));
      }
    }

    // Tidy layered layout of the revealed nodes: leaves on consecutive slots, parents centred over their children.
    relayout(animate) {
      const target = new Map();
      let slot = 0;
      const visit = (n) => {
        const kids = n.kids.filter((c) => this.shown.has(c.id));
        if (!kids.length) target.set(n.id, { x: slot++ * DX, y: n.depth * DY });
        else {
          kids.forEach(visit);
          const xs = kids.map((c) => target.get(c.id).x);
          target.set(n.id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: n.depth * DY });
        }
      };
      visit(this.node(0));
      const x0 = target.get(0).x;
      for (const q of target.values()) q.x -= x0;
      this.target = target;
      const from = new Map();
      for (const [id, q] of target) {
        const par = this.node(id).parent;
        from.set(id, this.pos.get(id) || (par !== null && this.pos.get(par)) || q);
      }
      cancelAnimationFrame(this.layoutRaf);
      clearTimeout(this.layoutSnap);
      const settle = () => { cancelAnimationFrame(this.layoutRaf); this.pos = new Map(target); this.applyPositions(); };
      if (this.autoFit) this.fit(animate);
      if (!animate) { settle(); return; }
      const t0 = performance.now();
      const step = (now) => {
        const u = ease(clamp((now - t0) / TWEEN_MS, 0, 1));
        for (const [id, q] of target) {
          const f = from.get(id);
          this.pos.set(id, { x: f.x + (q.x - f.x) * u, y: f.y + (q.y - f.y) * u });
        }
        this.applyPositions();
        if (u < 1) this.layoutRaf = requestAnimationFrame(step);
      };
      this.layoutRaf = requestAnimationFrame(step);
      this.layoutSnap = setTimeout(settle, TWEEN_MS + 60);  // finish even when frames are throttled (hidden tab)
    }

    applyPositions() {
      for (const id of this.shown) {
        const q = this.pos.get(id), e = this.els.get(id);
        if (!q || !e) continue;
        e.g.setAttribute("transform", `translate(${q.x},${q.y})`);
        const edge = this.edges.get(id);
        if (edge) {
          const a = this.pos.get(this.node(id).parent);
          const y1 = a.y + R + 37, y2 = q.y - R - 4, m = (y1 + y2) / 2;
          edge.setAttribute("d", `M${a.x},${y1} C${a.x},${m} ${q.x},${m} ${q.x},${y2}`);
        }
      }
    }

    // --------------------------------------------------------------- pan / zoom
    size() { const b = this.svg.getBoundingClientRect(); return { W: b.width || 600, H: b.height || 480 }; }

    applyView() {
      if (!this.view) return;
      const v = this.view;
      this.viewport.setAttribute("transform", `translate(${v.tx},${v.ty}) scale(${v.k})`);
    }

    // Fit the whole revealed tree, but never so small that nodes vanish: wide trees fill the height and follow the
    // newest path sideways.
    fit(animate = true) {
      const pts = [...this.target.values()];
      if (!pts.length) return;
      const { W, H } = this.size(), pad = R + 40;
      const x0 = Math.min(...pts.map((q) => q.x)) - pad, x1 = Math.max(...pts.map((q) => q.x)) + pad;
      const y0 = Math.min(...pts.map((q) => q.y)) - pad, y1 = Math.max(...pts.map((q) => q.y)) + pad + 30;
      const k = clamp(Math.min(W / (x1 - x0), H / (y1 - y0)), Math.min(0.55, H / (y1 - y0)), 1);
      let cx = (x0 + x1) / 2;
      if (k * (x1 - x0) > W) {  // too wide to show whole: follow this iteration's path
        const s = this.t.snaps[this.i], p = this.target.get(s.end) || this.target.get(0);
        cx = clamp(p.x, x0 + W / (2 * k), x1 - W / (2 * k));
      }
      const to = { k, tx: W / 2 - k * cx, ty: Math.min(H / 2 - k * (y0 + y1) / 2, 30 - k * y0) };
      if (!animate || !this.view) { this.view = to; this.applyView(); return; }
      const from = { ...this.view }, t0 = performance.now();
      cancelAnimationFrame(this.viewRaf);
      const step = (now) => {
        const u = ease(clamp((now - t0) / TWEEN_MS, 0, 1));
        this.view = { k: from.k + (to.k - from.k) * u, tx: from.tx + (to.tx - from.tx) * u, ty: from.ty + (to.ty - from.ty) * u };
        this.applyView();
        if (u < 1) this.viewRaf = requestAnimationFrame(step);
      };
      this.viewRaf = requestAnimationFrame(step);
    }

    zoomAt(px, py, f) {
      const v = this.view, k = clamp(v.k * f, 0.06, 3);
      this.view = { k, tx: px - (px - v.tx) * (k / v.k), ty: py - (py - v.ty) * (k / v.k) };
      this.autoFit = false;
      this.applyView();
    }

    zoomBy(f) { cancelAnimationFrame(this.viewRaf); const { W, H } = this.size(); this.zoomAt(W / 2, H / 2, f); }

    bindPanZoom() {
      const s = this.svg, pts = new Map();
      let drag = null;
      const local = (e) => { const b = s.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
      s.addEventListener("wheel", (e) => {
        if (!this.view) return;
        e.preventDefault();
        cancelAnimationFrame(this.viewRaf);
        const q = local(e);
        this.zoomAt(q.x, q.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)));
      }, { passive: false });
      s.addEventListener("pointerdown", (e) => {
        if (!this.view) return;
        cancelAnimationFrame(this.viewRaf);
        try { s.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already-released pointer */ }
        pts.set(e.pointerId, local(e));
        drag = { moved: 0, hit: pts.size === 1 ? e.target.closest(".ds-node") : null };
      });
      s.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId) || !drag) return;
        const q = local(e), prev = pts.get(e.pointerId);
        if (pts.size === 1) {
          this.view.tx += q.x - prev.x;
          this.view.ty += q.y - prev.y;
          drag.moved += Math.abs(q.x - prev.x) + Math.abs(q.y - prev.y);
          if (drag.moved > 5) { s.classList.add("ds-dragging"); this.autoFit = false; }
          this.applyView();
        } else if (pts.size === 2) {
          const [a, b] = [...pts.entries()].map(([id, w]) => (id === e.pointerId ? q : w));
          const [a0, b0] = [...pts.values()];
          const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
          if (d0 > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d1 / d0);
          drag.moved += 100;
        }
        pts.set(e.pointerId, q);
      });
      const up = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (pts.size === 0 && drag) {
          s.classList.remove("ds-dragging");
          if (drag.moved <= 5 && drag.hit) { this.inspect = Number(drag.hit.dataset.id); this.render(false); }
          drag = null;
        }
      };
      s.addEventListener("pointerup", up);
      s.addEventListener("pointercancel", up);
    }

    // --------------------------------------------------------------- viewer
    deadReason(n) {
      const r = this.reasons[`${this.id}/${n.id}`];
      if (r) return r;
      return "No saved action from this state leads anywhere new.";
    }

    showViewer(s) {
      const t = this.t, last = t.snaps.length - 1, total = t.num_objects, shelf = t.task === "shelf";
      const n = this.node(this.inspect ?? s.end), failed = !feasible(n);
      this.stageImg.src = this.src(failed && n.outcome_image ? n.outcome_image : n.image);
      this.stageTag.textContent = this.inspect !== null ? (n.id === 0 ? "Start" : `Inspecting step ${n.depth}`)
        : this.i === 0 ? "Start" : `Iteration ${this.i}: end state`;
      this.iterTitle.textContent = this.i === 0 ? "Before the search" : `Iteration ${this.i} of ${last}`;

      let kind = "info", head, text = "";
      if (this.inspect !== null) {
        const N = s.N.get(n.id) || 0;
        head = n.id === 0 ? "Start state" : failed ? `Failed action: ${failName(n.failure_type)}` : `Step ${n.depth}`;
        if (failed) kind = "failed";
        else if (this.isDead(n)) { kind = "dead"; head = "Dead end"; text = this.deadReason(n); }
        else if (n.status === "goal" && this.rolled.has(n.id)) { kind = "goal"; head = "A plan (goal state)"; }
        if (!failed && !text) text = (shelf ? `${n.progress ?? 0}/${total} objects in the shelf` : `Tower height ${n.progress ?? 0}/${total}`) +
          (N ? ` · visited ${N}× · Q ${fmt(s.W.get(n.id) / N)}` : ` · not visited yet · Qφ ${fmt(n.Q)}`);
      } else if (this.i === 0) {
        head = shelf ? `Pack all ${total} objects into the shelf` : `Stack all ${total} objects into one tower`;
        text = "Press play to watch DISCO search, or drag the timeline.";
      } else if (s.why === "goal") {
        kind = "goal";
        head = s.newPlan ? `Plan ${s.plans.length} found!` : "Reached a goal";
        text = `All ${total} objects ${shelf ? "are in the shelf" : "are stacked"} after ${plural(n.depth, "action")}.`;
      } else if (s.why === "dead") { kind = "dead"; head = "Rollout ended at a dead end"; text = this.deadReason(n); }
      else { kind = "dead"; head = "Rollout ended"; text = "Every action sampled from π at this state failed, so the rollout stops here."; }
      this.outcome.dataset.kind = kind;
      this.outcome.replaceChildren(el("b", {}, head), text ? el("span", {}, text) : null);

      const stat = (v, l) => el("div", { class: "ds-statbox" }, el("b", {}, String(v)), el("span", {}, l));
      this.stats.replaceChildren(stat(s.plans.length, s.plans.length === 1 ? "plan" : "plans"),
        stat(s.revealed.length, "nodes"), stat(s.sampled, "policy calls"), stat(s.actions, "executed"));
      this.log.replaceChildren(...s.log.map((l) => el("li", { class: `ds-log-${l.kind}` }, l.text)));
      if (this.i === 0) this.log.replaceChildren(el("li", { class: "ds-log-check" }, "The tree holds only the start state."));
    }
  }

  function boot() {
    document.querySelectorAll("[data-disco-search]").forEach((r) => { if (!r.dsSearch) r.dsSearch = new Search(r); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
