"""Locations used by the desktop and loopback sketch applications."""
import hashlib
import os
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("GTP_PROJECT_DIR", APP)).resolve()
TREE_DSH = ROOT / "local/work/RFdiffusion_dsh_gpu"
GPU_PYTHON = ROOT / "local/envs/dsh-gpu/Scripts/python.exe"
WEIGHTS = ROOT / "weights/rfdiffusion"
ENTRY = APP / "integrations/rfdiffusion_gtp/entry.py"

def sha256_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def child_env():
    env = os.environ.copy()
    shim = APP / "integrations/rfdiffusion_gtp"
    env["PYTHONPATH"] = os.pathsep.join(map(str,[shim/"dgl_shim", shim, TREE_DSH, TREE_DSH/"env/SE3Transformer",APP]))
    env.update(PYTHONHASHSEED="0", PYTHONIOENCODING="utf-8", CUDA_VISIBLE_DEVICES="0",
               PYTORCH_CUDA_ALLOC_CONF="expandable_segments:False")
    env.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 4)//2)))
    env.setdefault("MKL_NUM_THREADS", env["OMP_NUM_THREADS"])
    return env
