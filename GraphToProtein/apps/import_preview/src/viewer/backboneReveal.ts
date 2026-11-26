import type { PdbAtom } from "./pdb.js";
import type { Vec3 } from "../contract/dto.js";

// A brush uncovers the verified structure in residue order. The camera stays interactive.
export function revealBackbone(
  scene: { projectPoint(point: Vec3): {x: number; y: number; visible: boolean} | null },
  host: HTMLElement, atoms: readonly PdbAtom[],
): () => void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const trace = atoms.filter(a => a.atomName === 'CA');
  if (trace.length < 2) return () => {};

  const veil = document.createElement('canvas');
  veil.className = 'backbone-reveal';
  veil.setAttribute('aria-hidden', 'true');
  host.append(veil);
  const ctx = veil.getContext('2d');
  if (!ctx) { veil.remove(); return () => {}; }
  const brush = ctx;
  const start = performance.now();
  let frame = 0;
  const timeout = window.setTimeout(finish, 920);
  function finish() {
    cancelAnimationFrame(frame);
    window.clearTimeout(timeout);
    veil.remove();
    host.removeEventListener('pointerdown', finish);
  }
  function paint(now: number) {
    const elapsed = now - start;
    if (elapsed > 920) { finish(); return; }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = host.clientWidth, h = host.clientHeight;
    veil.width = Math.round(w * ratio); veil.height = Math.round(h * ratio);
    brush.scale(ratio, ratio);
    brush.fillStyle = '#fcfcf9';
    brush.fillRect(0, 0, w, h);
    brush.globalCompositeOperation = 'destination-out';
    const count = Math.min(trace.length, 1 + Math.floor(trace.length * elapsed / 660));
    let tip;
    for (const atom of trace.slice(0, count)) {
      const point = scene.projectPoint([atom.x, atom.y, atom.z]);
      if (!point?.visible) continue;
      tip = point;
      brush.beginPath(); brush.arc(point.x, point.y, Math.max(13, h / 18), 0, Math.PI * 2); brush.fill();
    }
    if (tip && count < trace.length) {
      brush.globalCompositeOperation = 'source-over';
      brush.strokeStyle = '#488176'; brush.lineWidth = 2;
      brush.beginPath(); brush.arc(tip.x, tip.y, 7, 0, Math.PI * 2); brush.stroke();
    }
    veil.style.opacity = String(Math.min(1, (920 - elapsed) / 260));
    frame = requestAnimationFrame(paint);
  }
  host.addEventListener('pointerdown', finish, { once: true });
  paint(start);
  return finish;
}
