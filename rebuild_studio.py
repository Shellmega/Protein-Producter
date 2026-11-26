"""Recreate the bundled drawing studio from both locked frontend projects."""
import gzip
import os
from pathlib import Path
import subprocess
import sys

root=Path(__file__).resolve().parent
gtp=root/"GraphToProtein"
ptg=root/"PhotoToGraph/apps/web"
bridge=gtp/"local/build/ptg-graph.js"
bridge.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(["node","tools/compile/build.mjs"],cwd=gtp/"apps/import_preview",check=True)
script="require('esbuild').buildSync({stdin:{contents:require('fs').readFileSync(0,'utf8'),resolveDir:process.cwd()},bundle:true,format:'esm',minify:true,outfile:process.argv[1]})"
subprocess.run(["node","-e",script,str(bridge)],cwd=ptg,input=(gtp/"demo/quick-graph.js").read_bytes(),check=True)
native=list((ptg/"node_modules/@esbuild").glob("*/esbuild.exe" if os.name=="nt" else "*/bin/esbuild"))
if len(native)!=1:
    raise SystemExit("Install the esbuild package for this platform in PhotoToGraph/apps/web first.")
subprocess.run([sys.executable,gtp/"demo/build-standalone.py","--bridge",bridge,"--esbuild",native[0]],check=True)
(gtp/"assets/studio.html.gz").write_bytes(gzip.compress((gtp/"GraphToProtein.html").read_bytes(),mtime=0))
