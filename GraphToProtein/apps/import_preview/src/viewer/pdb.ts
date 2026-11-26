/**
 * Minimal, read-faithful PDB handling for the P4-G fixed viewer (pure: no DOM).
 *
 * Two rules make this trustworthy:
 *   1. The exported PDB is the *original byte string*. Nothing is re-serialised,
 *      so Å coordinates, occupancy, element columns and any remark lines survive
 *      exactly and the export can be compared per atom after an actual reload.
 *   2. The parser reads the fixed columns of the PDB spec, so the numbers shown
 *      in the DOM are the numbers in the file (8.3f decimals), not a re-parse of
 *      a lossy round trip.
 */

import type { Vec3 } from "../contract/dto.js";
import type { ViewerError } from "./types.js";

export interface PdbAtom {
  serial: number;
  record: "ATOM" | "HETATM";
  atomName: string;
  altLoc: string;
  resName: string;
  chainId: string;
  resSeq: number;
  iCode: string;
  x: number;
  y: number;
  z: number;
  element: string;
  line: number;
}

export interface PdbResidueKey {
  chainId: string;
  resSeq: number;
  iCode: string;
}

export interface PdbStructure {
  atoms: PdbAtom[];
  residues: PdbResidueKey[];
  chains: string[];
}

export type PdbResult = { ok: true; structure: PdbStructure } | { ok: false; error: ViewerError };

const ATOM_PREFIXES = ["ATOM  ", "HETATM"];

function error(code: string, field: string | null, message: string, location: string | null): ViewerError {
  return { code, field, message, location };
}

function parseIntField(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}

function parseFloatField(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function parsePdb(text: string, location: string): PdbResult {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: error("PDB_EMPTY", "structure", "结构文件为空（没有任何字节内容）", location) };
  }
  const lines = text.split(/\r?\n/);
  const atoms: PdbAtom[] = [];
  const residueKeys = new Map<string, PdbResidueKey>();
  const chains = new Set<string>();
  const unparsed: number[] = [];
  let sawAtomRecord = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const prefix = ATOM_PREFIXES.find((candidate) => line.startsWith(candidate));
    if (!prefix) continue;
    sawAtomRecord = true;
    if (line.length < 54) {
      unparsed.push(index + 1);
      continue;
    }
    const serial = parseIntField(line.slice(6, 11));
    const x = parseFloatField(line.slice(30, 38));
    const y = parseFloatField(line.slice(38, 46));
    const z = parseFloatField(line.slice(46, 54));
    const resSeq = parseIntField(line.slice(22, 26));
    if (serial === null || x === null || y === null || z === null || resSeq === null) {
      unparsed.push(index + 1);
      continue;
    }
    const chainId = line.slice(21, 22).trim();
    const iCode = line.slice(26, 27).trim();
    const atom: PdbAtom = {
      serial,
      record: prefix === "HETATM" ? "HETATM" : "ATOM",
      atomName: line.slice(12, 16).trim(),
      altLoc: line.slice(16, 17).trim(),
      resName: line.slice(17, 20).trim(),
      chainId,
      resSeq,
      iCode,
      x,
      y,
      z,
      element: line.slice(76, 78).trim(),
      line: index + 1,
    };
    atoms.push(atom);
    chains.add(chainId);
    const key = residueKey(atom);
    if (!residueKeys.has(key)) residueKeys.set(key, { chainId, resSeq, iCode });
  }

  if (atoms.length === 0) {
    if (sawAtomRecord || unparsed.length > 0) {
      return {
        ok: false,
        error: error(
          "PDB_PARSE_FAILED",
          "structure",
          `结构文件没有可解析的原子记录（ATOM/HETATM 行 ${unparsed.length} 行解析失败：行 ${unparsed.slice(0, 5).join(", ")}）`,
          location,
        ),
      };
    }
    return { ok: false, error: error("PDB_EMPTY", "structure", "结构文件没有 ATOM/HETATM 记录（空结构）", location) };
  }
  if (unparsed.length > 0) {
    return {
      ok: false,
      error: error(
        "PDB_PARSE_FAILED",
        "structure",
        `部分 ATOM 记录无法解析（行 ${unparsed.slice(0, 5).join(", ")}${unparsed.length > 5 ? " …" : ""}）`,
        location,
      ),
    };
  }

  return {
    ok: true,
    structure: { atoms, residues: [...residueKeys.values()], chains: [...chains] },
  };
}

export function residueKey(atom: PdbAtom): string {
  return `${atom.chainId}|${atom.resSeq}|${atom.iCode}`;
}

export function atomKey(atom: PdbAtom): string {
  return `${atom.chainId}:${atom.resName}${atom.resSeq}:${atom.atomName}#${atom.serial}`;
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text.slice(text.length - width) : text.padStart(width, " ");
}

function padEnd(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width, " ");
}

function fixed8(value: number): string {
  const text = value.toFixed(3);
  return text.padStart(8, " ");
}

/**
 * Build a small PDB describing the control polygon so Mol* draws the curve as a
 * real 3D object in the same scene as the skeleton. Coordinates are written with
 * the caller's unit (model Å for the overlay in the model frame, scene_unit for
 * the source frame) and the caller must label the frame — this helper never
 * converts anything.
 */
export function buildGuidePdb(points: Array<{ id: string; position: Vec3 }>, label: string): string {
  const lines: string[] = [
    `HEADER    ${padEnd(label.slice(0, 40).toUpperCase(), 40)}`,
    "REMARK   1 P4-G CONTROL POLYGON GUIDE (generated for display only)",
  ];
  points.forEach((point, index) => {
    const serial = index + 1;
    const [x, y, z] = point.position;
    lines.push(
      "ATOM  " +
        padStart(String(serial), 5) +
        " " +
        padEnd("CA", 4) +
        " " +
        padEnd("GLY", 3) +
        " " +
        "A" +
        padStart(String(index + 1), 4) +
        " " +
        "   " +
        fixed8(x) +
        fixed8(y) +
        fixed8(z) +
        "  1.00  0.00          " +
        padEnd("C", 2),
    );
  });
  for (let index = 0; index + 1 < points.length; index += 1) {
    lines.push(`CONECT${padStart(String(index + 1), 5)}${padStart(String(index + 2), 5)}`);
  }
  lines.push("END");
  return lines.join("\n") + "\n";
}

/**
 * Re-emit the same atom identities with new coordinates.
 *
 * Used only for the *display* of the source frame (scene_unit): the skeleton is
 * remapped through the saved inverse transform so both the skeleton and the
 * control polygon can be drawn in one consistent frame. The physical Å export is
 * always the original byte string, never this.
 */
export function retargetPdb(atoms: PdbAtom[], positions: Vec3[], label: string): string {
  const lines: string[] = [
    `HEADER    ${padEnd(label.slice(0, 40).toUpperCase(), 40)}`,
    "REMARK   1 P4-G DISPLAY-ONLY REMAP OF A FIXED HISTORICAL SAMPLE (NOT AN EXPORT)",
  ];
  atoms.forEach((atom, index) => {
    const [x, y, z] = positions[index];
    lines.push(
      (atom.record === "HETATM" ? "HETATM" : "ATOM  ") +
        padStart(String(atom.serial), 5) +
        " " +
        padEnd(atom.atomName, 4) +
        " " +
        padEnd(atom.resName, 3) +
        " " +
        (atom.chainId || " ") +
        padStart(String(atom.resSeq), 4) +
        (atom.iCode || " ") +
        "   " +
        fixed8(x) +
        fixed8(y) +
        fixed8(z) +
        "  1.00  0.00          " +
        padEnd(atom.element || "", 2),
    );
  });
  lines.push("END");
  return lines.join("\n") + "\n";
}

export interface AtomComparison {
  atomCount: number;
  matched: number;
  mismatched: number;
  maxDelta: number;
  tolerance: number;
  ok: boolean;
  failures: Array<{ index: number; expected: string; actual: string; delta: number }>;
}

/**
 * Per-atom comparison of two parsed structures (used by the actual export →
 * reload round trip). Matching is by position in the file order, which is what
 * "same atoms in the same order" means for a byte-identical export.
 */
export function compareAtoms(expected: PdbAtom[], actual: PdbAtom[], tolerance: number): AtomComparison {
  const failures: AtomComparison["failures"] = [];
  let matched = 0;
  let mismatched = 0;
  let maxDelta = 0;
  if (expected.length !== actual.length) {
    mismatched += Math.abs(expected.length - actual.length);
  }
  const count = Math.min(expected.length, actual.length);
  for (let index = 0; index < count; index += 1) {
    const left = expected[index];
    const right = actual[index];
    const delta = Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y), Math.abs(left.z - right.z));
    maxDelta = Math.max(maxDelta, delta);
    const sameIdentity =
      left.serial === right.serial &&
      left.atomName === right.atomName &&
      left.resName === right.resName &&
      left.chainId === right.chainId &&
      left.resSeq === right.resSeq;
    if (sameIdentity && delta <= tolerance) {
      matched += 1;
    } else {
      mismatched += 1;
      if (failures.length < 5) {
        failures.push({ index, expected: atomKey(left), actual: atomKey(right), delta });
      }
    }
  }
  return {
    atomCount: count,
    matched,
    mismatched,
    maxDelta,
    tolerance,
    ok: mismatched === 0 && maxDelta <= tolerance,
    failures,
  };
}
