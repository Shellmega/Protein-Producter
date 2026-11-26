/**
 * Mol* scene for the P4-G fixed viewer: mounts the real Mol* engine on our own
 * canvas, loads the skeleton and the control-polygon guide as two separate
 * structures, and reports selection + camera state for evidence.
 *
 * Deliberately narrow: no Mol* UI is created (no React), so the page keeps the
 * existing P4 font/layout conventions and only the 3D canvas is Mol*'s.
 */

import type { PluginContext } from "molstar/lib/mol-plugin/context.js";
import type { Structure } from "molstar/lib/mol-model/structure/structure.js";
import type { Loci } from "molstar/lib/mol-model/structure/structure/element/loci.js";
import type { Vec3 as MolstarVec3 } from "molstar/lib/mol-math/linear-algebra/3d/vec3.js";
import { getMolstar, type MolstarGlobal } from "./molstar.js";
import type { CameraPose, SceneProbe, SelectionInfo, ViewFrame } from "./types.js";
import type { Vec3 } from "../contract/dto.js";

export interface StructureLoadSpec {
  /** PDB text of the skeleton (model frame, Å). */
  structureText: string;
  structureLabel: string;
  /** PDB text of the control polygon in the frame being displayed, or null. */
  guideText: string | null;
  guideLabel: string | null;
  /**
   * Length scale of the numbers being drawn relative to Å (1 in the model frame,
   * 1/s in the source frame). Representation radii are world-space numbers, so
   * they must be scaled with the coordinates or a 10x smaller model would be
   * drawn with 10x oversized atoms.
   */
  unitScale?: number;
}

type RepresentationProps = Parameters<PluginContext["builders"]["structure"]["representation"]["addRepresentation"]>[1];

export async function buildPolymer(plugin: PluginContext, text: string, label: string, unitScale: number, meshOnly = false) {
  const builders = plugin.builders;
  const data = await builders.data.rawData({ data: text, label });
  const trajectory = await builders.structure.parseTrajectory(data, "pdb");
  const model = await builders.structure.createModel(trajectory);
  const structure = await builders.structure.createStructure(model);
  const isGuide = label.startsWith("guide");
  const representation = builders.structure.representation;
  const layers = [];
  // Without WebGL, Mol* can still tessellate these same representations on the CPU.
  const typeParams = meshOnly ? { quality: "low", tryUseImpostor: false } : {};
  const component = await builders.structure.tryCreateComponentStatic(structure, "polymer", { label });
  if (!component) throw new Error(`结构组件为空（${label}）`);
  if (isGuide) {
    layers.push(await representation.addRepresentation(component, { typeParams,
      type: "ball-and-stick",
      color: "sequence-id",
      sizeFactor: 3.2 * unitScale,
    } as unknown as RepresentationProps));
  } else {
    layers.push(await representation.addRepresentation(component, { typeParams, type: "cartoon", color: "sequence-id" } as unknown as RepresentationProps));
    layers.push(await representation.addRepresentation(component, { typeParams,
      type: "ball-and-stick",
      color: "element-symbol",
      sizeFactor: 0.35 * unitScale,
    } as unknown as RepresentationProps));
  }
  const value = structure.data;
  if (!value) throw new Error(`结构数据缺失（${label}）`);
  return { structure: value, layers };
}

export class MolstarScene {
  private structure: Structure | null = null;
  private guide: Structure | null = null;
  private guideVisible = false;
  private poseId = 0;
  private structureCount = 0;
  private selectionListener: ((info: SelectionInfo | null) => void) | null = null;
  private clickSubscription: { unsubscribe(): void } | null = null;
  private clickCount = 0;
  private lastClickLociSize = 0;
  private lastClickAt: [number, number] | null = null;

  private constructor(
    private readonly plugin: PluginContext,
    private readonly molstar: MolstarGlobal,
  ) {}

  static async create(canvas: HTMLCanvasElement, container: HTMLDivElement): Promise<MolstarScene> {
    const molstar = getMolstar();
    const plugin = new molstar.PluginContext(molstar.DefaultPluginSpec());
    // initViewerAsync also rejects its separate readiness promise when WebGL is absent.
    void plugin.canvas3dInitialized.catch(() => {});
    await plugin.init();
    const ready = await plugin.initViewerAsync(canvas, container);
    if (!ready) {
      plugin.dispose();
      throw new Error("Mol* 画布初始化失败（WebGL2 不可用）");
    }
    const scene = new MolstarScene(plugin, molstar);
    scene.subscribeClicks();
    return scene;
  }

  private subscribeClicks(): void {
    const click = this.plugin.behaviors.interaction.click;
    this.clickSubscription = click.subscribe((event) => {
      this.clickCount += 1;
      const raw = (event.current?.loci ?? null) as unknown as Loci | null;
      // The click behavior is a BehaviorSubject: the first emission is its
      // initial (empty) state, which is not an element-loci value.
      const loci = raw && raw.kind === "element-loci" ? raw : null;
      if (loci) this.lastClickLociSize = this.molstar.StructureElement.Loci.size(loci);
      if (event.page) this.lastClickAt = [event.page[0], event.page[1]];
      this.selectionListener?.(this.describeLoci(loci));
    });
  }

  onSelect(listener: (info: SelectionInfo | null) => void): void {
    this.selectionListener = listener;
  }

  private describeLoci(loci: Loci | null): SelectionInfo | null {
    if (!loci) return null;
    const size = this.molstar.StructureElement.Loci.size(loci);
    const location = this.molstar.StructureElement.Loci.getFirstLocation(loci);
    if (!location) {
      return {
        source: "empty",
        atomName: null,
        resName: null,
        chainId: null,
        resSeq: null,
        serial: null,
        position: null,
        scenePosition: null,
        lociSize: size,
      };
    }
    const properties = this.molstar.StructureProperties;
    const molstarPosition = [0, 0, 0] as unknown as MolstarVec3;
    location.unit.conformation.position(location.element, molstarPosition);
    const out: Vec3 = [molstarPosition[0], molstarPosition[1], molstarPosition[2]];
    const inGuide = this.guide !== null && location.structure === this.guide;
    let atomName: string | null = null;
    let resName: string | null = null;
    let chainId: string | null = null;
    let resSeq: number | null = null;
    let serial: number | null = null;
    try {
      atomName = properties.atom.label_atom_id(location);
      resName = properties.residue.label_comp_id(location);
      chainId = properties.chain.auth_asym_id(location);
      resSeq = properties.residue.auth_seq_id(location);
      serial = properties.atom.id(location);
    } catch {
      /* element > atom (coarse): keep the position only */
    }
    return {
      source: inGuide ? "overlay" : "structure",
      atomName,
      resName,
      chainId,
      resSeq,
      serial,
      position: out,
      scenePosition: null,
      lociSize: size,
    };
  }

  /** Remove every structure from the state tree (used before a switch/reload). */
  async clearStructures(): Promise<void> {
    // Mark the scene empty before awaiting teardown so a probe taken right after
    // the call cannot report stale structures.
    this.structure = null;
    this.guide = null;
    this.guideVisible = false;
    this.structureCount = 0;
    await this.plugin.clear();
  }

  async load(spec: StructureLoadSpec): Promise<void> {
    const unitScale = spec.unitScale && spec.unitScale > 0 ? spec.unitScale : 1;
    await this.clearStructures();
    this.structure = (await buildPolymer(this.plugin, spec.structureText, spec.structureLabel, unitScale)).structure;
    this.structureCount = 1;
    if (spec.guideText && spec.guideLabel) {
      this.guide = (await buildPolymer(this.plugin, spec.guideText, spec.guideLabel, unitScale)).structure;
      this.structureCount = 2;
      this.guideVisible = true;
    }
    this.resetCamera();
  }

  /**
   * Show/hide the control-polygon guide without touching its data or the camera.
   * Mol* owns the visibility of the guide structure, so the toggle exercises the
   * real renderer path instead of re-drawing a page-level decoration.
   */
  setGuideVisible(visible: boolean): boolean {
    const hierarchy = this.plugin.managers.structure.hierarchy;
    const refs = hierarchy.current.structures;
    if (refs.length === 0 || !this.guide) return false;
    const ref =
      refs.find((entry) => (entry.cell.obj as { data?: unknown } | undefined)?.data === this.guide) ??
      // Structures are added skeleton-first, guide-second in `load()`; the
      // fallback keeps the toggle working if the data object is wrapped.
      (refs.length >= 2 ? refs[refs.length - 1] : undefined);
    if (!ref) return false;
    hierarchy.toggleVisibility([ref], visible ? "show" : "hide");
    this.guideVisible = visible;
    return true;
  }

  resetCamera(): void {
    this.plugin.managers.camera.reset();
    this.poseId += 1;
  }

  cameraPose(): CameraPose {
    const camera = this.plugin.canvas3d?.camera;
    if (!camera) {
      return { position: [0, 0, 0], target: [0, 0, 0], distance: 0, poseId: this.poseId };
    }
    const snapshot = camera.getSnapshot();
    const position: Vec3 = [snapshot.position[0], snapshot.position[1], snapshot.position[2]];
    const target: Vec3 = [snapshot.target[0], snapshot.target[1], snapshot.target[2]];
    const distance = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
    return { position, target, distance, poseId: this.poseId };
  }

  /**
   * Project a model-frame point to CSS pixels of the canvas, so the browser
   * evidence can click a known atom instead of guessing a pixel.
   */
  projectPoint(position: Vec3): { x: number; y: number; visible: boolean } | null {
    const canvas3d = this.plugin.canvas3d;
    if (!canvas3d) return null;
    const out = [0, 0, 0] as unknown as MolstarVec3;
    const input = [position[0], position[1], position[2]] as unknown as MolstarVec3;
    this.molstar.LinearAlgebra.Vec3.transformMat4(out, input, canvas3d.camera.projectionView);
    const canvas = this.plugin.canvas3dContext?.webgl?.gl?.canvas as HTMLCanvasElement | undefined;
    const width = canvas?.clientWidth ?? 0;
    const height = canvas?.clientHeight ?? 0;
    if (width === 0 || height === 0) return null;
    return {
      x: (out[0] * 0.5 + 0.5) * width,
      y: (1 - (out[1] * 0.5 + 0.5)) * height,
      visible: Math.abs(out[0]) <= 1 && Math.abs(out[1]) <= 1 && out[2] <= 1,
    };
  }

  probe(frame: ViewFrame): SceneProbe {
    const canvas3dContext = this.plugin.canvas3dContext;
    const gl = canvas3dContext?.webgl?.gl;
    const webgl = Boolean(gl);
    let renderer: string | null = null;
    if (gl) {
      try {
        const debugInfo = (gl as WebGL2RenderingContext).getExtension("WEBGL_debug_renderer_info");
        const value = debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.VERSION);
        renderer = typeof value === "string" ? value : null;
      } catch {
        renderer = null;
      }
    }
    const canvas = gl?.canvas as HTMLCanvasElement | undefined;
    return {
      webgl,
      renderer,
      canvas: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
      camera: this.cameraPose(),
      visible: this.structure !== null,
      structures: this.structureCount,
      guideVisible: this.guideVisible,
      frame,
      clicks: this.clickCount,
      lastClickLociSize: this.lastClickLociSize,
      lastClickAt: this.lastClickAt,
    };
  }

  dispose(): void {
    this.clickSubscription?.unsubscribe();
    this.clickSubscription = null;
    this.selectionListener = null;
    this.plugin.dispose();
  }
}
