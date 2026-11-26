"""Pure-stdlib geometry for the ordered-curve probe.

Conventions are intentionally identical to the accepted P0 reference
implementation in ``tools/contract/geometry.py`` (column-vector convention,
frozen in ``contracts/ptg-graph/v1/spec.md`` section 8.1):

    p_model  = s * R * (p_source - c) + t
    p_source = c + R^T * (p_model - t) / s

with ``s > 0``, ``R^T R = I``, ``det(R) = +1``.  Constants, formulas and names
mirror that module and ``contracts/ptg-graph/v1/rules.json``; the probe does not
invent new transform semantics.  ``tests/p2/test_geometry_reference.py`` pins
numerical equality against ``tools.contract.geometry`` so that any drift fails
the suite instead of silently diverging.

This module uses the standard library only (no numpy, no torch), which keeps the
geometry runnable in a bare interpreter and in the model environment alike.
All coordinates are plain ``(x, y, z)`` tuples/lists of ``float``.
"""

from __future__ import annotations

import math

#: unit roundoff of binary64
UNIT_ROUNDOFF = 2.0**-53

# rules.json -> tolerances.derived_transform.gamma_order
GAMMA_ORDER = 10
# rules.json -> tolerances.derived_transform.rotation_residual.residual_max
ORTHOGONALITY_RESIDUAL_MAX = 64 * UNIT_ROUNDOFF  # 7.105427357601002e-15
DETERMINANT_RESIDUAL_MAX = 64 * UNIT_ROUNDOFF
# rules.json -> tolerances.derived_transform.precision_limit_ratio
PRECISION_LIMIT_RATIO = 0.001
# rules.json -> tolerances.non_coplanarity.stable_threshold
NON_COPLANARITY_STABLE_THRESHOLD = 1.0e-9
# rules.json -> limits.coincidence.reject_if_euclidean_distance_lte
COINCIDENCE_THRESHOLD = 1.0e-6
# rules.json -> limits.coincidence.implementation (squared distance slack, 8u)
COINCIDENCE_SLACK = 8 * UNIT_ROUNDOFF

_SQRT3 = math.sqrt(3.0)


def gamma(order: int | None = None) -> float:
    """gamma_n = n*u / (1 - n*u), the classic binary64 forward error factor."""
    if order is None:
        order = GAMMA_ORDER
    return order * UNIT_ROUNDOFF / (1.0 - order * UNIT_ROUNDOFF)


# ---------------------------------------------------------------------------
# small 3x3 linear algebra
# ---------------------------------------------------------------------------
def identity3() -> list[list[float]]:
    return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]


def transpose(matrix) -> list[list[float]]:
    return [[float(matrix[row][column]) for row in range(3)] for column in range(3)]


def as_matrix(matrix) -> list[list[float]]:
    """Coerce any 3x3 sequence to a fresh list of lists of float."""
    if len(matrix) != 3 or any(len(row) != 3 for row in matrix):
        raise ValueError("expected a 3x3 matrix")
    return [[float(value) for value in row] for row in matrix]


def as_vector(vector) -> tuple[float, float, float]:
    if len(vector) != 3:
        raise ValueError("expected a 3-component vector")
    return (float(vector[0]), float(vector[1]), float(vector[2]))


def mat_mul(left, right) -> list[list[float]]:
    return [
        [sum(left[row][k] * right[k][column] for k in range(3)) for column in range(3)]
        for row in range(3)
    ]


def mat_vec(matrix, vector) -> list[float]:
    return [sum(matrix[row][k] * vector[k] for k in range(3)) for row in range(3)]


def det3(matrix) -> float:
    a, b, c = matrix[0]
    d, e, f = matrix[1]
    g, h, i = matrix[2]
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)


def rotation_x(degrees: float) -> list[list[float]]:
    angle = math.radians(degrees)
    cos, sin = math.cos(angle), math.sin(angle)
    return [[1.0, 0.0, 0.0], [0.0, cos, -sin], [0.0, sin, cos]]


def rotation_y(degrees: float) -> list[list[float]]:
    angle = math.radians(degrees)
    cos, sin = math.cos(angle), math.sin(angle)
    return [[cos, 0.0, sin], [0.0, 1.0, 0.0], [-sin, 0.0, cos]]


def rotation_z(degrees: float) -> list[list[float]]:
    angle = math.radians(degrees)
    cos, sin = math.cos(angle), math.sin(angle)
    return [[cos, -sin, 0.0], [sin, cos, 0.0], [0.0, 0.0, 1.0]]


def max_abs(vector) -> float:
    return max(abs(float(component)) for component in vector)


def subtract(left, right) -> list[float]:
    return [float(a) - float(b) for a, b in zip(left, right)]


def add(left, right) -> list[float]:
    return [float(a) + float(b) for a, b in zip(left, right)]


def scale(vector, factor: float) -> list[float]:
    return [float(component) * float(factor) for component in vector]


def norm(vector) -> float:
    return math.sqrt(sum(float(component) ** 2 for component in vector))


def distance(left, right) -> float:
    return norm(subtract(left, right))


def dot(left, right) -> float:
    return sum(float(a) * float(b) for a, b in zip(left, right))


def cross(left, right) -> list[float]:
    a0, a1, a2 = (float(v) for v in left)
    b0, b1, b2 = (float(v) for v in right)
    return [a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0]


# ---------------------------------------------------------------------------
# transform application
# ---------------------------------------------------------------------------
def forward_point(point, *, center, scale_factor: float, rotation, translation) -> list[float]:
    """p_model = s * R * (p_source - c) + t"""
    shifted = subtract(point, center)
    rotated = mat_vec(rotation, shifted)
    return add(scale(rotated, scale_factor), translation)


def inverse_point(point, *, center, scale_factor: float, rotation, translation) -> list[float]:
    """p_source = c + R^T * (p_model - t) / s"""
    shifted = subtract(point, translation)
    unscaled = scale(shifted, 1.0 / scale_factor)
    back = mat_vec(transpose(rotation), unscaled)
    return add(back, center)


def forward_points(points, **kwargs) -> list[list[float]]:
    return [forward_point(point, **kwargs) for point in points]


def inverse_points(points, **kwargs) -> list[list[float]]:
    return [inverse_point(point, **kwargs) for point in points]


# ---------------------------------------------------------------------------
# analytic error bounds (spec.md 8.2)
# ---------------------------------------------------------------------------
def forward_residual_term(point, *, center, scale_factor: float, rotation) -> float:
    """abs(s) * eps_R * (A(p) + A(c)): stored rotation residual, forward map."""
    return (
        abs(scale_factor)
        * orthogonality_residual(rotation)
        * (max_abs(point) + max_abs(center))
    )


def inverse_residual_term(point, *, translation, scale_factor: float, rotation) -> float:
    """eps_R * (A(m) + A(t)) / abs(s): stored rotation residual, inverse map."""
    return (
        orthogonality_residual(rotation)
        * (max_abs(point) + max_abs(translation))
        / abs(scale_factor)
    )


def forward_error_bound(point, *, center, scale_factor: float, translation, rotation=None) -> float:
    rounding = gamma() * (
        abs(scale_factor) * _SQRT3 * (max_abs(point) + max_abs(center)) + max_abs(translation)
    )
    if rotation is None:
        return rounding
    return rounding + forward_residual_term(
        point, center=center, scale_factor=scale_factor, rotation=rotation
    )


def inverse_error_bound(point, *, center, scale_factor: float, translation, rotation=None) -> float:
    rounding = gamma() * (
        _SQRT3 * (max_abs(point) + max_abs(translation)) / abs(scale_factor) + max_abs(center)
    )
    if rotation is None:
        return rounding
    return rounding + inverse_residual_term(
        point, translation=translation, scale_factor=scale_factor, rotation=rotation
    )


def round_trip_error_bound(point, *, center, scale_factor: float, rotation, translation) -> float:
    model_point = forward_point(
        point,
        center=center,
        scale_factor=scale_factor,
        rotation=rotation,
        translation=translation,
    )
    return forward_error_bound(
        point,
        center=center,
        scale_factor=scale_factor,
        translation=translation,
        rotation=rotation,
    ) + inverse_error_bound(
        model_point,
        center=center,
        scale_factor=scale_factor,
        translation=translation,
        rotation=rotation,
    )


def observed_max_error(observed, reference) -> float:
    """Largest absolute component difference between two point lists."""
    worst = 0.0
    for left, right in zip(observed, reference):
        for a, b in zip(left, right):
            worst = max(worst, abs(float(a) - float(b)))
    return worst


def orthogonality_residual(rotation) -> float:
    """max |R^T R - I|: how far the stored matrix is from an exact rotation."""
    return observed_max_error(mat_mul(transpose(rotation), rotation), identity3())


def rotation_is_proper(rotation, *, tolerance: float | None = None) -> dict:
    residual = orthogonality_residual(rotation)
    determinant = det3(rotation)
    determinant_residual = abs(determinant - 1.0)
    limit = ORTHOGONALITY_RESIDUAL_MAX if tolerance is None else tolerance
    return {
        "orthogonality_residual": residual,
        "determinant": determinant,
        "determinant_residual": determinant_residual,
        "residual_limit": limit,
        "proper": residual <= limit and determinant_residual <= limit,
    }


# ---------------------------------------------------------------------------
# non-coplanarity / hand (spec.md 8.3)
# ---------------------------------------------------------------------------
def triple_product(first, second, third, fourth) -> float:
    """V = (p2-p1) . ((p3-p1) x (p4-p1)); six times the signed tetra volume."""
    a = subtract(second, first)
    b = subtract(third, first)
    c = subtract(fourth, first)
    return dot(a, cross(b, c))


def quad_measure(first, second, third, fourth) -> dict:
    """Signed triple product plus the scale invariant normalised measure."""
    value = triple_product(first, second, third, fourth)
    lengths = (
        norm(subtract(second, first)),
        norm(subtract(third, first)),
        norm(subtract(fourth, first)),
    )
    denominator = lengths[0] * lengths[1] * lengths[2]
    normalised = 0.0 if denominator == 0.0 else value / denominator
    stable = abs(normalised) > NON_COPLANARITY_STABLE_THRESHOLD
    return {
        "signed_triple_product": value,
        "leg_lengths": list(lengths),
        "normalised_triple_product": normalised,
        "hand": (1 if value > 0 else -1 if value < 0 else 0) if stable else None,
        "stable": stable,
        "degenerate": not stable,
    }


def quads(points) -> list[dict]:
    """Consecutive quadruples in N -> C path order."""
    result = []
    for index in range(max(0, len(points) - 3)):
        measure = quad_measure(points[index], points[index + 1], points[index + 2], points[index + 3])
        measure["indices"] = [index, index + 1, index + 2, index + 3]
        result.append(measure)
    return result


def segment_lengths(points) -> list[float]:
    return [distance(points[index], points[index + 1]) for index in range(len(points) - 1)]


def path_length(points) -> float:
    return sum(segment_lengths(points))


def centroid(points) -> list[float]:
    count = len(points)
    if count == 0:
        raise ValueError("centroid of an empty point set")
    return [sum(float(point[axis]) for point in points) / count for axis in range(3)]


def _pair_distances(points) -> tuple[float, float]:
    smallest_squared = math.inf
    largest_squared = 0.0
    for left in range(len(points)):
        ax, ay, az = (float(v) for v in points[left])
        for right in range(left + 1, len(points)):
            bx, by, bz = (float(v) for v in points[right])
            dx, dy, dz = ax - bx, ay - by, az - bz
            squared = dx * dx + dy * dy + dz * dz
            if squared < smallest_squared:
                smallest_squared = squared
            if squared > largest_squared:
                largest_squared = squared
    if smallest_squared is math.inf:
        return 0.0, 0.0
    return math.sqrt(smallest_squared), math.sqrt(largest_squared)


def min_pair_distance(points) -> float:
    return _pair_distances(points)[0]


def max_pair_distance(points) -> float:
    return _pair_distances(points)[1]


def path_metrics(points) -> dict:
    """Geometry summary of the ordered curve (contract ``path_metrics`` shape)."""
    lengths = segment_lengths(points)
    columns = [[float(point[axis]) for point in points] for axis in range(3)]
    quad_results = quads(points)
    pair_min, pair_max = _pair_distances(points)
    return {
        "path_length": sum(lengths),
        "segment_length_min": min(lengths) if lengths else 0.0,
        "segment_length_max": max(lengths) if lengths else 0.0,
        "pair_distance_min": pair_min,
        "pair_distance_max": pair_max,
        "bbox_min": [min(column) for column in columns],
        "bbox_max": [max(column) for column in columns],
        "centroid": centroid(points),
        "non_coplanarity": {
            "defined": bool(quad_results),
            "quad_count": len(quad_results),
            "quads": quad_results,
            "quads_truncated": False,
            "all_stable": all(item["stable"] for item in quad_results) if quad_results else None,
            "any_degenerate": any(item["degenerate"] for item in quad_results),
        },
    }


def precision_limit(bound_round_trip: float, smallest_feature: float) -> dict:
    """Is the derived transform numerically usable for this source graph?"""
    allowed = PRECISION_LIMIT_RATIO * smallest_feature
    return {
        "bound_round_trip": bound_round_trip,
        "smallest_feature": smallest_feature,
        "ratio": PRECISION_LIMIT_RATIO,
        "allowed": allowed,
        "exceeded": bound_round_trip > allowed,
    }
