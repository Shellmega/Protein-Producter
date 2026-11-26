"""Build the model-consumable condition payload (``gtp.curve_condition/1``).

The schema is fixed by the model-side consumer (Lead, this session) so that the
RFdiffusion potential can load the file without rework:

    schema, created_by,
    source {graph_path, graph_id, revision, n_terminal_node, node_order},
    target_length,
    transform {from_unit, to_unit, s, R, c, t, policy, forward, inverse},
    control_points_scene_unit, control_points_angstrom,
    anchors [{control_point_index, residue_index0}],
    anchor_positions_angstrom,
    kernel {type, sigma}, weight, notes, frame

Contract invariants enforced by :func:`validate_payload` (and by the test
suite):

* ``anchors`` is strictly increasing in ``residue_index0``, starts at 0, ends at
  ``target_length - 1``, and has exactly one entry per
  ``anchor_positions_angstrom``;
* ``anchor_positions_angstrom[k] == control_points_angstrom[anchors[k].control_point_index]``;
* ``residue_index0`` is 0-based in N -> C order, matching RFdiffusion's residue
  indexing (index 0 = N-terminus);
* every ``*_angstrom`` value is an absolute model-frame Angstrom coordinate and
  the curve is centred on the origin (mean of ``control_points_angstrom`` is 0),
  because ``transform.c`` is the curve centroid and ``transform.t`` is zero;
* the payload is strict JSON: no NaN/Infinity anywhere.

What is *not* in the payload: no source-graph coordinates outside
``control_points_scene_unit`` and no derivation of the model kernel.  The payload
is entry-point neutral; :mod:`adapters.gtp_curve.rfdiffusion_bridge` and
:mod:`adapters.gtp_curve.fold_condition` serialise the same payload for a
specific model entry point.
"""

from __future__ import annotations

import json
import math

from . import geometry
from .allocation import (
    allocate_anchors,
    allocate_explicit_anchors,
    extension_fractions,
    residue_gaps,
)
from .errors import TransformError
from .graph import SourceGraph
from .transform import (
    DEFAULT_CA_SPACING_ANGSTROM,
    DEFAULT_EXTENSION_FRACTION,
    FORWARD_FORMULA,
    INVERSE_FORMULA,
    POLICY_DECLARED_SCALE,
    ScalePolicy,
    derive_transform,
)

CONDITION_SCHEMA = "gtp.curve_condition/1"
CREATED_BY = "adapters/gtp_curve"
DEFAULT_TARGET_LENGTH = 60
#: bound width of the potential kernel in Angstrom.  ``huber`` uses ``sigma`` as the
#: smoothing epsilon of ``-weight * sum sqrt(d^2 + sigma^2)``: the pull magnitude is
#: ~constant far from a target and decays inside it, which is what makes anchors that
#: start far from the origin reachable.  2.0 A is ~0.5 of a CA-CA spacing.
DEFAULT_KERNEL = {"type": "huber", "sigma": 2.0}
SUPPORTED_KERNEL_TYPES = ("gauss", "huber")
DEFAULT_WEIGHT = 1.0

_NOTES_TEMPLATE = (
    "Ordered-curve condition from the frozen ptg-graph/1.0 path (N terminus = %(n_terminal)s). "
    "This probe is equivalent to scaffolding %(k)d single-residue CA anchors at fixed 3D positions in "
    "sequence order - a coarse motif-scaffolding-like condition expressed as a soft potential. Only "
    "the anchor residues are constrained; the intervening chain is free. "
    "Frame: the transform block is apparatus, held constant across the paired arms. transform.R is the "
    "identity, transform.t is [0,0,0] and transform.c = %(c)s scene_unit is the frozen frame centre, so "
    "a variant's own centroid is NOT the origin - it is reported in frame.centroid_angstrom (the two "
    "arms sit symmetrically about the flip plane, not exactly on the origin). Do NOT re-centre per "
    "payload: re-centring would translate one arm relative to the other and destroy the exact mirror "
    "symmetry and the identical transform block. "
    "Scale policy: %(policy)s - s = %(s).12g angstrom per scene_unit, so the control polygon is "
    "%(arc).12g angstrom long and every anchor lies within %(radius).12g angstrom of the frame origin, "
    "inside the reachable band of a model whose initial CA cloud sits at the origin. "
    "%(anchor_policy)s; residue_index0 is RFdiffusion 0-based, N -> C."
)

_NOTES_TEMPLATE_CONTOUR = (
    "Ordered-curve condition from the frozen ptg-graph/1.0 path (N terminus = %(n_terminal)s). "
    "This probe is equivalent to scaffolding %(k)d single-residue CA anchors at fixed 3D positions in "
    "sequence order - a coarse motif-scaffolding-like condition expressed as a soft potential. Only "
    "the anchor residues are constrained; the intervening chain is free. "
    "Frame: the transform block is apparatus, held constant across the paired arms. transform.R is the "
    "identity, transform.t is [0,0,0] and transform.c = %(c)s scene_unit is the frozen frame centre, so "
    "a variant's own centroid is NOT the origin - it is reported in frame.centroid_angstrom (the two "
    "arms sit symmetrically about the flip plane, not exactly on the origin). Do NOT re-centre per "
    "payload: re-centring would translate one arm relative to the other and destroy the exact mirror "
    "symmetry and the identical transform block. "
    "Scale policy: %(policy)s - s = %(s).12g angstrom per scene_unit, so the control polygon maps onto "
    "%(arc).12g angstrom of required chain contour, i.e. %(mean_ca).12g angstrom per residue for "
    "%(target)d residues. This is a contour-matching configuration: the chain must follow the polyline; "
    "the anchors are not individually reachable by a straight pull from the origin. "
    "%(anchor_policy)s; residue_index0 is RFdiffusion 0-based, N -> C."
)


def build_condition_payload(
    graph: SourceGraph,
    *,
    graph_path: str,
    target_length: int = DEFAULT_TARGET_LENGTH,
    weight: float = DEFAULT_WEIGHT,
    kernel: dict | None = None,
    policy: ScalePolicy | None = None,
    center=None,
    frame_definition: str = "centroid of the ordered control points",
    extra_notes: str | None = None,
    anchor_residues: list[int] | None = None,
    anchor_policy: str | None = None,
) -> dict:
    """Derive the transform, anchor allocation and condition payload for a graph.

    ``center`` fixes ``transform.c``; ``None`` uses the graph's own control-point
    centroid.  The probe passes a *shared* centre so that the transform block is
    identical for every arm and the pair differs only in the curve geometry.

    ``anchor_residues`` pins the control points to an explicitly declared 0-based
    residue map (used by the controlled pair, where both arms must share one map).
    ``None`` keeps the arc-length allocation that the saved conversion uses.
    """
    if graph.graph_path is not None and graph_path is None:
        graph_path = graph.graph_path
    points = graph.control_points
    policy = policy or ScalePolicy()
    transform = derive_transform(points, target_length, policy=policy, center=center)
    scene_points = [[float(value) for value in point] for point in points]
    model_points = transform.forward_many(scene_points)
    if anchor_residues is None:
        anchors = allocate_anchors(scene_points, target_length)
        if anchor_policy is None:
            anchor_policy = "Anchors are allocated by cumulative arc-length fraction"
    else:
        anchors = allocate_explicit_anchors(anchor_residues, target_length)
        if anchor_policy is None:
            anchor_policy = "Anchors are pinned by a declared common residue map"
    anchor_positions = [model_points[anchor["control_point_index"]] for anchor in anchors]
    kernel = dict(kernel or DEFAULT_KERNEL)
    model_centroid = geometry.centroid(model_points)
    max_radius = max(geometry.norm(point) for point in model_points)
    arc_length = sum(geometry.segment_lengths(model_points))
    if transform.policy["name"] == POLICY_DECLARED_SCALE:
        template = _NOTES_TEMPLATE_CONTOUR
        mean_residue_contour = arc_length / (target_length - 1)
    else:
        template = _NOTES_TEMPLATE
        mean_residue_contour = 0.0
    notes = template % {
        "n_terminal": graph.n_terminal_node,
        "k": len(anchors),
        "c": list(transform.c),
        "policy": transform.policy["description"],
        "s": transform.s,
        "arc": arc_length,
        "radius": max_radius,
        "mean_ca": mean_residue_contour,
        "target": target_length,
        "anchor_policy": anchor_policy,
    }
    if extra_notes:
        notes = notes + " " + extra_notes

    payload = {
        "schema": CONDITION_SCHEMA,
        "created_by": CREATED_BY,
        "source": {
            "graph_path": graph_path,
            "graph_id": graph.graph_id,
            "revision": graph.revision,
            "n_terminal_node": graph.n_terminal_node,
            "node_order": graph.node_order,
        },
        "target_length": target_length,
        "transform": {
            "from_unit": transform.from_unit,
            "to_unit": transform.to_unit,
            "s": transform.s,
            "R": [list(row) for row in transform.R],
            "c": list(transform.c),
            "t": list(transform.t),
            "policy": "%s (s = %.12g A per scene_unit)" % (transform.policy["description"], transform.s),
            "forward": FORWARD_FORMULA,
            "inverse": INVERSE_FORMULA,
        },
        "control_points_scene_unit": scene_points,
        "control_points_angstrom": model_points,
        "anchors": [
            {
                "control_point_index": anchor["control_point_index"],
                "residue_index0": anchor["residue_index0"],
            }
            for anchor in anchors
        ],
        "anchor_positions_angstrom": anchor_positions,
        "kernel": kernel,
        "weight": float(weight),
        "frame": {
            "centre_definition": frame_definition,
            "centroid_scene_unit": list(transform.c),
            "centroid_angstrom": model_centroid,
            "max_radius_angstrom": max_radius,
            "note": (
                "anchor_positions_angstrom are absolute model-frame coordinates. The frame is held "
                "constant across the paired arms; a variant's own centroid is reported in "
                "centroid_angstrom and must not be subtracted."
            ),
        },
        "notes": notes,
    }
    validate_payload(payload)
    return payload


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------
def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _require(condition: bool, detail: str, *, field: str) -> None:
    if not condition:
        raise TransformError("DERIVATION_INVALID", field=field, detail=detail)


def validate_payload(payload: dict) -> None:
    """Raise ``TransformError`` unless the payload matches ``gtp.curve_condition/1``."""
    _require(isinstance(payload, dict), "payload must be an object", field="$")
    for member in (
        "schema",
        "created_by",
        "source",
        "target_length",
        "transform",
        "control_points_scene_unit",
        "control_points_angstrom",
        "anchors",
        "anchor_positions_angstrom",
        "kernel",
        "weight",
    ):
        _require(member in payload, "missing member %r" % member, field=member)
    _require(payload["schema"] == CONDITION_SCHEMA, "unexpected schema", field="schema")
    _require(payload["created_by"] == CREATED_BY, "unexpected created_by", field="created_by")

    source = payload["source"]
    _require(isinstance(source, dict), "source must be an object", field="source")
    for member in ("graph_path", "graph_id", "revision", "n_terminal_node", "node_order"):
        _require(member in source, "source is missing %r" % member, field="source." + member)
    _require(
        isinstance(source["node_order"], list) and len(source["node_order"]) >= 2,
        "node_order must list at least two node ids",
        field="source.node_order",
    )

    target_length = payload["target_length"]
    _require(
        isinstance(target_length, int) and not isinstance(target_length, bool) and target_length >= 2,
        "target_length must be an integer >= 2",
        field="target_length",
    )

    transform = payload["transform"]
    _require(isinstance(transform, dict), "transform must be an object", field="transform")
    for member in ("from_unit", "to_unit", "s", "R", "c", "t", "policy", "forward", "inverse"):
        _require(member in transform, "transform is missing %r" % member, field="transform." + member)
    _require(transform["from_unit"] == "scene_unit", "from_unit must be scene_unit", field="transform.from_unit")
    _require(transform["to_unit"] == "angstrom", "to_unit must be angstrom", field="transform.to_unit")
    _require(_is_number(transform["s"]) and float(transform["s"]) > 0.0, "s must be positive", field="transform.s")
    rotation = transform["R"]
    _require(
        isinstance(rotation, list) and len(rotation) == 3 and all(isinstance(row, list) and len(row) == 3 for row in rotation),
        "R must be 3x3",
        field="transform.R",
    )
    for name in ("c", "t"):
        vector = transform[name]
        _require(
            isinstance(vector, list) and len(vector) == 3 and all(_is_number(value) for value in vector),
            "%s must be 3 finite numbers" % name,
            field="transform." + name,
        )
    _require(isinstance(transform["policy"], str) and transform["policy"], "policy must be text", field="transform.policy")

    scene_points = _point_list(payload["control_points_scene_unit"], "control_points_scene_unit")
    model_points = _point_list(payload["control_points_angstrom"], "control_points_angstrom")
    _require(
        len(scene_points) == len(model_points),
        "the scene and angstrom control point lists must have equal length",
        field="control_points_angstrom",
    )
    anchor_positions = _point_list(payload["anchor_positions_angstrom"], "anchor_positions_angstrom")

    node_order = source["node_order"]
    _require(
        len(node_order) == len(scene_points),
        "node_order length must match the ordered control point count",
        field="source.node_order",
    )

    anchors = payload["anchors"]
    _require(isinstance(anchors, list) and anchors, "anchors must be a non-empty list", field="anchors")
    _require(
        len(anchors) == len(anchor_positions),
        "anchors and anchor_positions_angstrom must have equal length",
        field="anchors",
    )
    residues = []
    for index, anchor in enumerate(anchors):
        _require(isinstance(anchor, dict), "anchor must be an object", field="anchors[%d]" % index)
        for member in ("control_point_index", "residue_index0"):
            _require(
                isinstance(anchor.get(member), int) and not isinstance(anchor.get(member), bool),
                "anchor is missing integer %r" % member,
                field="anchors[%d].%s" % (index, member),
            )
        control_point_index = anchor["control_point_index"]
        _require(
            0 <= control_point_index < len(model_points),
            "control_point_index out of range",
            field="anchors[%d].control_point_index" % index,
        )
        _require(
            anchor_positions[index] == model_points[control_point_index],
            "anchor_positions_angstrom[%d] must equal control_points_angstrom[%d]" % (index, control_point_index),
            field="anchor_positions_angstrom[%d]" % index,
        )
        residues.append(anchor["residue_index0"])
    _require(residues[0] == 0, "the first anchor must be residue_index0 0", field="anchors[0].residue_index0")
    _require(
        residues[-1] == target_length - 1,
        "the last anchor must be residue_index0 target_length-1",
        field="anchors[%d].residue_index0" % (len(residues) - 1),
    )
    for index in range(1, len(residues)):
        _require(
            residues[index] > residues[index - 1],
            "anchors must be strictly increasing in residue_index0",
            field="anchors[%d].residue_index0" % index,
        )

    kernel = payload["kernel"]
    _require(isinstance(kernel, dict), "kernel must be an object", field="kernel")
    _require(
        kernel.get("type") in SUPPORTED_KERNEL_TYPES,
        "kernel.type must be one of %s" % (SUPPORTED_KERNEL_TYPES,),
        field="kernel.type",
    )
    _require(
        _is_number(kernel.get("sigma")) and float(kernel["sigma"]) > 0.0,
        "kernel.sigma must be positive",
        field="kernel.sigma",
    )
    _require(_is_number(payload["weight"]), "weight must be a finite number", field="weight")

    # strict JSON
    try:
        json.dumps(payload, allow_nan=False)
    except (TypeError, ValueError) as error:  # pragma: no cover - defensive
        raise TransformError("DERIVATION_INVALID", field="$", detail="payload is not strict JSON: %s" % error)

    # the reported frame statistics must be the ones of the payload geometry
    if "frame" in payload:
        frame = payload["frame"]
        _require(isinstance(frame, dict), "frame must be an object", field="frame")
        _require("centroid_angstrom" in frame, "frame is missing centroid_angstrom", field="frame.centroid_angstrom")
        reported = frame["centroid_angstrom"]
        _require(
            isinstance(reported, list) and len(reported) == 3 and all(_is_number(value) for value in reported),
            "frame.centroid_angstrom must be three finite numbers",
            field="frame.centroid_angstrom",
        )
        computed = geometry.centroid(model_points)
        _require(
            geometry.max_abs(geometry.subtract(reported, computed)) <= 1e-12,
            "frame.centroid_angstrom must equal the centroid of control_points_angstrom",
            field="frame.centroid_angstrom",
        )
        if "max_radius_angstrom" in frame:
            expected = max(geometry.norm(point) for point in model_points)
            _require(
                abs(float(frame["max_radius_angstrom"]) - expected) <= 1e-12,
                "frame.max_radius_angstrom must equal max |control_points_angstrom|",
                field="frame.max_radius_angstrom",
            )


def _point_list(value, field: str) -> list[list[float]]:
    _require(isinstance(value, list) and value, "%s must be a non-empty list" % field, field=field)
    points = []
    for index, point in enumerate(value):
        _require(
            isinstance(point, list) and len(point) == 3 and all(_is_number(component) for component in point),
            "%s[%d] must be three finite numbers" % (field, index),
            field="%s[%d]" % (field, index),
        )
        points.append([float(component) for component in point])
    return points


# ---------------------------------------------------------------------------
# reporting helpers
# ---------------------------------------------------------------------------
def condition_summary(payload: dict) -> dict:
    """Small human/machine-readable summary used by the probe manifest."""
    transform = payload["transform"]
    anchors = payload["anchors"]
    gaps = residue_gaps(anchors)
    scene = payload["control_points_scene_unit"]
    model = payload["control_points_angstrom"]
    path_length_scene_unit = geometry.path_length(scene)
    contour = (payload["target_length"] - 1) * DEFAULT_CA_SPACING_ANGSTROM
    return {
        "schema": payload["schema"],
        "target_length": payload["target_length"],
        "transform_s_angstrom_per_scene_unit": transform["s"],
        "transform_c": transform["c"],
        "transform_t": transform["t"],
        "rotation_is_identity": transform["R"] == geometry.identity3(),
        "anchor_node_ids": payload["source"]["node_order"],
        "anchor_residues_0based": [anchor["residue_index0"] for anchor in anchors],
        "anchor_residues_1based": [anchor["residue_index0"] + 1 for anchor in anchors],
        "residue_gaps": gaps,
        "extension_fractions": extension_fractions(model, anchors, DEFAULT_CA_SPACING_ANGSTROM),
        "segment_lengths_angstrom": geometry.segment_lengths(model),
        "curve_arc_length_angstrom": geometry.path_length(model),
        "curve_arc_length_scene_unit": path_length_scene_unit,
        "control_polygon_arc_length_angstrom": geometry.path_length(model),
        "contour_length_angstrom": contour,
        "s_full_extension": contour / path_length_scene_unit,
        "s_contour_alpha_alternative": DEFAULT_EXTENSION_FRACTION * contour / path_length_scene_unit,
        "extension_fraction_alpha_alternative": DEFAULT_EXTENSION_FRACTION,
        "realised_extension_fractions": extension_fractions(model, anchors, DEFAULT_CA_SPACING_ANGSTROM),
        "kernel": payload["kernel"],
        "weight": payload["weight"],
        "frame_centroid_angstrom": payload["frame"]["centroid_angstrom"],
        "max_radius_angstrom": payload["frame"]["max_radius_angstrom"],
    }
