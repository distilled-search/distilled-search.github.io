// DISCO search-tree explorer: grow DISCO's MCTS tree yourself. Select a node, sample the actions the search tried
// there, and click one to roll it out: the viewer plays the simulated robot executing it, and the node turns into the
// state it reached. Mount: <div class="dx" data-disco-explorer data-base="./"></div> + this script + explorer.css.
(function () {
  "use strict";

  const R = 34;               // node radius, graph units
  const DX = 92, DY = 150;    // sibling and level spacing
  const TWEEN_MS = 380;

  const FAILURE_TEXT = {
    place_motion_plan: ["No placement motion", "The object was grasped, but no collision-free motion to its placement could be planned."],
    place_execution: ["Placement failed", "The placement was executed, but the object did not end up inside the shelf."],
    grasp_execution: ["Grasp slipped", "The gripper closed, but the object was not lifted."],
    knocked_base: ["Knocked the base", "The placement knocked the tower's base."],
    no_contact_or_offset: ["Missed the base", "The object did not land on the block below."],
    ik_infeasible: ["Unreachable grasp", "No arm configuration reaches the grasp."],
    pick_failed: ["Pick failed", "The pick could not be executed."],
    grasp_motion_plan: ["No grasp motion", "No collision-free motion to the grasp could be planned."],
    pre_grasp_motion_plan: ["No approach motion", "No collision-free motion to the pre-grasp pose could be planned."],
    expansion_crashed: ["Simulation error", "The simulator failed on this action."],
  };
  const STATUS_TEXT = {
    goal: "solves it", on_path: "leads to a solution", solved_hidden: "solved (not shown)",
    dead_end: "dead end", unexplored: "unexplored", failed: "fails",
  };
  let instances = 0;

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
  const failText = (t) => FAILURE_TEXT[t] || [String(t).replace(/_/g, " "), ""];
  const ease = (u) => 1 - Math.pow(1 - u, 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class Explorer {
    constructor(root) {
      this.root = root;
      this.base = (root.dataset.base || "./").replace(/\/?$/, "/");
      this.clipId = `dx-clip-${instances++}`;
      this.cache = {};
      this.rate = 1;
      this.busy = false;
      this.build();
      fetch(this.base + "data/games.json").then((r) => r.json()).then((games) => {
        this.games = games;
        this.tabs.replaceChildren(...games.map((g) =>
          el("button", { class: "dx-tab", role: "tab", "data-id": g.id, onclick: () => this.load(g.id) }, g.title)));
        this.load(games[0].id);
      });
    }

    // =============================================================== skeleton
    build() {
      const r = this.root;
      r.classList.add("dx");
      this.tabs = el("div", { class: "dx-tabs", role: "tablist" });
      this.blurb = el("p", { class: "dx-blurb" });

      // graph
      this.edgeLayer = svg("g");
      this.nodeLayer = svg("g");
      this.pill = svg("g", { class: "dx-pill", style: "display:none" }, svg("rect", { rx: 14, height: 28 }), svg("text"));
      this.viewport = svg("g", {}, this.edgeLayer, this.nodeLayer, this.pill);
      this.svg = svg("svg", { class: "dx-graph", role: "img", "aria-label": "Search tree" },
        svg("defs", {}, svg("clipPath", { id: this.clipId, clipPathUnits: "objectBoundingBox" },
          svg("circle", { cx: 0.5, cy: 0.5, r: 0.5 }))),
        this.viewport);
      const zoom = el("div", { class: "dx-zoom" },
        el("button", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => this.zoomBy(1.3) }, "+"),
        el("button", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => this.zoomBy(1 / 1.3) }, "−"),
        el("button", { title: "Fit the tree", "aria-label": "Fit the tree", onclick: () => this.fit(null) }, "⤢"));
      const legend = el("div", { class: "dx-legend" },
        ...[["goal", "goal"], ["on-path", "leads to a solution"], ["hidden", "solved (not shown)"], ["dead", "dead end"],
          ["failed", "fails"]].map(([c, t]) => el("span", { style: `--c: var(--dx-${c})` }, t)));
      this.help = el("div", { class: "dx-graph-help" }, "Click a node · scroll to zoom · drag to pan");
      const graphWrap = el("div", { class: "dx-graph-wrap" }, this.svg, this.help, zoom, legend);

      // viewer
      this.stageImg = el("img", { alt: "" });
      this.video = el("video", { muted: "", playsinline: "", preload: "auto" });
      this.video.muted = true;
      this.video.addEventListener("ended", () => this.onVideoEnd());
      this.banner = el("div", { class: "dx-banner", role: "status" });
      this.stepTag = el("div", { class: "dx-step-tag" });
      this.stage = el("div", { class: "dx-stage" }, this.stageImg, this.video, this.stepTag,
        el("button", { class: "dx-skip", onclick: () => this.skip() }, "Skip ▸▸"), this.banner);
      this.progress = el("div", { class: "dx-status-row" });
      this.sampleBtn = el("button", { class: "dx-btn dx-primary", onclick: () => this.sample(this.sel()) }, "Sample actions");
      this.planBtn = el("button", { class: "dx-btn", onclick: () => this.playPlan() }, "Show DISCO's plan");
      this.note = el("p", { class: "dx-note" });
      const hint = el("input", { type: "checkbox", onchange: (e) => this.root.classList.toggle("dx-hints", e.target.checked) });
      const speed = el("button", {
        class: "dx-btn", title: "Playback speed",
        onclick: (e) => { this.rate = this.rate === 1 ? 2 : 1; e.target.textContent = this.rate + "×"; this.video.playbackRate = this.rate; },
      }, "1×");
      const controls = el("div", { class: "dx-controls" },
        el("button", { class: "dx-btn", onclick: () => this.reset() }, "Reset"),
        el("button", { class: "dx-btn", onclick: () => this.revealAll() }, "Reveal whole tree"),
        el("span", { class: "dx-spacer" }), el("label", { class: "dx-toggle" }, hint, "Hints"), speed);
      const viewer = el("div", { class: "dx-viewer" }, this.stage, this.progress,
        el("div", { class: "dx-actions" }, this.sampleBtn, this.planBtn), this.note, controls);

      this.footer = el("p", { class: "dx-footer" });
      r.append(this.tabs, this.blurb, el("div", { class: "dx-main" }, graphWrap, viewer), this.footer);

      this.bindPanZoom();
      new ResizeObserver(() => this.tree && this.applyView()).observe(this.svg);
      document.addEventListener("keydown", (e) => {
        if (!this.root.isConnected || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
        if ((e.key === " " || e.key === "Escape") && this.busy) { e.preventDefault(); this.skip(); }
      });
    }

    // =============================================================== data
    async load(id) {
      this.cancelAuto();
      if (this.busy) this.stopVideo();
      for (const t of this.tabs.children) t.setAttribute("aria-selected", t.dataset.id === id ? "true" : "false");
      this.blurb.textContent = this.games.find((g) => g.id === id).blurb || "";
      if (!this.cache[id]) {
        const t = await (await fetch(`${this.base}data/${id}/tree.json`)).json();
        t.byId = new Map(t.nodes.map((n) => [n.id, n]));
        t.dir = `${this.base}data/${id}/`;
        for (const n of t.nodes) {  // fixed sibling order: successful actions by search visits, then failures
          n.kids = n.children.map((c) => t.byId.get(c))
            .sort((a, b) => (a.status === "failed") - (b.status === "failed") || b.visits - a.visits || a.id - b.id);
        }
        this.cache[id] = t;
        this.initState(t);
      }
      this.tree = this.cache[id];
      this.footer.textContent = this.footerText();
      this.redraw();
      this.select(this.tree.selected);
    }

    initState(t) {
      t.revealed = new Set([0]);
      t.rolled = new Set([0]);
      t.selected = 0;
      t.pos = new Map();
      t.view = null;
    }

    footerText() {
      const s = this.tree.summary;
      const what = this.tree.task === "shelf" ? "pack every object into the shelf" : "stack every object into one tower";
      return `Goal: ${what}. Every video is the simulated robot replaying the motion DISCO's search executed for that ` +
        `action (${s.valid_edges} successful actions${s.failed_edges ? ` and ${s.failed_edges} failed attempts` : ""} ` +
        `shown, from a search tree of ${s.tree_nodes} nodes).`;
    }

    node(id) { return this.tree.byId.get(id); }
    sel() { return this.node(this.tree.selected); }
    src(rel) { return this.tree.dir + rel; }
    lineage(n) { const p = []; for (let x = n; x; x = x.parent === null ? null : this.node(x.parent)) p.unshift(x); return p; }
    hidden(n) { return n.kids.filter((k) => !this.tree.revealed.has(k.id)); }
    canSample(n) { const t = this.tree; return t.rolled.has(n.id) && n.status !== "failed" && this.hidden(n).length > 0; }
    hasPlan(n) {
      return this.tree.rolled.has(n.id) && n.status !== "goal" &&
        n.kids.some((k) => k.status === "on_path" || k.status === "goal");
    }

    // =============================================================== graph drawing
    redraw() {
      const t = this.tree;
      this.edgeLayer.replaceChildren();
      this.nodeLayer.replaceChildren();
      this.els = new Map();
      this.edges = new Map();
      for (const id of t.revealed) this.ensureEl(this.node(id));
      this.relayout(false);
      if (!t.view) this.homeView(); else this.applyView();
    }

    ensureEl(n) {
      if (this.els.has(n.id)) return this.els.get(n.id);
      const sel = svg("circle", { class: "dx-sel", r: R + 7 });
      const ring = svg("circle", { class: "dx-ring", r: R + 1.5 });
      const img = svg("image", { x: -R, y: -R, width: 2 * R, height: 2 * R, "clip-path": `url(#${this.clipId})`,
        preserveAspectRatio: "xMidYMid slice" });
      const markBg = svg("circle", { class: "dx-node-mark-bg", cx: R * 0.74, cy: -R * 0.74, r: 11 });
      const mark = svg("text", { class: "dx-node-mark", x: R * 0.74, y: -R * 0.74 });
      const label = svg("text", { class: "dx-node-label", y: R + 17 });
      const title = svg("title");
      const g = svg("g", { class: "dx-node", "data-id": n.id }, title, sel, ring, img, markBg, mark, label);
      this.nodeLayer.append(g);
      const e = { g, img, mark, markBg, label, title };
      this.els.set(n.id, e);
      if (n.parent !== null) {
        const path = svg("path", { class: "dx-edge" });
        this.edgeLayer.append(path);
        this.edges.set(n.id, path);
      }
      this.styleNode(n);
      return e;
    }

    styleNode(n) {
      const t = this.tree, e = this.els.get(n.id);
      if (!e) return;
      const rolled = t.rolled.has(n.id);
      const failed = n.status === "failed";
      e.g.classList.toggle("dx-proposed", !rolled);
      e.g.classList.toggle("dx-selected", t.selected === n.id && !this.busy);
      e.g.classList.toggle("dx-playing", this.busy && this.pending === n);
      e.g.dataset.status = n.status;
      let outcome = "";
      if (rolled && failed) outcome = "failed";
      else if (rolled && n.status === "goal") outcome = "goal";
      else if (rolled && n.id !== 0 && !n.kids.length) outcome = "leaf";
      e.g.dataset.outcome = outcome;
      const href = rolled ? (failed ? n.outcome_thumb || n.thumb : n.thumb) : (n.card || n.thumb);
      if (e.img.getAttribute("href") !== href) e.img.setAttribute("href", this.src(href));
      const markText = outcome === "goal" ? "★" : outcome === "failed" ? "✕" : "";
      e.mark.textContent = markText;
      e.mark.style.fill = outcome === "goal" ? "var(--dx-goal)" : "var(--dx-failed)";
      e.mark.style.display = e.markBg.style.display = markText ? "" : "none";
      e.markBg.style.fill = "var(--dx-bg)";
      e.label.textContent = rolled && !failed && n.progress !== null ? `${n.progress}/${t.num_objects}` : "";
      e.title.textContent = n.id === 0 ? "Start" : !rolled
        ? `Action — click to roll it out (search visited ${n.visits}×)`
        : failed ? `Failed: ${failText(n.failure_type)[0]}` : `Step ${n.depth}`;
      const edge = this.edges.get(n.id);
      if (edge) {
        edge.classList.toggle("dx-proposed", !rolled);
        edge.classList.toggle("dx-playing", this.busy && this.pending === n);
      }
    }

    styleAll() {
      const trail = new Set(this.lineage(this.sel()).map((n) => n.id));
      for (const id of this.tree.revealed) {
        const n = this.node(id);
        this.styleNode(n);
        this.edges.get(id)?.classList.toggle("dx-on-trail", trail.has(id) && !(this.busy && this.pending === n));
      }
      this.placePill();
    }

    // Tidy layered layout of the revealed nodes: leaves on consecutive slots, parents centred over their children.
    relayout(animate = true) {
      const t = this.tree, target = new Map();
      let slot = 0;
      const visit = (n) => {
        const kids = n.kids.filter((k) => t.revealed.has(k.id));
        if (!kids.length) target.set(n.id, { x: slot++ * DX, y: n.depth * DY });
        else {
          kids.forEach(visit);
          const xs = kids.map((k) => target.get(k.id).x);
          target.set(n.id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: n.depth * DY });
        }
      };
      visit(this.node(0));
      const x0 = target.get(0).x;
      for (const p of target.values()) p.x -= x0;
      t.target = target;
      const from = new Map();
      for (const [id, p] of target) {
        const par = this.node(id).parent;
        from.set(id, t.pos.get(id) || (par !== null && t.pos.get(par)) || p);
      }
      cancelAnimationFrame(this.layoutRaf);
      clearTimeout(this.layoutSnap);
      const settle = () => { cancelAnimationFrame(this.layoutRaf); t.pos = new Map(target); this.applyPositions(); };
      if (!animate) { settle(); return; }
      const t0 = performance.now();
      const step = (now) => {
        const u = ease(clamp((now - t0) / TWEEN_MS, 0, 1));
        for (const [id, p] of target) {
          const f = from.get(id);
          t.pos.set(id, { x: f.x + (p.x - f.x) * u, y: f.y + (p.y - f.y) * u });
        }
        this.applyPositions();
        if (u < 1) this.layoutRaf = requestAnimationFrame(step);
      };
      this.layoutRaf = requestAnimationFrame(step);
      this.layoutSnap = setTimeout(settle, TWEEN_MS + 60);  // finish even when frames are throttled (hidden tab)
    }

    applyPositions() {
      const t = this.tree;
      for (const id of t.revealed) {
        const p = t.pos.get(id), e = this.els.get(id);
        if (!p || !e) continue;
        e.g.setAttribute("transform", `translate(${p.x},${p.y})`);
        const edge = this.edges.get(id);
        if (edge) {
          const q = t.pos.get(this.node(id).parent);
          const y1 = q.y + R + 23, y2 = p.y - R - 4, m = (y1 + y2) / 2;  // start below the parent's progress label
          edge.setAttribute("d", `M${q.x},${y1} C${q.x},${m} ${p.x},${m} ${p.x},${y2}`);
        }
      }
      this.placePill();
    }

    placePill() {
      const n = this.sel(), p = this.tree.pos.get(n.id);
      const show = p && !this.busy && this.canSample(n);
      this.pill.style.display = show ? "" : "none";
      if (!show) return;
      const text = `Sample actions (${this.hidden(n).length})`;
      const w = 30 + text.length * 7.2;
      const [rect, label] = this.pill.children;
      rect.setAttribute("x", -w / 2);
      rect.setAttribute("y", -14);
      rect.setAttribute("width", w);
      label.textContent = text;
      this.pill.setAttribute("transform", `translate(${p.x},${p.y + R + 44})`);
    }

    // =============================================================== pan / zoom
    applyView() {
      const v = this.tree.view;
      this.viewport.setAttribute("transform", `translate(${v.tx},${v.ty}) scale(${v.k})`);
    }

    size() { const b = this.svg.getBoundingClientRect(); return { W: b.width || 600, H: b.height || 500 }; }

    homeView() {
      const { W } = this.size();
      this.tree.view = { tx: W / 2, ty: R + 70, k: 1 };
      this.applyView();
    }

    animateView(to) {
      this.stopViewTween();
      const from = { ...this.tree.view }, t0 = performance.now();
      const step = (now) => {
        const u = ease(clamp((now - t0) / 450, 0, 1));
        this.tree.view = { tx: from.tx + (to.tx - from.tx) * u, ty: from.ty + (to.ty - from.ty) * u, k: from.k + (to.k - from.k) * u };
        this.applyView();
        if (u < 1) this.viewRaf = requestAnimationFrame(step);
      };
      this.viewRaf = requestAnimationFrame(step);
      this.viewSnap = setTimeout(() => { cancelAnimationFrame(this.viewRaf); this.tree.view = { ...to }; this.applyView(); }, 510);
    }

    stopViewTween() { cancelAnimationFrame(this.viewRaf); clearTimeout(this.viewSnap); }

    // Bring nodes into view (all revealed if ids is null). With onlyIfNeeded, keep the view when they already fit,
    // pan when they fit at the current zoom, and zoom out only when they do not.
    fit(ids, onlyIfNeeded = false) {
      const t = this.tree, { W, H } = this.size(), pad = R + 46;
      const pts = (ids || [...t.revealed]).map((id) => t.target.get(id)).filter(Boolean);
      if (!pts.length) return;
      const x0 = Math.min(...pts.map((p) => p.x)) - pad, x1 = Math.max(...pts.map((p) => p.x)) + pad;
      const y0 = Math.min(...pts.map((p) => p.y)) - pad, y1 = Math.max(...pts.map((p) => p.y)) + pad + 30;
      const v = t.view;
      if (onlyIfNeeded) {
        const sx0 = v.tx + x0 * v.k, sx1 = v.tx + x1 * v.k, sy0 = v.ty + y0 * v.k, sy1 = v.ty + y1 * v.k;
        if (sx0 >= 0 && sy0 >= 0 && sx1 <= W && sy1 <= H) return;
      }
      let k = Math.min(W / (x1 - x0), H / (y1 - y0), 1.25);
      if (onlyIfNeeded) k = Math.min(k, v.k);
      this.animateView({ k, tx: W / 2 - k * (x0 + x1) / 2, ty: H / 2 - k * (y0 + y1) / 2 });
    }

    zoomAt(px, py, f) {
      const v = this.tree.view, k = clamp(v.k * f, 0.08, 3);
      this.tree.view = { k, tx: px - (px - v.tx) * (k / v.k), ty: py - (py - v.ty) * (k / v.k) };
      this.applyView();
    }

    zoomBy(f) {
      this.stopViewTween();
      const { W, H } = this.size();
      this.zoomAt(W / 2, H / 2, f);
    }

    bindPanZoom() {
      const s = this.svg, pts = new Map();
      let drag = null;
      const local = (e) => { const b = s.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
      s.addEventListener("wheel", (e) => {
        if (!this.tree) return;
        e.preventDefault();
        this.stopViewTween();
        const p = local(e);
        this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)));
      }, { passive: false });
      s.addEventListener("pointerdown", (e) => {
        if (!this.tree) return;
        this.stopViewTween();
        try { s.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already-released pointer */ }
        pts.set(e.pointerId, local(e));
        const hit = e.target.closest(".dx-node, .dx-pill");
        drag = { moved: 0, hit: pts.size === 1 ? hit : null };
      });
      s.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId) || !drag) return;
        const p = local(e), prev = pts.get(e.pointerId);
        if (pts.size === 1) {
          const v = this.tree.view;
          v.tx += p.x - prev.x;
          v.ty += p.y - prev.y;
          drag.moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
          if (drag.moved > 5) s.classList.add("dx-dragging");
          this.applyView();
        } else if (pts.size === 2) {
          const [a, b] = [...pts.entries()].map(([id, q]) => (id === e.pointerId ? p : q));
          const [a0, b0] = [...pts.values()];
          const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
          if (d0 > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d1 / d0);
          drag.moved += 100;
        }
        pts.set(e.pointerId, p);
      });
      const up = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (pts.size === 0 && drag) {
          s.classList.remove("dx-dragging");
          if (drag.moved <= 5 && drag.hit) {
            if (drag.hit.classList.contains("dx-pill")) this.sample(this.sel());
            else this.onNode(Number(drag.hit.dataset.id));
          }
          drag = null;
        }
      };
      s.addEventListener("pointerup", up);
      s.addEventListener("pointercancel", up);
    }

    // =============================================================== interaction
    onNode(id) {
      if (this.busy) { if (this.pending && this.pending.id === id) this.skip(); return; }
      this.cancelAuto();
      if (this.tree.rolled.has(id)) this.select(id);
      else this.rollout(this.node(id));
    }

    select(id) {
      this.tree.selected = id;
      this.styleAll();
      this.showViewer(this.node(id));
    }

    sample(n) {
      if (!n || this.busy || !this.canSample(n)) return;
      for (const k of n.kids) { this.tree.revealed.add(k.id); this.ensureEl(k); }
      this.relayout(true);
      this.styleAll();
      this.fit([n.id, ...n.kids.map((k) => k.id)], true);
      this.showViewer(n);
    }

    rollout(n) {
      const t = this.tree;
      this.busy = true;
      this.pending = n;
      const parent = this.node(n.parent);
      this.styleAll();
      this.banner.classList.remove("dx-visible");
      this.stepTag.textContent = `Rolling out step ${n.depth}`;
      this.video.src = this.src(n.video);
      this.video.poster = this.src(parent.image);
      this.video.playbackRate = this.rate;
      this.stage.classList.add("dx-playing");
      this.sampleBtn.disabled = this.planBtn.disabled = true;
      this.video.play().catch(() => this.onVideoEnd());
      if (!t.pos.has(n.id)) return;
      this.fit([n.id], true);
    }

    skip() {
      if (!this.busy) return;
      this.video.pause();
      this.onVideoEnd();
    }

    stopVideo() {
      this.video.pause();
      this.busy = false;
      this.pending = null;
      this.stage.classList.remove("dx-playing");
    }

    onVideoEnd() {
      if (!this.busy) return;
      const n = this.pending;
      this.stopVideo();
      this.tree.rolled.add(n.id);
      this.select(n.id);
      if (this.auto) this.autoTimer = setTimeout(() => this.auto && this.auto(), 650);
    }

    // DISCO's plan from the selected node: sample, then roll out the most-visited action that still reaches a goal.
    playPlan() {
      this.auto = () => {
        const n = this.sel();
        const next = n.kids.filter((k) => k.status === "on_path" || k.status === "goal").sort((a, b) => b.visits - a.visits)[0];
        if (!next || n.status === "goal") { this.cancelAuto(); return; }
        if (!this.tree.revealed.has(next.id)) {
          this.sample(n);
          this.autoTimer = setTimeout(() => this.auto && this.rollout(next), 750);
        } else this.rollout(next);
      };
      this.auto();
    }

    cancelAuto() { this.auto = null; clearTimeout(this.autoTimer); }

    reset() {
      this.cancelAuto();
      if (this.busy) this.stopVideo();
      this.initState(this.tree);
      this.redraw();
      this.select(0);
    }

    revealAll() {
      this.cancelAuto();
      for (const n of this.tree.nodes) { this.tree.revealed.add(n.id); this.ensureEl(n); }
      this.relayout(true);
      this.styleAll();
      // Large trees (shelf B has ~575 nodes) fit only as a hairline: keep nodes visible and centre the selection.
      const { W, H } = this.size(), p = this.tree.target.get(this.tree.selected);
      const all = [...this.tree.target.values()];
      const w = Math.max(...all.map((q) => q.x)) - Math.min(...all.map((q) => q.x)) + 2 * R + 80;
      const h = Math.max(...all.map((q) => q.y)) + 2 * R + 140;
      const k = clamp(Math.min(W / w, H / h), 0.22, 1);
      const cx = k * w < W ? (Math.max(...all.map((q) => q.x)) + Math.min(...all.map((q) => q.x))) / 2 : p.x;
      this.animateView({ k, tx: W / 2 - k * cx, ty: H / 2 - k * (h / 2 - R - 50) });
      this.showViewer(this.sel());
    }

    // =============================================================== viewer
    setBanner(kind, title, text) {
      this.banner.dataset.kind = kind;
      this.banner.replaceChildren(el("strong", {}, title), text);
      this.banner.classList.add("dx-visible");
    }

    showViewer(n) {
      if (this.busy) return;
      const t = this.tree, total = t.num_objects, shelf = t.task === "shelf", failed = n.status === "failed";
      this.stage.classList.remove("dx-playing");
      this.stageImg.src = this.src(failed && n.outcome_image ? n.outcome_image : n.image);
      this.stepTag.textContent = n.depth === 0 ? "Start" : `Step ${n.depth}`;

      const done = n.progress ?? 0;
      const label = el("span", { class: "dx-progress-label" }, failed ? "Failed attempt"
        : shelf ? `${done} / ${total} in the shelf` : `Tower height ${done} / ${total}`);
      const pips = el("span", { class: "dx-pips" },
        ...Array.from({ length: total }, (_, i) => el("span", { class: "dx-pip" + (i < done ? " dx-on" : "") })));
      this.progress.replaceChildren(...(failed ? [label] : [label, pips]));

      const hidden = this.hidden(n).length;
      this.sampleBtn.disabled = !this.canSample(n);
      this.sampleBtn.textContent = hidden && !failed ? `Sample actions (${hidden})` : "Sample actions";
      this.planBtn.disabled = !this.hasPlan(n);
      this.note.textContent = failed ? "" : this.triedText(n);

      if (failed) {
        const [title, text] = failText(n.failure_type);
        this.setBanner("failed", title, text + (n.outcome_image ? " The image shows the result the search recorded." : ""));
      } else if (n.status === "goal") {
        this.setBanner("goal", shelf ? `All ${total} objects are in the shelf!` : `All ${total} objects are stacked!`,
          `Reached in ${n.depth} actions. Select another node to explore other branches.`);
      } else if (!n.kids.length && n.id !== 0) {
        if (n.status === "dead_end") this.setBanner("dead_end", "Dead end",
          `The search tried ${n.tried.total} action${n.tried.total === 1 ? "" : "s"} from this state and none of them led to a solution.`);
        else if (n.status === "solved_hidden") this.setBanner("info", "The search continued from here",
          "It found a solution below this state, but those motions were not saved, so they cannot be played.");
        else this.setBanner("dead_end", "Unexplored", "The search never expanded this state. Select another node.");
      } else if (hidden) {
        this.setBanner("info", n.id === 0 ? (shelf ? `Pack all ${total} objects into the shelf` : `Stack all ${total} objects into one tower`)
          : "Sample the next actions",
        `Press “Sample actions” to see what DISCO's search tried from ${n.id === 0 ? "the start" : "here"}. Each new node shows an object held where the robot will place it.`);
      } else {
        this.setBanner("info", "Pick an action", "Click one of the dashed nodes under this state in the graph to roll it out.");
      }
    }

    triedText(n) {
      const t = n.tried;
      if (!t || !t.total) return "";
      const failed = Object.values(t.failed).reduce((a, b) => a + b, 0);
      const shownFailed = n.kids.filter((k) => k.status === "failed").length;
      let s = `From this state the search tried ${t.total} action${t.total === 1 ? "" : "s"}`;
      if (failed) {
        const kinds = Object.entries(t.failed).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${failText(k)[0].toLowerCase()}`);
        s += `; ${failed} failed (${kinds.join(", ")})`;
      }
      s += ".";
      if (shownFailed && failed > shownFailed) s += " The graph shows one example of each failure where the robot actually moved.";
      if (t.not_shown) s += ` ${t.not_shown} more succeeded but their motions were not saved, so they are not shown.`;
      return s;
    }
  }

  function boot() {
    document.querySelectorAll("[data-disco-explorer]").forEach((r) => { if (!r.dxExplorer) r.dxExplorer = new Explorer(r); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
