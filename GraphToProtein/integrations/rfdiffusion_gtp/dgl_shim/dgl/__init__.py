"""PYTHONPATH alias package: ``import dgl`` resolves to the pure-PyTorch shim.

This package exists so that **unmodified** upstream RFdiffusion can run on a CUDA box
with no CUDA build of DGL and no edits at all::

    PYTHONPATH=<repo>/integrations/rfdiffusion_gtp/dgl_shim;<rf_tree>;<rf_tree>/env/SE3Transformer;<repo>

With ``<repo>/integrations/rfdiffusion_gtp/dgl_shim`` at the front of ``PYTHONPATH``,
``import dgl`` lands here; this module immediately imports the real implementation
package ``dgl_shim`` (the parent directory, a package) and calls ``dgl_shim.install()``,
which registers ``sys.modules['dgl']``, ``dgl.ops``, ``dgl.nn`` and ``dgl.nn.pytorch``.
The implementation package stays importable on its own (the parity tests import
``dgl_shim`` directly while real dgl 2.2.1 is loaded in the same process), so it must
not auto-install by itself -- only this alias does.

This module is self-sufficient: it inserts both ``<...>/integrations/rfdiffusion_gtp``
(so that ``import dgl_shim`` works) and ``<...>/integrations/rfdiffusion_gtp/dgl_shim``
into ``sys.path``, so it works when either directory -- or both -- are on PYTHONPATH.

CPython's import machinery replaces ``sys.modules['dgl']`` with the ``dgl_shim`` package
object after this module body finishes (``importlib._bootstrap._load_unlocked`` moves the
post-``exec_module`` ``sys.modules`` entry back into place), so ``import dgl`` binds the
``dgl_shim`` package itself; the explicit assignment and re-exports below make the
behaviour independent of that detail.

Do not add a top-level ``dgl/`` directory or a ``dgl.py`` module anywhere else in the
repository: this alias is the only intended shadowing mechanism.
"""

from __future__ import annotations

import os
import sys

#: Marker read by ``dgl_shim.install()``: an alias module is ours, not a real DGL.
__is_dgl_shim_alias__ = True

_ALIAS_DIR = os.path.dirname(os.path.abspath(__file__))  # .../dgl_shim/dgl
_ROOT = os.path.dirname(_ALIAS_DIR)  # .../integrations/rfdiffusion_gtp/dgl_shim
_PARENT = os.path.dirname(_ROOT)  # .../integrations/rfdiffusion_gtp
for _p in (_PARENT, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import dgl_shim as _impl  # noqa: E402  (needs the sys.path entries added just above)

if __name__ == "dgl":
    # Normal `import dgl` through this alias: register every dgl.* name and replace this
    # module with the implementation so `import dgl` yields dgl_shim.
    _impl.install()
    sys.modules["dgl"] = _impl
    globals().update(
        {name: getattr(_impl, name) for name in ("graph", "DGLGraph", "ops", "nn", "__version__")}
    )

from dgl_shim import (  # noqa: E402,F401
    ALL,
    DGLGraph,
    Graph,
    __version__,
    copy_e_sum,
    e_dot_v,
    edge_softmax,
    graph,
    install,
    is_all,
    nn,
    ops,
    segment_max,
    segment_sum,
)

#: Re-exported without adding an import line, so the alias surface matches dgl_shim.
EdgeDataView = _impl.EdgeDataView

__all__ = [
    "ALL",
    "DGLGraph",
    "EdgeDataView",
    "Graph",
    "__version__",
    "copy_e_sum",
    "e_dot_v",
    "edge_softmax",
    "graph",
    "install",
    "is_all",
    "nn",
    "ops",
    "segment_max",
    "segment_sum",
]
