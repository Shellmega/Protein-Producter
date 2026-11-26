import type { Vec3 } from "../contract/dto.js";
import type { PdbAtom } from "./pdb.js";
import { cameraTransform, drawSurfaces, molecularSurfaces, type MolecularSurface } from "./molecularMesh.js";
import { revealBackbone } from "./backboneReveal.js";

export class BackbonePreview {
  readonly element = document.createElement("div");
  readonly drawing = document.createElement("canvas");
  private readonly message = document.createElement("span");
  private meshes: MolecularSurface[] = [];
  private stopReveal?: () => void;
  private guide: Vec3[] = [];
  private original: readonly PdbAtom[] | null = null;
  private center: Vec3 = [0, 0, 0];
  private scale = 1;
  private yaw = 0;
  private pitch = 0;
  private zoom = 1;
  private dragging: { id: number; x: number; y: number } | null = null;
  guideVisible = false;

  constructor() {
    this.element.className = "backbone-preview";
    this.element.hidden = true;
    this.drawing.tabIndex = 0;
    this.drawing.setAttribute("role", "img");
    this.drawing.setAttribute("aria-label", "彩色蛋白质丝带与原子球棍，方向键旋转，加减键缩放，0 复位");
    this.message.setAttribute("role", "status");
    new ResizeObserver(() => this.paint()).observe(this.drawing);
    const tools = document.createElement("div");
    tools.className = "preview-controls";
    for (const [label, name, action] of [
      ["−", "缩小骨架", () => this.magnify(0.8)],
      ["+", "放大骨架", () => this.magnify(1.25)],
      ["复位", "恢复初始视角", () => this.reset()],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", name);
      button.onclick = action;
      tools.append(button);
    }
    this.element.append(this.drawing, this.message, tools);
    this.drawing.onpointerdown = e => {
      if (!e.isPrimary || e.button !== 0) return;
      this.drawing.focus({ preventScroll: true });
      this.drawing.setPointerCapture(e.pointerId);
      this.dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    this.drawing.onpointermove = e => {
      const d = this.dragging;
      if (!d || d.id !== e.pointerId) return;
      this.yaw += (e.clientX - d.x) * 0.012;
      this.pitch += (e.clientY - d.y) * 0.012;
      d.x = e.clientX; d.y = e.clientY;
      this.paint();
    };
    this.drawing.onlostpointercapture = this.drawing.onpointercancel = this.drawing.onpointerup = () => { this.dragging = null; };
    this.drawing.addEventListener("wheel", e => {
      if (!e.deltaY) return;
      e.preventDefault();
      this.magnify(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    this.drawing.onkeydown = e => {
      switch (e.key) {
        case "ArrowRight": this.yaw += 0.16; break;
        case "ArrowLeft": this.yaw -= 0.16; break;
        case "ArrowUp": this.pitch -= 0.16; break;
        case "ArrowDown": this.pitch += 0.16; break;
        case "+": case "=": e.preventDefault(); this.magnify(1.25); return;
        case "-": e.preventDefault(); this.magnify(0.8); return;
        case "0": e.preventDefault(); this.reset(); return;
        default: return;
      }
      e.preventDefault();
      this.paint();
    };
  }

  show(atoms: readonly PdbAtom[], guide: Vec3[], pdb: string): void {
    this.element.hidden = false;
    if (this.original === atoms) return;
    this.stopReveal?.();
    this.original = atoms;
    this.meshes = [];
    this.guide = guide;
    this.guideVisible = false;
    this.fit();
    this.reset();
    this.element.dataset.mesh = "loading";
    this.message.textContent = "正在绘制彩色结构…";
    void molecularSurfaces(pdb).then(meshes => {
      if (this.original !== atoms) return;
      this.meshes = meshes;
      this.message.textContent = "";
      this.element.dataset.mesh = "ready";
      this.paint();
      this.stopReveal = revealBackbone(this, this.element, atoms);
    }).catch(() => {
      if (this.original !== atoms) return;
      this.message.textContent = "彩色结构预览未能载入，仍可下载结构文件。";
      this.element.dataset.mesh = "error";
    });
  }

  clear(): void {
    if (!this.original) return;
    this.stopReveal?.();
    this.original = null;
    this.meshes = []; this.guide = [];
    this.guideVisible = false;
    this.dragging = null;
    this.drawing.width = 0;
    this.element.hidden = true;
    delete this.element.dataset.mesh;
  }

  toggleGuide(): void {
    this.guideVisible = !this.guideVisible;
    this.fit();
    this.paint();
  }

  private fit(): void {
    const points: Vec3[] = (this.original ?? []).map(a => [a.x, a.y, a.z]);
    if (this.guideVisible) points.push(...this.guide);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]);
    }
    this.center = [(lo[0]+hi[0])/2, (lo[1]+hi[1])/2, (lo[2]+hi[2])/2];
    let radius = 1;
    for (const p of points) radius = Math.max(radius, Math.hypot(p[0]-this.center[0], p[1]-this.center[1], p[2]-this.center[2]));
    this.scale = 0.46 / radius;
  }

  private reset(): void {
    this.yaw = 0; this.pitch = 0; this.zoom = 1; this.paint();
  }

  private magnify(factor: number): void {
    this.zoom = Math.max(0.35, Math.min(4, this.zoom * factor)); this.paint();
  }

  private camera(width: number, height: number) {
    return { width, height, center: this.center, yaw: this.yaw, pitch: this.pitch,
      scale: this.scale * this.zoom * Math.min(width, height) };
  }

  projectPoint(p: Vec3) {
    const w = this.drawing.clientWidth, h = this.drawing.clientHeight;
    const out = new Float32Array(3);
    cameraTransform(this.camera(w, h)).position(...p, out, 0);
    return {x: out[0], y: out[1], visible: w > 0 && h > 0};
  }

  private paint(): void {
    if (this.element.hidden) return;
    const w = this.drawing.clientWidth, h = this.drawing.clientHeight;
    if (!w || !h) return;
    // Supersample thin bonds at ordinary display density, bounded on large screens.
    const ratio = Math.min(Math.max(1.5, window.devicePixelRatio || 1), 2, 1800/w, 1000/h);
    const width = Math.max(1, Math.round(w*ratio)), height = Math.max(1, Math.round(h*ratio));
    if (this.drawing.width !== width) this.drawing.width = width;
    if (this.drawing.height !== height) this.drawing.height = height;
    const ctx = this.drawing.getContext("2d");
    if (!ctx) return;
    if (!this.meshes.length) { ctx.clearRect(0, 0, width, height); return; }
    const camera = this.camera(width, height);
    drawSurfaces(ctx, this.meshes, camera);
    if (this.guideVisible && this.guide.length) {
      const transform = cameraTransform(camera), out = new Float32Array(3);
      ctx.beginPath();
      this.guide.forEach((p, i) => {
        transform.position(...p, out, 0);
        if (i === 0) ctx.moveTo(out[0],out[1]); else ctx.lineTo(out[0],out[1]);
      });
      ctx.strokeStyle = "#a6491b"; ctx.lineWidth = 2*ratio;
      ctx.setLineDash([5*ratio,3*ratio]); ctx.stroke();
    }
  }
}
