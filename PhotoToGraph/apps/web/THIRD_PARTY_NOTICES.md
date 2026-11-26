# Third-party notices

PhotoToGraph 前端使用以下第三方软件。本文件记录固定版本、许可证与来源映射，供复审核对。

## Three.js（MIT）

- 包版本：`three@0.187.0`（`package-lock.json`）
- 固定源码提交：`84fde13820dbccbb1f6688f44a20c59c9c740dc9`
- 复用参考文件（实际下载并运行，未复制进产品源码）：
  - `examples/webgl_geometry_spline_editor.html`
  - `examples/jsm/controls/OrbitControls.js`
  - `examples/jsm/controls/TransformControls.js`
  - `examples/jsm/libs/lil-gui.module.min.js`
  - `build/three.module.js`、`build/three.core.js`、`examples/main.css`
- 来源 URL 与逐文件 SHA-256：`docs/evidence/PTG-1/spatial-v1/author/logs/fixed-source-manifest.json`
- 许可证原文：`docs/evidence/PTG-1/spatial-v1/author/source/three-LICENSE.txt`

移植说明：应用没有逐字复制示例源码，而是重新实现其交互模型（射线拾取、指针按下/抬起判定、相机拖动与编辑互斥、显示更新）。对应映射见 `docs/implementation/PTG-1_spatial_scene_v1.md` §8。

Three.js MIT 许可证原文：

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## React / React DOM（MIT）

- `react@19.3.1`、`react-dom@19.3.1`
- 许可证：MIT，版权归 Meta Platforms, Inc. 及 React contributors。

## React Three Fiber（MIT）

- `@react-three/fiber@9.8.2`
- 许可证：MIT，版权归 Poimandres 及 contributors。

## Drei（MIT）

- `@react-three/drei@10.7.9`
- 许可证：MIT，版权归 Poimandres 及 contributors。
- 本应用使用其 `OrbitControls` 与 `TransformControls` 组件；`three-stdlib` 作为传递依赖随锁文件固定。

## Zustand（MIT）

- `zustand@5.1.0`
- 许可证：MIT，版权归 Poimandres 及 contributors。

## Zundo（MIT）

- `zundo@2.3.0`，peer `zustand@^4.3.0 || ^5.0.0`，本轮使用 `zustand@5.1.0`。
- 来源：<https://github.com/charkour/zundo>；npm integrity 见锁文件。
- `temporal` 仅追踪领域 content；图身份/revision/资源对象不进入时间旅行。

```
MIT License

Copyright (c) 2021 Charles Kornoelje

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 构建与测试工具（devDependencies）

- `vite@7.3.7`（MIT）
- `@vitejs/plugin-react@5.2.0`（MIT）
- `typescript@5.9.3`（Apache-2.0）
- `vitest@4.1.12`（MIT）
- `playwright-core@1.65.0`（Apache-2.0，仅证据脚本）
- `@types/react@19.3.0`、`@types/react-dom@19.3.0`、`@types/three@0.187.0`（MIT / Apache-2.0，按包声明）

完整依赖树与 integrity 见 `apps/web/package-lock.json`。
