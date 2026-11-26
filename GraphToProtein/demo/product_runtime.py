"""Resolve every component and result relative to this distribution."""
import hashlib
import os
from pathlib import Path
import sys

APP = ROOT = Path(__file__).resolve().parents[1]
TREE_DSH = APP / "runtime/upstream"
SUPPORT = APP.parent / "runtime/support"
TORCH = APP / "local/runtime/torch-cu128"
GPU_PYTHON = Path(sys.executable)
WEIGHTS = APP / "weights/rfdiffusion"
ENTRY = APP / "integrations/rfdiffusion_gtp/entry.py"

def sha256_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def child_env():
    env = os.environ.copy()
    env.pop("PYTHONHOME", None)
    shim = APP / "integrations/rfdiffusion_gtp"
    env["PYTHONPATH"] = os.pathsep.join(map(str,[TORCH, SUPPORT, shim/"dgl_shim", shim, TREE_DSH, TREE_DSH/"env/SE3Transformer",APP]))
    env.update(PYTHONHASHSEED="0", PYTHONIOENCODING="utf-8", PYTHONNOUSERSITE="1", CUDA_VISIBLE_DEVICES="0",
               PYTORCH_CUDA_ALLOC_CONF="expandable_segments:False")
    env.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 4)//2)))
    env.setdefault("MKL_NUM_THREADS", env["OMP_NUM_THREADS"])
    return env

