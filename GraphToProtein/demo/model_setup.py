"""Install the two large model assets on demand, relative to this copy of the app."""
import hashlib
import msvcrt
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.request import urlopen
from uuid import uuid4
from zipfile import ZipFile

import product_runtime as rt

WEIGHT_NAME = "Base_ckpt.pt"
WEIGHT_HASH = "0fcf7d7c32b4848030aca3a051e6768de194616f96ba6c38186351a33bfc6eca"
WEIGHT_URL = "https://files.ipd.uw.edu/pub/RFdiffusion/6f5902ac237024bdd0c176cb93063dc4/Base_ckpt.pt"
TORCH_NAME = "torch-2.7.1+cu128-cp312-cp312-win_amd64.whl"
TORCH_HASH = "2bb8c05d48ba815b316879a18195d53a6472a03e297d971e916753f8e1053d30"
TORCH_URL = "https://download.pytorch.org/whl/cu128/" + TORCH_NAME.replace("+", "%2B")

def offline_file(relative):
    configured = os.environ.get("PTG_OFFLINE_DIR")
    roots = ([Path(configured)] if configured else []) + [p/"offline" for p in (rt.ROOT.parent,*rt.ROOT.parent.parents)]
    return next((p/relative for p in roots if (p/relative).is_file()),None)

def verified_file(relative, url, digest, scratch, status):
    source = offline_file(relative)
    name = Path(relative).name
    if source:
        status("正在校验离线文件 " + name)
    else:
        source = scratch/name
        status("首次使用，正在下载 " + name)
        with urlopen(url, timeout=90) as response, source.open("wb") as out:
            total = int(response.headers.get("Content-Length") or 0)
            copied = 0
            while chunk := response.read(4*1024*1024):
                out.write(chunk)
                copied += len(chunk)
                status(f"正在下载 {name} · {copied//1048576} MiB" + (f" / {total//1048576} MiB" if total else ""))
    if rt.sha256_file(source) != digest:
        raise ValueError(f"{name} 的 SHA-256 校验失败。请重新获取该文件并重试。")
    return source

def torch_ready():
    mark = rt.TORCH / ".installed"
    return (mark.is_file() and mark.read_text("ascii").strip()==TORCH_HASH
            and (rt.TORCH/"torch/lib/torch_cuda.dll").is_file())

def ensure_model(status=lambda message: None):
    if not (rt.SUPPORT/"numpy/__init__.py").is_file() or not (rt.TREE_DSH/"scripts/run_inference.py").is_file():
        raise RuntimeError("缺少随附的运行文件。请完整解压 Windows ZIP 到可写目录。")
    state = rt.TORCH.parent
    state.mkdir(parents=True,exist_ok=True)
    status("正在检查本机模型环境")
    with (state/"setup.lock").open("a+b") as lock:
        lock.seek(0)
        while True:
            try:
                msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
                break
            except OSError as err:
                if err.errno not in (13, 11, 36):
                    raise
                status("另一窗口正在准备模型，完成后会继续")
                time.sleep(1)
        with tempfile.TemporaryDirectory(dir=state, prefix="setup-") as work:
            work=Path(work)
            if not torch_ready():
                required = 6_100_000_000 if offline_file(Path("wheels")/TORCH_NAME) else 9_500_000_000
                if shutil.disk_usage(state).free < required:
                    raise RuntimeError(f"安装模型运行时需要在当前磁盘留出 {required/1e9:.1f} GB。")
                wheel=verified_file(Path("wheels")/TORCH_NAME,TORCH_URL,TORCH_HASH,work,status)
                status("正在安装 GPU 运行时，首次安装需要几分钟")
                pending=work/"torch-package"
                with ZipFile(wheel) as archive:
                    archive.extractall(pending)
                if not (pending/"torch/lib/torch_cuda.dll").is_file():
                    raise RuntimeError("GPU 运行时文件不完整")
                (pending/".installed").write_text(TORCH_HASH,"ascii")
                if rt.TORCH.exists():
                    rt.TORCH.rename(state/("incomplete-"+uuid4().hex))
                pending.rename(rt.TORCH)
            status("正在检查显卡")
            probe=subprocess.run([str(rt.GPU_PYTHON),"-B","-s","-c",
                "import torch; print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA unavailable'); raise SystemExit(0 if torch.cuda.is_available() else 2)"],
                env=rt.child_env(),capture_output=True,text=True,encoding="utf8",errors="replace",
                creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
            if probe.returncode:
                detail=(probe.stderr or probe.stdout).strip().splitlines()
                raise RuntimeError("GPU 运行时不可用，请检查 NVIDIA 驱动。"+(" "+detail[-1] if detail else ""))
            dest=rt.WEIGHTS/WEIGHT_NAME
            status("正在核对模型权重")
            if not dest.is_file() or rt.sha256_file(dest)!=WEIGHT_HASH:
                src=verified_file(WEIGHT_NAME,WEIGHT_URL,WEIGHT_HASH,work,status)
                dest.parent.mkdir(parents=True,exist_ok=True)
                staged=work/"verified-checkpoint"
                shutil.copyfile(src,staged)
                staged.replace(dest)
    status("模型就绪，正在生成骨架")

