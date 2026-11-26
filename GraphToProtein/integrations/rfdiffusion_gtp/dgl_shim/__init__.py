"""Pure-PyTorch drop-in replacement for the small slice of DGL used by RFdiffusion.

Use it either as a library (parity tests import ``dgl_shim`` next to real dgl 2.2.1)::

    import torch, dgl_shim
    g = dgl_shim.graph(src, tgt, num_nodes=N)
    out = dgl_shim.ops.e_dot_v(g, key, query)

or install it under the ``dgl`` import name::

    import dgl_shim
    dgl_shim.install()          # registers sys.modules['dgl', 'dgl.ops', 'dgl.nn', ...]
    import dgl                  # -> dgl_shim package
    dgl.ops.e_dot_v(g, key, query)

For unmodified upstream RFdiffusion there is also the auto-install alias package
``dgl_shim/dgl/__init__.py``: put ``<repo>/integrations/rfdiffusion_gtp/dgl_shim`` at
the front of ``PYTHONPATH`` and ``import dgl`` resolves to the shim with no source edits
and no ``sitecustomize``.

Why: no CUDA build of DGL exists for Windows, so RFdiffusion's ``import dgl`` plus
``dgl.ops.{e_dot_v,copy_e_sum,edge_softmax}`` calls (``rfdiffusion/util_module.py:7``,
vendored ``se3_transformer`` layers) are replaced by plain torch ops that run on whatever
device the tensors are on.  The real CPU dgl 2.2.1 wheel is only needed as the parity
reference; :func:`install` never replaces an already-imported real dgl silently.

The package is dependency-free (torch only), device agnostic (no numpy import, no
``.cpu()`` calls, no hard-coded device strings), and autograd-differentiable.

Semantics are pinned to dgl 2.2.1 sources (paths relative to
``local/envs/p2/Lib/site-packages/dgl``):

* ``dgl/convert.py:32`` -- ``graph(src, tgt, num_nodes=...)``; no canonicalisation and
  edge order == input order (spec 5.3.1).
* ``dgl/ops/sddmm.py:14-41,101-103`` -- ``e_dot_v`` = SDDMM with ``lhs_target='e'``,
  ``rhs_target='v'`` (destination node), rank padding after axis 0 (spec 5.3.2).
* ``dgl/ops/spmm.py:33-79,180-217`` -- ``copy_e_sum`` = ``copy_e``/``copy_rhs`` SpMM,
  i.e. scatter-add onto destination nodes (spec 5.3.3).
* ``dgl/ops/edge_softmax.py:12`` and ``dgl/ops/segment.py:62-102`` -- per-destination
  edge softmax with per-segment max subtraction (spec 5.3.4).
* ``dgl/base.py:10,27-29`` -- the ``ALL`` sentinel is the string ``"__ALL__"``.
"""

from __future__ import annotations

import sys
import types

from . import graph as _graph_module
from . import nn_pytorch as _nn_pytorch
from . import ops as ops
from .graph import DGLGraph, EdgeDataView, Graph, graph
from .ops import (
    ALL,
    copy_e_sum,
    deterministic_reductions_enabled,
    deterministic_reductions_policy,
    e_dot_v,
    edge_softmax,
    is_all,
    segment_max,
    segment_sum,
    set_deterministic_reductions,
)

__version__ = "2.2.1+dsh-shim"

__all__ = [
    "ALL",
    "DGLGraph",
    "EdgeDataView",
    "Graph",
    "__version__",
    "copy_e_sum",
    "deterministic_reductions_enabled",
    "deterministic_reductions_policy",
    "e_dot_v",
    "edge_softmax",
    "graph",
    "install",
    "is_all",
    "nn",
    "ops",
    "segment_max",
    "segment_sum",
    "set_deterministic_reductions",
]

#: Marker read by ``install()`` and by ``dgl_shim/dgl/__init__.py`` so the shim can tell
#: itself apart from the real dgl package.
__is_dgl_shim__ = True
#: The ``dgl`` alias package sets this on itself before calling ``install()``.
__is_dgl_shim_alias__ = False

#: Namespace registered as ``sys.modules['dgl.nn']``; only ``.pytorch`` exists.
nn = types.ModuleType(__name__ + ".nn")
nn.__doc__ = (
    "Stub namespace for dgl.nn provided by dgl_shim; only dgl.nn.pytorch is populated."
)
nn.pytorch = _nn_pytorch


def install(force=False):
    """Register this package under the ``dgl`` name (idempotent).

    After the call these all work::

        import dgl
        dgl.graph(...)
        dgl.ops.e_dot_v(...)
        from dgl import DGLGraph
        from dgl.ops import edge_softmax
        from dgl.nn.pytorch import AvgPooling, MaxPooling

    A real, *already imported* dgl is never replaced silently: in that case this raises
    ``RuntimeError`` unless ``force=True`` is passed.  (Real dgl that is merely installed
    but not imported is not detectable/irrelevant: ``sys.modules['dgl']`` is what wins,
    which is exactly what makes the shim usable without touching the environment.)
    """
    package = sys.modules[__name__]
    existing = sys.modules.get("dgl")
    if existing is not None and existing is not package:
        ours = bool(
            getattr(existing, "__is_dgl_shim__", False)
            or getattr(existing, "__is_dgl_shim_alias__", False)
        )
        if not ours and not force:
            raise RuntimeError(
                "dgl_shim.install() refused: a real 'dgl' module is already imported "
                "(name={0!r}, file={1!r}). The shim must never silently replace real "
                "DGL -- the parity tests need both importable at the same time. Call "
                "dgl_shim.install(force=True) only when replacing it is explicitly "
                "intended.".format(
                    getattr(existing, "__name__", existing),
                    getattr(existing, "__file__", "<unknown>"),
                )
            )

    sys.modules["dgl"] = package
    sys.modules["dgl.ops"] = ops
    sys.modules["dgl.nn"] = nn
    sys.modules["dgl.nn.pytorch"] = _nn_pytorch

    # Attribute fallbacks: ``dgl.ops.e_dot_v`` and ``dgl.nn.pytorch`` work even when the
    # caller never performed the corresponding submodule import.
    package.ops = ops
    package.nn = nn
    package.graph = graph
    package.DGLGraph = DGLGraph
    package.Graph = Graph
    nn.pytorch = _nn_pytorch
    return package
