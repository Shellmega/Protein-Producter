"""Prepare the verified Windows desktop studio and its local model runtime."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
APP = ROOT / "GraphToProtein"
PIN = "86507b6538f51fce57b5a72477165f03999ed7ae"
WEIGHT_SHA = "0fcf7d7c32b4848030aca3a051e6768de194616f96ba6c38186351a33bfc6eca"
WEIGHT_URL = "https://files.ipd.uw.edu/pub/RFdiffusion/6f5902ac237024bdd0c176cb93063dc4/Base_ckpt.pt"
def digest(p):
    with p.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

def studio():
    target = APP / "GraphToProtein.html"
    with gzip.open(APP / "assets/studio.html.gz", "rb") as gz:
        put(target, gz.read())

def put(path, data):
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(data)
    Path(f.name).replace(path)

def source(tree, upstream):
    records = json.loads((APP / "runtime/upstream-files.json").read_bytes())
    overlay = APP / "runtime/upstream-overlay"
    def normalized(p, data):
        return data if p.endswith(".npz") else data.replace(b"\r\n", b"\n")
    def valid(p, data):
        return hashlib.sha256(normalized(p,data)).hexdigest()==records[p]
    missing = [p for p in records if not (tree/p).is_file() or not valid(p,(tree/p).read_bytes())]
    if not missing:
        return
    zip_source = None
    if not upstream:
        url = f"https://codeload.github.com/RosettaCommons/RFdiffusion/zip/{PIN}"
        with urllib.request.urlopen(url, timeout=120) as response:
            zip_source = zipfile.ZipFile(io.BytesIO(response.read()))
    try:
        for p in missing:
            if (overlay/p).is_file():
                data = (overlay/p).read_bytes()
            elif upstream:
                data = (upstream/p).read_bytes()
            else:
                data = zip_source.read(f"RFdiffusion-{PIN}/{p}")
            data = normalized(p,data)
            if p == "rfdiffusion/inference/model_runners.py" and not valid(p,data):
                for original in (b"seq_t[contig_map.hal_idx0] = seq_orig[contig_map.ref_idx0]", b"seq_t[self.mask_seq.squeeze()] = seq_orig[self.mask_seq.squeeze()]"):
                    data=data.replace(original+b"\n",original+b".to(seq_t.dtype)\n")
                data=data.replace(b"seq_orig, num_classes=22",b"seq_orig.long(), num_classes=22")
            if not valid(p,data):
                raise ValueError(f"Upstream file digest differs: {p}")
            put(tree/p, normalized(p,data))
    finally:
        if zip_source:
            zip_source.close()

def weights(local):
    dest = APP / "weights/rfdiffusion/Base_ckpt.pt"
    if dest.is_file() and digest(dest)==WEIGHT_SHA:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as f:
        tmp = Path(f.name)
    try:
        with (local.open("rb") if local else urllib.request.urlopen(WEIGHT_URL,timeout=120)) as src, tmp.open("wb") as file:
            shutil.copyfileobj(src,file)
        if digest(tmp)!=WEIGHT_SHA:
            raise ValueError("Base checkpoint SHA-256 differs")
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)

def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--studio-only", action="store_true")
    args.add_argument("--wheelhouse", type=Path)
    args.add_argument("--weights", type=Path)
    args.add_argument("--upstream", type=Path)
    a=args.parse_args()
    studio()
    if a.studio_only:
        print(APP/"GraphToProtein.html")
        return
    if sys.platform!="win32" or sys.version_info[:2]!=(3,12):
        raise SystemExit("For the GPU runtime use 64-bit Windows Python 3.12: py -3.12 prepare.py")
    source(APP/"local/work/RFdiffusion_dsh_gpu",a.upstream)
    weights(a.weights)
    venv=APP/"local/envs/dsh-gpu"
    python=venv/"Scripts/python.exe"
    if not python.is_file():
        subprocess.run([sys.executable,"-m","venv",str(venv)],check=True)
    pip=[str(python),"-m","pip","install"]
    options=["--no-index","--find-links",str(a.wheelhouse.resolve())] if a.wheelhouse else []
    lock=APP/"experiments/p2/dsh_gpu/requirements-gpu.lock.txt"
    subprocess.run(pip+options+["setuptools==84.2.1","wheel==0.48.0","packaging==26.3"],check=True)
    subprocess.run(pip+options+["--no-build-isolation","-r",str(lock)],check=True)
    torch_options=options or ["--index-url","https://download.pytorch.org/whl/cu128"]
    subprocess.run(pip+torch_options+["torch==2.7.1+cu128"],check=True)
    subprocess.run([str(python),"-c","import torch; assert torch.cuda.is_available(), 'CUDA GPU unavailable'; print(torch.cuda.get_device_name(0))"],check=True)
    print("Ready. Open Start.cmd.")

if __name__=="__main__":
    main()
