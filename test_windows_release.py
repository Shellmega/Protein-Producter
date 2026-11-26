"""Validate the actual Windows launcher in a clean extraction before and after moving it."""
import argparse
import gzip
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from zipfile import ZipFile

def run(archive, offline=None):
    with tempfile.TemporaryDirectory(prefix="GTP portable ") as test:
        test=Path(test)
        with ZipFile(archive) as z:
            z.extractall(test)
        app=next(test.glob("*/Start.cmd")).parent
        env=dict(os.environ)
        env.update(PATH=os.environ["SystemRoot"]+r"\System32",
                   GTP_PROJECT_DIR=str(test/"missing-old-checkout"),
                   PYTHONHOME=str(test/"missing-python"),PYTHONPATH=str(test/"wrong-packages"))
        def start(option):
            subprocess.run([os.environ["COMSPEC"],"/d","/c","Start.cmd",option],cwd=app,env=env,stdin=subprocess.DEVNULL,check=True,timeout=900)
        start("--check-startup")
        assert not (app/"GraphToProtein/local/runtime/torch-cu128/.installed").exists()
        if offline:
            env["PTG_OFFLINE_DIR"]=str(offline.resolve())
            start("--prepare-model")
        moved=test/"移动后的目录 with spaces"
        app.rename(moved)
        app=moved
        env.pop("PTG_OFFLINE_DIR",None)
        start("--check-startup")
        if offline:
            start("--prepare-model")
        studio=app/"GraphToProtein"
        reference=studio/"runtime/upstream/examples/input_pdbs/1qys.pdb"
        assert hashlib.sha256(reference.read_bytes()).hexdigest()=="a85e3898e6dc84fdcdc9e2f15f371003d214cf83b5597559461e63704f3570e8"
        assert (studio/"GraphToProtein.html").read_bytes()==gzip.decompress((studio/"assets/studio.html.gz").read_bytes())
        print("Portable launcher and relocated copy passed.")

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive",type=Path)
    parser.add_argument("--offline",type=Path)
    args=parser.parse_args()
    run(args.archive,args.offline)

