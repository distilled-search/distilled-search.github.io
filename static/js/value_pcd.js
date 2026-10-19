// Interactive version of the paper's Figure 6: the real table-bussing point cloud with DISCO's grasp pose (magenta)
// and candidate placement poses coloured by their Q-value (viridis, 0 to 1). Drag to rotate, scroll to zoom,
// right-drag to pan. The scene is exported by an offline script into assets/value_pcd/ (scene.json + cloud.bin:
// uint16 positions quantised to the bounding box, then uint8 RGB). three.js loads only when the viewer nears the screen.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const VIRIDIS = ["#440154", "#482172", "#423D84", "#38578C", "#2D6F8E", "#24858D", "#1E9A89", "#2AB07E", "#51C468",
  "#86D449", "#C2DF22", "#FDE724"];
const TUBE = 0.003;  // gripper line thickness (m), as in visualize_plan.py

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

async function mount(root) {
  const base = (root.dataset.base || "./").replace(/\/?$/, "/");
  const [meta, buf] = await Promise.all([
    fetch(base + "scene.json").then((r) => r.json()),
    fetch(base + "cloud.bin").then((r) => r.arrayBuffer()),
  ]);

  // ------------------------------------------------------------- scene
  const n = meta.count, [lo, hi] = meta.bbox;
  const q = new Uint16Array(buf, 0, n * 3), c = new Uint8Array(buf, n * 6, n * 3);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const a = i % 3;
    pos[i] = lo[a] + (q[i] / 65535) * (hi[a] - lo[a]);
    col[i] = c[i] / 255;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const scene = new THREE.Scene();
  const points = new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.0045, vertexColors: true, sizeAttenuation: true }));
  scene.add(points);

  // grippers: one tube per segment, with small spheres at the joints
  const up = new THREE.Vector3(0, 1, 0);
  for (const p of meta.poses) {
    const mat = new THREE.MeshBasicMaterial({ color: p.color });
    for (const [a, b] of p.segments) {
      const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(TUBE, TUBE, d.length(), 10), mat);
      tube.position.copy(A).add(B).multiplyScalar(0.5);
      tube.quaternion.setFromUnitVectors(up, d.normalize());
      scene.add(tube);
      for (const P of [A, B]) {
        const j = new THREE.Mesh(new THREE.SphereGeometry(TUBE, 10, 8), mat);
        j.position.copy(P);
        scene.add(j);
      }
    }
  }

  // ------------------------------------------------------------- view
  const center = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10);
  camera.up.set(0, 0, 1);  // robot frame: z is up
  const home = () => {
    camera.position.copy(center).add(new THREE.Vector3(0.62, -0.32, 0.95));  // from the front of the table, as in Fig. 6
    controls.target.copy(center);
    controls.update();
  };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const canvasWrap = root.querySelector(".vp-canvas");
  canvasWrap.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.15;
  controls.maxDistance = 2.2;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  home();
  const stopSpin = () => { controls.autoRotate = false; };
  renderer.domElement.addEventListener("pointerdown", stopSpin);
  renderer.domElement.addEventListener("wheel", stopSpin, { passive: true });
  root.querySelector(".vp-reset").addEventListener("click", () => { home(); controls.autoRotate = true; });

  const resize = () => {
    const w = canvasWrap.clientWidth, h = canvasWrap.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // nudge the picture right so the scene photo on the left does not cover it (rotation centre is unchanged)
    if (w > 600) camera.setViewOffset(w, h, -w * 0.09, 0, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvasWrap);
  resize();

  // render only while on screen
  let visible = true, raf = 0;
  const loop = () => { controls.update(); renderer.render(scene, camera); raf = visible ? requestAnimationFrame(loop) : 0; };
  new IntersectionObserver((es) => {
    visible = es.some((e) => e.isIntersecting);
    if (visible && !raf) raf = requestAnimationFrame(loop);
  }).observe(root);
  root.classList.add("is-ready");
  loop();
}

function build(root) {
  const base = (root.dataset.base || "./").replace(/\/?$/, "/");
  const bar = `linear-gradient(to top, ${VIRIDIS.join(", ")})`;
  root.append(
    el("div", "vp-canvas"),
    el("figure", "vp-photo", `<img src="${base}scene.webp" alt="The real table-bussing scene: the robot places the orange cup in the tray, next to plates and bowls"><figcaption>The real scene</figcaption>`),
    el("div", "vp-loading", "Loading point cloud…"),
    el("div", "vp-legend",
      `<div class="vp-grasp"><span class="vp-dot"></span>Grasp pose</div>
       <div class="vp-scale"><span class="vp-scale-title">Placement pose<br>Q-value</span>
         <span class="vp-bar" style="background:${bar}"></span>
         <span class="vp-ticks"><span>1</span><span>0</span></span></div>`),
    el("div", "vp-help", "Drag to rotate · scroll to zoom · right-drag to pan"),
    el("button", "vp-reset", "↺ Reset view"),
  );
  root.querySelector(".vp-reset").type = "button";
}

for (const root of document.querySelectorAll("[data-value-pcd]")) {
  build(root);
  // load three.js scene data only when the viewer comes near the screen
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    mount(root).catch((err) => { root.querySelector(".vp-loading").textContent = "Could not load the point cloud."; console.error(err); });
  }, { rootMargin: "300px" });
  io.observe(root);
}
