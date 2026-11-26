"""Port-free Windows drawing window. Open each generated PDB in the bundled 3D viewer."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
from pathlib import Path
import time
import tkinter as tk
from tkinter import filedialog, ttk
from uuid import uuid4
import webbrowser

from sketch_model import CANDIDATES, ROOT, check_installation, generate


def drawing_graph(points, key):
    ids = [f"n{i+1}" for i in range(len(points))]
    return {
        "schema_version": "ptg-graph/1.0", "profile": "protein_open_chain_v1",
        "producer": "PhotoToGraph", "producer_instance_id": "gtp-local-editor",
        "graph_id": "sketch-" + key, "revision": 1,
        "source": {"kind": "interactive_3d", "reference_image_ids": []},
        "coordinate_system": {"frame_id": "drawing", "dimension": 3, "unit": "scene_unit",
                              "handedness": "right", "axes": "xyz"},
        "nodes": [{"id": node, "position": list(pos)} for node, pos in zip(ids, points)],
        "adjacency": {node: ids[max(i-1,0):i] + ids[i+1:i+2] for i, node in enumerate(ids)},
        "n_terminal_node": ids[0],
    }


def result_page(template, work):
    result = json.loads((work / "result.json").read_bytes())
    graph = (work / "sketch.json").read_bytes()
    pdb = (work / "backbone_0.pdb").read_bytes()
    if (hashlib.sha256(pdb).hexdigest() != result["pdb_sha256"] or
            hashlib.sha256(graph).hexdigest() != result["graph_sha256"]):
        raise ValueError("模型结果与本次草图记录不一致")
    record = {"id": work.name, "label": "本次生成", "graph": json.loads(graph), "result": result,
              "pdb": base64.b64encode(pdb).decode()}
    html = template.read_text(encoding="utf-8")
    tag = '<script id="generated-examples" type="application/json">'
    pos = html.index(tag) + len(tag)
    html = html[:pos] + json.dumps([record]).replace("<", r"\u003c") + html[html.index("</script>", pos):]
    html = html.replace('<body data-gtp-model="live"', '<body data-open-result="true" data-gtp-model="live"', 1)
    output = work / "result.html"
    tmp = work / "result.tmp"
    tmp.write_text(html, encoding="utf-8")
    tmp.replace(output)
    return output


class Studio:
    def __init__(self, window, directory, template, open_file=webbrowser.open):
        self.window, self.directory, self.template, self.open_file = window, directory, template, open_file
        directory.mkdir(parents=True, exist_ok=True)
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.future = self.work = self.selected = None
        self.points, self.history = [], []
        self.axis = 0
        window.title("GraphToProtein · 从草图生成蛋白骨架")
        window.geometry("940x700")
        window.minsize(620,500)
        frame = ttk.Frame(window, padding=20)
        frame.pack(expand=True, fill="both")
        header = ttk.Frame(frame)
        header.pack(fill="x")
        ttk.Label(header, text="画一条空间折线", font=("Microsoft YaHei UI", 21, "bold")).pack(side="left")
        self.advanced = ttk.Frame(frame)
        self.developer = ttk.Button(header, text="开发者模式", command=self.toggle_developer)
        self.developer.pack(side="right")
        ttk.Button(self.advanced,text="导出当前草图 JSON",command=self.export_graph).pack(side="left")
        ttk.Label(frame, text="在正面依次点击画出轮廓。切到侧面，左右拖动已有点调整深度。").pack(anchor="w", pady=(3,12))
        views = ttk.Frame(frame)
        views.pack(fill="x")
        for title, axis in (("正面 · X/Y",0), ("侧面 · Z/Y",2)):
            ttk.Button(views, text=title, command=lambda a=axis:self.set_axis(a)).pack(side="left", padx=(0,6))
        self.undo = ttk.Button(views, text="撤销", command=self.undo_edit)
        self.undo.pack(side="right")
        self.canvas = tk.Canvas(frame, bg="#143536", highlightthickness=0, cursor="crosshair")
        self.canvas.pack(expand=True, fill="both", pady=8)
        self.canvas.bind("<Configure>",lambda _:self.paint())
        self.canvas.bind("<ButtonPress-1>",self.press)
        self.canvas.bind("<B1-Motion>",self.drag)
        self.canvas.bind("<ButtonRelease-1>",lambda _:setattr(self,"selected",None))
        actions = ttk.Frame(frame)
        actions.pack(fill="x")
        self.status = tk.StringVar(value="画三个或更多的点，即可生成。")
        ttk.Label(actions, textvariable=self.status, wraplength=430).pack(side="left")
        self.create = ttk.Button(actions, text="一键生产蛋白质", command=self.submit)
        self.create.pack(side="right")
        self.again = ttk.Button(actions, text="新草图", command=self.clear)
        self.again.pack(side="right",padx=8)
        ttk.Label(frame,text="已生成的骨架").pack(anchor="w",pady=(10,3))
        self.saved = ttk.Combobox(frame, state="readonly")
        self.saved.pack(side="left",fill="x",expand=True)
        self.reopen = ttk.Button(frame,text="查看三维结果",command=self.open_selected)
        self.reopen.pack(side="right",padx=(8,0))
        self.refresh_results()
        self.paint()

    def toggle_developer(self):
        if self.advanced.winfo_manager():
            self.advanced.pack_forget()
            self.developer.configure(text="开发者模式")
        else:
            self.advanced.pack(after=self.developer.master, fill="x",pady=5)
            self.developer.configure(text="收起开发者模式")

    def export_graph(self):
        if len(self.points)<3:
            self.status.set("先在画布上点出至少三个点。")
            return
        path=filedialog.asksaveasfilename(parent=self.window,defaultextension=".json",initialfile="sketch.json")
        if path:
            Path(path).write_text(json.dumps(drawing_graph(self.points,uuid4().hex),ensure_ascii=False,indent=2),encoding="utf-8")

    def refresh_results(self):
        self.results = sorted(self.directory.glob("*/result.html"), key=lambda p:p.stat().st_mtime, reverse=True)
        self.saved.configure(values=[datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                                     + "  ·  " + p.parent.name[:8] for p in self.results])
        if self.results:
            self.saved.current(0)
        self.reopen.configure(state="normal" if self.results else "disabled")

    def open_selected(self):
        if self.saved.current() >= 0:
            try:
                work = self.results[self.saved.current()].parent
                self.open_file(result_page(self.template, work).as_uri())
            except (OSError, ValueError, KeyError) as error:
                self.status.set(str(error))

    def set_axis(self, axis):
        self.axis = axis
        self.paint()

    def camera(self):
        w,h = self.canvas.winfo_width(),self.canvas.winfo_height()
        return w/2,h/2,max(1,min(w,h)/6)

    def projected(self, point):
        x,y,s = self.camera()
        return x+s*point[self.axis], y-s*point[1]

    def snapshot(self):
        self.history.append([p.copy() for p in self.points])

    def press(self, event):
        if self.future:
            return
        self.snapshot()
        hits = [( (x-event.x)**2 + (y-event.y)**2, i)
                for i, point in enumerate(self.points) for x,y in [self.projected(point)]]
        nearest = min(hits,default=(1000,None))
        if nearest[0] <= 100:
            self.selected = nearest[1]
        else:
            self.points.append(self.points[-1].copy() if self.points else [0.,0.,0.])
            self.selected = len(self.points)-1
            self.drag(event)
        self.status.set(f"当前草图有 {len(self.points)} 个点")
        self.paint()

    def drag(self, event):
        if self.future or self.selected is None:
            return
        x,y,s = self.camera()
        p = self.points[self.selected]
        p[self.axis],p[1] = (event.x-x)/s,(y-event.y)/s
        self.paint()

    def undo_edit(self):
        if self.history and not self.future:
            self.points = self.history.pop()
            self.status.set(f"当前草图有 {len(self.points)} 个点")
            self.paint()

    def clear(self):
        if not self.future:
            self.snapshot()
            self.points = []
            self.status.set("画三个或更多的点，即可生成。")
            self.paint()

    def paint(self):
        self.canvas.delete("all")
        x,y,s = self.camera()
        self.canvas.create_line(0,y,2*x,y,fill="#395b54")
        self.canvas.create_line(x,0,x,2*y,fill="#395b54")
        self.canvas.create_text(12,12,anchor="nw",fill="#b5d9c9",text="正面 · X/Y" if self.axis==0 else "侧面 · Z/Y")
        xy=[self.projected(p) for p in self.points]
        for a,b in zip(xy,xy[1:]):
            self.canvas.create_line(*a,*b,fill="#a3e9bb",width=3)
        for i,(px,py) in enumerate(xy):
            self.canvas.create_oval(px-5,py-5,px+5,py+5,fill="#d5fb7f",outline="")
            self.canvas.create_text(px+9,py-8,anchor="w",text=str(i+1),fill="#ffffff")
        self.create.configure(state="normal" if len(xy)>=3 and not self.future else "disabled")
        self.undo.configure(state="normal" if self.history and not self.future else "disabled")
        self.again.configure(state="disabled" if self.future else "normal")

    def submit(self):
        if self.future or len(self.points)<3:
            return
        key=uuid4().hex
        self.work=self.directory/key
        graph=drawing_graph(self.points,key)
        self.started=time.monotonic()
        self.status.set(f"本机模型正在为这张草图生成 {CANDIDATES} 份候选，再按轮廓偏差选取结果…")
        self.future=self.pool.submit(self.run_model,graph,self.work)
        self.paint()
        self.window.after(350,self.check_result)

    def run_model(self, graph, work):
        generate(graph,work)
        return result_page(self.template,work)

    def check_result(self):
        if not self.future.done():
            self.status.set(f"正在生成和比较 {CANDIDATES} 份候选骨架… 已用 {int(time.monotonic()-self.started)} 秒")
            self.window.after(350,self.check_result)
            return
        try:
            output=self.future.result()
            self.refresh_results()
            self.status.set("骨架已生成，可在三维结果里旋转、叠加草图或下载 PDB。")
            self.open_file(output.as_uri())
        except Exception as error:
            self.status.set(str(error))
        finally:
            self.future=None
            self.paint()


def open_studio():
    check_installation()
    window=tk.Tk()
    studio=Studio(window,ROOT/"local/gtp-model-desktop/jobs",Path(__file__).resolve().parents[1]/"GraphToProtein.html")
    window.mainloop()
    studio.pool.shutdown()
