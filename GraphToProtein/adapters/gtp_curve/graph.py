"""Load, validate and walk a ``ptg-graph/1.0`` open-chain source graph.

The probe needs exactly one thing from the wire document that the rest of the
contract already freezes: the **ordered** N -> C path.  ``spec.md`` 2.1 says the
chain order is computed from graph structure and ``n_terminal_node`` and that
"node table, adjacency dictionary and neighbour array order carry no semantics,
they only affect serialisation".  This module implements that walk and the
validation stages that make it well defined (contract stages 2, 4, 5, 6, 7 of
``spec.md`` 5.1), reusing the frozen error codes.

Nothing here depends on file order: the only ordered walk is
``walk_ordered_path``, driven by ``n_terminal_node`` and ``adjacency``.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import geometry
from .errors import GraphValidationError

SCHEMA_VERSION = "ptg-graph/1.0"
PROFILE = "protein_open_chain_v1"
PRODUCER = "PhotoToGraph"

COORDINATE_SYSTEM = {
    "dimension": 3,
    "unit": "scene_unit",
    "handedness": "right",
    "axes": "xyz",
}

NODE_COUNT_MIN = 2
NODE_COUNT_MAX = 2048
COORDINATE_COMPONENT_ABS_MAX = 1.0e6
DEGREE_MAX = 2
ENDPOINT_DEGREE = 1

IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

REQUIRED_TOP_LEVEL = (
    "schema_version",
    "profile",
    "producer",
    "producer_instance_id",
    "graph_id",
    "revision",
    "source",
    "coordinate_system",
    "nodes",
    "adjacency",
    "n_terminal_node",
)


def _reject_constant(name):
    raise GraphValidationError(
        "NUMBER_NOT_REPRESENTABLE",
        field="$",
        detail="non-finite JSON number %r is not a representable binary64 value" % (name,),
    )


def has_json_duplicate_keys(pairs):
    """``object_pairs_hook`` that rejects duplicate object keys (stage 1)."""
    seen = set()
    for key, _ in pairs:
        if key in seen:
            raise GraphValidationError(
                "DUPLICATE_JSON_KEY", field="$", detail="duplicate object key %r" % (key,)
            )
        seen.add(key)
    return dict(pairs)


def read_json_document(path) -> dict:
    text = Path(path).read_text(encoding="utf-8")
    return json.loads(
        text,
        object_pairs_hook=has_json_duplicate_keys,
        parse_constant=_reject_constant,
    )


# ---------------------------------------------------------------------------
# validated graph
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class SourceGraph:
    """A validated single open chain, with its computed N -> C path."""

    document: dict
    path: tuple[str, ...]
    positions: dict[str, tuple[float, float, float]]
    adjacency: dict[str, tuple[str, ...]]
    n_terminal_node: str
    graph_path: str | None = None
    extra: dict = field(default_factory=dict)

    # -- ordered geometry ---------------------------------------------------
    @property
    def node_order(self) -> list[str]:
        """Ordered node ids along the path, N terminus first."""
        return list(self.path)

    @property
    def control_points(self) -> list[list[float]]:
        """Ordered control points in source units (``scene_unit``)."""
        return [list(self.positions[node_id]) for node_id in self.path]

    def source_geometry(self) -> dict:
        metrics = geometry.path_metrics(self.control_points)
        return {
            "unit": COORDINATE_SYSTEM["unit"],
            "node_order": list(self.path),
            "n_terminal_node": self.n_terminal_node,
            "point_count": len(self.path),
            "path_length": metrics["path_length"],
            "segment_lengths": geometry.segment_lengths(self.control_points),
            "bbox_min": metrics["bbox_min"],
            "bbox_max": metrics["bbox_max"],
            "centroid": metrics["centroid"],
            "pair_distance_min": metrics["pair_distance_min"],
            "pair_distance_max": metrics["pair_distance_max"],
            "non_coplanarity": metrics["non_coplanarity"],
        }

    # -- identity -----------------------------------------------------------
    @property
    def graph_id(self) -> str:
        return self.document["graph_id"]

    @property
    def revision(self) -> int:
        return int(self.document["revision"])

    def with_positions(self, positions: dict, *, graph_path: str | None = None) -> "SourceGraph":
        """Return a copy of this graph with replaced node positions (same topology)."""
        document = json.loads(json.dumps(self.document))
        for node in document["nodes"]:
            if node["id"] in positions:
                node["position"] = [float(value) for value in positions[node["id"]]]
        new_positions = dict(self.positions)
        new_positions.update({key: tuple(float(v) for v in value) for key, value in positions.items()})
        return SourceGraph(
            document=document,
            path=self.path,
            positions=new_positions,
            adjacency=self.adjacency,
            n_terminal_node=self.n_terminal_node,
            graph_path=graph_path if graph_path is not None else self.graph_path,
            extra=dict(self.extra),
        )


# ---------------------------------------------------------------------------
# validation (contract stages 2, 4, 5, 6, 7)
# ---------------------------------------------------------------------------
def _require(condition: bool, code: str, *, field: str = "$", node_ids=(), detail: str = ""):
    if not condition:
        raise GraphValidationError(code, field=field, node_ids=node_ids, detail=detail)


def _validate_identifier(value: str, *, field: str, node_ids=()) -> None:
    _require(
        isinstance(value, str) and bool(IDENTIFIER_PATTERN.match(value)),
        "FIELD_INVALID",
        field=field,
        node_ids=node_ids,
        detail="identifier %r does not match %s" % (value, IDENTIFIER_PATTERN.pattern),
    )


def validate_source_graph(document: dict, *, graph_path: str | None = None) -> SourceGraph:
    """Validate a parsed document and return the ordered open chain.

    Raises :class:`GraphValidationError` with the contract's first deterministic
    error code for the failing stage.
    """
    _require(isinstance(document, dict), "FIELD_INVALID", field="$", detail="document must be an object")
    for member in REQUIRED_TOP_LEVEL:
        _require(member in document, "FIELD_INVALID", field=member, detail="missing required member")

    # stage 2: version ------------------------------------------------------
    _require(
        document["schema_version"] == SCHEMA_VERSION,
        "SCHEMA_UNSUPPORTED",
        field="schema_version",
        detail="expected %s, got %r" % (SCHEMA_VERSION, document["schema_version"]),
    )
    _require(
        document["profile"] == PROFILE,
        "PROFILE_UNSUPPORTED",
        field="profile",
        detail="expected %s, got %r" % (PROFILE, document["profile"]),
    )
    _require(
        document["producer"] == PRODUCER,
        "FIELD_INVALID",
        field="producer",
        detail="producer must be %s" % PRODUCER,
    )

    # stage 4: structure ----------------------------------------------------
    coordinate_system = document["coordinate_system"]
    _require(
        isinstance(coordinate_system, dict), "FIELD_INVALID", field="coordinate_system"
    )
    for key, expected in COORDINATE_SYSTEM.items():
        _require(
            coordinate_system.get(key) == expected,
            "FIELD_INVALID",
            field="coordinate_system." + key,
            detail="expected %r, got %r" % (expected, coordinate_system.get(key)),
        )
    _validate_identifier(document["producer_instance_id"], field="producer_instance_id")
    _validate_identifier(document["graph_id"], field="graph_id")
    _validate_identifier(document["coordinate_system"]["frame_id"], field="coordinate_system.frame_id")
    revision = document["revision"]
    _require(
        isinstance(revision, int) and not isinstance(revision, bool),
        "FIELD_INVALID",
        field="revision",
        detail="revision must be a JSON integer",
    )
    _require(
        1 <= revision <= 9007199254740991,
        "FIELD_INVALID",
        field="revision",
        detail="revision out of the frozen range 1..2^53-1",
    )
    _require(
        isinstance(document["source"], dict) and document["source"].get("kind") == "interactive_3d",
        "FIELD_INVALID",
        field="source.kind",
        detail="source.kind must be interactive_3d",
    )

    nodes = document["nodes"]
    _require(isinstance(nodes, list), "FIELD_INVALID", field="nodes")
    _require(
        NODE_COUNT_MIN <= len(nodes) <= NODE_COUNT_MAX,
        "NODE_COUNT_LIMIT",
        field="nodes",
        detail="node count %d outside 2..2048" % len(nodes),
    )

    positions: dict[str, tuple[float, float, float]] = {}
    node_order: list[str] = []
    for index, node in enumerate(nodes):
        _require(isinstance(node, dict), "FIELD_INVALID", field="nodes[%d]" % index)
        _require("id" in node, "FIELD_INVALID", field="nodes[%d].id" % index)
        _require("position" in node, "FIELD_INVALID", field="nodes[%d].position" % index)
        node_id = node["id"]
        _validate_identifier(node_id, field="nodes[%d].id" % index, node_ids=(node_id,))
        _require(
            node_id not in positions,
            "NODE_ID_DUPLICATE",
            field="nodes",
            node_ids=(node_id,),
            detail="node id %r appears more than once" % (node_id,),
        )
        raw_position = node["position"]
        _require(
            isinstance(raw_position, list) and len(raw_position) == 3,
            "COORDINATE_INVALID",
            field="nodes[%d].position" % index,
            node_ids=(node_id,),
            detail="position must have exactly 3 components",
        )
        components = []
        for component_index, component in enumerate(raw_position):
            _require(
                isinstance(component, (int, float)) and not isinstance(component, bool),
                "COORDINATE_INVALID",
                field="nodes[%d].position[%d]" % (index, component_index),
                node_ids=(node_id,),
                detail="coordinate component must be a JSON number",
            )
            value = float(component)
            _require(
                math.isfinite(value),
                "COORDINATE_INVALID",
                field="nodes[%d].position[%d]" % (index, component_index),
                node_ids=(node_id,),
                detail="coordinate component must be finite",
            )
            _require(
                abs(value) <= COORDINATE_COMPONENT_ABS_MAX,
                "COORDINATE_INVALID",
                field="nodes[%d].position[%d]" % (index, component_index),
                node_ids=(node_id,),
                detail="coordinate component exceeds the +-1e6 bound",
            )
            components.append(value)
        positions[node_id] = (components[0], components[1], components[2])
        node_order.append(node_id)

    # stage 5: graph --------------------------------------------------------
    adjacency_document = document["adjacency"]
    _require(isinstance(adjacency_document, dict), "FIELD_INVALID", field="adjacency")
    node_id_set = set(positions)
    keys = set(adjacency_document)
    unexpected = sorted(keys - node_id_set)
    _require(
        not unexpected,
        "ADJACENCY_KEYS",
        field="adjacency." + unexpected[0] if unexpected else "adjacency",
        node_ids=unexpected,
        detail="adjacency has keys that are not node ids",
    )
    missing = sorted(node_id_set - keys)
    _require(
        not missing,
        "ADJACENCY_KEYS",
        field="adjacency",
        node_ids=missing,
        detail="adjacency is missing node entries",
    )

    adjacency: dict[str, tuple[str, ...]] = {}
    for node_id in sorted(adjacency_document):
        neighbours = adjacency_document[node_id]
        _require(
            isinstance(neighbours, list),
            "FIELD_INVALID",
            field="adjacency." + node_id,
            node_ids=(node_id,),
        )
        seen: set[str] = set()
        for neighbour_index, neighbour in enumerate(neighbours):
            _require(
                isinstance(neighbour, str) and neighbour in node_id_set,
                "UNKNOWN_NODE",
                field="adjacency.%s[%d]" % (node_id, neighbour_index),
                node_ids=(node_id, str(neighbour)),
                detail="neighbour does not exist",
            )
            _require(
                neighbour not in seen,
                "EDGE_DUPLICATE",
                field="adjacency." + node_id,
                node_ids=(node_id, neighbour),
                detail="duplicate neighbour",
            )
            _require(
                neighbour != node_id,
                "SELF_LOOP",
                field="adjacency." + node_id,
                node_ids=(node_id,),
                detail="self loop",
            )
            seen.add(neighbour)
        adjacency[node_id] = tuple(neighbours)
    for source in sorted(adjacency):
        for neighbour in sorted(adjacency[source]):
            _require(
                source in adjacency.get(neighbour, ()),
                "ADJACENCY_ASYMMETRIC",
                field="adjacency." + source,
                node_ids=(source, neighbour),
                detail="edge is not listed in both directions",
            )

    # stage 6: geometry (coincident control points) ------------------------
    ordered_ids = sorted(positions)
    limit_squared = geometry.COINCIDENCE_THRESHOLD**2 * (1.0 + geometry.COINCIDENCE_SLACK)
    for left_index, left in enumerate(ordered_ids):
        for right in ordered_ids[left_index + 1 :]:
            delta = geometry.subtract(positions[left], positions[right])
            if geometry.dot(delta, delta) <= limit_squared:
                raise GraphValidationError(
                    "COINCIDENT_NODES",
                    field="nodes",
                    node_ids=(left, right),
                    detail="control points coincide within %.0e scene_unit"
                    % geometry.COINCIDENCE_THRESHOLD,
                )

    # stage 7: topology (single open chain, start is an endpoint) -----------
    for node_id in sorted(adjacency):
        _require(
            len(adjacency[node_id]) <= DEGREE_MAX,
            "GRAPH_BRANCH",
            field="adjacency." + node_id,
            node_ids=(node_id,),
            detail="degree %d exceeds the open-chain maximum 2" % len(adjacency[node_id]),
        )
    _require_connected(adjacency, ordered_ids)
    endpoints = [node_id for node_id in ordered_ids if len(adjacency[node_id]) == ENDPOINT_DEGREE]
    _require(
        len(endpoints) == 2,
        "GRAPH_CYCLE",
        field="adjacency",
        node_ids=tuple(endpoints) or (ordered_ids[0],),
        detail="an open chain has exactly two degree-1 endpoints, found %d" % len(endpoints),
    )

    declared = document["n_terminal_node"]
    _require(
        declared in adjacency,
        "N_TERMINAL_INVALID",
        field="n_terminal_node",
        node_ids=(declared,) if isinstance(declared, str) else (),
        detail="n_terminal_node does not exist",
    )
    _require(
        len(adjacency[declared]) == ENDPOINT_DEGREE,
        "N_TERMINAL_INVALID",
        field="n_terminal_node",
        node_ids=(declared,),
        detail="n_terminal_node must be a degree-1 endpoint",
    )

    path = walk_ordered_path(adjacency, declared)
    if len(path) != len(ordered_ids):  # pragma: no cover - guarded by the checks above
        raise GraphValidationError(
            "GRAPH_DISCONNECTED",
            field="adjacency",
            node_ids=tuple(sorted(set(ordered_ids) - set(path))),
            detail="the ordered walk does not visit every node",
        )

    return SourceGraph(
        document=document,
        path=path,
        positions=positions,
        adjacency=adjacency,
        n_terminal_node=declared,
        graph_path=graph_path,
        extra={"file_node_order": tuple(node_order)},
    )


def _require_connected(adjacency: dict, ordered_ids: list) -> None:
    start = ordered_ids[0]
    seen = {start}
    stack = [start]
    while stack:
        current = stack.pop()
        for neighbour in adjacency[current]:
            if neighbour not in seen:
                seen.add(neighbour)
                stack.append(neighbour)
    unreachable = sorted(set(ordered_ids) - seen)
    _require(
        not unreachable,
        "GRAPH_DISCONNECTED",
        field="adjacency",
        node_ids=tuple(unreachable),
        detail="graph is not connected",
    )


def walk_ordered_path(adjacency: dict, start: str) -> tuple[str, ...]:
    """Walk from ``start`` along the unique neighbour chain, N -> C order.

    Deterministic and independent of file order: at every step the only next
    node is the neighbour that is not the node we came from.
    """
    if start not in adjacency:
        raise GraphValidationError(
            "N_TERMINAL_INVALID", field="n_terminal_node", node_ids=(start,), detail="unknown start node"
        )
    path = [start]
    previous = None
    current = start
    while True:
        candidates = [neighbour for neighbour in adjacency[current] if neighbour != previous]
        if not candidates:
            break
        if len(candidates) > 1:
            raise GraphValidationError(
                "GRAPH_BRANCH",
                field="adjacency." + current,
                node_ids=(current,),
                detail="branch encountered while walking the chain",
            )
        previous, current = current, candidates[0]
        if current in path:
            raise GraphValidationError(
                "GRAPH_CYCLE",
                field="adjacency",
                node_ids=(current,),
                detail="walk revisited a node, the chain is not open",
            )
        path.append(current)
    return tuple(path)


def load_source_graph(path, *, graph_path: str | None = None) -> SourceGraph:
    """Read a ptg-graph JSON file and validate it."""
    document = read_json_document(path)
    return validate_source_graph(document, graph_path=graph_path or str(path))


def ordered_control_points(graph: SourceGraph) -> list[list[float]]:
    """Ordered control points in ``scene_unit`` (path order, N first)."""
    return graph.control_points


def non_coplanarity(graph: SourceGraph) -> dict:
    """Contract 8.3 non-coplanarity report for the ordered path."""
    return geometry.path_metrics(graph.control_points)["non_coplanarity"]
