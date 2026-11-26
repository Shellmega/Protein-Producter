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

def main():
    args = argparse.ArgumentParser(description="Prepare the portable Windows studio.")
    args.add_argument("--studio-only", action="store_true")
    args.add_argument("--offline", type=Path, help="Directory containing wheels/ and Base_ckpt.pt")
    options = args.parse_args()
    studio()
    if options.studio_only:
        print(APP/"GraphToProtein.html")
        return
    python = ROOT/"runtime/python/python.exe"
    if not python.is_file():
        raise SystemExit("Download and extract the Windows release ZIP first.")
    import os
    env = os.environ.copy()
    if options.offline:
        env["PTG_OFFLINE_DIR"] = str(options.offline.resolve())
    subprocess.run([str(python),"-B","-s","-X","utf8",str(APP/"demo/run.py"),"--prepare-model"],env=env,check=True)

if __name__=="__main__":
    main()
