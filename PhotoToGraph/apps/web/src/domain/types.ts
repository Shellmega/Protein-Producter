/**
 * PTG domain state for spatial interaction and graph editing.
 *
 * Only the graph content + graph identity are "domain" data. Camera, work
 * plane, selection and reference-image placement are editor state and never
 * increment the graph revision.
 */

import type { PlaneKind } from '../spatial/planes';
import type { ReferencePose } from '../spatial/referenceImage';
import type { Vec3 } from '../spatial/math';

export type { Vec3 };

export const MAX_ABS_COORD = 1_000_000;
export const COINCIDENT_EPS = 1e-6;
/** 2^53-1, the frozen maximum graph revision (contract `rules.limits.revision`). */
export const MAX_GRAPH_REVISION = 9_007_199_254_740_991;

export interface CoordinateSystem {
  frame_id: string;
  dimension: 3;
  unit: 'scene_unit';
  handedness: 'right';
  axes: 'xyz';
}

export interface GraphNode {
  id: string;
  position: [number, number, number];
}

export interface GraphContent {
  nodes: GraphNode[];
  /** Normalized unique undirected edge set; sole source for derived adjacency. */
  edges: [string, string][];
  /** Existing stable ID, possibly a draft endpoint that needs repair. */
  n_terminal_node: string | null;
  /** Transport source association; sorted, unique. */
  source_reference_image_ids: string[];
}

export interface GraphIdentity {
  producer_instance_id: string;
  graph_id: string;
  frame_id: string;
  revision: number;
  coordinate_system: CoordinateSystem;
}

export interface GraphDraft {
  identity: GraphIdentity;
  content: GraphContent;
}

export type EditorMode = 'select' | 'create' | 'connect' | 'move';

export type FeedbackLevel = 'info' | 'success' | 'error';

export interface Feedback {
  level: FeedbackLevel;
  source:
    | 'create'
    | 'plane'
    | 'reference'
    | 'select'
    | 'draft'
    | 'camera'
    | 'system'
    | 'persistence'
    | 'export'
    | 'restore';
  code: string;
  message: string;
  at: number;
}

export interface ReferenceImageRecord {
  sourceId: string;
  fileName: string;
  mimeType: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  bitmap: ImageBitmap;
  pose: ReferencePose;
  baseWidth: number;
  /**
   * Original encoded file bytes (EXIF untouched). The persistable side of the
   * reference resource: Three.js objects, ImageBitmap and object URLs are never
   * serialized.
   */
  bytes: Uint8Array;
  /** Decode policy used for `bitmap`: EXIF applied exactly once, on every decode. */
  orientationPolicy: 'from-image';
}

export type ReferenceStatus = 'empty' | 'loading' | 'ready';

export interface EditorSnapshot {
  mode: EditorMode;
  planeKind: PlaneKind;
  planeOffsets: Record<'xy' | 'xz' | 'yz', number>;
  selectedNodeId: string | null;
  referenceStatus: ReferenceStatus;
  referenceError: string | null;
}
