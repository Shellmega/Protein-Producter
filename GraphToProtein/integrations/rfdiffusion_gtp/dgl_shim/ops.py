"""Pure-PyTorch implementations of the three DGL operators RFdiffusion uses.

Every semantic below was verified against the dgl 2.2.1 cp312 win_amd64 CPU wheel
(``local/envs/p2/Lib/site-packages/dgl``) and is cross-checked by
``tests/p2/gpu/test_dgl_shim_ops.py`` (in-process parity against real dgl) and
``tests/p2/gpu/test_dgl_shim_reference.py`` (independent numpy reference).

* ``e_dot_v`` is a generated SDDMM op: ``_gen_sddmm_func("e", "v", "dot")``
  (``dgl/ops/sddmm.py:101-103``; ``target_dict = {"u": "source node", "e": "edge",
  "v": "destination node"}``).  The node operand is therefore indexed by DESTINATION
  nodes and the last axis is contracted with keepdim::

      out[e, ..., k] = sum_last(lhs[e, ..., :] * rhs[dst[e], ..., :])
      out.shape      = broadcast(lhs, rhs_padded).shape[:-1] + (1,)

  Rank padding follows dgl's ``reshape_lhs_rhs`` (``dgl/ops/sddmm.py:14-41``): the
  smaller-rank operand gets singleton dims AFTER axis 0 (e.g. ``rhs [N,K]`` with
  ``lhs [E,H,K]`` becomes ``rhs [N,1,K]``).  Do not reduce over ``src``: keys come from
  source nodes but queries come from destination nodes (``attention.py:93``).

* ``copy_e_sum`` is a generated SpMM op: ``copy_e`` -> ``gspmm(g, "copy_rhs", "sum",
  None, x)`` (``dgl/ops/spmm.py:180-217``) and SpMM aggregates the messages on
  DESTINATION nodes (``dgl/ops/spmm.py:33-79``)::

      out = zeros(num_nodes, *x.shape[1:]); out.index_add_(0, dst, x)

  Nodes without incoming edges stay zero, duplicate edges accumulate, dtype/device are
  preserved.  dgl 2.2.1 rejects node-shaped data here (it checks the first dimension
  equals the number of edges), so this shim does too instead of guessing a direction.

* ``edge_softmax`` (``dgl/ops/edge_softmax.py:12``) normalises over the incoming edges
  of each destination node.  dgl's CPU path is ``segment_softmax``
  (``dgl/ops/segment.py:62-102``): per-segment max subtraction, then exp, then
  per-segment sum.  The normalisation is element-wise over the trailing dimensions, so
  ``[E, H]`` and ``[E, H, 1]`` are both supported.

Everything is differentiable and device agnostic (no numpy, no ``.cpu()``, no hard-coded
device strings); all outputs live on the same device/dtype as the inputs.

Deterministic CUDA reductions
-----------------------------
``index_add``/``scatter_reduce`` use floating point atomics on CUDA, so float32
accumulation order -- and therefore the bits of the result -- depends on thread
scheduling.  That is harmless for a single run but breaks bitwise reproducibility and
was measured to shift repeated RFdiffusion GPU designs by 0.02-0.94 A CA RMSD.  For CUDA
tensors the shim therefore accumulates segment sums with a stable sort by segment id plus
a segmented cumulative sum (``argsort(stable=True)`` -> ``cumsum`` -> prefix differences
at segment starts/ends), which is a fixed-order, atomics-free reduction.  The CPU path
keeps the plain ``index_add`` (already bitwise deterministic) so existing CPU evidence
stays comparable.

Control (explicit, module-level, no hidden per-call state)::

    import dgl_shim
    dgl_shim.ops.deterministic_reductions_enabled()          # effective policy / device
    dgl_shim.ops.deterministic_reductions_policy()           # "auto" | "on" | "off"
    dgl_shim.ops.set_deterministic_reductions(True)          # force on (CPU too)
    dgl_shim.ops.set_deterministic_reductions(False)         # force the scatter path
    dgl_shim.ops.set_deterministic_reductions(None)          # back to "auto"

or set ``GTP_DGL_SHIM_DETERMINISTIC=1|0`` before importing.  "auto" (the default) means:
deterministic path on CUDA tensors, legacy scatter path on CPU tensors.  ``segment_max``
stays a scatter reduction on purpose: max is order-insensitive, so its *value* is already
bitwise deterministic (verified by ``test_dgl_shim_cuda.py``); only sums need reordering.
The deterministic scan internally accumulates float32 inputs in float64 and casts the
result back (prefix differences lose ~1e-5 in pure float32 at the L=60 graph size; see
``_deterministic_scan_dtype``); output dtype/device are unchanged and parity against real
dgl 2.2.1 is re-verified by the p2 suite.
"""

from __future__ import annotations

import os
import weakref

import torch

__all__ = [
    "ALL",
    "is_all",
    "e_dot_v",
    "copy_e_sum",
    "edge_softmax",
    "segment_sum",
    "segment_max",
    "set_deterministic_reductions",
    "deterministic_reductions_enabled",
    "deterministic_reductions_policy",
]


# ``dgl.base`` defines the "all edges" sentinel as the literal string "__ALL__"
# (dgl/base.py:10) and ``is_all`` as an isinstance+equality check (dgl/base.py:27-29).
ALL = "__ALL__"


def is_all(value):
    """Return True when ``value`` is dgl's ALL sentinel (``"__ALL__"``)."""
    return isinstance(value, str) and value == ALL


# ---------------------------------------------------------------------------------
# deterministic-reduction control
# ---------------------------------------------------------------------------------
#: Environment variable read once at import time: ``1``/``true``/``on`` forces the
#: deterministic path everywhere, ``0``/``false``/``off`` forces the fast scatter path,
#: unset/invalid means "auto" (deterministic on CUDA, fast path on CPU).
DETERMINISTIC_ENV_VAR = "GTP_DGL_SHIM_DETERMINISTIC"

#: ``None`` == auto; ``True``/``False`` == explicit override set through
#: :func:`set_deterministic_reductions`.  This is the only state that influences the
#: choice between the two reduction implementations, and it changes only through the
#: explicit setter (never inside an op), so op behaviour cannot drift between calls.
_deterministic_override = None


def _parse_deterministic_env(raw):
    if raw is None:
        return None
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    return None


_deterministic_override = _parse_deterministic_env(os.environ.get(DETERMINISTIC_ENV_VAR))


def set_deterministic_reductions(enabled):
    """Select the deterministic (sort + segmented cumsum) reduction path.

    ``True`` forces it for every device, ``False`` forces the fast scatter path, and
    ``None`` restores the default policy ("auto": deterministic for CUDA tensors, fast
    ``index_add`` for CPU tensors, which is already bitwise deterministic).  Returns the
    stored override (``True``/``False``/``None``).  The choice never changes implicitly.
    """
    global _deterministic_override
    _deterministic_override = None if enabled is None else bool(enabled)
    return _deterministic_override


def deterministic_reductions_policy():
    """Return ``"auto"``, ``"on"`` or ``"off"`` for the current reduction policy."""
    if _deterministic_override is None:
        return "auto"
    return "on" if _deterministic_override else "off"


def deterministic_reductions_enabled(device=None):
    """Return whether the deterministic reduction path is selected for ``device``.

    ``device=None`` reports the policy level: ``True`` means the deterministic path is
    used on CUDA (the "auto" default), ``False`` only when explicitly forced off.
    With a device, ``"auto"`` returns ``True`` for CUDA tensors and ``False`` for CPU
    tensors -- on CPU ``False`` still means bitwise-deterministic results, because the
    plain ``index_add`` scatter path is deterministic there.
    """
    if _deterministic_override is not None:
        return _deterministic_override
    if device is None:
        return True
    resolved = device if isinstance(device, torch.device) else torch.device(device)
    return resolved.type == "cuda"


def _use_deterministic_path(values):
    """Effective decision for the tensors an op is about to reduce."""
    if _deterministic_override is not None:
        return _deterministic_override
    return values.device.type == "cuda"


# ---------------------------------------------------------------------------------
# internal helpers
# ---------------------------------------------------------------------------------
def _check_edge_tensor(graph, tensor, op_name):
    """Validate that ``tensor``'s first dimension is ``graph.num_edges()``."""
    if not isinstance(tensor, torch.Tensor):
        raise TypeError(
            "dgl_shim.ops.{0}: expected a torch.Tensor, got {1}".format(
                op_name, type(tensor).__name__
            )
        )
    if tensor.dim() < 1:
        raise ValueError(
            "dgl_shim.ops.{0}: expected at least a 1-D tensor, got a 0-dim tensor".format(
                op_name
            )
        )
    num_edges = int(graph.num_edges())
    if tensor.shape[0] != num_edges:
        raise ValueError(
            "dgl_shim.ops.{0}: first dimension is {1}, expected {2} (num_edges). "
            "dgl 2.2.1 checks the same thing (dgl/ops/spmm.py:180-217, "
            "dgl/src/array/check.h); passing node-shaped data here is a direction "
            "bug, not a shape to guess.".format(op_name, tensor.shape[0], num_edges)
        )


def _check_index_vector(index):
    if not isinstance(index, torch.Tensor):
        raise TypeError(
            "dgl_shim.ops: segment index must be a torch.Tensor, got {0}".format(
                type(index).__name__
            )
        )
    if index.dim() != 1:
        raise ValueError(
            "dgl_shim.ops: segment index must be 1-D, got shape {0}".format(
                tuple(index.shape)
            )
        )


def _reshape_lhs_rhs(lhs, rhs):
    """Pad the smaller-rank operand with singleton dims AFTER axis 0.

    Mirrors dgl's ``reshape_lhs_rhs`` (``dgl/ops/sddmm.py:14-41``) exactly, e.g.
    ``(N, 3, 1)`` / ``(E, 5, 3, 4)`` -> ``(N, 1, 3, 1)`` / ``(E, 5, 3, 4)``.
    """
    lhs_ndim = lhs.dim()
    rhs_ndim = rhs.dim()
    if lhs_ndim == rhs_ndim:
        return lhs, rhs
    max_ndims = max(lhs_ndim, rhs_ndim)
    lhs = lhs.reshape((lhs.shape[0],) + (1,) * (max_ndims - lhs_ndim) + tuple(lhs.shape[1:]))
    rhs = rhs.reshape((rhs.shape[0],) + (1,) * (max_ndims - rhs_ndim) + tuple(rhs.shape[1:]))
    return lhs, rhs


# ---------------------------------------------------------------------------------
# segment helpers
# ---------------------------------------------------------------------------------
def _build_segment_metadata(index, num_nodes):
    """Index-only bookkeeping for the deterministic segmented sum.

    Edges are stably sorted by segment id; for node ``n``, ``starts[n]``/``ends[n]`` are
    the half-open range of its edges in that sorted order (``starts == ends`` when the
    node has no incoming edges).  The segment sum is then
    ``prefix[ends] - prefix[starts]`` where ``prefix`` is the cumulative sum over sorted
    edges.  This is pure index arithmetic: no feature values are stored, so a cache of
    it can never change results.
    """
    num_edges = int(index.numel())
    order = torch.argsort(index, stable=True)
    sorted_index = index.index_select(0, order)
    nodes = torch.arange(int(num_nodes), dtype=index.dtype, device=index.device)
    starts = torch.searchsorted(sorted_index, nodes)
    ends = torch.searchsorted(sorted_index, nodes, right=True)
    return {
        "index": None,
        "num_nodes": int(num_nodes),
        "num_edges": num_edges,
        "order": order,
        "starts": starts,
        "ends": ends,
    }


#: Per-graph memoisation of the index metadata above, keyed weakly by the graph object.
#: An entry is only reused for the *same index tensor object* (a ``.to()`` device move
#: replaces the tensors and naturally invalidates it).  This is a pure index-arithmetic
#: cache; it cannot alter op results, it only avoids recomputing the sort for each of the
#: (up to three) reduction calls that share one graph in a layer.
_METADATA_CACHE = weakref.WeakKeyDictionary()


def _metadata_for_graph(graph, index, num_nodes):
    """Return cached index metadata for ``(graph, index tensor)``, building it if needed."""
    entries = None
    try:
        entries = _METADATA_CACHE.get(graph)
    except TypeError:  # unhashable / not weak-referenceable graph object: no caching
        entries = None
    if entries is None:
        entries = []
        try:
            _METADATA_CACHE[graph] = entries
        except TypeError:
            entries = None
    if entries is not None:
        for metadata in entries:
            if metadata["index"] is index and metadata["num_nodes"] == int(num_nodes):
                return metadata
    metadata = _build_segment_metadata(index, num_nodes)
    metadata["index"] = index
    if entries is not None:
        entries.append(metadata)
        if len(entries) > 2:  # 'dst' and (optionally) 'src' normalisation
            entries.pop(0)
    return metadata


def _segment_sum_scatter(values, index, num_nodes):
    """Fast path: one scatter-add (bitwise deterministic on CPU; CUDA uses atomics)."""
    out = values.new_zeros((int(num_nodes),) + tuple(values.shape[1:]))
    if values.shape[0] == 0:
        return out
    return out.index_add(0, index, values)


def _deterministic_scan_dtype(dtype):
    """Accumulation dtype of the deterministic cumsum scan.

    The scan runs in ``float64`` for float32/float16 inputs and is cast back to the input
    dtype at the end.  Reason (measured, see README/report): a float32 prefix sum over the
    ~3540-edge L=60 full graph accumulates up to ~1e-5 absolute error in the segment sums
    (and ~1e-5 in edge-softmax weights) because segment sums are prefix differences; the
    float64 scan keeps the result within ~1e-6 of the exact sum (and ~6e-8 for edge
    softmax) at <10% extra cost of the reduction path.  Dtype/device of the *output* are
    unchanged; only the internal accumulation is wider.  This is deliberate, not silent:
    parity against real dgl 2.2.1 is re-verified by the p2 test suite, and the narrower
    float32 scan was measured to still pass that parity bar (it is simply less accurate).
    """
    if dtype in (torch.float16, torch.bfloat16, torch.float32):
        return torch.float64
    return dtype


def _segment_sum_deterministic(values, metadata, num_nodes):
    """Atomics-free segmented sum: stable sort + segmented cumsum + prefix differences.

    The kernel sequence and the accumulation order are fixed for identical inputs (a
    stable argsort, a cumsum along a contiguous dimension, two gathers, one subtraction),
    so CUDA results are bitwise reproducible.  The internal scan accumulates in
    ``float64`` for 32-bit float inputs (see :func:`_deterministic_scan_dtype`) and the
    result is cast back to the input dtype, so the output dtype/device semantics are
    unchanged.
    """
    num_edges = int(values.shape[0])
    tail = tuple(values.shape[1:])
    if num_edges == 0:
        return values.new_zeros((int(num_nodes),) + tail)
    sorted_values = values.index_select(0, metadata["order"])
    flat = sorted_values.reshape(num_edges, -1)
    # [num_tail_elements, E]: cumsum along the last (contiguous) dimension is ~30x faster
    # on CUDA than scanning axis 0.
    columns = flat.transpose(0, 1).contiguous()
    scan_dtype = _deterministic_scan_dtype(values.dtype)
    if columns.dtype != scan_dtype:
        columns = columns.to(scan_dtype)
    prefix = torch.cumsum(columns, dim=1)
    zeros = torch.zeros((prefix.shape[0], 1), dtype=prefix.dtype, device=prefix.device)
    prefix = torch.cat([zeros, prefix], dim=1)  # prefix[:, k] == sum of the first k edges
    totals = prefix.index_select(1, metadata["ends"]) - prefix.index_select(1, metadata["starts"])
    return totals.to(values.dtype).transpose(0, 1).contiguous().reshape((int(num_nodes),) + tail)


class _DeterministicSegmentSum(torch.autograd.Function):
    """Autograd wrapper for the sorted-cumsum segment sum.

    The forward pass is the atomics-free, fixed-order reduction.  The backward pass is the
    exact gather ``grad_out[index]`` -- for a segment sum
    ``d out[n, ...] / d values[e, ...] == 1`` when ``index[e] == n`` -- which is also
    exactly what the scatter path's autograd computes.  Taking the gradient explicitly
    avoids the tiny rounding error a reverse cumulative sum would otherwise add, so the
    deterministic path has the same gradients as the old one rather than merely close
    ones.  (Second-order gradients are not supported; inference runs under ``no_grad``.)
    """

    @staticmethod
    def forward(ctx, values, metadata, num_nodes, index):
        ctx.save_for_backward(index)
        return _segment_sum_deterministic(values, metadata, num_nodes)

    @staticmethod
    def backward(ctx, grad_output):
        (index,) = ctx.saved_tensors
        return grad_output.index_select(0, index), None, None, None


def segment_sum(values, index, num_nodes):
    """Sum ``values`` into ``num_nodes`` segments given by ``index`` (1-D int).

    ``values`` may have arbitrary trailing dimensions; those are reduced independently
    (``out`` has shape ``(num_nodes, *values.shape[1:])``).  Segments with no element
    stay 0.  On CUDA the deterministic sort + segmented-cumsum path is used by default
    (see the module docstring), so identical inputs give bitwise-identical outputs; pass
    ``set_deterministic_reductions(False)`` to benchmark the old scatter path.
    """
    _check_index_vector(index)
    if not isinstance(values, torch.Tensor):
        raise TypeError(
            "dgl_shim.ops.segment_sum: values must be a torch.Tensor, got {0}".format(
                type(values).__name__
            )
        )
    if values.dim() < 1:
        raise ValueError("dgl_shim.ops.segment_sum: values must have at least one dimension")
    if index.numel() != values.shape[0]:
        raise ValueError(
            "dgl_shim.ops.segment_sum: index has {0} entries but values has {1} "
            "rows".format(index.numel(), values.shape[0])
        )
    if _use_deterministic_path(values):
        metadata = _build_segment_metadata(index, num_nodes)
        return _DeterministicSegmentSum.apply(values, metadata, int(num_nodes), index)
    return _segment_sum_scatter(values, index, num_nodes)


def _segment_sum_for_graph(graph, values, index, num_nodes):
    """Internal :func:`segment_sum` that reuses the per-graph sort metadata cache."""
    if _use_deterministic_path(values):
        metadata = _metadata_for_graph(graph, index, num_nodes)
        return _DeterministicSegmentSum.apply(values, metadata, int(num_nodes), index)
    return _segment_sum_scatter(values, index, num_nodes)


def segment_max(values, index, num_nodes):
    """Max-reduce ``values`` per segment and per trailing index.

    Segments with no element hold ``-inf`` (which is never read back for segment
    softmax because only segments referenced by ``index`` are gathered).  Uses
    ``Tensor.scatter_reduce_`` with ``reduce="amax"`` (documented as supported on CUDA
    tensors; see the ``scatter_reduce_`` docstring: "This operation may behave
    nondeterministically when given tensors on a CUDA device") and falls back to the
    equivalent ``index_reduce_("amax")`` spelling on builds where the former is not
    available.
    """
    _check_index_vector(index)
    if not isinstance(values, torch.Tensor):
        raise TypeError(
            "dgl_shim.ops.segment_max: values must be a torch.Tensor, got {0}".format(
                type(values).__name__
            )
        )
    if values.dim() < 1:
        raise ValueError("dgl_shim.ops.segment_max: values must have at least one dimension")
    if not values.is_floating_point():
        raise TypeError(
            "dgl_shim.ops.segment_max: values must be a floating point tensor (the "
            "empty-segment fill value is -inf), got {0}".format(values.dtype)
        )
    if index.numel() != values.shape[0]:
        raise ValueError(
            "dgl_shim.ops.segment_max: index has {0} entries but values has {1} "
            "rows".format(index.numel(), values.shape[0])
        )
    out = values.new_full((int(num_nodes),) + tuple(values.shape[1:]), float("-inf"))
    if values.shape[0] == 0:
        return out
    # expand()+contiguous() gives each edge row its segment id (cheap: segment softmax only
    # ever calls this with the [E, H] logits of the attention heads).
    index_expanded = (
        index.reshape((-1,) + (1,) * (values.dim() - 1)).expand_as(values).contiguous()
    )
    try:
        return out.scatter_reduce_(0, index_expanded, values, reduce="amax", include_self=True)
    except RuntimeError:
        return out.index_reduce_(0, index, values, "amax", include_self=True)


# ---------------------------------------------------------------------------------
# public operators
# ---------------------------------------------------------------------------------
def e_dot_v(graph, lhs, rhs):
    """``dgl.ops.e_dot_v``: edge dot destination-node features -> ``[E, ..., 1]``.

    ``lhs`` is the edge operand (``[E, ...]``) and ``rhs`` the destination-node operand
    (``[N, ...]``; padded per ``reshape_lhs_rhs`` when the ranks differ).  The last axis
    is contracted with keepdim.  Output shape is the broadcast shape minus its last
    dimension plus a trailing 1.
    """
    if not isinstance(lhs, torch.Tensor) or not isinstance(rhs, torch.Tensor):
        raise TypeError(
            "dgl_shim.ops.e_dot_v: lhs and rhs must be torch.Tensors, got {0} / "
            "{1}".format(type(lhs).__name__, type(rhs).__name__)
        )
    if lhs.dim() < 2 or rhs.dim() < 2:
        raise ValueError(
            "dgl_shim.ops.e_dot_v: both operands need a contractible last axis, got "
            "shapes {0} and {1}".format(tuple(lhs.shape), tuple(rhs.shape))
        )
    _check_edge_tensor(graph, lhs, "e_dot_v")
    _, dst = graph.edges()  # 'v' target == destination node (dgl/ops/sddmm.py:103)
    lhs_padded, rhs_padded = _reshape_lhs_rhs(lhs, rhs)
    rhs_at_dst = rhs_padded.index_select(0, dst)
    return (lhs_padded * rhs_at_dst).sum(dim=-1, keepdim=True)


def copy_e_sum(graph, x):
    """``dgl.ops.copy_e_sum``: scatter-add edge features onto destination nodes.

    ``out[dst[e]] += x[e]``; output shape is ``(num_nodes, *x.shape[1:])``.  Nodes with
    no incoming edges are zero, duplicate edges accumulate.  Uses the deterministic
    CUDA reduction path by default (see :func:`segment_sum`).
    """
    _check_edge_tensor(graph, x, "copy_e_sum")
    _, dst = graph.edges()
    return _segment_sum_for_graph(graph, x, dst, int(graph.num_nodes()))


def edge_softmax(graph, logits, eids=ALL, norm_by="dst"):
    """``dgl.ops.edge_softmax``: per-node softmax over the incoming (or outgoing) edges.

    ``logits`` has shape ``[E, *tail]``; the softmax runs over the edge axis inside each
    destination node segment, independently for every trailing index.  Numerically
    stable (per-segment max is subtracted first, like dgl's ``segment_softmax``,
    ``dgl/ops/segment.py:62-102``), so large logits do not overflow.  Nodes with no
    incident edges never appear in the output, hence no NaN is produced.

    ``eids`` must be dgl's ALL sentinel (the only form the RFdiffusion inference path
    uses, spec section 5.3.4); other selections raise ``NotImplementedError``.
    ``norm_by`` supports ``"dst"`` (default) and ``"src"``.
    """
    if not is_all(eids):
        raise NotImplementedError(
            "dgl_shim.ops.edge_softmax: only eids=ALL is implemented (RFdiffusion calls "
            "the all-edges form, spec 5.3.4); got {0!r}".format(eids)
        )
    if norm_by not in ("dst", "src"):
        raise ValueError(
            "dgl_shim.ops.edge_softmax: norm_by must be 'dst' or 'src', got "
            "{0!r}".format(norm_by)
        )
    _check_edge_tensor(graph, logits, "edge_softmax")
    src, dst = graph.edges()
    if logits.numel() == 0:
        return logits.clone()
    index = dst if norm_by == "dst" else src
    num_nodes = int(graph.num_nodes())
    shape = tuple(logits.shape)
    flat = logits.reshape(shape[0], -1)

    # max subtraction is mathematically an exact shift (softmax is shift invariant, so
    # d(softmax)/d(max) == 0); detaching it keeps autograd away from scatter_reduce's
    # amax backward, which would otherwise not be implemented.
    segment_maxima = segment_max(flat, index, num_nodes).detach()
    exponents = torch.exp(flat - segment_maxima.index_select(0, index))
    denominators = _segment_sum_for_graph(graph, exponents, index, num_nodes)
    out = exponents / denominators.index_select(0, index)
    return out.reshape(shape)
