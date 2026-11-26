"""Serve the drawing page and serialize geometry-only inference jobs on the local GPU."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
from pathlib import Path
from urllib.parse import urlsplit
import webbrowser

from sketch_model import ROOT, condition_for, generate, write_json

ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


class Jobs:
    def __init__(self, base):
        self.base = base
        self.base.mkdir(parents=True, exist_ok=True)
        self.active = {}
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sketch-model")

    def status(self, key):
        work = self.base/key
        with self.lock:
            if key in self.active:
                return {"id":key, "state":self.active[key]}
            if (work/"result.json").is_file():
                return {"id":key, "state":"done", "result":json.loads((work/"result.json").read_bytes())}
            if (work/"failure.json").is_file():
                return {"id":key, "state":"failed", **json.loads((work/"failure.json").read_bytes())}
            if work.exists():
                return {"id":key, "state":"failed", "message":"上次生成已中断，请重新生成。"}
        raise KeyError("没有找到这次生成记录")

    def submit(self, key, graph):
        if not isinstance(key,str) or not ID.fullmatch(key) or not isinstance(graph,dict):
            raise ValueError("草图标识或内容无效")
        condition_for(graph)
        work = self.base/key
        with self.lock:
            if work.exists():
                frozen = work/"request.json"
                if not frozen.is_file() or json.loads(frozen.read_bytes()) != graph:
                    raise ValueError("此生成标识已绑定另一张草图")
                return self.status(key)
            work.mkdir()
            write_json(work/"request.json",graph)
            self.active[key] = "queued"
            self.worker.submit(self.run,key,graph)
            return {"id":key,"state":"queued"}

    def run(self,key,graph):
        work = self.base/key
        try:
            with self.lock:
                self.active[key] = "running"
            result = generate(graph, work/"model")
            write_json(work/"result.json",result)
        except Exception as error:
            write_json(work/"failure.json",{"message":str(error)})
        finally:
            with self.lock:
                self.active.pop(key,None)


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, data, kind="application/json; charset=utf-8"):
        raw = data if isinstance(data,bytes) else json.dumps(data,ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type",kind)
        self.send_header("Content-Length",str(len(raw)))
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def local_origin(self):
        address = "127.0.0.1:"+str(self.server.server_port)
        return self.headers.get("Host")==address and self.headers.get("Origin","http://"+address)=="http://"+address

    def do_GET(self):
        if not self.local_origin():
            return self.reply(403,{"message":"请从本机绘图页打开"})
        path = urlsplit(self.path).path
        if path in ("/","/demo","/demo/"):
            return self.reply(200,self.server.page,"text/html; charset=utf-8")
        if path=="/api/sketch-model":
            return self.reply(200,{"model":"RFdiffusion","geometry_only":True})
        match = re.fullmatch(r"/api/sketch-jobs/([^/]+)(/backbone.pdb)?",path)
        if match and ID.fullmatch(match[1]):
            try:
                state = self.server.jobs.status(match[1])
                if not match[2]:
                    return self.reply(200,state)
                if state["state"]=="done":
                    data = (self.server.jobs.base/match[1]/"model/backbone_0.pdb").read_bytes()
                    return self.reply(200,data,"chemical/x-pdb")
                return self.reply(409,{"message":"骨架尚未生成"})
            except (KeyError, FileNotFoundError):
                pass
        self.reply(404,{"message":"没有找到该页面或结果"})

    def do_POST(self):
        if not self.local_origin() or self.headers.get_content_type()!="application/json":
            return self.reply(403,{"message":"请从本机绘图页提交草图"})
        if self.path!="/api/sketch-jobs":
            return self.reply(404,{"message":"未知入口"})
        try:
            size = int(self.headers.get("Content-Length",0))
            if not 0<size<=262144:
                raise ValueError("草图内容为空或过大")
            request = json.loads(self.rfile.read(size))
            if not isinstance(request,dict):
                raise ValueError("需要草图对象")
            state = self.server.jobs.submit(request.get("id"),request.get("graph"))
            self.reply(202,state)
        except (ValueError,TypeError,KeyError) as error:
            self.reply(400,{"message":str(error)})
        except Exception as error:
            from adapters.gtp_curve.errors import AdapterError
            if isinstance(error,AdapterError):
                return self.reply(400,{"message":str(error)})
            raise

    def log_message(self,fmt,*args):
        if args and str(args[0]).startswith("GET /api/sketch-jobs"):
            return
        super().log_message(fmt,*args)


def serve(port, no_browser=False, stop=False):
    base = ROOT/"local"/f"gtp-model-{port}"
    marker = base/"server.stop"
    if stop:
        base.mkdir(parents=True,exist_ok=True)
        marker.touch()
        return
    page = (Path(__file__).resolve().parents[1]/"GraphToProtein.html").read_bytes()
    if b'data-gtp-model="live"' not in page:
        raise RuntimeError("请先重新构建本地模型绘图页 GraphToProtein.html")
    home = f"http://127.0.0.1:{port}/demo/"
    with ThreadingHTTPServer(("127.0.0.1",port),Handler) as server:
        server.page = page
        server.jobs = Jobs(base/"jobs")
        server.timeout = 0.5
        marker.unlink(missing_ok=True)
        print(f"GTP 本地模型已就绪：{home}",flush=True)
        if not no_browser:
            webbrowser.open(home)
        try:
            while not marker.exists():
                server.handle_request()
        finally:
            server.jobs.worker.shutdown(wait=True)
