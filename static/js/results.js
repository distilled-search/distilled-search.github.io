// Results carousel: one slide per set of graphs from the paper. It advances slowly on its own, with a progress bar;
// arrows, dots, swipes and the arrow keys move by hand and restart the timer. It only pauses while off screen.
(function () {
  "use strict";

  const SLIDE_MS = 9000;

  function mount(root) {
    const track = root.querySelector(".res-track"), slides = [...track.children];
    const dots = root.querySelector(".res-dots"), bar = root.querySelector(".res-progress > span");
    let i = 0, visible = false, elapsed = 0, last = performance.now();

    slides.forEach((s, k) => {
      s.setAttribute("aria-label", `${k + 1} of ${slides.length}`);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "res-dot";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-label", `Show result ${k + 1}: ${s.querySelector(".res-kicker").textContent}`);
      b.addEventListener("click", () => go(k));
      dots.append(b);
    });

    function go(k) {
      i = (k + slides.length) % slides.length;
      track.style.transform = `translateX(${-100 * i}%)`;
      slides.forEach((s, n) => s.setAttribute("aria-hidden", String(n !== i)));
      [...dots.children].forEach((d, n) => d.setAttribute("aria-selected", String(n === i)));
      elapsed = 0;
    }

    // Progress clock: runs while the carousel is on screen.
    function tick(now) {
      const dt = now - last;
      last = now;
      if (visible) {
        elapsed += dt;
        if (elapsed >= SLIDE_MS) go(i + 1);
      }
      bar.style.width = `${Math.min(elapsed / SLIDE_MS, 1) * 100}%`;
      requestAnimationFrame(tick);
    }

    root.querySelector(".res-prev").addEventListener("click", () => go(i - 1));
    root.querySelector(".res-next").addEventListener("click", () => go(i + 1));
    root.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
    });
    let x0 = null;
    root.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    root.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1));
      x0 = null;
    });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }, { threshold: 0.4 }).observe(root);
    } else visible = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) visible = false;  // no auto-advance

    go(0);
    requestAnimationFrame(tick);
  }

  function boot() { document.querySelectorAll("[data-results]").forEach(mount); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
