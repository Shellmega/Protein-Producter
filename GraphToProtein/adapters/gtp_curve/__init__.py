"""Ordered-curve condition adapter for the GTP P2/G0 probe.

Public surface
--------------
``load_source_graph`` / ``validate_source_graph``
    Read and validate a ``ptg-graph/1.0`` open-chain document and walk the
    N -> C ordered path (never the JSON array order).
``SceneToAngstrom``
    The explicit similarity transform ``p_A = s * R * (p_source - c) + t`` with
    exact inverse and a JSON-serialisable record.
``derive_transform``
    Default scale policy (contour fraction of the real CA contour length).
``allocate_anchor_residues``
    Ordered control point -> 0-based residue index allocation.
``build_condition_payload``
    Emit the model-consumable condition (schema ``gtp.curve_condition/1``).
``fold_condition`` / ``rfdiffusion_bridge``
    Entry-point specific serialisers.  ``rfdiffusion_bridge`` is the thin
    PENDING-INTEGRATION layer; nothing else imports torch.
"""

from .allocation import allocate_anchor_residues, cumulative_arc_fractions
from .errors import GraphValidationError, TransformError
from .geometry import quad_measure, triple_product
from .graph import (
    load_source_graph,
    ordered_control_points,
    validate_source_graph,
    walk_ordered_path,
)
from .payload import CONDITION_SCHEMA, build_condition_payload
from .transform import (
    DEFAULT_CA_SPACING_ANGSTROM,
    DEFAULT_EXTENSION_FRACTION,
    DEFAULT_MODEL_FRAME_ARC_LENGTH_ANGSTROM,
    POLICY_CONTOUR_EXTENSION,
    POLICY_DECLARED_SCALE,
    POLICY_MODEL_FRAME_ARC_LENGTH,
    ScalePolicy,
    SceneToAngstrom,
    derive_transform,
    identity_rotation,
    symmetric_flip_frame_center,
)

__all__ = [
    "CONDITION_SCHEMA",
    "DEFAULT_CA_SPACING_ANGSTROM",
    "DEFAULT_EXTENSION_FRACTION",
    "DEFAULT_MODEL_FRAME_ARC_LENGTH_ANGSTROM",
    "GraphValidationError",
    "POLICY_CONTOUR_EXTENSION",
    "POLICY_DECLARED_SCALE",
    "POLICY_MODEL_FRAME_ARC_LENGTH",
    "ScalePolicy",
    "SceneToAngstrom",
    "TransformError",
    "allocate_anchor_residues",
    "build_condition_payload",
    "cumulative_arc_fractions",
    "derive_transform",
    "identity_rotation",
    "load_source_graph",
    "ordered_control_points",
    "quad_measure",
    "symmetric_flip_frame_center",
    "triple_product",
    "validate_source_graph",
    "walk_ordered_path",
]

__version__ = "1.0.0"
