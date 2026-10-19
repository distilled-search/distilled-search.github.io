// The DISCO Game: race DISCO through one of its own saved search trees. Each round, each player runs one MCTS iteration.
// You pick a state you have reached, sample actions with the policy π, execute one, and keep going until the rollout
// hits a goal or a dead end. Failed actions show up red as soon as they are sampled, cannot be chosen, and fade from the
// graph shortly after (dead-end states keep their mark). DISCO plays
// its own MCTS on the same tree: UCB selection with progressive widening, then a rollout that executes the feasible
// action its value estimate Qφ rates highest, then a backup of the progress reached. After the last round, whoever
// found more distinct plans wins. Nothing is simulated here; both sides only walk the recorded tree.
// Mount: <div data-disco-game data-base="assets/tree_explorer/"></div> + this script + disco_game.css.
(function () {
  "use strict";

  const R = 34;               // node radius, graph units
  const DX = 92, DY = 160;    // sibling and level spacing
  const TWEEN_MS = 380;
  const FAIL_LINGER_MS = 1600;  // how long a failed action stays on the graph before it fades out
  const FADE_MS = 400;
  const PAPER = { k: 2.0, alpha: 0.3, C: 1.5 };  // paper, Table 4
  const VISIBLE_PW = { k: 4.0, alpha: 0.5, C: 1.5 };
  const B_MAX = 8;
  const HERE = (document.currentScript && document.currentScript.src.replace(/[^/]*$/, "")) || "";

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
  const failText = (t) => FAILURE_TEXT[t] || [String(t).replace(/_/g, " "), ""];
  const ease = (u) => 1 - Math.pow(1 - u, 3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (x) => x.toFixed(2);
  const num = (x) => String(Math.round(x * 100) / 100);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const feasible = (n) => n.status !== "failed";
  // A reached state is a dead end for a player once every saved action from it has been sampled and none is feasible
  // (a state with no saved actions at all is one as soon as it is reached).
  const deadFor = (p, n) => n.parent !== null && n.status !== "goal" && feasible(n) && p.rolled.has(n.id) &&
    n.kids.every((k) => p.revealed.has(k.id) && !feasible(k));
  function draw(list, k) {  // k random items, without replacement
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, k);
  }

  // A spinning disco ball: a strip of mirror tiles slides behind a round clip, under a spherical shade.
  function discoBall(size) {
    const id = `dg-ball-${uid++}`, tiles = [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 14; col++) {  // the visible 30 units plus one 24-unit period
        const lum = 0.25 + 0.75 * (((col % 6) * 7 + row * 5 + (row * col) % 3) % 10) / 10;
        tiles.push(svg("rect", { x: 5 + col * 4 + 0.3, y: 7 + row * 3.75 + 0.3, width: 3.4, height: 3.15, rx: 0.5,
          fill: `rgba(255,255,255,${lum.toFixed(2)})` }));
      }
    }
    const spark = (x, y, s, d) => svg("path", { class: "dg-spark", style: `animation-delay:${d}s`,
      d: `M${x},${y - s}L${x + s * 0.25},${y - s * 0.25}L${x + s},${y}L${x + s * 0.25},${y + s * 0.25}L${x},${y + s}` +
        `L${x - s * 0.25},${y + s * 0.25}L${x - s},${y}L${x - s * 0.25},${y - s * 0.25}Z` });
    return svg("svg", { class: "dg-ball", viewBox: "0 0 44 40", width: size * 1.1, height: size, "aria-hidden": "true" },
      svg("defs", {},
        svg("clipPath", { id: id + "-clip" }, svg("circle", { cx: 20, cy: 22, r: 15 })),
        svg("radialGradient", { id: id + "-shade", cx: "50%", cy: "50%", r: "50%" },
          svg("stop", { offset: "55%", "stop-color": "#0b1020", "stop-opacity": 0 }),
          svg("stop", { offset: "100%", "stop-color": "#0b1020", "stop-opacity": 0.7 })),
        svg("radialGradient", { id: id + "-glow", cx: "34%", cy: "30%", r: "40%" },
          svg("stop", { offset: "0%", "stop-color": "#fff", "stop-opacity": 0.95 }),
          svg("stop", { offset: "100%", "stop-color": "#fff", "stop-opacity": 0 }))),
      svg("line", { x1: 20, y1: 0, x2: 20, y2: 7, class: "dg-ball-string" }),
      svg("circle", { cx: 20, cy: 22, r: 15, fill: "#8a94a8" }),
      svg("g", { "clip-path": `url(#${id}-clip)` }, svg("g", { class: "dg-ball-tiles" }, ...tiles)),
      svg("circle", { cx: 20, cy: 22, r: 15, fill: `url(#${id}-shade)` }),
      svg("circle", { cx: 20, cy: 22, r: 15, fill: `url(#${id}-glow)` }),
      spark(37, 10, 4, 0), spark(5, 33, 3, 0.7), spark(38, 33, 2.5, 1.3));
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

  // Search state of one player. phase/cur/path track the iteration in progress. gone holds failed actions that were
  // shown once and then removed from the graph; they still count as revealed.
  function newPlayer() {
    return { revealed: new Set([0]), gone: new Set(), rolled: new Set([0]), selected: 0, pos: new Map(), target: null, view: null,
      N: new Map(), W: new Map(), exhausted: new Set(), plans: new Set(), iters: 0, actions: 0, sampled: 0,
      phase: "select", cur: null, path: [], gaveUp: false };
  }

  // =============================================================== one player's graph and viewer
  class Board {
    constructor(game, who) {
      this.game = game;
      this.who = who;
      this.clipId = `dg-clip-${uid++}`;
      this.build();
    }

    build() {
      const you = this.who === "you";
      this.badge = el("span", { class: "dg-badge" });
      const head = el("div", { class: "dg-side-head" },
        el("span", { class: "dg-side-name" }, you ? "Your search tree" : "DISCO's search tree"), this.badge);

      this.edgeLayer = svg("g");
      this.nodeLayer = svg("g");
      this.pill = svg("g", { class: "dg-pill", style: "display:none" }, svg("rect", { rx: 14, height: 28 }), svg("text"));
      this.viewport = svg("g", {}, this.edgeLayer, this.nodeLayer, this.pill);
      this.svg = svg("svg", { class: "dg-graph", role: "img", "aria-label": you ? "Your search tree" : "DISCO's search tree" },
        svg("defs", {}, svg("clipPath", { id: this.clipId, clipPathUnits: "objectBoundingBox" },
          svg("circle", { cx: 0.5, cy: 0.5, r: 0.5 }))),
        this.viewport);
      const zoom = el("div", { class: "dg-zoom" },
        el("button", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => this.zoomBy(1.3) }, "+"),
        el("button", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => this.zoomBy(1 / 1.3) }, "−"),
        el("button", { title: "Fit the tree", "aria-label": "Fit the tree", onclick: () => this.fit(null) }, "⤢"));
      const help = el("div", { class: "dg-graph-help" },
        (you ? "Hover a state for options · " : "Labels: visits N, value Q · ") +
        "scroll or pinch to zoom · drag to pan · ⤢ fits the tree");
      this.menu = el("div", { class: "dg-menu", role: "menu" });
      this.toastEl = el("div", { class: "dg-toast" });
      this.graphWrap = el("div", { class: "dg-graph-wrap" }, this.svg, help, zoom, this.menu, this.toastEl);

      this.stageImg = el("img", { alt: "" });
      this.video = el("video", { muted: "", playsinline: "", preload: "auto" });
      this.video.muted = true;
      this.video.addEventListener("ended", () => this.finishVideo());
      this.video.addEventListener("error", () => this.finishVideo());
      this.stepTag = el("div", { class: "dg-step-tag" });
      this.stage = el("div", { class: "dg-stage" }, this.stageImg, this.video, this.stepTag,
        el("button", { class: "dg-skip", onclick: () => this.skip() }, "Skip ▸▸"));
      this.progress = el("div", { class: "dg-status-row" });
      this.msgTitle = el("div", { class: "dg-msg-title" });
      this.msgText = el("div", { class: "dg-msg-text" });
      this.extra = el("div", { class: you ? "dg-actions" : "dg-log" });
      if (you) {
        this.sampleBtn = el("button", { class: "dg-btn dg-primary", onclick: () => this.game.userSample() }, "Sample actions");
        this.extra.append(this.sampleBtn);
      }
      const info = el("div", { class: "dg-info" }, this.progress, this.msgTitle, this.msgText, this.extra);
      this.el = el("section", { class: `dg-side dg-${this.who}` }, head, this.graphWrap,
        el("div", { class: "dg-bottom" }, this.stage, info));

      this.bindPanZoom();
      if (you) this.bindMenu();
      new ResizeObserver(() => this.p && this.p.view && this.applyView()).observe(this.svg);
    }

    attach(tree, player) {
      this.t = tree;
      this.p = player;
      this.focus = null;
      this.trail = new Set();
      this.pending = null;
      this.hideMenu();
      if (this.video.src) { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); }
      this.stage.classList.remove("dg-playing");
      if (this.who === "disco") this.extra.replaceChildren();
      this.redraw();
      this.show(this.node(0));
    }

    node(id) { return this.t.byId.get(id); }
    src(rel) { return this.t.dir + rel; }
    hidden(n) { return n.kids.filter((k) => !this.p.revealed.has(k.id)); }
    lineage(n) { const a = []; for (let x = n; x; x = x.parent === null ? null : this.node(x.parent)) a.unshift(x); return a; }
    drawn(id) { return this.p.revealed.has(id) && !this.p.gone.has(id); }
    drawnIds() { return [...this.p.revealed].filter((id) => !this.p.gone.has(id)); }

    // --------------------------------------------------------------- drawing
    redraw() {
      this.edgeLayer.replaceChildren();
      this.nodeLayer.replaceChildren();
      this.els = new Map();
      this.edges = new Map();
      for (const id of this.drawnIds()) this.ensureEl(this.node(id));
      this.relayout(false);
      if (!this.p.view) this.homeView(); else this.applyView();
      this.styleAll();
    }

    ensureEl(n) {
      if (this.els.has(n.id)) return this.els.get(n.id);
      const sel = svg("circle", { class: "dg-sel", r: R + 7 });
      const ring = svg("circle", { class: "dg-ring", r: R + 1.5 });
      const img = svg("image", { x: -R, y: -R, width: 2 * R, height: 2 * R, "clip-path": `url(#${this.clipId})`,
        preserveAspectRatio: "xMidYMid slice" });
      const markBg = svg("circle", { class: "dg-node-mark-bg", cx: R * 0.74, cy: -R * 0.74, r: 11 });
      const mark = svg("text", { class: "dg-node-mark", x: R * 0.74, y: -R * 0.74 });
      const label = svg("text", { class: "dg-node-label", y: R + 17 });
      const stat = svg("text", { class: "dg-node-stat", y: R + 31 });
      const title = svg("title");
      const g = svg("g", { class: "dg-node", "data-id": n.id }, title, sel, ring, img, markBg, mark, label, stat);
      this.nodeLayer.append(g);
      const e = { g, img, mark, markBg, label, stat, title };
      this.els.set(n.id, e);
      if (n.parent !== null) {
        const path = svg("path", { class: "dg-edge" });
        this.edgeLayer.append(path);
        this.edges.set(n.id, path);
      }
      return e;
    }

    styleNode(n) {
      const p = this.p, e = this.els.get(n.id);
      if (!e) return;
      const rolled = p.rolled.has(n.id), failed = !feasible(n);
      const playing = this.pending === n;
      e.g.classList.toggle("dg-proposed", !rolled && !failed);
      e.g.classList.toggle("dg-selected", this.focus === n.id && !this.pending);
      e.g.classList.toggle("dg-playing", playing);
      e.g.classList.toggle("dg-on-trail", this.trail.has(n.id));
      let outcome = "";
      if (failed) outcome = "failed";
      else if (rolled && n.status === "goal") outcome = "goal";
      else if (deadFor(p, n)) outcome = "dead";
      e.g.dataset.outcome = outcome;
      const href = failed ? n.outcome_thumb || n.thumb : rolled ? n.thumb : (n.card || n.thumb);
      if (e.img.getAttribute("href") !== this.src(href)) e.img.setAttribute("href", this.src(href));
      const markText = { goal: "★", failed: "✕", dead: "⊘" }[outcome] || "";
      e.mark.textContent = markText;
      e.mark.style.fill = outcome === "goal" ? "var(--dg-goal)" : "var(--dg-failed)";
      e.mark.style.display = e.markBg.style.display = markText ? "" : "none";
      e.label.textContent = failed ? "failed" : rolled && n.progress !== null ? `${n.progress}/${this.t.num_objects}` : "";
      if (this.who === "disco") {
        const N = p.N.get(n.id) || 0;
        e.stat.textContent = failed || n.id === 0 && !N ? "" : N ? `N ${N} · Q ${fmt(p.W.get(n.id) / N)}` : `Qφ ${fmt(n.Q)}`;
      }
      e.title.textContent = n.id === 0 ? "Start" : failed ? `Failed: ${failText(n.failure_type)[0]} (cannot be chosen)`
        : !rolled ? (this.who === "you" ? "Action sampled from π" : "Sampled action, not executed yet")
        : outcome === "dead" ? "Dead end" : `Step ${n.depth}`;
      const edge = this.edges.get(n.id);
      if (edge) {
        edge.classList.toggle("dg-proposed", !rolled && !failed);
        edge.classList.toggle("dg-edge-failed", failed);
        edge.classList.toggle("dg-playing", playing);
        edge.classList.toggle("dg-on-trail", this.trail.has(n.id) && !playing);
      }
    }

    styleAll() {
      for (const id of this.drawnIds()) this.styleNode(this.node(id));
      this.placePill();
    }

    // Progressive widening: gold ripples from the state, a "widened +n" tag, and its new edges glow for a moment.
    flash(id, kids = []) {
      const e = this.els.get(id);
      if (!e) return;
      for (let k = 0; k < 3; k++) {
        const ring = svg("circle", { class: "dg-pw-ripple", r: R + 4, style: `animation-delay:${k * 0.25}s` });
        e.g.insertBefore(ring, e.g.children[1]);
        setTimeout(() => ring.remove(), 1500 + k * 250);
      }
      const tag = svg("text", { class: "dg-pw-tag", y: -R - 14 });
      tag.textContent = `widened +${kids.length}`;
      e.g.append(tag);
      setTimeout(() => tag.remove(), 2000);
      for (const k of kids) {
        const edge = this.edges.get(k.id);
        if (!edge) continue;
        edge.classList.add("dg-pw-edge");
        setTimeout(() => edge.classList.remove("dg-pw-edge"), 1800);
      }
    }

    toast(text, kind) {
      const t = el("div", { class: `dg-toast-msg dg-toast-${kind}` }, text);
      this.toastEl.append(t);
      setTimeout(() => t.remove(), 1900);
    }

    // Tidy layered layout of the revealed nodes: leaves on consecutive slots, parents centred over their children.
    relayout(animate = true) {
      const p = this.p, target = new Map();
      let slot = 0;
      const visit = (n) => {
        const kids = n.kids.filter((k) => this.drawn(k.id));
        if (!kids.length) target.set(n.id, { x: slot++ * DX, y: n.depth * DY });
        else {
          kids.forEach(visit);
          const xs = kids.map((k) => target.get(k.id).x);
          target.set(n.id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: n.depth * DY });
        }
      };
      visit(this.node(0));
      const x0 = target.get(0).x;
      for (const q of target.values()) q.x -= x0;
      p.target = target;
      const from = new Map();
      for (const [id, q] of target) {
        const par = this.node(id).parent;
        from.set(id, p.pos.get(id) || (par !== null && p.pos.get(par)) || q);
      }
      cancelAnimationFrame(this.layoutRaf);
      clearTimeout(this.layoutSnap);
      const settle = () => { cancelAnimationFrame(this.layoutRaf); p.pos = new Map(target); this.applyPositions(); };
      if (!animate) { settle(); return; }
      const t0 = performance.now();
      const step = (now) => {
        const u = ease(clamp((now - t0) / TWEEN_MS, 0, 1));
        for (const [id, q] of target) {
          const f = from.get(id);
          p.pos.set(id, { x: f.x + (q.x - f.x) * u, y: f.y + (q.y - f.y) * u });
        }
        this.applyPositions();
        if (u < 1) this.layoutRaf = requestAnimationFrame(step);
      };
      this.layoutRaf = requestAnimationFrame(step);
      this.layoutSnap = setTimeout(settle, TWEEN_MS + 60);  // finish even when frames are throttled (hidden tab)
    }

    applyPositions() {
      const p = this.p;
      for (const id of this.drawnIds()) {
        const q = p.pos.get(id), e = this.els.get(id);
        if (!q || !e) continue;
        e.g.setAttribute("transform", `translate(${q.x},${q.y})`);
        const edge = this.edges.get(id);
        if (edge) {
          const a = p.pos.get(this.node(id).parent);
          const y1 = a.y + R + (this.who === "disco" ? 37 : 23), y2 = q.y - R - 4, m = (y1 + y2) / 2;
          edge.setAttribute("d", `M${a.x},${y1} C${a.x},${m} ${q.x},${m} ${q.x},${y2}`);
        }
      }
      this.placePill();
    }

    placePill() {
      if (this.who !== "you" || !this.p) return;
      const n = this.node(this.p.selected), q = this.p.pos.get(n.id);
      const show = q && this.game.canUserSample(n);
      this.pill.style.display = show ? "" : "none";
      if (!show) return;
      const text = this.game.sampleLabel(n);
      const w = 30 + text.length * 7.2;
      const [rect, label] = this.pill.children;
      rect.setAttribute("x", -w / 2);
      rect.setAttribute("y", -14);
      rect.setAttribute("width", w);
      label.textContent = text;
      this.pill.setAttribute("transform", `translate(${q.x + R + 16 + w / 2},${q.y})`);  // beside the node, clear of edges
    }

    // --------------------------------------------------------------- hover menu (your board)
    bindMenu() {
      let hideTimer = null;
      const cancel = () => clearTimeout(hideTimer);
      this.scheduleHide = () => { cancel(); hideTimer = setTimeout(() => this.hideMenu(), 260); };
      this.nodeLayer.addEventListener("pointerover", (e) => {
        if (e.pointerType !== "mouse" || this.dragging) return;
        const g = e.target.closest(".dg-node");
        if (g) { cancel(); this.openMenu(Number(g.dataset.id)); }
      });
      this.nodeLayer.addEventListener("pointerout", (e) => {
        if (e.pointerType === "mouse" && !e.relatedTarget?.closest?.(".dg-menu")) this.scheduleHide();
      });
      this.menu.addEventListener("pointerenter", cancel);
      this.menu.addEventListener("pointerleave", () => this.scheduleHide());
    }

    openMenu(id) {
      const spec = this.game.menuFor(this.node(id));
      if (!spec) { this.hideMenu(); return; }
      this.menuId = id;
      this.menu.replaceChildren(...[
        el("div", { class: "dg-menu-title" }, spec.title),
        spec.dead ? el("div", { class: "dg-menu-dead" }, el("b", {}, "Dead end. "), spec.dead) : null,
        spec.warn ? el("div", { class: "dg-menu-warn" }, "⚠ " + spec.warn) : null,
        spec.note ? el("div", { class: "dg-menu-note" }, spec.note) : null,
        ...(spec.buttons || []).map((b) => el("button", {
          class: "dg-menu-btn" + (b.primary ? " dg-menu-primary" : ""), role: "menuitem",
          onclick: () => { this.hideMenu(); b.act(); },
        }, b.label))].filter(Boolean));
      this.menu.classList.add("dg-open");
      const e = this.els.get(id), w = this.graphWrap.getBoundingClientRect();
      if (!e) return;
      const r = e.g.getBoundingClientRect(), m = this.menu.getBoundingClientRect();
      let x = r.right - w.left + 6, y = r.top - w.top - 4;
      if (x + m.width > w.width - 8) x = r.left - w.left - m.width - 6;
      this.menu.style.left = `${clamp(x, 6, Math.max(6, w.width - m.width - 6))}px`;
      this.menu.style.top = `${clamp(y, 6, Math.max(6, w.height - m.height - 6))}px`;
    }

    hideMenu() {
      this.menuId = null;
      this.menu.classList.remove("dg-open");
    }

    // --------------------------------------------------------------- pan / zoom
    applyView() {
      const v = this.p.view;
      this.viewport.setAttribute("transform", `translate(${v.tx},${v.ty}) scale(${v.k})`);
      if (this.menuId !== null && this.menuId !== undefined) this.hideMenu();
    }

    size() { const b = this.svg.getBoundingClientRect(); return { W: b.width || 500, H: b.height || 400 }; }

    homeView() {
      const { W } = this.size();
      this.p.view = { tx: W / 2, ty: R + 60, k: 1 };
      this.applyView();
    }

    animateView(to) {
      this.stopViewTween();
      const from = { ...this.p.view }, t0 = performance.now();
      const step = (now) => {
        const u = ease(clamp((now - t0) / 450, 0, 1));
        this.p.view = { tx: from.tx + (to.tx - from.tx) * u, ty: from.ty + (to.ty - from.ty) * u, k: from.k + (to.k - from.k) * u };
        this.applyView();
        if (u < 1) this.viewRaf = requestAnimationFrame(step);
      };
      this.viewRaf = requestAnimationFrame(step);
      this.viewSnap = setTimeout(() => { cancelAnimationFrame(this.viewRaf); this.p.view = { ...to }; this.applyView(); }, 510);
    }

    stopViewTween() { cancelAnimationFrame(this.viewRaf); clearTimeout(this.viewSnap); }

    // Bring nodes into view (all revealed if ids is null). With onlyIfNeeded, keep the view when they already fit,
    // pan when they fit at the current zoom, and zoom out only when they do not.
    fit(ids, onlyIfNeeded = false) {
      const p = this.p, { W, H } = this.size(), pad = R + 46;
      const pts = (ids || this.drawnIds()).map((id) => p.target.get(id)).filter(Boolean);
      if (!pts.length) return;
      const x0 = Math.min(...pts.map((q) => q.x)) - pad, x1 = Math.max(...pts.map((q) => q.x)) + pad;
      const y0 = Math.min(...pts.map((q) => q.y)) - pad, y1 = Math.max(...pts.map((q) => q.y)) + pad + 30;
      const v = p.view;
      if (onlyIfNeeded) {
        const sx0 = v.tx + x0 * v.k, sx1 = v.tx + x1 * v.k, sy0 = v.ty + y0 * v.k, sy1 = v.ty + y1 * v.k;
        if (sx0 >= 0 && sy0 >= 0 && sx1 <= W && sy1 <= H) return;
      }
      let k = Math.min(W / (x1 - x0), H / (y1 - y0), 1.1);
      if (onlyIfNeeded) k = Math.min(k, v.k);
      k = Math.max(k, 0.22);
      this.animateView({ k, tx: W / 2 - k * (x0 + x1) / 2, ty: H / 2 - k * (y0 + y1) / 2 });
    }

    zoomAt(px, py, f) {
      const v = this.p.view, k = clamp(v.k * f, 0.08, 3);
      this.p.view = { k, tx: px - (px - v.tx) * (k / v.k), ty: py - (py - v.ty) * (k / v.k) };
      this.applyView();
    }

    zoomBy(f) {
      if (!this.p) return;
      this.stopViewTween();
      const { W, H } = this.size();
      this.zoomAt(W / 2, H / 2, f);
    }

    bindPanZoom() {
      const s = this.svg, pts = new Map();
      let drag = null;
      const local = (e) => { const b = s.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
      s.addEventListener("wheel", (e) => {
        if (!this.p) return;
        e.preventDefault();
        this.stopViewTween();
        const q = local(e);
        this.zoomAt(q.x, q.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)));
      }, { passive: false });
      s.addEventListener("pointerdown", (e) => {
        if (!this.p) return;
        this.stopViewTween();
        try { s.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already-released pointer */ }
        pts.set(e.pointerId, local(e));
        const hit = e.target.closest(".dg-node, .dg-pill");
        drag = { moved: 0, hit: pts.size === 1 ? hit : null };
      });
      s.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId) || !drag) return;
        const q = local(e), prev = pts.get(e.pointerId);
        if (pts.size === 1) {
          const v = this.p.view;
          v.tx += q.x - prev.x;
          v.ty += q.y - prev.y;
          drag.moved += Math.abs(q.x - prev.x) + Math.abs(q.y - prev.y);
          if (drag.moved > 5) { s.classList.add("dg-dragging"); this.dragging = true; }
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
          s.classList.remove("dg-dragging");
          this.dragging = false;
          if (drag.moved <= 5 && drag.hit && this.who === "you") {
            if (drag.hit.classList.contains("dg-pill")) this.game.userSample();
            else if (e.pointerType !== "mouse") this.openMenu(Number(drag.hit.dataset.id));  // touch: tap opens the menu
            else { this.hideMenu(); this.game.userNode(Number(drag.hit.dataset.id)); }
          }
          drag = null;
        }
      };
      s.addEventListener("pointerup", up);
      s.addEventListener("pointercancel", up);
    }

    // --------------------------------------------------------------- state changes
    reveal(kids) {
      for (const k of kids) { this.p.revealed.add(k.id); this.ensureEl(k); }
      this.relayout(true);
      this.styleAll();
      const par = kids.length ? kids[0].parent : null;
      if (par !== null) setTimeout(() => this.fit([par, ...kids.map((k) => k.id)], true), 20);
      const failed = kids.filter((k) => !feasible(k));
      if (failed.length) this.fadeOut(failed);
    }

    // Failed actions are shown once, then faded out and dropped from the layout. Their parent keeps its dead-end mark.
    fadeOut(kids) {
      const p = this.p;
      setTimeout(() => {
        if (this.p !== p) return;  // a new game started
        for (const k of kids) {
          this.els.get(k.id)?.g.classList.add("dg-fading");
          this.edges.get(k.id)?.classList.add("dg-fading");
          if (this.menuId === k.id) this.hideMenu();
        }
        setTimeout(() => {
          if (this.p !== p) return;
          for (const k of kids) {
            p.gone.add(k.id);
            this.els.get(k.id)?.g.remove();
            this.edges.get(k.id)?.remove();
            this.els.delete(k.id);
            this.edges.delete(k.id);
          }
          this.relayout(true);
        }, FADE_MS);
      }, this.game.fast ? FAIL_LINGER_MS / 2 : FAIL_LINGER_MS);
    }

    setFocus(id, trail) {
      this.focus = id;
      this.trail = new Set(trail || this.lineage(this.node(id)).map((n) => n.id));
      if (this.who === "you") this.p.selected = id;
      this.styleAll();
    }

    play(n, fast) {
      this.pending = n;
      this.hideMenu();
      this.styleAll();
      this.fit([n.id], true);
      const parent = this.node(n.parent);
      this.stepTag.textContent = `Executing step ${n.depth}`;
      if (fast) return sleep(350).then(() => { this.pending = null; });
      return new Promise((resolve) => {
        this.resolveVideo = resolve;
        this.video.src = this.src(n.video);
        this.video.poster = this.src(parent.image);
        this.video.playbackRate = this.game.rate;
        this.stage.classList.add("dg-playing");
        this.game.whenOpen().then(() => this.video.play().catch(() => this.finishVideo()));
      });
    }

    skip() { if (this.resolveVideo) { this.video.pause(); this.finishVideo(); } }

    finishVideo() {
      const r = this.resolveVideo;
      if (!r) return;
      this.resolveVideo = null;
      this.pending = null;
      this.stage.classList.remove("dg-playing");
      r();
    }

    // Stage image, progress pips and the state message for node n.
    show(n) {
      const t = this.t, total = t.num_objects, shelf = t.task === "shelf", failed = !feasible(n);
      this.stageImg.src = this.src(failed && n.outcome_image ? n.outcome_image : n.image);
      this.stepTag.textContent = n.depth === 0 ? "Start" : failed ? "Failed action" : `Step ${n.depth}`;
      const done = n.progress ?? 0;
      const label = el("span", { class: "dg-progress-label" }, failed ? "Failed action"
        : shelf ? `${done} / ${total} in the shelf` : `Tower height ${done} / ${total}`);
      const pips = el("span", { class: "dg-pips" },
        ...Array.from({ length: total }, (_, i) => el("span", { class: "dg-pip" + (i < done ? " dg-on" : "") })));
      this.progress.replaceChildren(...(failed ? [label] : [label, pips]));
      if (failed) {
        const [title, text] = failText(n.failure_type);
        this.message("failed", `Failed: ${title}`, `${text} Failed actions cannot be chosen.`);
      } else if (n.status === "goal" && this.p.rolled.has(n.id)) this.message("goal",
        shelf ? `All ${total} objects are in the shelf!` : `All ${total} objects are stacked!`, `A plan in ${plural(n.depth, "action")}.`);
      else if (deadFor(this.p, n)) this.message("failed", "Dead end", this.game.deadReason(n));
      else this.message("info", n.id === 0 ? (shelf ? `Pack all ${total} objects into the shelf` : `Stack all ${total} objects into one tower`)
        : `Step ${n.depth}`, this.who === "you" ? this.game.youHint(n) : "");
      if (this.sampleBtn) {
        this.sampleBtn.disabled = !this.game.canUserSample(n);
        this.sampleBtn.textContent = this.game.sampleLabel(n);
      }
    }

    message(kind, title, text) {
      this.msgTitle.dataset.kind = kind;
      this.msgTitle.textContent = title;
      this.msgText.textContent = text || "";
    }

    log(text, kind) {
      this.extra.prepend(el("div", { class: "dg-log-line" + (kind ? ` dg-log-${kind}` : "") }, text));
      this.extra.scrollTop = 0;
      while (this.extra.children.length > 400) this.extra.lastChild.remove();
    }

    setBadge(text, active) {
      this.badge.textContent = text;
      this.el.classList.toggle("dg-active", !!active);
    }
  }

  // =============================================================== the game
  class Game {
    constructor(base) {
      this.base = base;
      this.cache = {};
      this.rate = 1;
      this.fast = false;
      this.cfg = { B: 3, budget: 10, ...PAPER };
      this.openWaiters = [];
      this.reasons = {};
      fetch(HERE + "dead_ends.json").then((r) => r.json()).then((j) => { this.reasons = j; }).catch(() => {});
      this.build();
    }

    build() {
      this.statusText = el("span", { class: "dg-status" });
      const fast = el("input", { type: "checkbox", onchange: (e) => { this.fast = e.target.checked; this.disco.skip(); } });
      const speed = el("button", {
        class: "dg-btn", title: "Playback speed",
        onclick: (e) => {
          this.rate = this.rate === 1 ? 2 : 1;
          e.target.textContent = this.rate + "×";
          this.you.video.playbackRate = this.disco.video.playbackRate = this.rate;
        },
      }, "1×");
      this.giveUpBtn = el("button", { class: "dg-giveup", type: "button", title: "Stop playing; DISCO plays its remaining rounds",
        onclick: () => this.giveUp() }, el("span", { "aria-hidden": "true" }, "🏳️"), el("span", {}, "Give up and let DISCO run"));
      this.playControls = el("div", { class: "dg-top-controls" },
        el("label", { class: "dg-toggle" }, fast, "Skip DISCO's videos"), speed,
        el("button", { class: "dg-btn", onclick: () => this.showSetup() }, "New game"));
      const close = el("button", { class: "dg-close", "aria-label": "Close the game", title: "Close", onclick: () => this.close() }, "✕");
      const top = el("div", { class: "dg-top" },
        discoBall(30), el("span", { class: "dg-title" }, "The DISCO Game"), this.statusText,
        el("span", { class: "dg-spacer" }), this.playControls, close);

      // scoreboard: plans are the score; iterations and policy calls are the cost
      const side = (who, name) => {
        const plans = el("span", { class: "dg-score-num" }, "0");
        const sub = el("div", { class: "dg-score-sub" });
        const card = el("div", { class: `dg-score dg-score-${who}` },
          el("div", { class: "dg-score-name" }, name),
          el("div", { class: "dg-score-main" }, plans, el("span", { class: "dg-score-unit" }, "plans")), sub);
        return { card, plans, sub };
      };
      this.sb = { you: side("you", "You"), disco: side("disco", "DISCO") };
      this.roundNum = el("div", { class: "dg-round-num" });
      this.turnText = el("div", { class: "dg-round-turn" });
      this.scoreboard = el("div", { class: "dg-scoreboard", "aria-live": "polite" }, this.sb.you.card,
        el("div", { class: "dg-round-col" },
          el("div", { class: "dg-round" }, el("div", { class: "dg-round-label" }, "Round"), this.roundNum, this.turnText),
          this.giveUpBtn),
        this.sb.disco.card);
      this.banner = el("div", { class: "dg-banner" });

      this.setup = el("div", { class: "dg-setup" });
      this.you = new Board(this, "you");
      this.disco = new Board(this, "disco");
      this.result = el("div", { class: "dg-result", role: "status" });
      this.play = el("div", { class: "dg-play" }, this.you.el, this.disco.el, this.result, this.banner);
      this.body = el("div", { class: "dg-body" }, this.setup, this.scoreboard, this.play);
      this.window = el("div", { class: "dg-window", role: "dialog", "aria-modal": "true", "aria-label": "The DISCO Game" }, top, this.body);
      this.overlay = el("div", { class: "dg-overlay", onclick: (e) => { if (e.target === this.overlay) this.close(); } }, this.window);
      document.body.append(this.overlay);

      document.addEventListener("keydown", (e) => {
        if (!this.isOpen) return;
        if (e.key === "Escape") { e.preventDefault(); this.close(); }
        else if (e.key === " " && !["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          this.you.skip();
          this.disco.skip();
        }
      });
    }

    // --------------------------------------------------------------- open / close
    open() {
      this.isOpen = true;
      this.overlay.classList.add("dg-open");
      this.prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      if (!this.tree) this.showSetup();
      for (const b of [this.you, this.disco]) if (b.resolveVideo) b.video.play().catch(() => b.finishVideo());
      for (const w of this.openWaiters.splice(0)) w();
      this.window.querySelector(".dg-close").focus();
    }

    close() {
      this.isOpen = false;
      this.overlay.classList.remove("dg-open");
      document.documentElement.style.overflow = this.prevOverflow || "";
      for (const b of [this.you, this.disco]) b.video.pause();
    }

    whenOpen() { return this.isOpen ? Promise.resolve() : new Promise((r) => this.openWaiters.push(r)); }

    // --------------------------------------------------------------- setup screen
    async showSetup() {
      this.gen = (this.gen || 0) + 1;  // abandons any turn still running
      for (const b of [this.you, this.disco]) { b.video.pause(); b.resolveVideo = null; }
      this.tree = null;
      this.window.classList.add("dg-in-setup");
      this.playControls.style.display = "none";
      this.statusText.textContent = "";
      if (!this.games) this.games = await (await fetch(this.base + "data/games.json")).json();
      if (!this.gameId) this.gameId = this.games[0].id;
      const cfg = this.cfg;

      const cards = this.games.map((g) => el("button", {
        class: "dg-card", "aria-pressed": g.id === this.gameId ? "true" : "false",
        onclick: (e) => {
          this.gameId = g.id;
          for (const c of e.currentTarget.parentElement.children) c.setAttribute("aria-pressed", c === e.currentTarget ? "true" : "false");
        },
      }, el("img", { src: `${this.base}data/${g.id}/nodes/n_0.jpg`, alt: "" }), el("span", { class: "dg-card-title" }, g.title)));

      const slider = (key, min, max, help) => {
        const out = el("output", { class: "dg-b-value" }, String(cfg[key]));
        return el("div", { class: "dg-b-row" },
          el("input", { type: "range", min, max, step: 1, value: cfg[key], "aria-label": key,
            oninput: (e) => { cfg[key] = Number(e.target.value); out.textContent = e.target.value; } }),
          out, el("span", { class: "dg-b-help" }, help));
      };
      const inputs = {};
      const param = (key, label, min, max, step, help) => {
        inputs[key] = el("input", { type: "number", min, max, step, value: cfg[key], "aria-label": label,
          oninput: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) cfg[key] = clamp(v, min, max); } });
        return el("label", { class: "dg-param" }, el("span", { class: "dg-param-name" }, label), inputs[key],
          el("span", { class: "dg-param-help" }, help));
      };
      const preset = (vals) => {
        Object.assign(cfg, vals);
        for (const [k, inp] of Object.entries(inputs)) inp.value = cfg[k];
      };

      this.setup.replaceChildren(el("div", { class: "dg-setup-inner" },
        el("h2", { class: "dg-h2" }, el("span", { class: "dg-challenge" }, el("span", { "aria-hidden": "true" }, "⚡"), " Challenge:"),
          " Try finding more plans than ", el("span", { class: "dg-h2-disco" }, "DISCO"), "!"),
        el("ul", { class: "dg-rules" },
          el("li", {}, "Each round, you and DISCO each run one search iteration: from a state you have reached, sample actions with policy π and execute one, until you hit a goal or a dead end."),
          el("li", {}, "Failed actions turn red and cannot be chosen. A state where every action fails is a dead end."),
          el("li", {}, "DISCO plays the same task with its MCTS: UCB selection, progressive widening, and rollouts guided by its value estimate Qφ."),
          el("li", {}, "Each distinct goal reached is a plan. Most plans after the last round wins."),
          el("li", {}, "Scroll or pinch to zoom, drag to pan, ⤢ to fit the tree.")),
        el("div", { class: "dg-label" }, "Choose a task"),
        el("div", { class: "dg-cards" }, ...cards),
        el("div", { class: "dg-label" }, "Branching factor B"),
        slider("B", 1, B_MAX, "Actions drawn from π each time a state is sampled, for both you and DISCO. A state can be sampled again for more, until every saved action is shown."),
        el("div", { class: "dg-label" }, "Rounds"),
        slider("budget", 3, 30, "Iterations per player. Each iteration executes one or more actions and ends at a goal or a dead end."),
        el("details", { class: "dg-hyper" },
          el("summary", {}, "DISCO's hyperparameters"),
          el("div", { class: "dg-params" },
            param("k", "k", 0.5, 8, 0.1, "Widening coefficient"),
            param("alpha", "α", 0.05, 1, 0.05, "Widening exponent"),
            param("C", "C", 0, 4, 0.1, "UCB exploration constant")),
          el("div", { class: "dg-param-presets" },
            el("button", { class: "dg-btn", type: "button", onclick: () => preset(PAPER) }, "Paper values (k 2, α 0.3, C 1.5)"),
            el("button", { class: "dg-btn", type: "button", onclick: () => preset(VISIBLE_PW) }, "More widening (k 4, α 0.5)"))),
        el("button", { class: "dg-btn dg-primary dg-start", onclick: () => this.start(this.gameId) }, "Start game")));
    }

    // --------------------------------------------------------------- game flow
    async start(id) {
      const gen = (this.gen || 0) + 1;
      this.gen = gen;
      if (!this.cache[id]) {
        const t = await (await fetch(`${this.base}data/${id}/tree.json`)).json();
        t.byId = new Map(t.nodes.map((n) => [n.id, n]));
        t.dir = `${this.base}data/${id}/`;
        prune(t);
        this.cache[id] = t;
      }
      if (gen !== this.gen) return;
      this.tree = this.cache[id];
      this.gameId = id;
      this.busy = false;
      this.turn = null;
      this.round = 1;
      this.yp = newPlayer();
      this.dp = newPlayer();
      this.window.classList.remove("dg-in-setup");
      this.playControls.style.display = "";
      this.giveUpBtn.disabled = false;
      this.giveUpBtn.lastChild.textContent = "Give up and let DISCO run";
      this.result.classList.remove("dg-visible");
      this.you.attach(this.tree, this.yp);
      this.disco.attach(this.tree, this.dp);
      this.you.setFocus(0);
      this.disco.setFocus(0);
      this.disco.message("info", "Waiting for you", "DISCO runs one iteration after each of yours.");
      const c = this.cfg;
      this.statusText.textContent = `${this.title()} · B ${c.B} · k ${num(c.k)} · α ${num(c.alpha)} · C ${num(c.C)}`;
      this.updateStats();
      this.userTurn();
    }

    node(id) { return this.tree.byId.get(id); }
    title() { return this.games.find((g) => g.id === this.gameId).title; }
    deadReason(n) {
      if (this.reasons[`${this.gameId}/${n.id}`]) return this.reasons[`${this.gameId}/${n.id}`];
      const fails = n.kids.map((k) => failText(k.failure_type)[0].toLowerCase());
      return fails.length ? `Every action the policy proposed here failed (${[...new Set(fails)].join(", ")}).`
        : "The search tried every action from here and none led to a solution.";
    }

    updateStats() {
      const b = this.cfg.budget;
      for (const [who, p] of [["you", this.yp], ["disco", this.dp]]) {
        const s = this.sb[who];
        if (s.plans.textContent !== String(p.plans.size)) {
          s.plans.textContent = String(p.plans.size);
          s.plans.classList.remove("dg-bump");
          void s.plans.offsetWidth;  // restart the animation
          s.plans.classList.add("dg-bump");
        }
        s.sub.replaceChildren(
          el("span", {}, el("b", {}, `${p.iters}/${b}`), " iterations"),
          el("span", {}, el("b", {}, String(p.sampled)), " policy calls (π)"),
          el("span", {}, el("b", {}, String(p.actions)), " executed"));
      }
      this.sb.you.card.classList.toggle("dg-turn-on", this.turn === "you");
      this.sb.disco.card.classList.toggle("dg-turn-on", this.turn === "disco");
      this.roundNum.replaceChildren(this.turn === "over" ? "Final" : String(Math.min(this.round, b)),
        this.turn === "over" ? "" : el("span", {}, ` / ${b}`));
      this.turnText.textContent = this.turn === "you" ? "Your turn" : this.turn === "disco" ? "DISCO's turn"
        : this.turn === "over" ? "Game over" : "";
    }

    showBanner(text, kind) {
      this.banner.className = `dg-banner dg-banner-${kind}`;
      this.banner.textContent = text;
      void this.banner.offsetWidth;
      this.banner.classList.add("dg-show");
    }

    youDone() { const p = this.yp; return p.gaveUp || p.iters >= this.cfg.budget || p.exhausted.has(0); }
    discoDone() { const p = this.dp; return p.iters >= this.cfg.budget || p.exhausted.has(0); }

    next(after) {
      const gen = this.gen, y = this.youDone(), d = this.discoDone();
      if (y && d) { this.finish(); return; }
      const go = (f) => setTimeout(() => gen === this.gen && f(), this.fast ? 250 : 900);
      if (after === "you") go(d ? () => this.userTurn() : () => this.discoTurn());
      else go(y ? () => this.discoTurn() : () => this.userTurn());
    }

    // Prune a player's tree: a reached state is exhausted once it is a goal, or every saved action below it has been
    // sampled and is either failed or exhausted. `revealed` lets DISCO plan ahead of what its board shows.
    markExhausted(p, n, revealed = p.revealed) {
      for (let v = n; v; v = v.parent === null ? null : this.node(v.parent)) {
        const done = p.rolled.has(v.id) && (v.status === "goal" ||
          v.kids.every((k) => revealed.has(k.id) && (!feasible(k) || p.exhausted.has(k.id))));
        if (!done) return;
        p.exhausted.add(v.id);
      }
    }

    // Something left to try from a reached state: an action not sampled yet, or a feasible one not exhausted.
    hasOptions(p, n) {
      return n.status !== "goal" && n.kids.some((k) => !p.revealed.has(k.id) || (feasible(k) && !p.exhausted.has(k.id)));
    }

    // --------------------------------------------------------------- your iteration
    userTurn() {
      if (this.youDone()) { this.next("you"); return; }
      const p = this.yp;
      this.turn = "you";
      this.round = p.iters + 1;
      p.phase = "select";
      p.cur = null;
      p.path = [];
      this.you.setBadge("Your turn", true);
      this.disco.setBadge("", false);
      this.bringIntoView(this.you);
      this.updateStats();
      this.showBanner(`Round ${this.round} · Your turn`, "you");
      const start = this.hasOptions(p, this.node(p.selected)) ? p.selected : 0;
      this.you.setFocus(start);
      if (p.iters) this.you.fit(null);  // show the whole tree you have grown so far
      this.you.show(this.node(start));
    }

    myTurn() { return this.turn === "you" && !this.busy; }

    canUserSample(n) {
      const p = this.yp;
      return this.myTurn() && p.rolled.has(n.id) && n.status !== "goal" && this.you.hidden(n).length > 0 &&
        (p.phase === "select" || (p.cur && p.cur.id === n.id));
    }

    canTraverse(n) {
      const p = this.yp;
      if (!this.myTurn() || !p.rolled.has(n.id) || p.exhausted.has(n.id) || deadFor(p, n)) return false;
      return p.phase === "select" || (p.cur && n.parent === p.cur.id);
    }

    canExecute(n) {
      const p = this.yp;
      if (!this.myTurn() || p.rolled.has(n.id) || !feasible(n) || !p.revealed.has(n.id)) return false;
      return p.phase === "select" || (p.cur && n.parent === p.cur.id);
    }

    sampleLabel(n) {
      const k = Math.min(this.cfg.B, this.you.hidden(n).length);
      return k ? `Sample ${plural(k, "action")} with policy π` : "Sample with policy π";
    }

    // Sampled actions at n that can still be executed or entered.
    openKids(p, n) { return n.kids.filter((k) => p.revealed.has(k.id) && feasible(k) && !p.exhausted.has(k.id)); }

    allSampledFailed(p, n) {
      const shown = n.kids.filter((k) => p.revealed.has(k.id));
      return shown.length > 0 && shown.every((k) => !feasible(k));
    }

    youHint(n) {
      const p = this.yp, left = this.you.hidden(n).length, open = this.openKids(p, n).length;
      if (this.turn !== "you") return "";
      let hint;
      if (open && left) hint = `click a sampled action to execute it, or sample more with π (${left} more saved here).`;
      else if (open) hint = "click one of the actions under this state to continue.";
      else if (left && this.allSampledFailed(p, n)) hint = "every action sampled here so far failed. Sample again with π; " +
        "if all of them fail, this state becomes a dead end.";
      else if (left) hint = "sample actions with policy π from this state." + (p.phase === "select" ? " Or hover another state you reached." : "");
      else return "Nothing left to try from here. Hover another state you have reached.";
      return p.phase === "rollout" ? `Keep rolling out: ${hint}` : hint[0].toUpperCase() + hint.slice(1);
    }

    // Contents of the hover menu for a node on your board.
    menuFor(n) {
      const p = this.yp, B = this.cfg.B;
      const where = n.id === 0 ? "Start" : `Step ${n.depth}` +
        (n.progress !== null && feasible(n) ? ` · ${n.progress}/${this.tree.num_objects} placed` : "");
      if (!feasible(n)) {
        const [title, text] = failText(n.failure_type);
        return { title: `Failed action: ${title}`, note: `${text} It cannot be chosen.` };
      }
      if (!p.rolled.has(n.id)) {
        return this.canExecute(n)
          ? { title: "Action sampled from π", buttons: [{ label: "▶ Execute this action", primary: true, act: () => this.userNode(n.id) }] }
          : { title: "Action sampled from π", note: this.myTurn() ? "Finish the current rollout first." : "Wait for your turn." };
      }
      if (deadFor(p, n)) return { title: where, dead: this.deadReason(n) };
      if (n.status === "goal") return { title: where, note: "A plan you already found." };
      const spec = { title: where, buttons: [] };
      if (this.allSampledFailed(p, n)) spec.warn = this.you.hidden(n).length
        ? "Every action sampled here so far failed. If the rest fail too, this state becomes a dead end."
        : "Every action from this state fails: it is a dead end.";
      if (p.exhausted.has(n.id)) { spec.note = "Everything below this state has been explored."; return spec; }
      if (!this.myTurn()) { spec.note = "Wait for your turn."; return spec; }
      const here = p.selected === n.id;
      if (this.canTraverse(n) && !here) spec.buttons.push({ label: "➜ Traverse here", primary: true, act: () => this.userNode(n.id) });
      if (this.you.hidden(n).length && (this.canTraverse(n) || here) && (p.phase === "select" || here || n.parent === p.cur?.id)) {
        spec.buttons.push({ label: `π Sample ${plural(Math.min(B, this.you.hidden(n).length), "action")} here`,
          act: () => { if (!here) this.userNode(n.id); this.userSample(); } });
      }
      if (!spec.buttons.length) spec.note = p.phase === "rollout" ? "Mid-rollout: continue from the highlighted state." : "";
      return spec;
    }

    // A click on your board: traverse to a reached state, execute a sampled action, or inspect a failed one.
    userNode(id) {
      const p = this.yp, n = this.node(id);
      if (!feasible(n)) { this.you.show(n); return; }
      if (this.turn !== "you" || this.busy) return;
      if (!p.rolled.has(id)) {
        if (this.canExecute(n)) this.userExecute(n);
        else this.you.message("info", "You are mid-rollout", "Continue from the highlighted state until the rollout ends.");
        return;
      }
      if (deadFor(p, n)) { this.you.show(n); return; }
      if (p.phase === "select") { this.you.setFocus(id); this.you.show(n); return; }
      if (n.parent !== p.cur.id) {
        if (n.id !== p.cur.id) this.you.message("info", "You are mid-rollout", "Continue from the highlighted state until the rollout ends.");
        return;
      }
      if (p.exhausted.has(id)) { this.you.message("info", "Already explored", "Nothing left below that state. Choose another action."); return; }
      p.cur = n;  // a state you reached before: traverse into it without executing anything
      p.path.push(n);
      this.you.setFocus(n.id);
      this.you.show(n);
    }

    userSample() {
      const p = this.yp, n = this.node(p.selected);
      if (!this.canUserSample(n)) return;
      const kids = draw(this.you.hidden(n), this.cfg.B);
      p.sampled += kids.length;
      this.you.reveal(kids);
      this.markExhausted(p, n);
      const bad = kids.filter((k) => !feasible(k)).length;
      if (bad) this.you.toast(bad === kids.length ? `All ${kids.length} failed` : `${bad} of ${kids.length} failed`, "fail");
      this.updateStats();
      this.you.styleAll();
      this.you.show(n);
      if (deadFor(p, n)) {
        this.you.toast("Dead end", "fail");
        if (p.phase === "rollout") this.endUserIteration(n);
      }
    }

    async userExecute(n) {
      const gen = this.gen, p = this.yp;
      if (p.phase === "select") { p.phase = "rollout"; p.path = this.you.lineage(this.node(n.parent)); }
      this.busy = true;
      this.you.placePill();
      this.you.sampleBtn.disabled = true;
      await this.you.play(n, false);
      if (gen !== this.gen) return;
      p.rolled.add(n.id);
      p.actions++;
      p.cur = n;
      p.path.push(n);
      this.busy = false;
      this.you.setFocus(n.id);
      this.updateStats();
      if (n.status === "goal" || deadFor(p, n) || !this.hasOptions(p, n)) this.endUserIteration(n);
      else this.you.show(n);
    }

    endUserIteration(n) {
      const p = this.yp;
      this.markExhausted(p, n);
      p.iters++;
      p.phase = "select";
      p.cur = null;
      const isNew = n.status === "goal" && !p.plans.has(n.id);
      if (isNew) p.plans.add(n.id);
      this.you.show(n);
      if (n.status !== "goal" && !deadFor(p, n)) this.you.message("info", "Rollout over",
        "Everything below this state has already been explored.");
      if (isNew) {
        this.you.message("goal", `Plan ${p.plans.size} found!`, `All objects placed in ${plural(n.depth, "action")}.`);
        this.you.toast("+1 PLAN!", "plan");
      } else if (deadFor(p, n)) this.you.toast("Dead end", "fail");
      this.turn = null;
      this.updateStats();
      this.you.setBadge("", false);
      this.next("you");
    }

    giveUp() {
      if (this.turn === "over") return;
      this.yp.gaveUp = true;
      this.giveUpBtn.disabled = true;
      this.giveUpBtn.lastChild.textContent = "DISCO is playing on…";
      this.you.setBadge("Stopped", false);
      if (this.turn === "you" && !this.busy) { this.turn = null; this.next("you"); }
    }

    // --------------------------------------------------------------- DISCO: MCTS over the saved tree
    // Selection (paper, Alg. 1 and 4): descend by UCB through executed actions. At each state, check progressive widening
    // (sample B new actions with π while |children| < k·N^α) and stop when UCB picks a feasible action not executed yet.
    // Failed actions are discarded as soon as they are sampled. An action without visits is scored by its saved Q,
    // which stands in for the value function Qφ.
    plan() {
      const p = this.dp, { k: K, alpha: A, C } = this.cfg, steps = [], seen = new Set(p.revealed);
      for (let guard = 0; guard < 1000; guard++) {
        if (p.exhausted.has(0)) return null;
        let v = this.node(0);
        const path = [v];
        for (;;) {
          const N = p.N.get(v.id) || 0;
          let shown = v.kids.filter((k) => seen.has(k.id));
          const hidden = v.kids.filter((k) => !seen.has(k.id));
          let open = shown.filter((k) => feasible(k) && !p.exhausted.has(k.id));
          const limit = K * Math.pow(Math.max(N, 1), A);
          if (hidden.length && (shown.length < limit || !open.length)) {
            const kids = draw(hidden, this.cfg.B);
            const type = !shown.length ? "first" : shown.length < limit ? "widen" : "forced";
            steps.push({ kind: "expand", type, node: v, kids, N, limit, had: shown.length });
            for (const k of kids) seen.add(k.id);
            shown = shown.concat(kids);
            open = open.concat(kids.filter(feasible));
          } else if (hidden.length) steps.push({ kind: "check", node: v, N, limit, had: shown.length });
          if (!open.length) {  // nothing feasible below v yet: prune it if it is used up, and start the descent again
            this.markExhausted(p, v, seen);
            break;
          }
          const lnN = Math.log(N + 1);
          let best = null;
          for (const k of open) {
            const Nk = p.N.get(k.id) || 0;
            const q = Nk ? p.W.get(k.id) / Nk : k.Q;
            const ucb = q + C * Math.sqrt(lnN / (Nk + 1));
            if (!best || ucb > best.ucb) best = { node: k, q, ucb, bonus: ucb - q, Nk };
          }
          path.push(best.node);
          if (!p.rolled.has(best.node.id)) {
            steps.push({ kind: "execute", node: best.node, from: v, ...best });
            return { steps, path };
          }
          steps.push({ kind: "select", node: best.node, from: v, ...best });
          v = best.node;
        }
      }
      return null;
    }

    // Value-guided rollout step (paper, Sec. 4.2): sample B actions with π at the newest state and execute the feasible
    // one with the highest Qφ. The rollout stops when no sampled action is feasible.
    rolloutPlan(cur) {
      const p = this.dp, hidden = this.disco.hidden(cur), steps = [];
      const kids = hidden.length ? draw(hidden, this.cfg.B) : [];
      if (kids.length) steps.push({ kind: "expand", type: "rollout", node: cur, kids });
      const open = cur.kids.filter((k) => (p.revealed.has(k.id) || kids.includes(k)) && feasible(k) && !p.exhausted.has(k.id));
      if (!open.length) return { steps, best: null, allFailed: kids.length > 0 };
      const best = open.reduce((a, b) => (b.Q > a.Q ? b : a));
      steps.push({ kind: "execute", node: best, from: cur, q: best.Q, greedy: true });
      return { steps, best };
    }

    // End of an iteration: the return is the progress reached, R = κ(s_T) (1 at the goal), averaged into every state
    // on the path (paper, Alg. 5).
    backup(path, n) {
      const p = this.dp, prog = n.progress ?? 0;
      const ret = n.status === "goal" ? 1 : prog / this.tree.num_objects;
      for (const v of path) {
        p.N.set(v.id, (p.N.get(v.id) || 0) + 1);
        p.W.set(v.id, (p.W.get(v.id) || 0) + ret);
      }
      this.markExhausted(p, n);
      return ret;
    }

    // Animate and apply one plan's steps on DISCO's board. Resolves to the executed node, if any.
    async runSteps(steps, trail) {
      const p = this.dp, D = this.disco, gen = this.gen, { k: K, alpha: A } = this.cfg;
      const pace = () => (this.fast ? 160 : 520);
      let executed = null;
      for (const s of steps) {
        if (gen !== this.gen) return null;
        const d = s.node.depth;
        if (s.kind === "check") {
          D.setFocus(s.node.id, trail);
          D.log(`Step ${d}: |children| ${s.had} ≥ k·N^α = ${num(K)}·${Math.max(s.N, 1)}^${num(A)} = ${fmt(s.limit)}, so no widening.`);
          await sleep(pace());
        } else if (s.kind === "expand") {
          D.setFocus(s.node.id, trail);
          const acts = `${plural(s.kids.length, "action")} with policy π`;
          const bad = s.kids.filter((k) => !feasible(k)).length;
          const tail = bad ? ` ${bad === s.kids.length ? "All" : bad} failed.` : "";
          if (s.type === "widen") {
            D.log(`Widen step ${d}: |children| ${s.had} < k·N^α = ${num(K)}·${Math.max(s.N, 1)}^${num(A)} = ${fmt(s.limit)}, ` +
              `so sample ${acts}.${tail}`, "widen");
          } else if (s.type === "forced") D.log(`Step ${d}: no feasible sampled action left, so sample ${acts}.${tail}`);
          else if (s.type === "rollout") D.log(`Rollout at step ${d}: sample ${acts}.${tail}`);
          else D.log(`Expand step ${d}: sample ${acts}.${tail}`);
          p.sampled += s.kids.length;
          D.reveal(s.kids);
          if (s.type === "widen") D.flash(s.node.id, s.kids);
          this.updateStats();
          await sleep(pace() + (s.type === "widen" ? 700 : 250));
        } else if (s.kind === "select") {
          trail.push(s.node.id);
          D.setFocus(s.node.id, trail);
          D.show(s.node);
          D.log(`Select step ${d} by UCB ${fmt(s.ucb)} = Q ${fmt(s.q)} + explore ${fmt(s.bonus)}.`);
          await sleep(pace());
        } else {
          trail.push(s.node.id);
          D.setFocus(s.from.id, trail);
          D.log(s.greedy ? `Roll out: execute the feasible action with the highest Qφ (${fmt(s.q)}).`
            : `Execute a new action: UCB ${fmt(s.ucb)} = Qφ ${fmt(s.q)} + explore ${fmt(s.bonus)}.`);
          D.message("info", "Executing", "");
          await D.play(s.node, this.fast);
          if (gen !== this.gen) return null;
          p.rolled.add(s.node.id);
          p.actions++;
          D.setFocus(s.node.id, trail);
          D.show(s.node);
          this.updateStats();
          executed = s.node;
        }
      }
      return executed;
    }

    // One full MCTS iteration: selection, expansion, a greedy rollout to a goal or dead end, backup.
    async discoTurn() {
      if (this.discoDone()) { this.next("disco"); return; }
      const gen = this.gen, p = this.dp, D = this.disco;
      this.turn = "disco";
      this.round = p.iters + 1;
      this.busy = true;
      p.phase = "rollout";
      if (!this.yp.gaveUp) this.you.setBadge("", false);
      D.setBadge("Thinking…", true);
      this.bringIntoView(D);
      this.you.placePill();
      this.you.hideMenu();
      if (this.you.sampleBtn) this.you.sampleBtn.disabled = true;
      this.updateStats();
      this.showBanner(`Round ${this.round} · DISCO's turn`, "disco");

      const plan = this.plan();
      if (!plan) {
        D.log("Nothing left to try in the saved tree.");
        p.iters = this.cfg.budget;
        p.phase = "select";
        this.busy = false;
        this.turn = null;
        this.next("disco");
        return;
      }
      D.log(`Iteration ${p.iters + 1}: select from the start by UCB.`, "head");
      const trail = [0];
      D.setFocus(0, trail);
      D.show(this.node(0));
      await sleep(this.fast ? 160 : 520);
      let n = await this.runSteps(plan.steps, trail);
      if (gen !== this.gen) return;
      const path = plan.path;
      let why = "";
      if (!n) {  // every action sampled during selection failed: end the iteration where it stopped
        n = this.node(trail[trail.length - 1]);
        why = "every sampled action failed";
      }
      while (!why && n.status !== "goal" && !deadFor(p, n)) {
        const step = this.rolloutPlan(n);
        const next = await this.runSteps(step.steps, trail);
        if (gen !== this.gen) return;
        if (!next) { why = step.allFailed ? "every sampled action failed" : "nothing left to try"; break; }
        path.push(next);
        n = next;
      }
      if (!why) why = n.status === "goal" ? "goal reached" : "dead end";
      this.markExhausted(p, n);
      D.log(`Rollout ended (${why}). Back up R = ${fmt(this.backup(path, n))} along ${plural(path.length, "state")}.`);
      if (n.status === "goal" && !p.plans.has(n.id)) {
        p.plans.add(n.id);
        D.log(`Plan ${p.plans.size} found.`, "plan");
        D.toast("+1 PLAN!", "plan");
      } else if (deadFor(p, n)) D.toast("Dead end", "fail");
      p.iters++;
      p.phase = "select";
      D.setFocus(n.id, path.map((v) => v.id));
      D.show(n);
      D.setBadge("", false);
      this.busy = false;
      this.turn = null;
      this.updateStats();
      this.next("disco");
    }

    // On narrow screens the two sides are stacked: bring the side that is moving into view.
    bringIntoView(board) {
      if (window.matchMedia("(max-width: 900px)").matches) board.el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    finish() {
      this.turn = "over";
      this.giveUpBtn.disabled = true;
      this.giveUpBtn.lastChild.textContent = "Game over";
      this.you.setBadge("", false);
      this.disco.setBadge("", false);
      this.you.placePill();
      if (this.you.sampleBtn) this.you.sampleBtn.disabled = true;
      this.updateStats();
      const y = this.yp.plans.size, d = this.dp.plans.size;
      const head = y > d ? "You beat DISCO!" : d > y ? "DISCO wins" : "It's a tie!";
      const line = y === d ? `You both found ${plural(y, "plan")}.`
        : `${y > d ? "You" : "DISCO"} found ${plural(Math.max(y, d), "plan")} to ${Math.min(y, d)}.`;
      this.showBanner(head, y > d ? "you" : d > y ? "disco" : "tie");
      const row = (k, a, b) => el("tr", {}, el("th", {}, k), el("td", {}, a), el("td", {}, b));
      this.result.replaceChildren(el("div", { class: "dg-result-card" },
        discoBall(56),
        el("div", { class: "dg-result-head" }, head),
        el("p", {}, line),
        el("table", { class: "dg-result-table" },
          el("thead", {}, el("tr", {}, el("th", {}), el("th", {}, "You"), el("th", {}, "DISCO"))),
          el("tbody", {},
            row("Plans found", String(y), String(d)),
            row("Iterations", String(this.yp.iters), String(Math.min(this.dp.iters, this.cfg.budget))),
            row("Policy calls (π)", String(this.yp.sampled), String(this.dp.sampled)),
            row("Actions executed", String(this.yp.actions), String(this.dp.actions)))),
        el("div", { class: "dg-result-actions" },
          el("button", { class: "dg-btn dg-primary", onclick: () => this.start(this.gameId) }, "Play again"),
          el("button", { class: "dg-btn", onclick: () => this.showSetup() }, "New game"),
          el("button", { class: "dg-btn", onclick: () => this.result.classList.remove("dg-visible") }, "Look at the trees"))));
      setTimeout(() => this.turn === "over" && this.result.classList.add("dg-visible"), 900);
    }
  }

  // =============================================================== launcher
  function boot() {
    // Decorative disco balls elsewhere on the page: <span data-disco-ball></span>, sized by CSS.
    document.querySelectorAll("[data-disco-ball]").forEach((m) => { if (!m.firstChild) m.append(discoBall(40)); });
    document.querySelectorAll("[data-disco-game]").forEach((mount) => {
      if (mount.dgGame !== undefined) return;
      mount.dgGame = null;
      const base = (mount.dataset.base || "./").replace(/\/?$/, "/");
      const btn = el("button", { class: "dg-launch-btn", type: "button", onclick: () => {
        if (!mount.dgGame) mount.dgGame = new Game(base);
        mount.dgGame.open();
      } }, discoBall(34), el("span", {}, "Click to play the DISCO Game!"));
      btn.addEventListener("animationend", () => btn.classList.replace("dg-pop", "dg-popped"));
      mount.classList.add("dg-launch");
      mount.append(btn);
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver((es) => {
          if (es.some((e) => e.isIntersecting)) { btn.classList.add("dg-pop"); io.disconnect(); }
        }, { threshold: 0.6 });
        io.observe(btn);
      } else btn.classList.add("dg-pop");
    });
  }
  // Links elsewhere on the page that open the game: <a href="#" data-open-disco-game>…</a>
  document.addEventListener("click", (e) => {
    const link = e.target.closest && e.target.closest("[data-open-disco-game]");
    const btn = link && document.querySelector("[data-disco-game] .dg-launch-btn");
    if (btn) { e.preventDefault(); btn.click(); }
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
