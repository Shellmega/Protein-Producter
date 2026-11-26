"""Explicit ``scene_unit -> angstrom`` similarity transform.

The contract fixes the algebra but not the physical scale (``spec.md`` 3: "the
scene_unit is a design unit, not a physical Angstrom.  Physical scale conversion
is performed in GTP P3 and in model conditioning, and the conversion plus the
forward/inverse transform must be recorded").  This module makes the choice
explicit, keeps every parameter in a JSON record, and provides the exact
inverse.

Scale policy: reachability in the model frame (default)
-------------------------------------------------------
A de novo RFdiffusion monomer has **every CA initialised at the origin**
(``INIT_CRDS``: N=(-0.5272,1.3593,0), CA=(0,0,0), C=(1.5233,0,0), see
``rfdiffusion/kinematics.py:283`` ``get_init_xyz``) and the guiding potential is
applied in that same absolute Angstrom frame.  The choice of ``s`` is therefore
a *reachability* question, not an extended-chain-contour question: targets tens
of Angstrom from the origin are reachable by the guided trajectory, targets
~100 A away are not.

    s = L_target_angstrom / L_path_scene_unit          # default policy
    L_target_angstrom = 30.0 A                         # within the 24-32 A band

i.e. the *control polygon's total arc length in the model frame* lands at a
fixed, reachable size, whatever the drawn curve's extent in scene units.  With
the unit-spaced four-point example (L_path = 3 scene_unit) this gives
``s = 10.0 A/scene_unit`` and control points within 11.5 A of the origin.

The contour-based policy is kept as a documented alternative
(``POLICY_CONTOUR_EXTENSION``, ``s = alpha * (N-1) * 3.8 / L_path``): it maps the
drawn arc length onto a fixed fraction of the maximal CA contour of the target
chain and puts every anchor span at ~``alpha`` of full extension.  It is *not*
the default because 4 control points pin only 4 residues of a 60-residue chain:
at ``alpha = 1/3`` the polygon would be 74.7 A long, i.e. anchors tens of
Angstrom beyond the reachable band, and the condition would pull the whole chain
away from the origin instead of scaffolding four anchors.  Both numbers are
recorded (``s_applied`` and ``alternatives``) so the choice is auditable.

Frame policy
------------
``R`` is the identity (a proper rotation adds no information to an E(3)
equivariant model and its orthogonality residual is exactly 0, inside the frozen
``eps_R <= 64u`` bound) and ``t`` is zero.  ``c`` is supplied by the caller:

* general default - the centroid of the ordered control points;
* probe default - :func:`symmetric_flip_frame_center`, which places the frame
  origin so that flipping the last control point's ``axis`` component is an
  exact symmetry of the whole point cloud.  That keeps ``c`` *identical* for
  both arms of the paired probe (the frame is apparatus, it must not co-vary
  with the stimulus) while the two arms are exact mirror images of each other.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import geometry
from .errors import TransformError

#: virtual CA-CA bond length of a polypeptide (Angstrom)
DEFAULT_CA_SPACING_ANGSTROM = 3.8
#: target arc length of the control polygon in the model frame (Angstrom)
DEFAULT_MODEL_FRAME_ARC_LENGTH_ANGSTROM = 30.0
#: contour-policy alternative: fraction of the maximal CA contour the curve may occupy
DEFAULT_EXTENSION_FRACTION = 1.0 / 3.0

POLICY_MODEL_FRAME_ARC_LENGTH = "model_frame_arc_length"
POLICY_CONTOUR_EXTENSION = "contour_extension_fraction"
#: explicit experiment policy: one declared scale, shared by both arms of a controlled pair.
#: It is not a unit redefinition: the saved scene_unit factor and the default above stay as they are.
POLICY_DECLARED_SCALE = "declared_scale"

TRANSFORM_SCHEMA = "gtp.curve_transform/1.0"
FORWARD_FORMULA = "x_angstrom = s * R @ (x_scene - c) + t"
INVERSE_FORMULA = "x_scene = R^T @ ((x_angstrom - t) / s) + c"


def identity_rotation() -> list[list[float]]:
    return geometry.identity3()


def symmetric_flip_frame_center(points, *, axis: int = 2) -> tuple[float, float, float]:
    """Frame origin that makes a flip of the last control point's ``axis`` a symmetry.

    The non-flip coordinates use the mean over all control points; the flip-axis
    coordinate uses the mean over the control points that the flip keeps fixed
    (all but the last).  The resulting centre is identical for the two arms of
    the pair - one is the flip of the other about this plane - so the recorded
    transform block does not vary with the stimulus, and the two model-frame
    point clouds are exact mirror images through the frame origin.
    """
    ordered = [[float(value) for value in point] for point in points]
    if len(ordered) < 3:
        raise TransformError(
            "DERIVATION_INVALID",
            field="control_points",
            detail="the symmetric flip frame needs at least three control points",
        )
    centre = []
    for component in range(3):
        if component == axis:
            values = [point[component] for point in ordered[:-1]]
        else:
            values = [point[component] for point in ordered]
        centre.append(sum(values) / len(values))
    return tuple(centre)


@dataclass(frozen=True)
class ScalePolicy:
    """How ``s`` is chosen.  Serializable; every number is reported."""

    name: str = POLICY_MODEL_FRAME_ARC_LENGTH
    arc_length_target_angstrom: float = DEFAULT_MODEL_FRAME_ARC_LENGTH_ANGSTROM
    ca_spacing_angstrom: float = DEFAULT_CA_SPACING_ANGSTROM
    extension_fraction: float = DEFAULT_EXTENSION_FRACTION
    declared_scale_angstrom_per_scene_unit: float | None = None

    def contour_length_angstrom(self, target_length: int) -> float:
        """Maximal CA contour of a chain with ``target_length`` residues."""
        if target_length < 1:
            raise TransformError("DERIVATION_INVALID", field="target_length", detail="must be >= 1")
        return (target_length - 1) * self.ca_spacing_angstrom

    def full_extension_scale(self, path_length_scene_unit: float, target_length: int) -> float:
        """``s`` that maps the whole curve arc length onto the full CA contour (alpha = 1)."""
        if not path_length_scene_unit > 0.0:
            raise TransformError(
                "DERIVATION_INVALID",
                field="path_length",
                detail="the ordered curve must have positive arc length",
            )
        return self.contour_length_angstrom(target_length) / path_length_scene_unit

    def scale(self, path_length_scene_unit: float, target_length: int) -> float:
        if not (path_length_scene_unit > 0.0 and math.isfinite(path_length_scene_unit)):
            raise TransformError(
                "DERIVATION_INVALID",
                field="path_length",
                detail="the ordered curve must have positive finite arc length",
            )
        if self.name == POLICY_MODEL_FRAME_ARC_LENGTH:
            if not (self.arc_length_target_angstrom > 0.0 and math.isfinite(self.arc_length_target_angstrom)):
                raise TransformError(
                    "DERIVATION_INVALID",
                    field="arc_length_target_angstrom",
                    detail="must be positive and finite",
                )
            return self.arc_length_target_angstrom / path_length_scene_unit
        if self.name == POLICY_CONTOUR_EXTENSION:
            if not (0.0 < self.extension_fraction <= 1.0):
                raise TransformError(
                    "DERIVATION_INVALID",
                    field="extension_fraction",
                    detail="extension_fraction must be in (0, 1]",
                )
            return (
                self.extension_fraction
                * self.contour_length_angstrom(target_length)
                / path_length_scene_unit
            )
        if self.name == POLICY_DECLARED_SCALE:
            declared = self.declared_scale_angstrom_per_scene_unit
            if declared is None or not (float(declared) > 0.0 and math.isfinite(float(declared))):
                raise TransformError(
                    "DERIVATION_INVALID",
                    field="declared_scale_angstrom_per_scene_unit",
                    detail="a declared common scale must be positive and finite",
                )
            return float(declared)
        raise TransformError(
            "DERIVATION_INVALID",
            field="scale_policy",
            detail="unknown scale policy %r" % (self.name,),
        )

    def record(self, path_length_scene_unit: float, target_length: int) -> dict:
        contour = self.contour_length_angstrom(target_length)
        full = contour / path_length_scene_unit
        applied = self.scale(path_length_scene_unit, target_length)
        record = {
            "name": self.name,
            "description": {
                POLICY_MODEL_FRAME_ARC_LENGTH: (
                    "s = L_target / L_path: the control polygon has a fixed, reachable arc "
                    "length in the model frame, whose initial CA cloud sits at the origin"
                ),
                POLICY_CONTOUR_EXTENSION: (
                    "s = alpha * (N-1) * 3.8 / L_path: the drawn arc length occupies a fixed "
                    "fraction alpha of the maximal CA contour of the target chain"
                ),
                POLICY_DECLARED_SCALE: (
                    "s = s*: one declared common scale, identical for both arms of a controlled "
                    "pair; an explicit experiment configuration, not a redefinition of the saved "
                    "unit or of the adapter default"
                ),
            }[self.name],
            "rationale": (
                "reachability in the model frame (RFdiffusion initialises every CA at the origin "
                "and applies guidance there), not extended-chain contour matching"
                if self.name == POLICY_MODEL_FRAME_ARC_LENGTH
                else (
                    "extended-chain contour matching (documented alternative, not used for the probe)"
                    if self.name == POLICY_CONTOUR_EXTENSION
                    else (
                        "single-factor controlled pair: one declared scale for both arms so that a "
                        "change in one control point is the only difference; the saved s=1 unit fact "
                        "and the default 30 A arc-length target are unchanged"
                    )
                )
            ),
            "arc_length_target_angstrom": self.arc_length_target_angstrom,
            "ca_spacing_angstrom": self.ca_spacing_angstrom,
            "extension_fraction_alpha": self.extension_fraction,
            "target_length": target_length,
            "contour_length_angstrom": contour,
            "path_length_scene_unit": path_length_scene_unit,
            "s_applied": applied,
            "curve_arc_length_angstrom": applied * path_length_scene_unit,
            "alternatives": {
                "s_full_extension": full,
                "s_contour_alpha": self.extension_fraction * full,
                "contour_extended_arc_length_angstrom": full * path_length_scene_unit,
            },
        }
        if self.name == POLICY_DECLARED_SCALE:
            record["declared_scale_angstrom_per_scene_unit"] = self.declared_scale_angstrom_per_scene_unit
        return record


@dataclass(frozen=True)
class SceneToAngstrom:
    """``p_A = s * R * (p_scene - c) + t`` with exact inverse."""

    s: float
    R: tuple = field(default_factory=lambda: tuple(tuple(row) for row in geometry.identity3()))
    c: tuple = (0.0, 0.0, 0.0)
    t: tuple = (0.0, 0.0, 0.0)
    from_unit: str = "scene_unit"
    to_unit: str = "angstrom"
    policy: dict = field(default_factory=dict)

    # -- construction -------------------------------------------------------
    def __post_init__(self):
        object.__setattr__(self, "R", tuple(tuple(float(v) for v in row) for row in self.R))
        object.__setattr__(self, "c", tuple(float(v) for v in self.c))
        object.__setattr__(self, "t", tuple(float(v) for v in self.t))
        object.__setattr__(self, "s", float(self.s))

    # -- mapping ------------------------------------------------------------
    def forward(self, point) -> list[float]:
        return geometry.forward_point(
            point, center=self.c, scale_factor=self.s, rotation=self.R, translation=self.t
        )

    def inverse(self, point) -> list[float]:
        return geometry.inverse_point(
            point, center=self.c, scale_factor=self.s, rotation=self.R, translation=self.t
        )

    def forward_many(self, points) -> list[list[float]]:
        return [self.forward(point) for point in points]

    def inverse_many(self, points) -> list[list[float]]:
        return [self.inverse(point) for point in points]

    # -- admissibility (spec.md 8.1 / 8.2) ---------------------------------
    def proper_rotation(self) -> dict:
        report = geometry.rotation_is_proper(self.R)
        report["determinant_residual_limit"] = geometry.DETERMINANT_RESIDUAL_MAX
        return report

    def validate(self) -> None:
        if not (self.s > 0.0 and math.isfinite(self.s)):
            raise TransformError(
                "DERIVATION_INVALID", field="derived_transform.s", detail="s must be positive and finite"
            )
        if not all(math.isfinite(value) for value in self.c):
            raise TransformError("DERIVATION_INVALID", field="derived_transform.c", detail="c not finite")
        if not all(math.isfinite(value) for value in self.t):
            raise TransformError("DERIVATION_INVALID", field="derived_transform.t", detail="t not finite")
        report = self.proper_rotation()
        if not report["proper"]:
            if report["determinant_residual"] > geometry.DETERMINANT_RESIDUAL_MAX:
                detail = "det(R) deviates from +1 beyond the frozen 64u bound"
            else:
                detail = "R is not orthogonal within the frozen 64u bound"
            raise TransformError("DERIVATION_INVALID", field="derived_transform.R", detail=detail)

    # -- diagnostics --------------------------------------------------------
    def round_trip(self, point) -> dict:
        model_point = self.forward(point)
        recovered = self.inverse(model_point)
        absolute = geometry.observed_max_error([recovered], [point])
        reference = max(abs(float(value)) for value in point)
        bound = geometry.round_trip_error_bound(
            point,
            center=self.c,
            scale_factor=self.s,
            rotation=self.R,
            translation=self.t,
        )
        return {
            "source_point": [float(value) for value in point],
            "model_point": model_point,
            "recovered_point": recovered,
            "max_abs_error": absolute,
            "relative_error": absolute / reference if reference else absolute,
            "bound_round_trip": bound,
            "within_bound": absolute <= bound,
        }

    def diagnostics(self, points) -> dict:
        self.validate()
        round_trips = [self.round_trip(point) for point in points]
        max_abs = max(item["max_abs_error"] for item in round_trips)
        max_rel = max(item["relative_error"] for item in round_trips)
        max_bound = max(item["bound_round_trip"] for item in round_trips)
        smallest_feature = geometry.min_pair_distance(points)
        limit = geometry.precision_limit(max_bound, smallest_feature)
        model_points = self.forward_many(points)
        return {
            "rotation": self.proper_rotation(),
            "s_positive": self.s > 0.0,
            "round_trip_max_abs_error": max_abs,
            "round_trip_max_relative_error": max_rel,
            "bound_round_trip_max": max_bound,
            "all_within_bound": all(item["within_bound"] for item in round_trips),
            "precision_limit": limit,
            "model_frame": {
                "centroid": geometry.centroid(model_points),
                "max_radius": max(geometry.norm(point) for point in model_points),
                "point_count": len(model_points),
            },
            "round_trips": round_trips,
        }

    # -- serialisation ------------------------------------------------------
    def record(self, *, source_geometry: dict | None = None, points=None) -> dict:
        record = {
            "schema": TRANSFORM_SCHEMA,
            "from_unit": self.from_unit,
            "to_unit": self.to_unit,
            "convention": "column vectors: p_model = s * R @ (p_source - c) + t",
            "forward": FORWARD_FORMULA,
            "inverse": INVERSE_FORMULA,
            "s": self.s,
            "R": [list(row) for row in self.R],
            "c": list(self.c),
            "t": list(self.t),
            "policy": dict(self.policy),
        }
        if source_geometry is not None:
            record["source_geometry"] = source_geometry
        if points is not None:
            record["checks"] = self.diagnostics(points)
            record["model_control_points"] = self.forward_many(points)
        return record

    @classmethod
    def from_record(cls, record: dict) -> "SceneToAngstrom":
        required = ("s", "R", "c", "t")
        missing = [member for member in required if member not in record]
        if missing:
            raise TransformError(
                "DERIVATION_INVALID",
                field="derived_transform",
                detail="record is missing %s" % ", ".join(missing),
            )
        transform = cls(
            s=record["s"],
            R=record["R"],
            c=record["c"],
            t=record["t"],
            from_unit=record.get("from_unit", "scene_unit"),
            to_unit=record.get("to_unit", "angstrom"),
            policy=dict(record.get("policy", {})),
        )
        transform.validate()
        return transform


def derive_transform(
    points,
    target_length: int,
    *,
    policy: ScalePolicy | None = None,
    rotation=None,
    center=None,
    translation=None,
) -> SceneToAngstrom:
    """Derive the recorded transform for an ordered control polyline.

    ``center`` defaults to the centroid of the ordered points, ``rotation`` to
    the identity and ``translation`` to zero, so the model-frame curve is
    centred exactly on the origin.
    """
    ordered = [[float(value) for value in point] for point in points]
    if len(ordered) < 2:
        raise TransformError(
            "DERIVATION_INVALID", field="control_points", detail="need at least two ordered control points"
        )
    policy = policy or ScalePolicy()
    path_length_scene_unit = geometry.path_length(ordered)
    scale = policy.scale(path_length_scene_unit, target_length)
    transform = SceneToAngstrom(
        s=scale,
        R=tuple(tuple(row) for row in (rotation if rotation is not None else geometry.identity3())),
        c=tuple(center if center is not None else geometry.centroid(ordered)),
        t=tuple(translation if translation is not None else (0.0, 0.0, 0.0)),
        policy=policy.record(path_length_scene_unit, target_length),
    )
    transform.validate()
    diagnostics = transform.diagnostics(ordered)
    if diagnostics["precision_limit"]["exceeded"]:
        raise TransformError(
            "PRECISION_LIMIT",
            field="derived_transform",
            detail="round-trip bound exceeds precision_limit_ratio * L_min; the source graph is kept",
        )
    return transform
