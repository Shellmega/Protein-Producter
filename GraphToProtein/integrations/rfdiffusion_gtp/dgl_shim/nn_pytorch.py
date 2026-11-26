"""Import-compatible placeholders for the ``dgl.nn.pytorch`` pooling classes.

``se3_transformer/model/layers/pooling.py:28`` does
``from dgl.nn.pytorch import AvgPooling, MaxPooling`` at import time, but RFdiffusion
never instantiates or calls them: ``SE3TransformerWrapper`` passes no ``pooling``
(``rfdiffusion/SE3_network.py:42-49``), so the names only have to exist (spec section
5.3.5).  They fail loudly if someone actually uses them.
"""

from __future__ import annotations

import torch.nn as nn

__all__ = ["AvgPooling", "MaxPooling"]


class _UnsupportedPooling(nn.Module):
    """Placeholder that refuses to run: the shim does not implement pooling."""

    def __init__(self):
        super().__init__()

    def forward(self, graph, feat, *args, **kwargs):
        raise NotImplementedError(
            "{0} is only an import placeholder in dgl_shim: RFdiffusion's inference path "
            "never uses dgl pooling (spec section 5.3.5). If a code path needs it, the "
            "operation has to be implemented explicitly instead of being guessed.".format(
                type(self).__name__
            )
        )

    def __repr__(self):
        return "{0}()".format(type(self).__name__)


class AvgPooling(_UnsupportedPooling):
    """Placeholder for ``dgl.nn.pytorch.AvgPooling`` (unused by RFdiffusion)."""


class MaxPooling(_UnsupportedPooling):
    """Placeholder for ``dgl.nn.pytorch.MaxPooling`` (unused by RFdiffusion)."""
