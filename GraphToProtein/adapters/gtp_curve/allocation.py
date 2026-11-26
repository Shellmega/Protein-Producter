"""Residue allocation for ordered control points.

A control point must land on a residue of the designed chain.  The mapping is
driven by the **cumulative arc length** of the ordered polyline, not by the
number of control points or by file order:

    t_k   = (sum of the first k segment lengths) / (total path length)
    i_k   = round_half_up(t_k * (N - 1))            # 0-based residue index

so ``t_0 = 0`` pins the N-terminal control point to residue index 0 and
``t_{K-1} = 1`` pins the C-terminal one to ``N - 1``.  Consequence: with equal
segment lengths the anchors are evenly spaced, and a segment that is twice as
long receives twice as many residues - which is what "arc length maps onto the
designed chain" means.  Because ``s`` is chosen to match contour to arc length
(see :mod:`adapters.gtp_curve.transform`), consecutive anchors are then about
``3.8 A * (i_{k+1} - i_k)`` apart, i.e. exactly the CA contour budget of the
residues between them.
"""

from __future__ import annotations

import math

from . import geometry
from .errors import TransformError


def round_half_up(value: float) -> int:
    """Deterministic half-up rounding (never banker's rounding)."""
    return int(math.floor(value + 0.5))


def cumulative_arc_fractions(points) -> list[float]:
    """Cumulative arc-length fraction of every control point in path order."""
    if len(points) < 2:
        raise TransformError(
            "DERIVATION_INVALID",
            field="control_points",
            detail="at least two ordered control points are required",
        )
    lengths = geometry.segment_lengths(points)
    total = sum(lengths)
    if not math.isfinite(total) or total <= 0.0:
        raise TransformError(
            "DERIVATION_INVALID", field="control_points", detail="curve arc length must be positive"
        )
    fractions = [0.0]
    running = 0.0
    for length in lengths:
        running += length
        fractions.append(running / total)
    fractions[-1] = 1.0
    return fractions


def allocate_anchor_residues(points, target_length: int) -> list[int]:
    """0-based residue index (N -> C) for every ordered control point."""
    if not isinstance(target_length, int) or isinstance(target_length, bool):
        raise TransformError("DERIVATION_INVALID", field="target_length", detail="must be an integer")
    point_count = len(points)
    if target_length < 2:
        raise TransformError("DERIVATION_INVALID", field="target_length", detail="must be >= 2")
    if point_count > target_length:
        raise TransformError(
            "DERIVATION_INVALID",
            field="target_length",
            detail="%d control points cannot be placed on %d residues" % (point_count, target_length),
        )
    fractions = cumulative_arc_fractions(points)
    residues = [round_half_up(fraction * (target_length - 1)) for fraction in fractions]
    residues[0] = 0
    residues[-1] = target_length - 1
    for index in range(1, len(residues)):
        if residues[index] <= residues[index - 1]:
            raise TransformError(
                "DERIVATION_INVALID",
                field="anchors",
                detail=(
                    "arc-length allocation collides at control points %d and %d on a chain of %d residues"
                    % (index - 1, index, target_length)
                ),
            )
    return residues


def allocate_anchors(points, target_length: int) -> list[dict]:
    """Anchor records ``{control_point_index, residue_index0, residue_index1}``."""
    residues = allocate_anchor_residues(points, target_length)
    return [
        {
            "control_point_index": index,
            "residue_index0": residue,
            "residue_index1": residue + 1,
        }
        for index, residue in enumerate(residues)
    ]


def validate_anchor_residues(residues, target_length: int) -> list[int]:
    """Validate an explicitly declared 0-based residue map.

    Used by the controlled pair: both arms pin their control points to the *same*
    declared residues, instead of deriving the map from each arm's own arc length
    (which would make the map co-vary with the perturbation).
    """
    if not isinstance(target_length, int) or isinstance(target_length, bool) or target_length < 2:
        raise TransformError("DERIVATION_INVALID", field="target_length", detail="must be an integer >= 2")
    if not isinstance(residues, (list, tuple)):
        raise TransformError("DERIVATION_INVALID", field="anchors", detail="a declared anchor map must be a list")
    if len(residues) < 2:
        raise TransformError(
            "DERIVATION_INVALID", field="anchors", detail="a declared anchor map needs at least two residues"
        )
    if len(residues) > target_length:
        raise TransformError(
            "DERIVATION_INVALID",
            field="anchors",
            detail="%d anchors cannot be placed on %d residues" % (len(residues), target_length),
        )
    cleaned = []
    for index, residue in enumerate(residues):
        if not isinstance(residue, int) or isinstance(residue, bool):
            raise TransformError(
                "DERIVATION_INVALID", field="anchors[%d]" % index, detail="residue index must be an integer"
            )
        if not 0 <= residue < target_length:
            raise TransformError(
                "DERIVATION_INVALID",
                field="anchors[%d]" % index,
                detail="residue index %d outside 0..%d" % (residue, target_length - 1),
            )
        cleaned.append(residue)
    if cleaned[0] != 0:
        raise TransformError(
            "DERIVATION_INVALID", field="anchors[0]", detail="the first anchor must be residue 0"
        )
    if cleaned[-1] != target_length - 1:
        raise TransformError(
            "DERIVATION_INVALID",
            field="anchors[%d]" % (len(cleaned) - 1),
            detail="the last anchor must be residue %d" % (target_length - 1),
        )
    for index in range(1, len(cleaned)):
        if cleaned[index] <= cleaned[index - 1]:
            raise TransformError(
                "DERIVATION_INVALID",
                field="anchors[%d]" % index,
                detail="anchor residues must be strictly increasing",
            )
    return cleaned


def allocate_explicit_anchors(residues, target_length: int) -> list[dict]:
    """Anchor records for a declared residue map (same shape as :func:`allocate_anchors`)."""
    cleaned = validate_anchor_residues(residues, target_length)
    return [
        {
            "control_point_index": index,
            "residue_index0": residue,
            "residue_index1": residue + 1,
        }
        for index, residue in enumerate(cleaned)
    ]


def residue_gaps(anchors: list[dict]) -> list[int]:
    """Residue span between consecutive anchors (sums to target_length - 1)."""
    return [
        anchors[index + 1]["residue_index0"] - anchors[index]["residue_index0"]
        for index in range(len(anchors) - 1)
    ]


def extension_fractions(points, anchors: list[dict], ca_spacing_angstrom: float = 3.8) -> list[float]:
    """Realised CA contour fraction between consecutive anchors.

    ``distance(p_k, p_k+1) / ((i_k+1 - i_k) * 3.8)``.  A value near 1 means the
    two anchors would need a perfectly extended chain segment; the probe keeps
    it near 1/3 (an alpha helix is ~0.39).
    """
    result = []
    lengths = geometry.segment_lengths(points)
    gaps = residue_gaps(anchors)
    for length, gap in zip(lengths, gaps):
        result.append(length / (gap * ca_spacing_angstrom))
    return result
