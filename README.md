# Protein-Producter v0.1.0

在 Windows 上画一条三维折线，让本机模型沿草图生成单链蛋白质骨架。生成完成后可旋转查看三维结构、叠加原草图并下载 PDB。PhotoToGraph 提供草图编辑器与交换格式，GraphToProtein 负责读取草图、运行模型和显示结果。

## 启动

1. 下载 [Windows ZIP](https://github.com/Shellmega/Protein-Producter/raw/8a674421abb244f54d4a0ecd5db1290e7df2bad2/downloads/Protein-Producter-v0.1.0-Windows.zip) 并完整解压到可写目录。[SHA-256 校验文件](https://github.com/Shellmega/Protein-Producter/blob/8a674421abb244f54d4a0ecd5db1290e7df2bad2/downloads/SHA256SUMS.txt)
2. 安装 64 位 Python 3.12（含 Tk）并准备支持 CUDA 12.8 的 NVIDIA GPU 驱动。首次在解压目录运行 `py -3.12 prepare.py`。安装器会下载锁定版本的运行时、PyTorch 和约 484 MB 的基础权重，并验证权重与上游代码。
3. 双击 **Start.cmd**，在绘图区放置至少三个点，调整深度，点击“一键生成蛋白质”。模型会产生四份候选，从满足几何检查的结果中选取一份；有可用结果时会打开三维查看器。结果保存在 `GraphToProtein/local/gtp-model-desktop/jobs`。

只想先看绘图界面，可直接打开 Windows ZIP 内的 `GraphToProtein/GraphToProtein.html`。从源码下载时，先运行 `python prepare.py --studio-only`。单独打开 HTML 支持绘图和查看，执行模型需通过启动器。已有完整 GTP 模型安装可以把 `GTP_PROJECT_DIR` 指向旧的 GraphToProtein 工程再启动。

## 开发入口

- PTG 空间编辑器需要 Node.js 22.12 或以上，在 `PhotoToGraph/apps/web` 执行 `npm ci` 和 `npm run dev`，打开终端显示的本机地址。
- GTP 浏览器模型模式通过 `Start.cmd --browser` 打开。
- 修改前端后，在两个应用目录各执行 `npm ci`，再运行 `python rebuild_studio.py` 更新启动页。

## 首版来源

PTG 编辑器取自 `31dae0531a08ba842d2e6706bfdc5825324ac73e`。GTP 取自集成基线 `a0edba79546d20094f6e6f13ddb8efb4670f2b47` 和本地实际使用的绘图、模型启动、候选选择与查看器改动。RFdiffusion 来源为 `RosettaCommons/RFdiffusion@86507b6538f51fce57b5a72477165f03999ed7ae`，基础权重及上游组件遵循其随附许可证。模型输出为候选骨架，几何检查的读数描述的是坐标和草图之间的关系。

版本内的第三方声明见两个前端目录中的 `THIRD_PARTY_NOTICES.md` 和 `GraphToProtein/runtime/upstream-overlay`。
