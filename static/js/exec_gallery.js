// "DISCO during Execution": a large player with a playlist of task cards. Clicking a card plays that rollout; each clip
// moves on to the next one when it ends. Filter chips narrow the playlist, and the player only runs while on screen.
// Mount: <div class="exec" data-exec-gallery data-base="assets/task_chooser/"></div> (clips cN.mp4, posters pN.png).
(function () {
  "use strict";

  const CLIPS = [
    { n: 1, title: "Shelf packing", env: "sim", kind: "shelf" },
    { n: 2, title: "Table bussing", env: "real", kind: "bussing" },
    { n: 3, title: "Shelf packing", env: "sim", kind: "shelf" },
    { n: 4, title: "Cabinet packing", env: "sim", kind: "shelf" },
    { n: 5, title: "Object stacking", env: "sim", kind: "stacking" },
    { n: 6, title: "Shelf packing", env: "sim", kind: "shelf" },
    { n: 7, title: "Cabinet packing", env: "real", kind: "shelf" },
    { n: 8, title: "Object stacking", env: "sim", kind: "stacking" },
  ];
  const FILTERS = [
    ["all", "All", () => true],
    ["shelf", "Shelf packing", (c) => c.kind === "shelf"],
    ["stacking", "Stacking", (c) => c.kind === "stacking"],
    ["real", "Real world", (c) => c.env === "real"],
  ];

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
  const badge = (env) => el("span", { class: `exec-badge exec-badge-${env}` }, env === "real" ? "Real world" : "Simulation");

  function mount(root) {
    const base = (root.dataset.base || "./").replace(/\/?$/, "/");
    let filter = FILTERS[0], list = CLIPS.slice(), cur = CLIPS[0], visible = false;

    const video = el("video", { class: "exec-video", muted: "", playsinline: "", preload: "metadata", controls: "" });
    video.muted = true;
    const title = el("div", { class: "exec-title" });
    const count = el("div", { class: "exec-count" });
    const arrow = (dir, label) => el("button", { class: `exec-arrow exec-${dir}`, type: "button", "aria-label": label, title: label,
      onclick: () => step(dir === "next" ? 1 : -1) }, dir === "next" ? "›" : "‹");
    const player = el("div", { class: "exec-player" }, video, el("div", { class: "exec-head" }, title, count),
      arrow("prev", "Previous rollout"), arrow("next", "Next rollout"));

    const chips = el("div", { class: "exec-chips", role: "tablist" });
    const cards = el("div", { class: "exec-list" });
    root.append(player, el("div", { class: "exec-side" }, chips, cards));

    function drawChips() {
      chips.replaceChildren(...FILTERS.map((f) => el("button", {
        class: "exec-chip", type: "button", role: "tab", "aria-selected": f === filter ? "true" : "false",
        onclick: () => {
          filter = f;
          list = CLIPS.filter(f[2]);
          drawChips();
          drawCards();
          if (!list.includes(cur)) select(list[0], true);
          else count.textContent = `${list.indexOf(cur) + 1} / ${list.length}`;
        },
      }, f[1], el("span", { class: "exec-chip-n" }, String(CLIPS.filter(f[2]).length)))));
    }

    function drawCards() {
      cards.replaceChildren(...list.map((c) => el("button", {
        class: "exec-card" + (c === cur ? " is-active" : ""), type: "button", "data-n": c.n, "aria-pressed": c === cur ? "true" : "false",
        onclick: () => select(c, true),
      },
      el("span", { class: "exec-thumb" }, el("img", { src: `${base}p${c.n}.png`, alt: "", loading: "lazy" }), badge(c.env),
        el("span", { class: "exec-playing", "aria-hidden": "true" }, el("i"), el("i"), el("i")),
        el("span", { class: "exec-bar" }, el("span"))),
      el("span", { class: "exec-card-title" }, c.title))));
    }

    function select(c, play) {
      cur = c;
      video.src = `${base}c${c.n}.mp4`;
      video.poster = `${base}p${c.n}.png`;
      title.replaceChildren(el("span", {}, c.title), badge(c.env));
      count.textContent = `${list.indexOf(c) + 1} / ${list.length}`;
      for (const card of cards.children) {
        const on = Number(card.dataset.n) === c.n;
        card.classList.toggle("is-active", on);
        card.setAttribute("aria-pressed", on ? "true" : "false");
        card.querySelector(".exec-bar > span").style.width = "0%";
      }
      const active = cards.querySelector(".is-active");
      if (active && play) active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      if (play || visible) video.play().catch(() => {});
    }

    function step(d) {
      const i = list.indexOf(cur);
      select(list[(i + d + list.length) % list.length], true);
    }

    video.addEventListener("ended", () => step(1));
    video.addEventListener("timeupdate", () => {
      const bar = cards.querySelector(".is-active .exec-bar > span");
      if (bar && video.duration) bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
    });
    video.addEventListener("play", () => root.classList.add("is-playing"));
    video.addEventListener("pause", () => root.classList.remove("is-playing"));

    drawChips();
    drawCards();
    select(cur, false);
    // Play only while the player is on screen.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => {
        visible = es.some((e) => e.isIntersecting);
        if (visible) video.play().catch(() => {}); else video.pause();
      }, { threshold: 0.35 }).observe(player);
    }
  }

  function boot() { document.querySelectorAll("[data-exec-gallery]").forEach((r) => { if (!r.execGallery) { r.execGallery = true; mount(r); } }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
