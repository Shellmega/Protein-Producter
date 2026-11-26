<div align="center">

# 🧬 Protein-Producter

**在 Windows 上绘制一条三维空间折线，驱动本机 RFdiffusion 模型沿草图生成单链蛋白质骨架**

[![Version](https://img.shields.io/badge/release-v0.1.1-15574e?style=flat-square)](https://github.com/Shellmega/Protein-Producter/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square&logo=windows)](https://github.com/Shellmega/Protein-Producter)
[![Python](https://img.shields.io/badge/Python-3.12%20(64--bit)-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![CUDA](https://img.shields.io/badge/CUDA-12.8%20%7C%20PyTorch%202.7.1-76B900?style=flat-square&logo=nvidia&logoColor=white)](https://pytorch.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

[快速开始](#-快速开始) · [系统架构](#-系统架构) · [启动模式](#-启动模式速查) · [完整说明书](MANUAL.md) · [开发与构建](#-开发与构建)

</div>

---

## ✨ 项目简介

**Protein-Producter** 将三维交互式草图建模与本机 GPU 蛋白质骨架生成整合为一套开箱即用的 Windows 工具链：

* **PhotoToGraph (`PTG`)**：提供三维空间折线编辑器、参考图对齐与标准化的 `ptg-graph/1.0` 图交换契约（`protein_open_chain_v1`）。
* **GraphToProtein (`GTP`)**：将草图折线转化为有序曲线引导势（`gtp_curve`），调用本机 **RFdiffusion** 生成候选骨架，经 6 项严格几何门控筛选出最优结构，并在内置三维查看器中叠加草图展示、支持一键导出 `.pdb` 文件。

<p align="center">
  <img src="GraphToProtein/demo/structure.png" alt="Protein-Producter 三维蛋白质骨架预览" width="640" />
  <br />
  <sub>内置 Mol* / Three.js 三维查看器：支持旋转检视生成骨架、叠加原始空间草图与下载 PDB</sub>
</p>

---

## 🏗️ 系统架构

```mermaid
flowchart LR
    subgraph Input["1. 草图输入层"]
        A1["桌面双视角画板<br/>model_window.py (Tk)"]
        A2["浏览器绘图页<br/>GraphToProtein.html"]
        A3["PTG 完整三维编辑器<br/>React + Three.js"]
    end

    subgraph Contract["2. 图契约与几何适配"]
        B1["ptg-graph/1.0 校验<br/>sketch.json"]
        B2["曲线条件构建<br/>adapters/gtp_curve<br/>condition.json"]
    end

    subgraph Engine["3. 本机 GPU 推理与筛选"]
        C1["RFdiffusion + gtp_curve 引导势<br/>T=50 步 · 生成 4 份候选 (60 aa)"]
        C2["6 项几何门控检查<br/>键长 / Cα间距 / 碰撞 / 完整性"]
        C3["轮廓偏差与 Kabsch RMSD 择优<br/>输出 backbone_0.pdb"]
    end

    subgraph View["4. 可视化与交付"]
        D1["result.html 三维查看器<br/>骨架旋转 · 草图叠加 · 下载 PDB"]
    end

    A1 & A2 & A3 --> B1 --> B2 --> C1 --> C2 --> C3 --> D1
```

---

## 🚀 快速开始

### 环境要求

| 组件 | 最低要求 | 说明 |
| :--- | :--- | :--- |
| **操作系统** | Windows 10 / 11 (64 位) | 需解压至**可写目录** |
| **Python** | Windows 包已带 64 位 Python 3.12 和 Tk | 完整解压即可绘图 |
| **GPU 与驱动** | NVIDIA GPU + 支持 CUDA 12.8 的驱动 | 安装器自动部署 `torch==2.7.1+cu128` |
| **Node.js**（仅开发/工作台） | Node.js ≥ 22.12 | 日常桌面绘图与推理**无需**安装 Node.js |

### 三步运行

1. **下载并解压**
   从 [Releases](https://github.com/Shellmega/Protein-Producter/releases) 下载 `Protein-Producter-v0.1.1-Windows.zip`，完整解压到可写目录。

2. **双击 `Start.cmd`**
   在绘图窗口放置至少三个点，可切到侧面调整深度。打开窗口可完全离线。

3. **点击「一键生成蛋白质」**
   首次生成会自动准备 PyTorch CUDA 和模型权重，窗口显示进度。在线首次下载约 3.8 GB，建议预留 12 GB 空间。已有离线备份时，把新版解压到含 `offline` 文件夹的备份目录，程序会校验并使用其中的文件。通过几何检查的候选会在三维结果页打开。

> [!TIP]
> **仅想先体验绘图与查看界面（不跑模型）？**
> 直接用浏览器打开解压目录中的 `GraphToProtein/GraphToProtein.html` 即可。若是从源码克隆仓库，先执行 `python prepare.py --studio-only` 解压页面。

---

## 🧭 启动模式速查

| 启动方式 | 适用场景 | 说明 |
| :--- | :--- | :--- |
| `Start.cmd` | **日常推荐（桌面模式）** | 无端口原生窗口绘图，调用本机 GPU 推理，结果存入 `GraphToProtein/local/gtp-model-desktop/jobs` |
| `Start.cmd --browser` | 本机浏览器模型模式 | 启动 `127.0.0.1:4178` 本地服务，在浏览器中绘图并提交推理（支持 `--port-offset` 与 `--stop`） |
| `Start.cmd --prepare-model` | 单独准备并验证 GPU | 可提前下载或使用已有离线文件；完成后可直接生成 |
| 双击 `GraphToProtein.html` | 离线纯前端预览 | 仅支持绘图与查看示例，不执行本地模型推理 |

---

## 📂 仓库目录结构

```text
Protein-Producter/
├── Start.cmd                          # Windows 一键启动入口
├── prepare.py                         # 运行时/权重/上游代码自动安装与 SHA-256 校验脚本
├── rebuild_studio.py                  # 重新构建并压缩单文件绘图页 (studio.html.gz)
├── package_release.py                 # 打包 Windows 发行版 ZIP 与 SHA256SUMS.txt
├── PhotoToGraph/                      # [PTG] 三维草图编辑器与图契约
│   ├── apps/web/                      # React 19 + R3F + Three.js 空间编辑器
│   └── contracts/ptg-graph/v1/        # ptg-graph/1.0 规范、JSON Schema 与测试向量
└── GraphToProtein/                    # [GTP] 曲线适配、推理集成、服务与查看器
    ├── GraphToProtein.html            # 独立打包的绘图与三维查看页
    ├── adapters/gtp_curve/            # 草图 -> 锚点与控制点条件载荷转换
    ├── integrations/rfdiffusion_gtp/  # RFdiffusion 引导势 (gtp_curve) 与 DGL Shim
    ├── experiments/p3/metrics.py      # 几何门控 (geometry_gates) 与 Kabsch RMSD 评估
    ├── services/                      # import_receiver & generation_tasks 后端服务
    ├── apps/import_preview/           # Mol* + Three.js 结果查看器与任务面板
    └── demo/                          # 桌面窗口 (model_window.py) 与本机推理入口 (run.py)
```

---

## 🛠️ 开发与构建

* **独立运行 PTG 三维编辑器**（需 Node.js ≥ 22.12）：
  ```powershell
  cd PhotoToGraph/apps/web
  npm ci
  npm run dev
  ```
* **修改前端后重新打包启动页**：
  分别在 `PhotoToGraph/apps/web` 与 `GraphToProtein/apps/import_preview` 执行 `npm ci`，然后在根目录执行：
  ```powershell
  python rebuild_studio.py
  ```
* **构建 Windows 便携包**：在含 Tcl/Tk 的 64 位 Windows Python 3.12 环境中，执行 `python package_release.py ..\Protein-Producter-v0.1.1-Windows.zip`。离线构建可指定 `--wheelhouse` 和 `--upstream`。
* **迁移已安装的副本**：关闭应用并复制整个解压目录到新位置，再双击 `Start.cmd`。生成记录和安装成功的模型环境都使用相对路径。

---

## 📜 开源许可与上游声明

* 本项目代码遵循 [MIT License](LICENSE)（Copyright © 2026 Yuqi Dai）。
* 上游 RFdiffusion 固定基线为 `RosettaCommons/RFdiffusion@86507b6538f51fce57b5a72477165f03999ed7ae`，基础权重 `Base_ckpt.pt` 与 SE(3)-Transformer 等组件遵循其各自随附许可证。
* 前端与运行时第三方声明详见：
  * `PhotoToGraph/apps/web/THIRD_PARTY_NOTICES.md`
  * `GraphToProtein/apps/import_preview/THIRD_PARTY_NOTICES.md`
  * `GraphToProtein/runtime/upstream-overlay/`

