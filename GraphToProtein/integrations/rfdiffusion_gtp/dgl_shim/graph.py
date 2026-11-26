"""Pure-PyTorch ``DGLGraph`` replacement used by the RFdiffusion DGL shim.

Only the graph surface touched by RFdiffusion / the vendored SE(3)-Transformer is
implemented (see ``evidence/p2/source_analysis/05_dgl_shim_spec.md``, section 5.4):

    graph(src, tgt, num_nodes=None) -> Graph
    .to(device) / .edata / .ndata / .edges() / .num_nodes() / .num_edges() / .device

Invariants verified against dgl 2.2.1 (spec section 5.3.1):

* edge ``e`` has id == its position in the ``(src, tgt)`` input arrays and the order is
  preserved verbatim -- no sorting, no de-duplication, self-loops and parallel edges are
  allowed.  This is load-bearing: ``rfdiffusion/util_module.py:155,193`` writes
  ``rel_pos`` in that order and ``se3_transformer/model/layers/convolution.py:281``
  later gathers node features through ``graph.edges()``; any reordering would silently
  desynchronise ``rel_pos`` from ``edges()``.
* ``src``/``dst`` are 1-D ``torch.int64`` tensors on the graph device.
* ``G.edata[key]`` is indexed by edge id and is moved by ``.to(device)``; assigning an
  edge tensor whose first dimension is not ``num_edges`` raises instead of corrupting
  the edge/eid-order correspondence.
* The object is device agnostic: it never creates device-specific tensors on its own and
  never calls ``.cpu()``.  Lists / numpy arrays are accepted by ``graph()`` through
  ``torch.as_tensor`` (this module does not import numpy).
"""

from __future__ import annotations

from collections.abc import MutableMapping

import torch

__all__ = ["Graph", "DGLGraph", "EdgeDataView", "graph"]


def _as_node_ids(value, name):
    """Return ``value`` as a 1-D ``torch.int64`` tensor, preserving element order."""
    if isinstance(value, torch.Tensor):
        tensor = value
    else:
        # Accepts python lists/tuples and numpy arrays without importing numpy.
        tensor = torch.as_tensor(value)
    if tensor.dim() != 1:
        raise ValueError(
            "dgl_shim.graph: {0} must be a 1-D sequence of node ids, got shape {1}".format(
                name, tuple(tensor.shape)
            )
        )
    if tensor.dtype != torch.int64:
        tensor = tensor.to(torch.int64)
    return tensor


class EdgeDataView(MutableMapping):
    """Dict-like edge feature store indexed by edge id (spec section 5.3.1)."""

    __slots__ = ("_owner", "_store")

    def __init__(self, owner):
        self._owner = owner
        self._store = {}

    def __getitem__(self, key):
        return self._store[key]

    def __setitem__(self, key, value):
        if not isinstance(value, torch.Tensor):
            raise TypeError(
                "dgl_shim: edge data {0!r} must be a torch.Tensor, got {1}".format(
                    key, type(value).__name__
                )
            )
        if value.dim() == 0:
            raise ValueError(
                "dgl_shim: edge data {0!r} must have a first (edge) dimension, got a "
                "0-dim tensor".format(key)
            )
        num_edges = self._owner.num_edges()
        if value.shape[0] != num_edges:
            raise ValueError(
                "dgl_shim: edge data {0!r} has first dimension {1}, expected {2} "
                "(num_edges). Edge data is stored in input order (spec 5.3.1), so a "
                "mismatched first dimension would silently desynchronise it from "
                "graph.edges().".format(key, value.shape[0], num_edges)
            )
        self._store[key] = value

    def __delitem__(self, key):
        del self._store[key]

    def __iter__(self):
        return iter(self._store)

    def __len__(self):
        return len(self._store)

    def __repr__(self):
        return "EdgeDataView({0})".format(", ".join(repr(k) for k in self._store))


class Graph:
    """Minimal pure-PyTorch stand-in for ``dgl.DGLGraph`` (spec section 5.4)."""

    def __init__(self, src, tgt, num_nodes=None):
        src_ids = _as_node_ids(src, "src")
        dst_ids = _as_node_ids(tgt, "tgt")
        if src_ids.numel() != dst_ids.numel():
            raise ValueError(
                "dgl_shim.graph: src and tgt must have the same number of edges, got "
                "{0} and {1}".format(src_ids.numel(), dst_ids.numel())
            )
        if src_ids.device != dst_ids.device:
            raise ValueError(
                "dgl_shim.graph: src and tgt must be on the same device, got {0} and "
                "{1}".format(src_ids.device, dst_ids.device)
            )

        num_edges = int(src_ids.numel())
        if num_nodes is None:
            if num_edges == 0:
                num_nodes = 0
            else:
                # dgl/convert.py:32 dgl.graph defaults num_nodes to max(node id) + 1.
                largest = max(int(src_ids.max()), int(dst_ids.max()))
                num_nodes = largest + 1
        else:
            num_nodes = int(num_nodes)
            if num_nodes < 0:
                raise ValueError(
                    "dgl_shim.graph: num_nodes must be non-negative, got {0}".format(
                        num_nodes
                    )
                )
            if num_edges:
                largest = max(int(src_ids.max()), int(dst_ids.max()))
                if largest >= num_nodes:
                    raise ValueError(
                        "dgl_shim.graph: node id {0} is out of range for "
                        "num_nodes={1}".format(largest, num_nodes)
                    )

        self._src = src_ids
        self._dst = dst_ids
        self._num_nodes = num_nodes
        self.edata = EdgeDataView(self)
        self.ndata = {}

    # ------------------------------------------------------------------ properties
    @property
    def device(self):
        """Device of the graph's id tensors (and of its edge data after ``.to``)."""
        return self._src.device

    # ------------------------------------------------------------------- dgl-like API
    def to(self, device):
        """Move ``src``/``dst`` and every edge-data tensor to ``device``, in place.

        dgl's ``.to`` returns a graph whose tensors live on ``device``; this shim moves
        in place and returns ``self`` (allowed by spec 5.3.1).  ``rfdiffusion/util_module.py``
        calls ``dgl.graph(...).to(device)`` *before* assigning ``edata['rel_pos']``, so
        in-place and copy semantics are indistinguishable there.
        """
        target = device if isinstance(device, torch.device) else torch.device(device)
        if self._src.device != target:
            self._src = self._src.to(target)
        if self._dst.device != target:
            self._dst = self._dst.to(target)
        for key, value in list(self.edata.items()):
            if value.device != target:
                self.edata[key] = value.to(target)
        return self

    def edges(self, order="srcdst"):
        """Return ``(src, dst)`` int64 tensors in edge-id order."""
        if order not in ("srcdst", "eid"):
            raise ValueError(
                "dgl_shim: edges(order=...) only supports 'srcdst'/'eid' (row order is "
                "always edge-id order), got {0!r}".format(order)
            )
        return self._src, self._dst

    def num_nodes(self):
        return self._num_nodes

    def num_edges(self):
        return int(self._src.numel())

    def num_src_nodes(self):
        return self._num_nodes

    def num_dst_nodes(self):
        return self._num_nodes

    def __repr__(self):
        return "Graph(num_nodes={0}, num_edges={1}, device='{2}')".format(
            self._num_nodes, self.num_edges(), self.device
        )


#: ``from dgl import DGLGraph`` only needs the name to exist (it is used purely as a type
#: annotation in the vendored SE(3)-Transformer, spec section 5.3.5).
DGLGraph = Graph


def graph(src, tgt=None, num_nodes=None, **kwargs):
    """Create a :class:`Graph`.

    Accepts either ``graph(src, tgt, num_nodes=N)`` or dgl's two-tuple spelling
    ``graph((src, tgt), num_nodes=N)``.  ``src``/``tgt`` may be 1-D int64 tensors,
    python sequences or numpy arrays; they are stored verbatim (same order, no
    de-duplication).
    """
    if tgt is None:
        if isinstance(src, (tuple, list)) and len(src) == 2:
            src, tgt = src
        else:
            raise TypeError(
                "dgl_shim.graph: expected (src, tgt) or a 2-tuple of them, got a single "
                "{0}".format(type(src).__name__)
            )
    if kwargs:
        raise TypeError(
            "dgl_shim.graph: unsupported keyword argument(s): {0}".format(
                ", ".join(sorted(kwargs))
            )
        )
    return Graph(src, tgt, num_nodes=num_nodes)
