"""Backbone coordinate metrics used by the local drawing studio."""

from __future__ import annotations

import hashlib

import json

import math

import sys

import time

from pathlib import Path

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

Vec3 = Tuple[float, float, float]

BACKBONE_ATOMS = ("N", "CA", "C", "O")

CA_SPACING_MIN_ANGSTROM = 3.0

CA_SPACING_MAX_ANGSTROM = 4.5

BOND_MAX_ANGSTROM: Dict[str, float] = {
    "N-CA": 1.9,
    "CA-C": 1.9,
    "C-O": 1.9,
}

PEPTIDE_BOND_MAX_ANGSTROM = 1.8

CA_COLLISION_ANGSTROM = 4.0

CA_COLLISION_MIN_SEQUENCE_SEPARATION = 4

ATOM_CLASH_ANGSTROM = 3.0

ATOM_CLASH_MIN_SEQUENCE_SEPARATION = 2

class Residue:
    """One PDB residue with its parsed backbone atom coordinates (Angstrom)."""

    __slots__ = ("chain", "resseq", "icode", "atoms")

    def __init__(self, chain: str, resseq: int, icode: str) -> None:
        self.chain = chain
        self.resseq = resseq
        self.icode = icode
        self.atoms: Dict[str, Vec3] = {}

    @property
    def key(self) -> Tuple[str, int, str]:
        return (self.chain, self.resseq, self.icode)

    def has_backbone(self) -> bool:
        return all(atom in self.atoms for atom in BACKBONE_ATOMS)

    def missing_backbone_atoms(self) -> List[str]:
        return [atom for atom in BACKBONE_ATOMS if atom not in self.atoms]

def _parse_atom_lines(lines: Iterable[str]) -> List[Residue]:
    residues: List[Residue] = []
    index: Dict[Tuple[str, int, str], Residue] = {}
    for line in lines:
        if not line.startswith(("ATOM", "HETATM")):
            continue
        atom_name = line[12:16].strip()
        altloc = line[16:17].strip()
        if altloc and altloc != "A":
            continue
        chain = line[21:22].strip() or "_"
        try:
            resseq = int(line[22:26])
        except ValueError:
            continue
        icode = line[26:27].strip()
        try:
            xyz = (float(line[30:38]), float(line[38:46]), float(line[46:54]))
        except ValueError:
            continue
        key = (chain, resseq, icode)
        residue = index.get(key)
        if residue is None:
            residue = Residue(chain, resseq, icode)
            index[key] = residue
            residues.append(residue)
        residue.atoms[atom_name] = xyz
    return residues

def parse_pdb_frames(path: Path | str) -> List[List[Residue]]:
    """Split a PDB (possibly multi-frame) into one residue list per frame.

    RFdiffusion's ``writepdb_multi`` emits only ``ENDMDL`` between frames and
    reuses chain A / residues 1..L, so ``ENDMDL`` alone is a valid boundary
    (same convention as ``experiments/p2/trajectory_diag.py``).
    """
    path = Path(path)
    frames: List[List[str]] = []
    current: List[str] = []
    saw_boundary = False
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.startswith("MODEL"):
                saw_boundary = True
                current = []
                continue
            if line.startswith("ENDMDL"):
                saw_boundary = True
                frames.append(current)
                current = []
                continue
            if line.startswith(("ATOM", "HETATM", "TER")):
                current.append(line)
    if current and any(ln.startswith(("ATOM", "HETATM")) for ln in current):
        frames.append(current)
    if not saw_boundary:
        frames = [current]
    return [_parse_atom_lines(chunk) for chunk in frames if chunk]

def parse_pdb(path: Path | str) -> List[Residue]:
    """Parse the first model of a PDB into residues (file order)."""
    frames = parse_pdb_frames(path)
    return frames[0] if frames else []

def ca_trace(residues: Sequence[Residue]) -> List[Vec3]:
    """CA coordinates in file order (residues without CA are skipped)."""
    return [residue.atoms["CA"] for residue in residues if "CA" in residue.atoms]

def ca_residue_indices(residues: Sequence[Residue]) -> List[int]:
    """Indices (into ``residues``) of the entries that carry a CA atom."""
    return [index for index, residue in enumerate(residues) if "CA" in residue.atoms]

def _sub(a: Sequence[float], b: Sequence[float]) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])

def _norm(a: Sequence[float]) -> float:
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])

def _dist(a: Sequence[float], b: Sequence[float]) -> float:
    return _norm(_sub(a, b))

def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0

def _centroid(points: Sequence[Sequence[float]]) -> Vec3:
    n = len(points)
    return (
        sum(point[0] for point in points) / n,
        sum(point[1] for point in points) / n,
        sum(point[2] for point in points) / n,
    )

def _matmul3(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> List[List[float]]:
    return [[sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)] for r in range(3)]

def _transpose3(a: Sequence[Sequence[float]]) -> List[List[float]]:
    return [[a[c][r] for c in range(3)] for r in range(3)]

def _det3(a: Sequence[Sequence[float]]) -> float:
    return (
        a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
        - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
    )

def _orthogonality_residual(rotation: Sequence[Sequence[float]]) -> float:
    """``max |R^T R - I|`` for a 3x3 matrix."""
    rt = _transpose3(rotation)
    product = _matmul3(rt, rotation)
    worst = 0.0
    for r in range(3):
        for c in range(3):
            target = 1.0 if r == c else 0.0
            worst = max(worst, abs(product[r][c] - target))
    return worst

def _jacobi_eigen(matrix: List[List[float]], sweeps: int = 60):
    """Eigen-decomposition of a small symmetric matrix by cyclic Jacobi rotations.

    Reused from experiments/p2/metrics.py @654028b, P2 D-1 fix: the P2 review
    verified this implementation against numpy SVD to 8.9e-16.
    """
    size = len(matrix)
    a = [row[:] for row in matrix]
    v = [[1.0 if i == j else 0.0 for j in range(size)] for i in range(size)]
    for _ in range(sweeps):
        off = 0.0
        for i in range(size):
            for j in range(i + 1, size):
                off += a[i][j] * a[i][j]
        if off < 1e-30:
            break
        for p in range(size):
            for q in range(p + 1, size):
                if abs(a[p][q]) < 1e-18:
                    continue
                theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q])
                t = (1.0 if theta >= 0 else -1.0) / (
                    abs(theta) + math.sqrt(theta * theta + 1.0)
                )
                c = 1.0 / math.sqrt(t * t + 1.0)
                s = t * c
                for r in range(size):
                    arp, arq = a[r][p], a[r][q]
                    a[r][p] = c * arp - s * arq
                    a[r][q] = s * arp + c * arq
                for r in range(size):
                    arp, arq = a[p][r], a[q][r]
                    a[p][r] = c * arp - s * arq
                    a[q][r] = s * arp + c * arq
                for r in range(size):
                    vrp, vrq = v[r][p], v[r][q]
                    v[r][p] = c * vrp - s * vrq
                    v[r][q] = s * vrp + c * vrq
    return [a[i][i] for i in range(size)], v

def _kabsch_transform(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]):
    """Optimal *rigid* transform taking ``a`` onto ``b`` (Horn quaternion, Jacobi).

    Returns ``(rotation, translation, rmsd)`` with ``b_hat = rotation @ a + translation``.
    Reused from experiments/p2/metrics.py @654028b, P2 D-1 fix.  The quaternion
    eigenvector is always a unit quaternion, so the returned rotation is a proper
    rotation (``det(R) = +1``) even for reflected input — this is what DESIGN §6
    requires, and it is asserted by ``tests/p3/test_metrics.py``.
    """
    n = min(len(a), len(b))
    if n < 3:
        return None, None, float("nan")
    a = [tuple(float(v) for v in point) for point in a[:n]]
    b = [tuple(float(v) for v in point) for point in b[:n]]
    ca, cb = _centroid(a), _centroid(b)
    ac = [_sub(point, ca) for point in a]
    bc = [_sub(point, cb) for point in b]

    sxx = sxy = sxz = syx = syy = syz = szx = szy = szz = 0.0
    for pa, pb in zip(ac, bc):
        sxx += pa[0] * pb[0]
        sxy += pa[0] * pb[1]
        sxz += pa[0] * pb[2]
        syx += pa[1] * pb[0]
        syy += pa[1] * pb[1]
        syz += pa[1] * pb[2]
        szx += pa[2] * pb[0]
        szy += pa[2] * pb[1]
        szz += pa[2] * pb[2]
    k = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ]
    values, vectors = _jacobi_eigen(k)
    best = max(range(4), key=lambda i: values[i])
    w, x, y, z = (vectors[r][best] for r in range(4))
    rot = [
        [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
    ]
    rot_ca = (
        sum(rot[0][i] * ca[i] for i in range(3)),
        sum(rot[1][i] * ca[i] for i in range(3)),
        sum(rot[2][i] * ca[i] for i in range(3)),
    )
    trans = (cb[0] - rot_ca[0], cb[1] - rot_ca[1], cb[2] - rot_ca[2])
    total = 0.0
    for pa, pb in zip(ac, bc):
        rotated = (
            sum(rot[0][i] * pa[i] for i in range(3)),
            sum(rot[1][i] * pa[i] for i in range(3)),
            sum(rot[2][i] * pa[i] for i in range(3)),
        )
        total += _dist(rotated, pb) ** 2
    return rot, trans, math.sqrt(total / n)

def _rotation_angle_deg(rotation: Sequence[Sequence[float]]) -> float:
    trace = rotation[0][0] + rotation[1][1] + rotation[2][2]
    cos_theta = max(-1.0, min(1.0, (trace - 1.0) / 2.0))
    return math.degrees(math.acos(cos_theta))

def kabsch_rigid(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> Dict[str, Any]:
    """Rigid Kabsch fit mapping ``a`` onto ``b``; JSON-ready record."""
    rotation, translation, rmsd = _kabsch_transform(a, b)
    if rotation is None:
        return {
            "status": "NOT_AVAILABLE",
            "reason": "need at least 3 points",
            "n_points": min(len(a), len(b)),
        }
    return {
        "status": "OK",
        "n_points": min(len(a), len(b)),
        "rmsd_angstrom": rmsd,
        "rotation": [list(row) for row in rotation],
        "translation_angstrom": list(translation),
        "rotation_angle_deg": _rotation_angle_deg(rotation),
        "translation_norm_angstrom": _norm(translation),
        "det_rotation": _det3(rotation),
        "orthogonality_residual": _orthogonality_residual(rotation),
    }

def _bond_summary(distance: Sequence[float], threshold: float,
                  indices: Sequence[int]) -> Dict[str, Any]:
    violations = [indices[i] for i, value in enumerate(distance) if value > threshold]
    return {
        "threshold_angstrom": threshold,
        "n_pairs": len(distance),
        "max_angstrom": max(distance) if distance else None,
        "violation_count": len(violations),
        "violation_residue_indices0": violations,
    }

def geometry_metrics(residues: Sequence[Residue], target_length: Optional[int] = None) -> Dict[str, Any]:
    """All geometry-quality numbers for one candidate (DESIGN §6)."""
    trace = ca_trace(residues)
    ca_indices = ca_residue_indices(residues)
    n = len(trace)
    finite_atoms = 0
    nonfinite_atoms = 0
    for residue in residues:
        for xyz in residue.atoms.values():
            if all(math.isfinite(value) for value in xyz):
                finite_atoms += 1
            else:
                nonfinite_atoms += 1
    missing = [
        {"residue_index0": index, "missing_atoms": residue.missing_backbone_atoms()}
        for index, residue in enumerate(residues)
        if not residue.has_backbone()
    ]
    spacing = [_dist(trace[i], trace[i + 1]) for i in range(n - 1)]
    spacing_outliers = [
        {"ca_index": i, "residue_index0": ca_indices[i], "distance_angstrom": spacing[i]}
        for i in range(len(spacing))
        if spacing[i] < CA_SPACING_MIN_ANGSTROM or spacing[i] > CA_SPACING_MAX_ANGSTROM
    ]

    # -- main-chain bond lengths -------------------------------------------------
    bond_values: Dict[str, List[float]] = {label: [] for label in BOND_MAX_ANGSTROM}
    bond_indices: Dict[str, List[int]] = {label: [] for label in BOND_MAX_ANGSTROM}
    for index, residue in enumerate(residues):
        atoms = residue.atoms
        if "N" in atoms and "CA" in atoms:
            bond_values["N-CA"].append(_dist(atoms["N"], atoms["CA"]))
            bond_indices["N-CA"].append(index)
        if "CA" in atoms and "C" in atoms:
            bond_values["CA-C"].append(_dist(atoms["CA"], atoms["C"]))
            bond_indices["CA-C"].append(index)
        if "C" in atoms and "O" in atoms:
            bond_values["C-O"].append(_dist(atoms["C"], atoms["O"]))
            bond_indices["C-O"].append(index)
    peptide_values: List[float] = []
    peptide_indices: List[int] = []
    missing_sequentials = 0
    for index in range(len(residues) - 1):
        current, following = residues[index], residues[index + 1]
        sequential = (
            current.chain == following.chain
            and following.icode == ""
            and following.resseq == current.resseq + 1
        )
        if not sequential:
            missing_sequentials += 1
            continue
        if "C" in current.atoms and "N" in following.atoms:
            peptide_values.append(_dist(current.atoms["C"], following.atoms["N"]))
            peptide_indices.append(index)
    bond_report = {
        label: _bond_summary(bond_values[label], threshold, bond_indices[label])
        for label, threshold in BOND_MAX_ANGSTROM.items()
    }
    bond_report["C(i)-N(i+1)"] = _bond_summary(
        peptide_values, PEPTIDE_BOND_MAX_ANGSTROM, peptide_indices
    )
    bond_report["n_missing_sequential_pairs"] = missing_sequentials
    bond_report["n_violations_total"] = sum(
        bond_report[label]["violation_count"]
        for label in ("N-CA", "CA-C", "C-O", "C(i)-N(i+1)")
    )

    # -- non-local CA collisions -------------------------------------------------
    ca_collision_pairs: List[List[float]] = []
    for i in range(n):
        for k in range(i + CA_COLLISION_MIN_SEQUENCE_SEPARATION, n):
            distance = _dist(trace[i], trace[k])
            if distance < CA_COLLISION_ANGSTROM:
                ca_collision_pairs.append([ca_indices[i], ca_indices[k], distance])

    # -- non-local backbone atom clashes ----------------------------------------
    atom_clash_count = 0
    atom_clash_pairs: List[Dict[str, Any]] = []
    for i in range(len(residues)):
        atoms_i = residues[i].atoms
        for k in range(i + ATOM_CLASH_MIN_SEQUENCE_SEPARATION, len(residues)):
            atoms_k = residues[k].atoms
            for atom_i in BACKBONE_ATOMS:
                if atom_i not in atoms_i:
                    continue
                for atom_k in BACKBONE_ATOMS:
                    if atom_k not in atoms_k:
                        continue
                    distance = _dist(atoms_i[atom_i], atoms_k[atom_k])
                    if distance < ATOM_CLASH_ANGSTROM:
                        atom_clash_count += 1
                        if len(atom_clash_pairs) < 200:
                            atom_clash_pairs.append(
                                {
                                    "residue_index0_a": i,
                                    "atom_a": atom_i,
                                    "residue_index0_b": k,
                                    "atom_b": atom_k,
                                    "distance_angstrom": distance,
                                }
                            )

    if n:
        centre = _centroid(trace)
        radius_of_gyration = math.sqrt(_mean([_dist(point, centre) ** 2 for point in trace]))
        end_to_end = _dist(trace[0], trace[-1])
        extent = [
            max(point[0] for point in trace) - min(point[0] for point in trace),
            max(point[1] for point in trace) - min(point[1] for point in trace),
            max(point[2] for point in trace) - min(point[2] for point in trace),
        ]
    else:
        radius_of_gyration = None
        end_to_end = None
        extent = [None, None, None]

    return {
        "n_residues": n,
        "target_length": target_length,
        "n_chains": len({residue.chain for residue in residues}),
        "chain_ids": sorted({residue.chain for residue in residues}),
        "coordinates_finite": nonfinite_atoms == 0,
        "n_finite_atoms": finite_atoms,
        "n_nonfinite_atoms": nonfinite_atoms,
        "backbone_complete": len(missing) == 0 and len(residues) > 0,
        "n_backbone_complete_residues": len(residues) - len(missing),
        "missing_backbone": missing,
        "ca_ca_spacing": {
            "mean_angstrom": _mean(spacing),
            "std_angstrom": (
                math.sqrt(_mean([(value - _mean(spacing)) ** 2 for value in spacing]))
                if spacing
                else None
            ),
            "min_angstrom": min(spacing) if spacing else None,
            "max_angstrom": max(spacing) if spacing else None,
            "outlier_count": len(spacing_outliers),
            "outliers": spacing_outliers[:60],
            "min_bound_angstrom": CA_SPACING_MIN_ANGSTROM,
            "max_bound_angstrom": CA_SPACING_MAX_ANGSTROM,
        },
        "bonds": bond_report,
        "ca_nonlocal_collisions": {
            "count": len(ca_collision_pairs),
            "threshold_angstrom": CA_COLLISION_ANGSTROM,
            "min_sequence_separation": CA_COLLISION_MIN_SEQUENCE_SEPARATION,
            "pairs": ca_collision_pairs[:200],
        },
        "atom_nonlocal_clashes": {
            "count": atom_clash_count,
            "threshold_angstrom": ATOM_CLASH_ANGSTROM,
            "min_sequence_separation": ATOM_CLASH_MIN_SEQUENCE_SEPARATION,
            "atom_names": list(BACKBONE_ATOMS),
            "pairs_sample": atom_clash_pairs,
            "pairs_truncated": atom_clash_count > len(atom_clash_pairs),
        },
        "radius_of_gyration_angstrom": radius_of_gyration,
        "end_to_end_distance_angstrom": end_to_end,
        "bbox_extent_xyz_angstrom": extent,
        "z_extent_angstrom": extent[2],
    }

def _gate(gate_id: str, status: str, observed: Any, requirement: str, note: str = "") -> Dict[str, Any]:
    return {
        "id": gate_id,
        "status": status,
        "observed": observed,
        "requirement": requirement,
        "note": note,
    }

def geometry_gates(
    report_or_residues: Any, target_length: Optional[int] = None
) -> List[Dict[str, Any]]:
    """PASS/FAIL gates over :func:`geometry_metrics` (DESIGN §6)."""
    report = (
        report_or_residues
        if isinstance(report_or_residues, dict)
        else geometry_metrics(report_or_residues, target_length)
    )
    if target_length is None:
        target_length = report.get("target_length")
    gates: List[Dict[str, Any]] = []
    if target_length is not None:
        gates.append(
            _gate(
                "residue_count",
                "PASS" if report["n_residues"] == target_length else "FAIL",
                report["n_residues"],
                "n_residues == target_length (%d)" % target_length,
                "written design must contain exactly the conditioned chain length",
            )
        )
    gates.append(
        _gate(
            "coordinates_finite",
            "PASS" if report["coordinates_finite"] else "FAIL",
            {"n_nonfinite_atoms": report["n_nonfinite_atoms"]},
            "all parsed coordinates finite",
        )
    )
    gates.append(
        _gate(
            "backbone_complete",
            "PASS" if report["backbone_complete"] else "FAIL",
            {
                "n_backbone_complete_residues": report["n_backbone_complete_residues"],
                "missing": report["missing_backbone"][:10],
            },
            "every residue has N, CA, C, O",
        )
    )
    spacing = report["ca_ca_spacing"]
    gates.append(
        _gate(
            "ca_ca_spacing",
            "PASS" if spacing["outlier_count"] == 0 else "FAIL",
            {
                "outlier_count": spacing["outlier_count"],
                "outliers": spacing["outliers"][:20],
                "mean_angstrom": spacing["mean_angstrom"],
            },
            "3.0 A <= CA(i)-CA(i+1) <= 4.5 A for every step",
            "band inherited from P2 report §10.4 / review R2-08",
        )
    )
    gates.append(
        _gate(
            "main_chain_bonds",
            "PASS" if report["bonds"]["n_violations_total"] == 0 else "FAIL",
            {
                "n_violations_total": report["bonds"]["n_violations_total"],
                "peptide_C_N_max_angstrom": report["bonds"]["C(i)-N(i+1)"]["max_angstrom"],
                "n_missing_sequential_pairs": report["bonds"]["n_missing_sequential_pairs"],
            },
            "peptide C(i)-N(i+1) <= 1.8 A; N-CA, CA-C, C=O <= 1.9 A",
            "ideal peptide geometry + 0.4 A tolerance",
        )
    )
    gates.append(
        _gate(
            "ca_nonlocal_collisions",
            "PASS" if report["ca_nonlocal_collisions"]["count"] == 0 else "FAIL",
            {
                "count": report["ca_nonlocal_collisions"]["count"],
                "pairs": report["ca_nonlocal_collisions"]["pairs"][:10],
            },
            "no CA-CA pair with |i-k| >= 4 closer than 4.0 A",
            "4.0 A is the severe-clash floor fixed in DESIGN §6",
        )
    )
    return gates
