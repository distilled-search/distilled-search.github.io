// Interactive page sections:
// - [data-switcher]: segmented tabs that show one .task-panel at a time; its video plays only while visible.
// - [data-real-compare]: real-world comparison. Pick a task and a trial; DISCO and 3DFA play side by side.
(function () {
  "use strict";

  const REAL = [
    {
      id: "shelf", label: "Shelf packing", objects: 3,
      blurb: "Two objects start inside the shelf; the robot must fit three more without anything falling out. A test-only task.",
      disco: { avg: 88.9, trials: [["shelf/DISCO/DISCO_shelf_t1_r3.mp4", 3], ["shelf/DISCO/DISCO_shelf_t2_r3.mp4", 3], ["shelf/DISCO/DISCO_shelf_t3_r2.mp4", 2]] },
      base: { avg: 33.3, trials: [["shelf/3DFA/3DFA_shelf_t1_r1.mp4", 1], ["shelf/3DFA/3DFA_shelf_t2_r1.mp4", 1], ["shelf/3DFA/3DFA_shelf_t3_r1.mp4", 1]] },
    },
    {
      id: "tray", label: "Table bussing", objects: 6,
      blurb: "Put every cup, bowl and plate into the tray, upright. A test-only task: trained with randomised shelf poses, DISCO generalises to box-like containers.",
      disco: { avg: 83.3, trials: [["tray/DISCO/DISCO_t1_r5.mp4", 5], ["tray/DISCO/DISCO_t2_r6.mp4", 6], ["tray/DISCO/DISCO_t3_r4.mp4", 4]] },
      base: { avg: 27.8, trials: [["tray/3DFA/3DFA_t1_r2.mp4", 2], ["tray/3DFA/3DFA_t2_r1.mp4", 1], ["tray/3DFA/3DFA_t3_r2.mp4", 2]] },
    },
  ];
  const BASE = "assets/real_world/";

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

  // Play a video only while it is on screen (and not hidden in an inactive tab).
  const watched = new Map();
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => {
    for (const e of es) {
      watched.set(e.target, e.isIntersecting);
      if (e.isIntersecting && e.target.dataset.autoplay !== undefined) e.target.play().catch(() => {});
      else e.target.pause();
    }
  }, { threshold: 0.3 }) : null;
  const watch = (v) => { v.muted = true; if (io) io.observe(v); else v.play().catch(() => {}); };
  const onScreen = (v) => !io || watched.get(v);

  // ----------------------------------------------------------------- tabs with panels
  function switcher(root) {
    const btns = [...root.querySelectorAll(".seg-btn")];
    root.querySelectorAll("video[data-autoplay]").forEach(watch);
    const show = (id) => {
      for (const b of btns) b.setAttribute("aria-selected", String(b.dataset.show === id));
      for (const b of btns) {
        const panel = document.getElementById(b.dataset.show), on = b.dataset.show === id;
        panel.hidden = !on;
        const v = panel.querySelector("video");
        if (!v) continue;
        if (on) { v.currentTime = 0; v.play().catch(() => {}); } else v.pause();
      }
    };
    for (const b of btns) b.addEventListener("click", () => show(b.dataset.show));
  }

  // ----------------------------------------------------------------- real-world comparison
  function realCompare(root) {
    let task = REAL[0], trial = 0;
    const tabs = el("div", { class: "seg", role: "tablist", "aria-label": "Real-world task" });
    const blurb = el("p", { class: "real-blurb" });
    const bars = el("div", { class: "real-bars" });
    const trials = el("div", { class: "real-trials", role: "tablist", "aria-label": "Trial" });
    const side = (who, name) => {
      const video = el("video", { muted: "", playsinline: "", loop: "", preload: "metadata", controls: "", "data-autoplay": "" });
      const score = el("span", { class: "real-score" });
      const card = el("figure", { class: `real-side real-${who}` },
        el("figcaption", { class: "real-head" }, el("span", { class: "real-name" }, name), score),
        el("div", { class: "real-video" }, video));
      watch(video);
      return { card, video, score };
    };
    const disco = side("disco", "DISCO (ours)"), base = side("base", "3DFA (baseline)");
    const replay = el("button", { class: "real-replay", type: "button", onclick: () => play(true) }, "↺ Replay both from the start");
    root.append(el("div", { class: "real-top" }, tabs, bars), blurb,
      el("div", { class: "real-controls" }, trials, replay), el("div", { class: "real-pair" }, disco.card, base.card));

    function play(restart) {
      for (const s of [disco, base]) {
        if (restart) s.video.currentTime = 0;
        if (onScreen(s.video)) s.video.play().catch(() => {});
      }
    }

    function drawTabs() {
      tabs.replaceChildren(...REAL.map((t) => el("button", {
        class: "seg-btn", type: "button", role: "tab", "aria-selected": String(t === task),
        onclick: () => { task = t; trial = 0; render(); },
      }, t.label, el("span", { class: "seg-sub" }, ` · ${t.objects} objects`))));
    }

    function render() {
      drawTabs();
      blurb.textContent = task.blurb;
      const bar = (name, cls, v) => el("div", { class: `real-bar ${cls}` },
        el("span", { class: "real-bar-name" }, name),
        el("span", { class: "real-bar-track" }, el("span", { class: "real-bar-fill", style: `width:${v}%` })),
        el("b", {}, v.toFixed(1)));
      bars.replaceChildren(el("div", { class: "real-bars-title" }, "Average reward"),
        bar("DISCO", "is-disco", task.disco.avg), bar("3DFA", "is-base", task.base.avg));
      trials.replaceChildren(el("span", { class: "real-trials-label" }, "Trial"), ...task.disco.trials.map((d, i) => el("button", {
        class: "real-trial", type: "button", role: "tab", "aria-selected": String(i === trial),
        onclick: () => { trial = i; render(); },
      }, el("b", {}, String(i + 1)), el("span", {}, `${d[1]}/${task.objects} vs ${task.base.trials[i][1]}/${task.objects}`))));
      for (const [s, data] of [[disco, task.disco], [base, task.base]]) {
        const [file, packed] = data.trials[trial];
        s.video.src = BASE + file;
        s.score.textContent = `${packed}/${task.objects} placed`;
        s.score.className = "real-score" + (packed === task.objects ? " is-full" : "");
      }
      play(true);
    }
    render();
  }

  function boot() {
    document.querySelectorAll("[data-switcher]").forEach(switcher);
    document.querySelectorAll("[data-real-compare]").forEach(realCompare);
    // other stand-alone videos that should play only while on screen
    document.querySelectorAll("video[data-autoplay]").forEach((v) => { if (!v.closest("[data-switcher], [data-real-compare]")) watch(v); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
