"""GTP ordered-curve guidance potential for RFdiffusion.

This module adds a *new* ``Potential`` subclass that steers the designed CA trace
onto an ordered polyline of control points in sequence order (N -> C).  It is the
model-side consumer of the GTP P2 condition payload produced by
``adapters/gtp_curve``.

Design constraints that shaped this file
----------------------------------------
* Upstream RFdiffusion (commit 86507b6538f51fce57b5a72477165f03999ed7ae) must stay
  byte-identical on the conditioning path, so that "original code regression" is
  meaningful.  Registration therefore happens from outside, by inserting the new
  class into ``rfdiffusion.potentials.potentials.implemented_potentials`` -- the
  extension point the upstream comment at potentials.py:457-459 explicitly
  documents ("If you implement a new potential you must add it to this
  dictionary for it to be used by the PotentialManager").
* ``PotentialManager.parse_potential_string`` (manager.py:126-139) can only carry
  ``type`` plus float-valued keys, so the curve geometry cannot travel through the
  hydra ``potentials.guiding_potentials`` string.  The curve is bound at
  registration time instead; the config string carries only the numeric knobs
  (``weight``, ``sigma``/``k``) that upstream already knows how to parse.
* ``Potential.compute`` is called on ``xyz`` of shape ``[L, 14, 3]`` (full-atom
  backbone frames produced by ``get_next_pose``); index 1 along the atom axis is
  CA.  The returned scalar is MAXIMISED by the sampler, and its gradient is added
  to the CA delta with the timestep-dependent ``guide_scale``
  (rfdiffusion/inference/utils.py:389-404 and :484-491).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Sequence

import torch

from rfdiffusion.potentials.potentials import Potential

__all__ = [
    "GTPCurvePotential",
    "load_condition_spec",
    "make_potential_class",
    "register",
    "POTENTIAL_TYPE",
]

POTENTIAL_TYPE = "gtp_curve"

#: CA atom index along the per-residue atom axis of the tensor handed to compute().
CA_ATOM_INDEX = 1

SUPPORTED_KERNELS = ("huber", "gauss", "quadratic")


# --------------------------------------------------------------------------- #
# Condition payload loading / validation
# --------------------------------------------------------------------------- #
def load_condition_spec(path: str) -> Dict[str, Any]:
    """Load and validate a ``gtp.curve_condition/1`` payload.

    Validation is deliberately strict: a probe that silently falls back to a
    different condition would invalidate the paired comparison it exists to
    support.
    """
    with open(path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)

    if not isinstance(spec, dict):
        raise ValueError("condition spec must be a JSON object")
    schema = spec.get("schema")
    if schema != "gtp.curve_condition/1":
        raise ValueError(
            "unsupported condition schema %r (expected 'gtp.curve_condition/1')" % (schema,)
        )

    anchors = spec.get("anchors")
    positions = spec.get("anchor_positions_angstrom")
    if not isinstance(anchors, list) or not anchors:
        raise ValueError("spec.anchors must be a non-empty list")
    if not isinstance(positions, list) or len(positions) != len(anchors):
        raise ValueError(
            "spec.anchor_positions_angstrom must match len(spec.anchors): %r vs %r"
            % (len(positions) if isinstance(positions, list) else positions, len(anchors))
        )

    residue_index = []
    for i, anchor in enumerate(anchors):
        if not isinstance(anchor, dict) or "residue_index0" not in anchor:
            raise ValueError("anchor %d must be an object with residue_index0" % i)
        idx = anchor["residue_index0"]
        if not isinstance(idx, int) or isinstance(idx, bool):
            raise ValueError("anchor %d residue_index0 must be an int" % i)
        residue_index.append(idx)
    if residue_index != sorted(residue_index) or len(set(residue_index)) != len(residue_index):
        raise ValueError("anchor residue_index0 values must be strictly increasing")
    if residue_index[0] != 0:
        raise ValueError("first anchor must start at residue_index0 == 0 (N-terminus)")

    target_length = spec.get("target_length")
    if not isinstance(target_length, int) or target_length <= 0:
        raise ValueError("spec.target_length must be a positive int")
    if residue_index[-1] != target_length - 1:
        raise ValueError(
            "last anchor residue_index0 must be target_length-1 (%d), got %d"
            % (target_length - 1, residue_index[-1])
        )

    for i, point in enumerate(positions):
        if not isinstance(point, list) or len(point) != 3:
            raise ValueError("anchor_positions_angstrom[%d] must be [x, y, z]" % i)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point):
            raise ValueError("anchor_positions_angstrom[%d] must be numeric" % i)
        if not all(math.isfinite(float(v)) for v in point):
            raise ValueError("anchor_positions_angstrom[%d] must be finite" % i)

    kernel = spec.get("kernel") or {}
    if not isinstance(kernel, dict):
        raise ValueError("spec.kernel must be an object")
    if kernel.get("type", "gauss") not in SUPPORTED_KERNELS:
        raise ValueError(
            "kernel.type must be one of %r, got %r"
            % (list(SUPPORTED_KERNELS), kernel.get("type"))
        )
    return spec


# --------------------------------------------------------------------------- #
# The potential itself
# --------------------------------------------------------------------------- #
class GTPCurvePotential(Potential):
    """Attract ordered CA anchors onto an ordered 3D curve.

    The potential is MAXIMISED by the sampler, therefore every kernel below is
    written so that its maximum sits at zero anchor-target distance.

    ``huber``     : ``weight * sum_k -sqrt(d_k^2 + eps^2)``
                    constant-magnitude pull (``~weight``) while far, smoothly
                    vanishing near the target.  This is the default because the
                    sampler initialises de novo CA points at the origin, so an
                    anchor can start far from its target; a Gaussian well decays
                    too fast to pull from there.
    ``gauss``     : ``weight * sum_k exp(-d_k^2 / (2 sigma^2))``
                    bounded gradient (max ~ ``weight / (sigma * sqrt(e))``),
                    useful as a soft local well once the coarse path is set.
    ``quadratic`` : ``-weight * sum_k d_k^2``
                    unbounded pull, kept for a strong-condition contrast run.
    """

    def __init__(
        self,
        spec: Dict[str, Any],
        weight: float = 1.0,
        sigma: float = 3.0,
        kernel: str | None = None,
        recentre_targets: bool = False,
        spec_path: str | None = None,
    ) -> None:
        if kernel is None:
            kernel = (spec.get("kernel") or {}).get("type", "gauss")
        if kernel not in SUPPORTED_KERNELS:
            raise ValueError("kernel must be one of %r" % (list(SUPPORTED_KERNELS),))
        self.kernel = kernel
        self.weight = float(weight)
        self.sigma = float(sigma)
        self.spec_path = spec_path
        self.spec = spec

        anchors = spec["anchors"]
        self.residue_index = [int(a["residue_index0"]) for a in anchors]
        targets = torch.tensor(spec["anchor_positions_angstrom"], dtype=torch.float32)
        if recentre_targets:
            # RFdiffusion initialises unconditional CA points at the origin, so a
            # curve that is not already origin-centred must be shifted to make the
            # guidance reachable.  The shift is recorded so the inverse mapping can
            # undo it.
            targets = targets - targets.mean(dim=0, keepdim=True)
        self.recentre_targets = bool(recentre_targets)
        self.targets = targets
        self.target_centroid = targets.mean(dim=0).tolist()
        self._index_tensor = torch.tensor(self.residue_index, dtype=torch.long)
        #: per-compute diagnostics; the sampler only needs the scalar, but the
        #: recorded distances are what prove the condition is actually biting.
        self.last_stats: Dict[str, float] = {}
        self.call_count = 0
        self._trace_handle = None
        trace_path = os.environ.get("GTP_CURVE_TRACE")
        if trace_path:
            Path(trace_path).parent.mkdir(parents=True, exist_ok=True)
            self._trace_handle = open(trace_path, "w", encoding="utf-8")
            self._trace_handle.write("call,mean_distance,min_distance,max_distance,potential\n")

    # -- helpers ----------------------------------------------------------- #
    def _select_targets(self, xyz: torch.Tensor) -> torch.Tensor:
        index = self._index_tensor.to(xyz.device)
        targets = self.targets.to(xyz.device)
        if xyz.shape[0] < len(self.residue_index):
            raise RuntimeError(
                "curve condition targets %d anchors but the design only has %d residues"
                % (len(self.residue_index), xyz.shape[0])
            )
        if xyz.shape[1] <= CA_ATOM_INDEX:
            raise RuntimeError(
                "expected at least %d atoms per residue, got %d"
                % (CA_ATOM_INDEX + 1, xyz.shape[1])
            )
        return index, targets

    def distances(self, xyz: torch.Tensor) -> torch.Tensor:
        index, targets = self._select_targets(xyz)
        ca = xyz[index, CA_ATOM_INDEX, :]
        return torch.linalg.vector_norm(ca - targets, dim=-1)

    # -- Potential interface ---------------------------------------------- #
    def compute(self, xyz: torch.Tensor) -> torch.Tensor:
        index, targets = self._select_targets(xyz)
        ca = xyz[index, CA_ATOM_INDEX, :]
        squared = torch.sum((ca - targets) ** 2, dim=-1)

        if self.kernel == "gauss":
            sigma = max(self.sigma, 1e-6)
            potential = self.weight * torch.exp(-squared / (2.0 * sigma**2)).sum()
        elif self.kernel == "huber":
            eps = max(self.sigma, 1e-6)
            potential = -self.weight * torch.sqrt(squared + eps**2).sum()
        else:  # quadratic
            potential = -self.weight * squared.sum()

        with torch.no_grad():
            distances = torch.sqrt(squared.detach())
            self.call_count += 1
            self.last_stats = {
                "calls": float(self.call_count),
                "mean_anchor_distance": float(distances.mean()),
                "max_anchor_distance": float(distances.max()),
                "rms_anchor_distance": float(torch.sqrt(torch.mean(squared.detach()))),
                "potential": float(potential.detach()),
            }
            if self._trace_handle is not None:
                # Per-step trace is the only direct evidence that the condition is
                # actually moving the backbone, rather than merely being registered.
                self._trace_handle.write(
                    "%d,%.6f,%.6f,%.6f,%.6f\n"
                    % (
                        self.call_count,
                        float(distances.mean()),
                        float(distances.min()),
                        float(distances.max()),
                        float(potential.detach()),
                    )
                )
                self._trace_handle.flush()
        return potential

    # -- reproducibility --------------------------------------------------- #
    def describe(self) -> Dict[str, Any]:
        return {
            "potential_type": POTENTIAL_TYPE,
            "kernel": self.kernel,
            "weight": self.weight,
            "sigma": self.sigma,
            "n_anchors": len(self.residue_index),
            "anchor_residue_index0": list(self.residue_index),
            "targets_angstrom": self.targets.tolist(),
            "target_centroid_angstrom": self.target_centroid,
            "recentre_targets": self.recentre_targets,
            "spec_path": self.spec_path,
        }


# --------------------------------------------------------------------------- #
# Registration into upstream's extension point
# --------------------------------------------------------------------------- #
def make_potential_class(
    spec: Dict[str, Any],
    spec_path: str | None = None,
    recentre_targets: bool = False,
    kernel: str | None = None,
    name: str = POTENTIAL_TYPE,
):
    """Return a ``Potential`` subclass with the curve bound at construction.

    The returned class keeps upstream's constructor contract (keyword args parsed
    from the ``guiding_potentials`` string), so ``PotentialManager`` can build it
    unmodified.

    ``kernel`` overrides the payload's ``kernel.type``; this is needed because
    ``PotentialManager.parse_potential_string`` coerces every non-``type`` value
    with ``float()`` (manager.py:126-139), so a kernel *name* cannot travel through
    the config string.
    """

    class _BoundGTPCurvePotential(GTPCurvePotential):
        def __init__(self, weight: float = 1.0, sigma: float = 3.0, **kwargs: Any) -> None:
            if kwargs:
                # parse_potential_string turns every non-type value into a float;
                # an unexpected key means the config no longer matches this probe.
                raise TypeError("unexpected gtp_curve argument(s): %s" % sorted(kwargs))
            super().__init__(
                spec=spec,
                weight=weight,
                sigma=sigma,
                kernel=kernel,
                spec_path=spec_path,
                recentre_targets=recentre_targets,
            )

    _BoundGTPCurvePotential.__name__ = "BoundGTPCurvePotential"
    _BoundGTPCurvePotential.__qualname__ = "BoundGTPCurvePotential"
    _BoundGTPCurvePotential.gtp_name = name
    return _BoundGTPCurvePotential


def register(
    spec: Dict[str, Any],
    spec_path: str | None = None,
    recentre_targets: bool = False,
    kernel: str | None = None,
    name: str = POTENTIAL_TYPE,
) -> type:
    """Register the bound curve potential in ``implemented_potentials``."""
    from rfdiffusion.potentials import potentials as upstream_potentials

    cls = make_potential_class(
        spec=spec,
        spec_path=spec_path,
        recentre_targets=recentre_targets,
        kernel=kernel,
        name=name,
    )
    upstream_potentials.implemented_potentials[name] = cls
    return cls


def register_from_path(
    spec_path: str,
    recentre_targets: bool = False,
    kernel: str | None = None,
    name: str = POTENTIAL_TYPE,
) -> type:
    spec = load_condition_spec(spec_path)
    return register(
        spec=spec,
        spec_path=os.path.abspath(spec_path),
        recentre_targets=recentre_targets,
        kernel=kernel,
        name=name,
    )
