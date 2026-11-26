"""Build the portable Windows ZIP from a 64-bit Windows CPython 3.12 installation."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import struct
import sys
import tarfile
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile, ZIP_DEFLATED

import prepare

ROOT = Path(__file__).resolve().parent
APP = ROOT/"GraphToProtein"
PREFIX = "Protein-Producter-v0.1.1"
LOCK = APP/"experiments/p2/dsh_gpu/requirements-gpu.lock.txt"
EXCLUDE = {".git",".github","node_modules","__pycache__",".pytest_cache","dist","weights","local","offline"}

def wheel_input(spec, filename, digest, offline, cache):
    if offline:
        path = offline/filename
    else:
        project, version = spec.split("==")
        with urlopen(f"https://pypi.org/pypi/{project}/{version}/json",timeout=45) as response:
            files=json.load(response)["urls"]
        info=next(f for f in files if f["filename"]==filename and f["digests"]["sha256"]==digest)
        path=cache/filename
        with urlopen(info["url"],timeout=120) as stream,path.open("wb") as out:
            shutil.copyfileobj(stream,out)
    if prepare.digest(path)!=digest:
        raise ValueError(f"package digest differs: {filename}")
    return path

def add_support(out, wheelhouse, cache):
    # These exact Windows wheels contain importable packages at their root. SymPy
    # additionally ships a manpage under the wheel's data installation scheme.
    for line in LOCK.read_text("utf8").splitlines():
        if not line or line.startswith("#"):
            continue
        spec,digest,name=[field.strip() for field in line.split("#")]
        path=wheel_input(spec,name,digest,wheelhouse,cache)
        if name.endswith(".whl"):
            with ZipFile(path) as wheel:
                for entry in wheel.infolist():
                    if entry.is_dir():
                        continue
                    rel=PurePosixPath(entry.filename)
                    if rel.is_absolute() or ".." in rel.parts:
                        raise ValueError(entry.filename)
                    if rel.parts[0].endswith(".data"):
                        if rel.parts[1]=="data":
                            rel=PurePosixPath("share-wheel-data",*rel.parts[2:])
                        elif rel.parts[1] in ("platlib","purelib"):
                            rel=PurePosixPath(*rel.parts[2:])
                        else:
                            raise ValueError(f"Unhandled install scheme in {name}: {rel}")
                    out.writestr(f"{PREFIX}/runtime/support/{rel}",wheel.read(entry))
        elif name=="antlr4-python3-runtime-4.9.3.tar.gz":
            out.write(path,f"{PREFIX}/runtime/licenses/{name}")
            with tarfile.open(path) as archive:
                for entry in archive:
                    rel=PurePosixPath(entry.name)
                    if entry.isfile() and rel.parts[:3]==("antlr4-python3-runtime-4.9.3","src","antlr4") and ".." not in rel.parts:
                        out.writestr(f"{PREFIX}/runtime/support/{PurePosixPath(*rel.parts[2:])}",archive.extractfile(entry).read())
        else:
            raise ValueError(name)

def add_python(out):
    prefix=Path(sys.base_prefix).resolve()
    required=["python.exe","python312.dll","LICENSE.txt","DLLs/_tkinter.pyd","Lib/tkinter/__init__.py","tcl/tcl8.6/init.tcl","tcl/tk8.6/tk.tcl"]
    if not all((prefix/f).is_file() for f in required):
        raise RuntimeError("Build with the full Windows CPython 3.12 distribution including Tcl/Tk")
    files=[p for p in prefix.iterdir() if p.is_file() and (p.suffix.lower() in (".dll",".exe") or p.name=="LICENSE.txt")]
    for component in ("DLLs","Lib","tcl"):
        for directory,dirs,names in os.walk(prefix/component):
            dirs[:]=[d for d in dirs if d not in ("site-packages","__pycache__","test","tests","idlelib","ensurepip")]
            files.extend(Path(directory)/n for n in names if not n.endswith((".pyc",".pyo")))
    for p in sorted(files):
        out.write(p,f"{PREFIX}/runtime/python/{p.relative_to(prefix).as_posix()}")

def build(dest, wheelhouse, upstream):
    if sys.platform!="win32" or sys.version_info[:2]!=(3,12) or struct.calcsize("P")!=8:
        raise SystemExit("Build with Windows x64 Python 3.12")
    dest=dest.resolve()
    dest.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent,prefix="bundle-") as work:
        work=Path(work)
        # Materialize the registered model sources, default reference structure and licenses.
        tree=work/"upstream"
        prepare.source(tree,upstream)
        tmp=work/"product.zip"
        with ZipFile(tmp,"w",ZIP_DEFLATED,compresslevel=5) as out:
            for directory,dirs,names in os.walk(ROOT):
                dirs[:]=[d for d in dirs if d not in EXCLUDE]
                for name in sorted(names):
                    p=Path(directory)/name
                    rel=p.relative_to(ROOT)
                    if rel.parts[0] in ("runtime","downloads") or rel.as_posix()=="GraphToProtein/GraphToProtein.html" or name.endswith((".zip",".pyc")) or p.is_relative_to(work):
                        continue
                    out.write(p,f"{PREFIX}/{rel.as_posix()}")
            add_python(out)
            add_support(out,wheelhouse,work)
            for p in sorted(tree.rglob("*")):
                if p.is_file():
                    out.write(p,f"{PREFIX}/GraphToProtein/runtime/upstream/{p.relative_to(tree).as_posix()}")
            out.writestr(f"{PREFIX}/GraphToProtein/GraphToProtein.html",gzip.decompress((APP/"assets/studio.html.gz").read_bytes()))
        with ZipFile(tmp) as check:
            bad=check.testzip()
            if bad:raise ValueError(f"ZIP integrity failure: {bad}")
        os.replace(tmp,dest)
    digest=prepare.digest(dest)
    dest.with_name("SHA256SUMS.txt").write_bytes((digest+"  "+dest.name+"\n").encode("ascii"))
    print(digest,dest)

if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("dest",type=Path)
    p.add_argument("--wheelhouse",type=Path)
    p.add_argument("--upstream",type=Path)
    args=p.parse_args()
    build(args.dest,args.wheelhouse,args.upstream)

