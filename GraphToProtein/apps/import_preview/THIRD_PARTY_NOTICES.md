# 第三方组件与许可声明（P4 浏览器应用）

本应用提供两个独立页面入口：

| 入口 | 三维引擎 | 说明 |
|---|---|---|
| `dist/index.html`（P4-I 导入预览与派生编辑） | three.js 0.187.0 | 不使用 Mol*，三维场景为独立 three.js 应用 |
| `dist/viewer/index.html`（P4-G 固定结构查看器） | Mol* 5.13.0 | 使用冻结 Mol* 构建加载固定历史 PDB 与条件曲线叠加；不使用 three.js 场景 |

所有依赖在 `package.json` 中精确锁定（无 `^`/`~`），`package-lock.json` 固定完整依赖树。安装使用 `npm install --ignore-scripts`（本机 DSH 沙箱禁止子进程管道，且运行时依赖树不需要任何 install 生命周期脚本；`molstar` 的间接依赖 `@scarf/scarf` 的 postinstall 为遥测脚本，已被 `allow-scripts` 配置阻止，不影响构建与运行）。

## 运行期依赖

| 组件 | 版本 | 许可 | 用途 | 分发方式 |
|---|---|---|---|---|
| three.js | 0.187.0 | MIT | P4-I 三维场景（PerspectiveCamera/WebGLRenderer/OrbitControls） | `node_modules/three`，构建时复制冻结文件到 `dist/vendor/three.module.js`、`three.core.js`、`OrbitControls.js`，许可证原文 `dist/vendor/three-LICENSE.txt` |
| Mol* (molstar) | 5.13.0 | MIT | P4-G 固定结构查看器的结构装载/表示/相机/拾取（`PluginContext` + `Canvas3D`） | `node_modules/molstar`，构建时复制冻结文件到 `dist/vendor/molstar.js`、`molstar.css`，许可证原文 `dist/vendor/molstar-LICENSE.txt`；上游提交 `d4dbac43fc2839d6d59c222a428893be465d0cbe` |

three.js 版权：Copyright © 2010-2025 three.js authors（MIT，见其 LICENSE）。
Mol* 版权：Copyright (c) 2018-2026 molstar contributors（MIT，见其 LICENSE）。

Mol* 以经典脚本 bundle（UMD，暴露 `globalThis.molstar`）分发，由 `viewer.html` 在模块入口之前加载；应用只使用其库命名空间（`molstar.lib.plugin`、`...lib.structure`、`...lib.math`），不创建 Mol* 自带 React UI，页面字体与布局沿用 P4 规范。

## 构建与测试期依赖（不进入运行时页面，除非经 tsc 编译产物）

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| typescript | 5.9.3 | Apache-2.0 | `tsc` 类型检查与 ES module 输出（构建在进程内调用 TypeScript API） |
| playwright-core | 1.65.0 | Apache-2.0 | 浏览器证据驱动本机 Microsoft Edge（不随附/不下载浏览器） |
| @types/three | 0.187.0 | MIT | three.js 类型声明 |
| @types/node | 22.19.2 | MIT | Node API 类型声明 |

## 不随附的组件

- Microsoft Edge 浏览器：使用本机已安装的 Microsoft Edge，仅由 `playwright-core` 以 `executablePath` 启动；不随附、不下载。
- PTG 仓库 `apps/web`：只读参考，不复制其代码或依赖。
- 冻结契约包（`contracts/ptg-graph/v1/**`）：只读数据输入与 golden vectors，不属于本应用依赖。
- 固定历史 PDB / 条件曲线 / 变换记录：属于 GTP 自己的历史证据（`evidence/p2-coordinator/`、`experiments/p2/probe/inputs/`、`evidence/p2/probe_design/`），以只读 Git 对象为唯一来源，构建期按记录摘要物化到 `dist/viewer/data/`。

## 许可证合规检查

`node tools/verify/verify.mjs` 会核对：依赖版本精确锁定（含 `molstar` 5.13.0）、上述许可与版本声明与 `package.json` 一致、`dist/vendor/` 中存在 three.js 与 Mol* 的 LICENSE 原文、`dist/build-info.json` 记录 `vendor/molstar.js` 的版本与 SHA-256。任何依赖增加/升级必须同步更新本文件与证据。
