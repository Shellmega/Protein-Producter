"""Entry wrapper: run upstream RFdiffusion inference with a GTP curve condition.

Upstream ``scripts/run_inference.py`` is executed *unmodified*.  This wrapper only

1. binds the GTP ordered-curve potential into
   ``rfdiffusion.potentials.potentials.implemented_potentials`` (the documented
   upstream extension point), and
2. hands the remaining command line to the upstream hydra entry point.

Keeping upstream untouched on the conditioning path is what makes the
"original code regression" evidence meaningful: the only difference between a
baseline run and a conditioned run is the ``potentials.guiding_potentials``
config string.

Usage
-----
::

    python integrations/rfdiffusion_gtp/entry.py \
        --gtp-spec experiments/p2/probe/inputs/<cond>.json \
        [--gtp-recentre] [--gtp-upstream <RFdiffusion checkout>] \
        -- \
        inference.output_prefix=<abs> ... 'potentials.guiding_potentials=["type:gtp_curve,weight:1.0,sigma:3.0"]'

Everything after the bare ``--`` is passed verbatim to upstream hydra.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_UPSTREAM = REPO_ROOT / "third_party" / "checkouts" / "RFdiffusion"


def _parse_args(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    if "--" in argv:
        split = argv.index("--")
        own_args, upstream_args = argv[:split], argv[split + 1 :]
    else:
        own_args, upstream_args = argv, []
    parser = argparse.ArgumentParser(
        description="Run upstream RFdiffusion inference with a GTP curve potential."
    )
    parser.add_argument("--gtp-spec", required=True, help="path to gtp.curve_condition/1 JSON")
    parser.add_argument(
        "--gtp-recentre",
        action="store_true",
        help="recentre curve targets on their centroid (needed when the curve is not origin-centred)",
    )
    parser.add_argument(
        "--gtp-kernel",
        default=None,
        choices=["huber", "gauss", "quadratic"],
        help=(
            "override the payload's kernel type; needed because the upstream config-string "
            "parser coerces every non-'type' value to float, so a kernel name cannot travel "
            "through potentials.guiding_potentials"
        ),
    )
    parser.add_argument(
        "--gtp-upstream",
        default=str(DEFAULT_UPSTREAM),
        help="path to the RFdiffusion checkout to run",
    )
    parser.add_argument(
        "--gtp-run-record",
        default=None,
        help="optional path; a JSON record of this invocation is written here",
    )
    return parser.parse_args(own_args), upstream_args


def _load_upstream_entry(upstream_root: Path):
    entry_path = upstream_root / "scripts" / "run_inference.py"
    if not entry_path.is_file():
        raise SystemExit("upstream inference entry not found: %s" % entry_path)
    # upstream imports ``rfdiffusion`` as a top-level package, so the checkout root
    # must be importable before we execute the script module.
    root_str = str(upstream_root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    spec = importlib.util.spec_from_file_location("gtp_upstream_run_inference", entry_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    args, upstream_args = _parse_args(argv)

    spec_path = os.path.abspath(args.gtp_spec)
    upstream_root = Path(args.gtp_upstream).resolve()

    from integrations.rfdiffusion_gtp import curve_potential

    bound_class = curve_potential.register_from_path(
        spec_path, recentre_targets=bool(args.gtp_recentre), kernel=args.gtp_kernel
    )
    condition = curve_potential.load_condition_spec(spec_path)

    record = {
        "tool": "integrations/rfdiffusion_gtp/entry.py",
        "invoked_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version,
        "python_executable": sys.executable,
        "cwd": os.getcwd(),
        "upstream_root": str(upstream_root),
        "condition_spec_path": spec_path,
        "condition_spec_schema": condition.get("schema"),
        "potential_type": curve_potential.POTENTIAL_TYPE,
        "bound_potential_class": bound_class.__name__,
        "kernel_override": args.gtp_kernel,
        "recentre_targets": bool(args.gtp_recentre),
        "upstream_argv": upstream_args,
        "hydra_job_chdir": False,
    }

    # Keep the working directory stable so every path in the config resolves the
    # same way for baseline and conditioned runs.
    upstream_args = list(upstream_args) + ["hydra.job.chdir=False"]
    if not any(a.startswith("hydra.run.dir=") for a in upstream_args):
        upstream_args.append("hydra.run.dir=outputs/gtp_hydra")

    # Upstream's ``@hydra.main(config_path="../config/inference")`` resolves that
    # relative path against the *calling* module's directory.  Because this wrapper
    # is the caller, Hydra would look for integrations/config/inference and fail
    # with "Primary config module 'config.inference' not found".  Passing the
    # upstream config directory explicitly makes the wrapper location-independent.
    config_dir = (upstream_root / "config" / "inference").resolve()
    if not any(a.startswith("--config-path") for a in upstream_args):
        upstream_args = ["--config-path", str(config_dir), "--config-name", "base"] + upstream_args

    module = _load_upstream_entry(upstream_root)

    sys.argv = [str(upstream_root / "scripts" / "run_inference.py")] + upstream_args
    record["effective_argv"] = list(sys.argv)

    if args.gtp_run_record:
        out = Path(args.gtp_run_record)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(record, indent=2), encoding="utf-8")

    module.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
