"""Build the Windows distribution from a clean release checkout."""
import gzip
import hashlib
import sys
import zipfile
from pathlib import Path
root=Path(__file__).resolve().parent
dest=Path(sys.argv[1]).resolve()
with zipfile.ZipFile(dest,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=6) as out:
    for path in sorted(root.rglob("*")):
        rel=path.relative_to(root)
        if not path.is_file() or any(p in {".git",".github","node_modules","local","__pycache__","dist","weights","offline"} for p in rel.parts):
            continue
        if path==dest or rel.as_posix()=="GraphToProtein/GraphToProtein.html":
            continue
        info=zipfile.ZipInfo("Protein-Producter-v0.1.0/"+rel.as_posix())
        out.writestr(info,path.read_bytes(),compress_type=zipfile.ZIP_DEFLATED)
    out.writestr("Protein-Producter-v0.1.0/GraphToProtein/GraphToProtein.html",gzip.decompress((root/"GraphToProtein/assets/studio.html.gz").read_bytes()),compress_type=zipfile.ZIP_DEFLATED)
with dest.open("rb") as f:
    digest=hashlib.file_digest(f,"sha256").hexdigest()
dest.with_name("SHA256SUMS.txt").write_text(digest+"  "+dest.name+"\n",encoding="ascii")
print(digest, dest.name)
