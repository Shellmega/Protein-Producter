"""Bundle the drawing studio and optional verified, locally generated examples."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory

DEMO = Path(__file__).resolve().parent
ROOT = DEMO.parent


def inline_script(source):
    return "<script>" + re.sub(r"</script", lambda _: r"<\/script", source, flags=re.I) + "</script>"


def build(output, bridge, esbuild, example_dirs):
    dist = ROOT / "apps/import_preview/dist"
    examples = []
    for i,directory in enumerate(example_dirs):
        raw = (directory/"backbone_0.pdb").read_bytes()
        graph = (directory/"sketch.json").read_bytes()
        result = json.loads((directory/"result.json").read_bytes())
        if not result["is_real_model_output"] or hashlib.sha256(raw).hexdigest()!=result["pdb_sha256"] or hashlib.sha256(graph).hexdigest()!=result["graph_sha256"]:
            raise ValueError("示例草图与模型输出绑定不符")
        examples.append({"id":"example-"+str(i+1),"label":"实算草图 "+chr(65+i),
                         "graph":json.loads(graph),"result":result,"pdb":base64.b64encode(raw).decode()})
    output.parent.mkdir(parents=True, exist_ok=True)
    workdir = ROOT / "local"
    workdir.mkdir(exist_ok=True)
    with TemporaryDirectory(dir=workdir) as work:
        work = Path(work)
        for name in ["space-editor.js", "standalone.js"]:
            shutil.copyfile(DEMO / name, work / name)
        shutil.copyfile(bridge, work / "ptg-graph.js")
        bundle = subprocess.check_output([str(esbuild), "standalone.js", "--bundle", "--format=iife",
            "--minify", "--log-level=error", "--alias:@viewer="+str(dist/"src/viewer")], cwd=work).decode("utf-8")

    html = (DEMO / "index.html").read_text(encoding="utf-8")
    css = (DEMO / "showcase.css").read_text(encoding="utf-8") + """
#model .backbone-preview{position:absolute;inset:0;background:#fcfcf9}
#model .preview-controls{position:absolute;right:12px;bottom:10px;display:flex;gap:6px}
#model [role=status]{position:absolute;left:5%;right:5%;top:42%;text-align:center}
#model .preview-controls button{background:#fbfcf8}
#model canvas{cursor:grab}
#model canvas:active{cursor:grabbing}
#guide-toggle{color:white;border-color:#64867a}
#guide-toggle[aria-pressed=true]{background:#345c4e}
#graph-data{max-height:22em;overflow:auto;font-size:12px}
"""
    html = html.replace('<link rel="stylesheet" href="showcase.css">', '<style>'+css+'</style>')
    html = html.replace('data-ingress="{{IMPORT}}" data-tasks="{{TASK}}" ', '')
    html = html.replace('<body ', '<body data-gtp-model="live" ', 1)
    html = html.replace('<a href="workbench.html" data-developer>完整工作台 ↗</a>', '')
    html = html.replace('<title>空间描点 · PTG × GTP</title>', '<title>GraphToProtein · 按草图生成蛋白骨架</title>')
    html = html.replace('演示模式会返回固定的蛋白质结构。', '使用本机 RFdiffusion 生成候选骨架。')
    html = html.replace('<button type="button" id="back"', '<button type="button" id="guide-toggle" hidden>叠加草图</button><button type="button" id="back"')
    html = html.replace('<button id="photo"', '<button type="button" id="sample-sketch">试用示例草图</button><button id="photo"')
    html = re.sub(r'<a id="saved".*?</a>', '', html)
    html = re.sub(r'<p class="reopen-hint".*?</p>', '<p class="reopen-hint">查看已有模型输出，或打开草图继续编辑。</p>', html)
    html = re.sub(r'<p class="sample-link".*?</p>', '<section class="reopen" id="graph-info" hidden><h2>当前草图坐标</h2><button id="graph-export">下载草图 JSON</button><pre id="graph-data"></pre></section>', html)
    vendor = dist / "vendor"
    contents = ('<script id="generated-examples" type="application/json">'+json.dumps(examples,ensure_ascii=True).replace("<",r"\u003c")+'</script>'
                + inline_script((vendor/"molstar.js").read_text(encoding="utf-8")) + inline_script(bundle)
                + '<script type="text/plain" id="molstar-license">'+(vendor/"molstar-LICENSE.txt").read_text(encoding="utf-8")+'</script>')
    html = html.replace('<script type="module" src="showcase.js"></script>', contents)
    output.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", type=Path, required=True, help="Pinned, built demo/ptg-graph.js")
    parser.add_argument("--esbuild", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=ROOT/"GraphToProtein.html")
    parser.add_argument("--example",type=Path,action="append",default=[])
    args = parser.parse_args()
    build(args.out.resolve(), args.bridge.resolve(), args.esbuild.resolve(), args.example)
    print(args.out.resolve())
