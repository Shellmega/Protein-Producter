"""Errors raised by the ordered-curve adapter.

The probe is not an HTTP endpoint, so these exceptions reuse the *frozen* wire
error codes of ``contracts/ptg-graph/v1`` (see ``rules.json``) instead of
inventing a second vocabulary.  ``to_error()`` renders the same object shape the
contract uses for rejected imports, which lets the evidence files record a
concrete, locatable failure instead of a stack trace.
"""

from __future__ import annotations


class AdapterError(Exception):
    """Base class carrying a contract error code, field path and node ids."""

    default_code = "INTERNAL_ERROR"

    def __init__(self, code=None, *, field="$", node_ids=(), detail=""):
        self.code = code or self.default_code
        self.field = field
        self.node_ids = tuple(sorted(set(node_ids)))
        self.detail = detail
        message = "%s at %s" % (self.code, self.field)
        if self.node_ids:
            message += " (%s)" % ", ".join(self.node_ids)
        if detail:
            message += ": " + detail
        super().__init__(message)

    def to_error(self) -> dict:
        return {
            "error": {
                "code": self.code,
                "message": self.detail or self.code,
                "node_ids": list(self.node_ids),
                "field": self.field,
            }
        }


class GraphValidationError(AdapterError):
    """The source document is not an acceptable ``ptg-graph/1.0`` open chain."""


class TransformError(AdapterError):
    """The requested similarity transform is not admissible."""

    default_code = "DERIVATION_INVALID"
