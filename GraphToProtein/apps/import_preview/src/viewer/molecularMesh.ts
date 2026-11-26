import type { MeshValues } from "molstar/lib/mol-gl/renderable/mesh.js";
import { getMolstar } from "./molstar.js";
import { buildPolymer } from "./scene.js";

/** Meshes and original theme colours from the same Mol* presets as the WebGL scene. */
export interface MolecularSurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: ArrayLike<number>;
  count: number;
}

function surface(v: MeshValues, instance: number): MolecularSurface {
  const n = v.uVertexCount.ref.value;
  const matrix = v.aTransform.ref.value.subarray(instance * 16, (instance + 1) * 16);
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  const coord = v.aPosition.ref.value, normal = v.aNormal.ref.value;
  const palette = v.tColor.ref.value.array, uniform = v.uColor.ref.value;
  const kind = v.dColorType.ref.value, groups = v.aGroup.ref.value;
  for (let i = 0; i < n; i++) {
    const j = i * 3, group = groups[i];
    let colorIndex: number;
    switch (kind) {
      case "uniform": colorIndex = -1; break;
      case "instance": colorIndex = instance; break;
      case "group": colorIndex = group; break;
      case "groupInstance": colorIndex = instance * v.uGroupCount.ref.value + group; break;
      case "vertex": colorIndex = i; break;
      case "vertexInstance": colorIndex = instance * n + i; break;
      default: throw Error("结构颜色格式无法显示");
    }
    for (let k = 0; k < 3; k++) {
      positions[j+k] = matrix[k]*coord[j] + matrix[4+k]*coord[j+1] + matrix[8+k]*coord[j+2] + matrix[12+k];
      normals[j+k] = matrix[k]*normal[j] + matrix[4+k]*normal[j+1] + matrix[8+k]*normal[j+2];
      colors[j+k] = colorIndex < 0 ? uniform[k] * 255 : palette[colorIndex*3+k];
    }
  }
  return {positions, normals, colors, indices: v.elements.ref.value, count: v.drawCount.ref.value};
}

export async function molecularSurfaces(pdb: string): Promise<MolecularSurface[]> {
  const mol = getMolstar();
  const plugin = new mol.PluginContext(mol.DefaultPluginSpec());
  try {
    await plugin.init();
    const { layers } = await buildPolymer(plugin, pdb, "structure", 1, true);
    const result: MolecularSurface[] = [];
    for (const layer of layers) {
      for (const obj of layer?.data?.repr.renderObjects ?? []) {
        if (obj.type !== "mesh") continue;
        const values = obj.values as MeshValues;
        if (!values.drawCount.ref.value) continue;
        for (let i = 0; i < values.instanceCount.ref.value; i++) result.push(surface(values, i));
      }
    }
    if (!result.length) throw Error("这份结构没有可显示的分子表面");
    return result;
  } finally {
    plugin.dispose();
  }
}

export interface Projection {
  yaw: number;
  pitch: number;
  scale: number;
  center: readonly number[];
  width: number;
  height: number;
}

export function cameraTransform(camera: Projection) {
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  return {
    position(x: number, y: number, z: number, dst: Float32Array, j: number) {
      x -= camera.center[0]; y -= camera.center[1]; z -= camera.center[2];
      const depth = z*cy - x*sy;
      dst[j] = camera.width/2 + (x*cy + z*sy)*camera.scale;
      dst[j+1] = camera.height/2 - (y*cp - depth*sp)*camera.scale;
      dst[j+2] = depth*cp + y*sp;
    },
    light(x: number, y: number, z: number) {
      const depth = z*cy - x*sy;
      const diffuse = -0.24*(x*cy + z*sy) + 0.42*(y*cp - depth*sp) + 0.87*(depth*cp + y*sp);
      return 0.48 + 0.52*Math.max(0, diffuse);
    },
  };
}

/** Rasterize with a depth buffer so that the ribbon correctly occludes atoms and bonds. */
export function drawSurfaces(ctx: CanvasRenderingContext2D, meshes: MolecularSurface[], camera: Projection): void {
  const { width, height } = camera;
  if (!width || !height) return;
  const frame = ctx.createImageData(width, height);
  const depth = new Float32Array(width * height).fill(-Infinity);
  const transform = cameraTransform(camera);
  for (const mesh of meshes) {
    const { positions, normals, colors, indices } = mesh;
    const screen = new Float32Array(positions.length), shades = new Float32Array(positions.length / 3);
    for (let j = 0; j < positions.length; j += 3) {
      transform.position(positions[j], positions[j+1], positions[j+2], screen, j);
      shades[j/3] = transform.light(normals[j], normals[j+1], normals[j+2]);
    }
    for (let t = 0; t < mesh.count; t += 3) {
      const a = indices[t]*3, b = indices[t+1]*3, c = indices[t+2]*3;
      const x = screen[a], y = screen[a+1], bx = screen[b]-x, by = screen[b+1]-y;
      const cx = screen[c]-x, cy = screen[c+1]-y;
      const area = bx*cy - by*cx;
      if (Math.abs(area) < 0.001) continue;
      const left = Math.max(0, Math.floor(Math.min(x,x+bx,x+cx))), right = Math.min(width-1, Math.ceil(Math.max(x,x+bx,x+cx)));
      const top = Math.max(0, Math.floor(Math.min(y,y+by,y+cy))), bottom = Math.min(height-1, Math.ceil(Math.max(y,y+by,y+cy)));
      for (let row = top; row <= bottom; row++) {
        for (let col = left; col <= right; col++) {
          const dx = col+0.5-x, dy = row+0.5-y;
          const wb = (dx*cy-dy*cx)/area, wc = (bx*dy-by*dx)/area, wa = 1-wb-wc;
          if (wa < 0 || wb < 0 || wc < 0) continue;
          const z = wa*screen[a+2] + wb*screen[b+2] + wc*screen[c+2];
          const pixel = row*width+col;
          if (z <= depth[pixel]) continue;
          depth[pixel] = z;
          const light = wa*shades[a/3] + wb*shades[b/3] + wc*shades[c/3];
          for (let k=0; k<3; k++) frame.data[pixel*4+k] = (wa*colors[a+k]+wb*colors[b+k]+wc*colors[c+k])*light;
          frame.data[pixel*4+3] = 255;
        }
      }
    }
  }
  ctx.putImageData(frame,0,0);
}
