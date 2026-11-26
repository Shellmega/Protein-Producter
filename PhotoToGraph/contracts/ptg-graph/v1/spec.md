# PTG 图导入规范 · ptg-graph/1.0（包 ptg-graph/1.0-draft.gtp.5）

日期为 2026-11-08。本文件是 P0 收敛后的**规范性**规范；`spec-draft.md` 保留为 draft.gtp.1 的历史候选，二者冲突时以本文件为准。

**发布状态与术语**：当前包状态为 **PROPOSED（候选发布）**。文中“冻结/固定”指该规则已在本候选包内确定、实现与测试必须一致执行，**不等于正式 FROZEN 契约状态**；正式 FROZEN 由后续双方同版回执、独立复审接受和主协调登记产生。`bilateral_receipt` 仍为 `PENDING`。

`gtp.5` 相对 `gtp.4` 修正 A-GTP3-01：机器字段 `rules.limits.coincidence.normative_rule.u` 与关联说明统一为精确 binary64 的 `2^-53`，并补充轴向 `tau+0..+5 ulp` 回归向量；**不改变本规范的距离判据、校验行为或 schema**。`gtp.4` 的清单修正与 `gtp.2→gtp.3` 的行为迁移继续适用，不得因版本仅改机器元数据而把旧客户端迁移解释为不需要。

- 包版本：`ptg-graph/1.0-draft.gtp.5`（前一候选 `ptg-graph/1.0-draft.gtp.4`）
- wire 版本（`schema_version` 字段）：`ptg-graph/1.0`，**未变化**
- profile：`protein_open_chain_v1`（首版唯一）
- 规范化算法：`ptg-jcs-1`（RFC 8785 JCS + 语义投影，见第 6 节）
- JSON Schema 方言：`https://json-schema.org/draft/2020-12/schema`；验证器：jsonschema 4.26.0（见 `toolchain.json`）
- 机器可读规则：`rules.json`；可执行校验入口：`python tools/contract/validate_contract.py`
- 包摘要：见 `manifest.sha256.json` 的 `files`、`package_digest` 与 manifest 自身 SHA-256

本文件中的“必须/不得”为规范要求；“候选”一词已不再用于数值与错误语义，除明确标注为延期（DEFERRED）的事项外，本文件中的限制、错误码、检查顺序、比较规则与精度判据均为双方实现须一致执行的候选固定项。

## 1. 适用范围与版本边界

### 1.1 四类版本化对象

| 对象 | 身份 | 谁写入 | 可变性 |
|---|---|---|---|
| PTG 源图（source graph） | `producer_instance_id + graph_id + revision`；接收端另分配 `import_id` | PTG 生成，GTP 只保存 | 不可变；每次内容变化递增 `revision` |
| GTP 派生草稿（derived draft） | `draft_id + draft_revision`，关联 `import_id` | GTP | 可变；每次编辑产生新 `draft_revision` |
| 模型条件（model condition） | `condition_id + adapter_version` | GTP | 生成后固定 |
| 生成任务 / 候选结果 | `task_id + attempt_id` / `task_id + candidate_id` | GTP | 固定输入与参数 |

规则：

- 源图保存在接收端后**永不原地修改**。GTP 的所有编辑写在派生草稿上，模型条件固定某个派生修订，生成任务再固定条件版本。
- 目标残基数属于**派生草稿配置**，不属于源图；其可生成范围由 G0/P3 的模型能力证据确定。P0 只冻结其表示形式（正整数，见 10.4），不冻结上限，上限状态为 DEFERRED。
- 参考图片 ID 只记录来源，不承载几何；几何只由坐标框架中的坐标表达。

### 1.2 wire 版本与包版本分离

- `schema_version` 是 wire 版本，**精确匹配** `ptg-graph/1.0`，不做协商；未知值返回 `SCHEMA_UNSUPPORTED`。
- 包版本（`ptg-graph/1.0-draft.gtp.N`）标识契约包内容的发布批次，可随 schema、向量、判据、文档的补齐而变化而**不改变 wire 版本**。
- 历史导入按其保存的 `schema_version` 解码；读取旧导入不因包升级而改变。

## 2. 输入语义

### 2.1 结点、边与开放链

请求表示一条**单条开放蛋白链**的空间控制点路径：

- 结点 `nodes[]` 表示三维路径控制点，`position` 为 3 个有限 binary64 分量。
- 邻接 `adjacency` 是无向边的对称表示：键集合必须恰等于结点 ID 集合；每个邻居必须存在、在数组内不重复、无自环，且边必须双向出现。
- 图必须是**连通**的，**恰有两个度为 1 的端点**，其余结点度为 2，且**没有度为 3 及以上的结点**。满足这些条件即是一条开放链（路径）；闭合环、分支、断连均被拒绝。
- `n_terminal_node` 必须是一个度为 1 的端点。据此唯一确定 N→C 顺序：从该端点出发沿唯一相邻结点前进，直到另一个端点。
- 结点表、邻接字典与邻居数组的**排列不承载语义**，只影响序列化；链顺序永远由图结构与起点计算，不由数组顺序决定。

### 2.2 路径与纸面交叉

画面中两条线段在投影上交叉不建立连通性；连通性只由显式边决定。若未来需要禁止空间线段相交或引入额外交叉约束，必须作为新的语义变更单独对齐，不属于 `protein_open_chain_v1`。

### 2.3 退化输入

近平面、近共线甚至完全共线的控制点是**合法输入**（只要满足 2.1 与 2.4 的距离阈值），但必须被标记为退化并按 8.3 处理；不得因为退化而拒绝，也不得在退化时断言手性。

### 2.4 重合阈值

任意两个控制点的欧氏距离小于或等于 `1e-6 scene_unit` 时拒绝（`COINCIDENT_NODES`），并定位两个结点 ID。阈值比较是**含端点**的（`≤`）。

R-06 冻结**唯一规范性浮点计算规则**（与 `rules.json` 的 `limits.coincidence.normative_rule` 逐字一致）：

- 记 `u = 2^-53`、`τ = 1e-6`、`slack = fl(1 + 8u)`、`limit_squared = fl(fl(τ*τ) * slack)`，全部为 IEEE 754 binary64、round-to-nearest、ties-to-even。
- 对每一对控制点按固定顺序计算：`dx = fl(px−qx)`、`dy = fl(py−qy)`、`dz = fl(pz−qz)`、`s = fl(fl(fl(dx*dx) + fl(dy*dy)) + fl(dz*dz))`。
- **当且仅当 `s ≤ limit_squared` 时拒绝**。该判据是唯一判定依据；`sqrt`、`math.dist` 或语言内建距离只可用于展示，不得用于判定。
- 粗筛（任何加速结构）必须使用保守窗口 `W = fl(τ * slack)`：只访问 `|fl(px−qx)| ≤ W` 的点对，再对候选应用上面的最终判据。证明：若 `s ≤ limit_squared`，则任一已舍入平方项不超过 `s`（非负项求和的舍入结果不小于其中任一项），故 `dx² ≤ s/(1−u) ≤ τ²(1+8u)/(1−u)`，从而 `|dx| ≤ τ·sqrt((1+8u)/(1−u)) < τ(1+8u) = W`；因此窗口不会漏掉任何会被最终判据拒绝的点对。`W` 是严格上界，粗筛不得再使用旧的 `±τ`。
- 该余量为 `8u = 8.881784197001252e-16`（即 8 × 2^-53）相对量，远小于用户可见距离；它使几何距离恰为阈值时在任何 binary64 实现中都可确定性地判为“等于阈值”。
- **A-GTP3-01 机器一致性**：gtp.5 修正 `rules.json` 的 `limits.coincidence.normative_rule.u`（旧字段误写为 2^-52）及关联的 `why_slack`/本段近似值，统一为精确 binary64 的 `u = 2^-53`、`slack = fl(1 + 8u)`、`limit_squared = fl(fl(τ²)·slack)`、`W = fl(τ·slack)`。该修正只改机器元数据与说明，不改变本条的距离判据或任何已接受输入结果。

**兼容性说明（R-06）**：旧实现粗筛使用 `±τ`，因此 `d = nextafter(1e-6, +∞)` 的轴向点对落入最终平方判据却返回 `VALID`，而同一 `d` 的对角点对被拒绝。gtp.3 统一使用 `W`，两者都拒绝；这是本包声明的预期行为变化（旧轴向输入由 `VALID` 变为 `COINCIDENT_NODES`），并已用 `invalid-coincident-near-axis`、`invalid-coincident-near-diagonal` 与 `vectors/coincidence_vectors.json` 固定。

## 3. 坐标框架与单位

- 框架为**右手** XYZ：`handedness = "right"`，`axes = "xyz"`，`dimension = 3`，`unit = "scene_unit"`。参考视图中 +X 向右、+Y 向上、+Z 朝向观察者。
- `scene_unit` 是设计单位，不是物理 Å。物理尺度转换在 GTP P3 与模型条件中完成，必须记录换算与正反变换。
- `frame_id` 标识该图的坐标框架；原点、轴向与单位随图固定。
- **frame 固定规则**：同一 `(producer_instance_id, graph_id)` 的 `coordinate_system` 声明固定。任何重新定义（换 frame、换单位、换轴向或手性）**必须建立新 `graph_id`**，由 PTG 在本地记录转换来源。重复使用同一 `graph_id` 但改变框架声明返回 `FRAME_CONFLICT`。
- 该检查与幂等键绑定、修订唯一性、快照写入在**同一持久化事务**内完成（P5-I 实施）。
- GTP 只做整体平移、正规旋转与正的统一尺度变换，并保存可逆映射（见第 8 节）；反射变换不被支持（`det(R) = -1` 被拒绝）。

### 3.1 相机、屏幕、参考平面与对象局部坐标的转换责任（R-11）

- **完整转换责任在 PTG**：PTG 在提交前必须把相机坐标、屏幕/视口坐标、参考平面坐标和对象局部坐标**完整变换**到本规范定义的固定图框架（右手 XYZ、`scene_unit`、图固定原点），再写入 `nodes[].position`。wire 只传送变换后的 XYZ、`coordinate_system` 声明和 `source` 声明。
- **显示状态不进 wire**：相机位置/朝向、视口、工作平面/参考平面、参考图片显示参数属于**编辑器显示状态**，不得作为请求成员发送，也不属于 `source_graph`、身份或 `semantic_digest`。`request.schema.json` 的 `additionalProperties: false` 会以 `FIELD_UNKNOWN` 拒绝 `camera`、`viewport`、`work_plane`、`reference_plane` 等成员；`invalid-camera-field` 与 `invalid-work-plane-field` 固定该行为。
- **禁止二维化**：不得先把三维信息压入二维屏幕表示再提交；屏幕空间点不是合法控制点，Z 分量不得因投影而丢失或伪造。
- **视图切换 vs 图编辑**：只切换相机/视口/工作平面不改变源图，预期保持相同的 `source_graph` 数值、身份与 `semantic_digest`。切换视图后新建或编辑结点属于**图编辑**，必须把实际空间位置写入新 `revision`（新修订、新快照；提交中使用新幂等键）。
- **参考图片平面**：参考图片只提供来源（`source.reference_image_ids`），不承载几何；不得用图片平面坐标替代三维控制点。
- **可机器核对验收定义**：`rules.json` 的 `view_transform.acceptance_scenarios` 与 `vectors/view_transform_vectors.json` 固定契约侧可执行检查（显示字段拒绝、视图切换摘要不变、编辑保留非零 Z）。空白场景、参考图片平面、非单位对象变换、非零 Z、射线无唯一交点等真实 UI 场景由 PTG-1/PTG-2 执行，当前状态 NOT_RUN，责任与验收入口见第 11 节。

## 4. 结构与值域限制

下表是冻结的限制。schema 表达结构、类型、常量、标识符字符集与单字段值域；跨字段一致性、图规则、几何与拓扑由语义检查表达（分工见第 5 节）。

| 项 | 规则 |
|---|---|
| `schema_version` | 常量 `ptg-graph/1.0` |
| `profile` | 常量 `protein_open_chain_v1` |
| `producer` | 常量 `PhotoToGraph` |
| `source.kind` | 常量 `interactive_3d` |
| `dimension` / `unit` / `handedness` / `axes` | 常量 `3` / `scene_unit` / `right` / `xyz` |
| 标识符（`producer_instance_id`、`graph_id`、`frame_id`、结点 ID、图片 ID） | 1—128 字符，正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，大小写敏感 |
| `revision` | 数学整数，1—9007199254740991（2^53−1）；允许跳号与乱序到达 |
| `nodes` | 2—2048 个；ID 唯一；`position` 恰为 3 个分量 |
| 坐标分量 | 绝对值 ≤ 1000000 `scene_unit` |
| `source.reference_image_ids` | 0—64 个，唯一；顺序在语义比较中忽略 |
| 请求体 | 解码后 UTF-8 字节 ≤ 1048576；仅接受 `identity` 内容编码；`Content-Type: application/json`（可带 `charset=utf-8`） |
| `Idempotency-Key` | 必填，1—128 字符，同一字符集，单个头值，作用域为 `producer_instance_id` |
| JSON | 严格 RFC 8259；无 BOM；无重复对象键；无非有限数值；数值必须是可表示的有限 binary64；嵌套深度 ≤ 64 |

明确拒绝：缺字段、`null` 替代对象/数值、布尔替代数值、非有限数值、非 Unicode 标量值（孤立代理）、重复对象键、前导零、尾随逗号、注释、单引号、顶层值后的多余内容、未知字段（含嵌套对象）。

## 5. 校验流水线与错误

### 5.1 阶段顺序（冻结）

| 顺序 | 阶段 | 内容 |
|---|---|---|
| 0 | transport | `Content-Encoding`、`Content-Type`、解码后字节数、UTF-8 解码、BOM |
| 1 | syntax | 严格 RFC 8259、重复键、数值可表示性、嵌套深度 |
| 2 | version | `schema_version`、`profile` |
| 3 | headers | `Idempotency-Key` 存在性/长度/字符集/单值 |
| 4 | structure | JSON Schema 2020-12、未知字段、单字段值域、坐标与计数上限 |
| 5 | graph | 结点 ID 唯一、邻接键集合、邻居存在、邻居去重、无自环、双向对称 |
| 6 | geometry | 控制点两两距离高于重合阈值 |
| 7 | topology | 无分支、连通、恰有两个端点（开放链）、起点为端点、N→C 路径唯一 |
| 8 | identity | 幂等键作用域、框架注册、图修订唯一、冲突优先级、原子提交（**服务端阶段**） |
| 9 | canonicalize | `ptg-jcs-1` 规范化与 `semantic_digest` |

`identity` 与真实事务由服务端在 P5-I 执行；P0 的 CLI 校验命令把该阶段记为 SKIPPED，并用参考模型给出判定逻辑证据。

### 5.2 首错确定性

- 每次响应至少返回**首个确定性**错误；多错误输入只影响返回哪一个错误，不影响“整体拒绝”。
- **排序作用域（R-07）**：
  - `structure` 阶段：先按 `rules.json` 的 `field_order`（契约字段顺序，如 `nodes` 先于 `adjacency`），再按错误码优先级，最后按字段文本。`field_order` **只适用于 structure 阶段**，且必须覆盖 `adjacency.<id>` 与 `adjacency.<id>[<index>]`；结点 ID 允许 `.`、`_`、`-`，模式匹配不得把点号当作路径分隔符。
  - `graph`、`geometry`、`topology` 阶段：按 `rules.json` 的 `semantic_checks` 顺序（阶段内规则顺序）判定，**不**使用 `field_order`。规则内部按该规则定义的稳定语义对象选择决定首个错误。
  - `identity` 阶段：按 `conflict_priority`（键 → 框架 → 修订）。
- **稳定语义对象选择（R-02）**：同一语义图的不同数组/字典排列必须选择同一语义对象。`UNKNOWN_NODE` 选择最小的 `(引用结点 ID, 未知邻居 ID)` 对；同一未知邻居重复出现时取其在原邻居数组中的**首个**索引。`field` 是该对象在**原输入**中的位置（如 `adjacency.m1[1]`），随字节排列变化；`code` 与 `node_ids` 是错误语义身份，不随排列变化。调用方若以错误指纹做重试/对账，必须使用 `(code, node_ids, 语义对象)`，不得把 `field` 当作语义身份。
- 同一阶段内多个结点相关错误时按结点 ID 升序；成对结点 ID 排序后输出。
- 结构阶段之后仍需完整通过全部阶段才进入保存；不存在“部分保存”。

### 5.3 错误结构

```json
{"error": {"code": "GRAPH_BRANCH", "message": "结点 n2 有 3 个连接；单条开放链的中间结点度必须为 2，端点度为 1", "node_ids": ["n2"], "field": "adjacency.n2"}}
```

- `code` 稳定且机器可识别，取值见 `error.schema.json` 的枚举（等于 `rules.json` 的 wire 错误注册表）。
- `message` 为中文解释，可含结点 ID 与数值，不承载机器判断。
- `node_ids` 为受影响结点 ID，按字典序升序、去重；无对应结点时为空数组。
- `field` 使用字段路径：根问题 `$`，头问题 `headers.Idempotency-Key`，嵌套字段 `coordinate_system.dimension`、`nodes[0].position[0]`、`adjacency.n2`、`adjacency.n4[1]`。未知字段保留其自身路径。
- **缺少必填成员**时，`field` 是父路径加成员名，不得退化为裸成员名：根字段 `schema_version`、嵌套 `source.kind`、数组元素 `nodes[0].position`；若该成员属于某个结点，同时用 `node_ids` 定位该结点。
- **工具报告阶段（R-10）**：工具的校验报告额外带有 `error.stage`，其值必须是本次实际失败的阶段（`transport`、`syntax`、`version`、`headers`、`structure`、`graph`、`geometry`、`topology`、`identity`、`canonicalize` 之一），而不是错误注册表 `stage` 字段的第一个候选。例如 `JSON_SYNTAX` 同时登记于 `transport|syntax`：BOM/UTF-8 失败报告 `transport`，`invalid-nan`/尾随逗号等报告 `syntax`。wire 错误对象（`error.schema.json`）没有 `stage` 成员，该字段只用于工具诊断与阶段统计。

### 5.4 错误码与 HTTP 状态（冻结）

| HTTP | code |
|---|---|
| 400 | `JSON_SYNTAX`、`DUPLICATE_JSON_KEY`、`NUMBER_NOT_REPRESENTABLE`、`BODY_TOO_DEEP`、`SCHEMA_UNSUPPORTED`、`PROFILE_UNSUPPORTED`、`IDEMPOTENCY_KEY_INVALID` |
| 413 | `BODY_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE`、`CONTENT_ENCODING_UNSUPPORTED` |
| 422 | `FIELD_INVALID`、`FIELD_UNKNOWN`、`COORDINATE_INVALID`、`NODE_COUNT_LIMIT`、`NODE_ID_DUPLICATE`、`ADJACENCY_KEYS`、`UNKNOWN_NODE`、`EDGE_DUPLICATE`、`SELF_LOOP`、`ADJACENCY_ASYMMETRIC`、`COINCIDENT_NODES`、`GRAPH_BRANCH`、`GRAPH_DISCONNECTED`、`GRAPH_CYCLE`、`N_TERMINAL_INVALID` |
| 409 | `IDEMPOTENCY_CONFLICT`、`FRAME_CONFLICT`、`REVISION_CONFLICT` |
| 404 | `IMPORT_NOT_FOUND` |
| 429 | `RATE_LIMITED`（仅部署层限流；客户端规则冻结，本地单用户可不启用） |
| 500 | `STORAGE_FAILURE`、`INTERNAL_ERROR` |
| 503 | `IMPORT_BUSY`（事务冲突重试耗尽，可重试） |

补充边界（R-09c）：缺少 `profile` 成员时在 version 阶段按 `PROFILE_UNSUPPORTED`（400，`field=profile`）拒绝，与缺少 `schema_version` 的 `SCHEMA_UNSUPPORTED` 同口径；`revision` 不是数学整数（如 `7.5`）时在 structure 阶段按 `FIELD_INVALID`（422，`field=revision`）拒绝。`import_id` 的字符集/长度见 7.4。

派生阶段（P3/P4-I，不属于导入 wire 注册表）：`PRECISION_LIMIT`、`DERIVATION_INVALID`，见 8.3。

## 6. 规范化比较与身份

### 6.1 ptg-jcs-1

完整验证成功后，对解析结果做**语义投影**，再按 RFC 8785 序列化为 UTF-8，取 SHA-256 作为 `semantic_digest`：

1. `nodes` 按结点 ID 升序排序（保持每个结点与其位置的关联）；
2. 每个 `adjacency` 邻居数组按结点 ID 升序排序；
3. `source.reference_image_ids` 按 ID 升序排序；
4. 其余成员保持语义位置（`nodes` 的索引、`position` 的分量顺序）；
5. 对象成员键由 JCS 按 UTF-16 码元升序排列。

因标识符限制为 ASCII，字节序、码点序与 UTF-16 码元序一致。

数值规则（RFC 8785 / ECMAScript `Number::toString`）：最短往返表示；`-0` 与 `0` 都写 `0`；`1`、`1.0`、`1e0` 收敛为 `1`；`1e-6` 写作 `0.000001`，`1e-7` 写作 `1e-7`，`1e21` 写作 `1e+21`。字符串按 ECMAScript `JSON.stringify` 转义（只转义控制字符、引号、反斜杠；`/` 不转义；非 ASCII 原样输出）。

### 6.2 比较与保存的三份内容

- **原始 body 字节**：接收后按原样保存（或以字节可重建的方式保存）并记录 `body_sha256`，用于审计。
- **解析 source_graph**：首次成功接受的解析快照，GET 返回该快照（按 JSON 语义返回，数值字面形式可变化）。
- **semantic_digest**：用于内容身份判断。

重复的等价请求返回**首次导入**的原始快照与该 `import_id`；冲突请求不改变已保存快照。

### 6.3 源图数值精确保持（替换旧容差公式）

- 源图坐标按解析后的 binary64 数值**逐分量精确保持**：接受与读取之间没有任何几何容差（IEEE 754 值相等，`-0` 与 `0` 视为同一数值）。
- 内容身份按精确规范化比较判定：任何单个分量的变化都是内容变化，**与坐标量级无关**。
- 因此 `draft.gtp.1` 的派生容差公式 `1e-9 * max(1, max_abs_coordinate)` **被撤回**且不得作为任何验收阈值：在坐标上限 1e6 时它允许 1e-3 `scene_unit` 偏差，是重合阈值的 1000 倍，会掩盖真实的小编辑或微小 Z 位移。反例：点在 `(1e6, 1e6, 0)` 与 `(1e6, 1e6, 1e-4)` 之间移动 1e-4，该变化合法（高于 1e-6 阈值）却小于旧容差；新规则下 `semantic_digest` 必然不同。
- 该反例固定为案例 `valid-tiny-change-large-coords` 与身份场景 `identity-tiny-numeric-change-large-coords`。

## 7. HTTP 接收协议

### 7.1 端点与部署候选（PLANNED，NOT_RUN）

| 项 | 值 |
|---|---|
| 接收基址 | `http://127.0.0.1:8000` |
| 提交 | `POST /api/v1/sketch-imports`，`application/json`，`Idempotency-Key` 必填 |
| 读取 | `GET /api/v1/sketch-imports/{import_id}` |
| 允许来源（PTG 开发） | `http://127.0.0.1:5173` |
| CORS | 预检允许 `GET/POST/OPTIONS`，允许头 `Content-Type`、`Idempotency-Key`，`Max-Age 600` |
| 会话 | 回环监听、单用户、无 cookie 会话 |
| 持久化 | SQLite 候选；真实路径与事务设置由 P5-I 冻结 |

地址、来源和会话条件在 P5-I 真实部署时冻结；P0 只固定候选值与预期行为。

### 7.2 行为表

| 情形 | 预期 |
|---|---|
| 新身份、新键、合法内容 | 原子保存，**201**，返回新 `import_id` |
| 同作用域键、相同规范内容 | **200**，返回已有 `import_id` |
| 新键、同图修订、相同规范内容 | 同一事务内绑定键别名，**200**，返回已有 `import_id` |
| 同作用域键、不同规范内容 | **409** `IDEMPOTENCY_CONFLICT` |
| 同图修订、不同规范内容 | **409** `REVISION_CONFLICT` |
| 同 `graph_id` 改变框架声明 | **409** `FRAME_CONFLICT`，必须建立新 `graph_id` |
| 新修订、新键 | 独立导入，**201**；允许旧修订晚到 |
| 未知 `import_id` | **404** `IMPORT_NOT_FOUND` |
| 保存失败 | 5xx，且不得发送成功回执 |
| 事务冲突重试耗尽 | **503** `IMPORT_BUSY`，可用原键原快照重试 |

冲突优先级：`IDEMPOTENCY_CONFLICT` → `FRAME_CONFLICT` → `REVISION_CONFLICT`。

### 7.3 作用域与事务

- 幂等约束键：`(producer_instance_id, Idempotency-Key)`。
- 图修订约束键：`(producer_instance_id, graph_id, revision)`。
- 框架约束键：`(producer_instance_id, graph_id)`。
- 框架注册、导入快照、摘要、回执身份与键映射在**同一持久化事务**内提交；成功回执只在事务可靠提交后发送。
- 幂等键映射与导入记录同生命周期保留（首版不做键回收）；首版导入接口只提供创建与读取。
- **键绑定状态（R-09a）**：
  - **预验证失败**（transport 至 topology 任一阶段拒绝）：键为 `unbound`，没有记录或绑定；修正后用同一键重新提交是允许的。
  - **identity 冲突**（409）：已有绑定保持不变，本次不建立新绑定。
  - **事务回滚/存储失败**（500）与 `IMPORT_BUSY`（503）：键保持 `unbound`（除非提交实际完成）；没有成功回执，客户端必须用**原键与字节相同的原快照**重试。
  - **已提交但回执丢失**：键为 `bound`；同键同字节重试返回 200 与相同 `import_id`，同键不同字节返回 409。客户端据此收敛为 `confirmed`，不得换键。
  - 参考模型 `tools/contract/identity.py` 的 `key_state`、`submit_with_rollback`、`submit_with_lost_receipt` 执行上述状态；真实数据库事务仍为 NOT_RUN（P5-I）。

### 7.4 回执与读取

回执（201 与 200 共用，`receipt.schema.json`）：`import_id`、`schema_version`、`producer_instance_id`、`graph_id`、`revision`、`status`、`node_count`、`edge_count`。

- `status` 固定为 `imported_needs_configuration`：源图已可靠保存，派生配置（目标残基数等）尚未完成。
- `import_id` 为接收端分配的字符串：1—128 字符，字符集 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，大小写敏感（与 `receipt.schema.json` 一致，R-09d）。边界输出样例见 `examples/receipt-import-id-boundary.json` 与 `run_vectors` 的文档检查。
- `edge_count` 统计无向边（每条只计一次），对合法开放链应等于 `node_count - 1`。
- 读取（`read-response.schema.json`）返回 `{receipt, source_graph}` 两个必填字段，`source_graph` 为首次成功接受并保存的完整解析快照。

### 7.5 历史修订与重放

- `revision` 可跳号；乱序到达的合法历史修订各自独立导入，不覆盖任何已有记录。
- 旧修订的回执只对应其自身快照；PTG 界面同时显示“当前编辑版本”与“已送达版本”。
- 提交后编辑产生新修订，必须使用新幂等键与新快照。

### 7.6 重试与“结果待确认”状态机

客户端状态：`idle → submitting → confirmed | rejected | pending_reconcile`。

| 情形 | 行为 |
|---|---|
| 201 / 200 | `confirmed`，绑定回执到该快照修订 |
| 可定位 4xx | `rejected`，显示错误；不自动重试；用户修改产生新修订与新键 |
| **500（`STORAGE_FAILURE` / `INTERNAL_ERROR`）** | **确定失败**且无成功回执：进入 `rejected`，**不自动重试**；用户可显式重试，但必须复用原键与字节相同的原快照（重试返回 200 表示此前实际已提交，收敛为 `confirmed`；返回 201 表示本次成功）；源图保持不被修改 |
| 网络错误 / 超时（结果未知） | `pending_reconcile`，保留**原键与原快照**，按退避自动重试 |
| 503 / 429 | `pending_reconcile`，遵守 `Retry-After`，用原键原快照重试 |
| 自动重试耗尽 | 保持 `pending_reconcile`，提示人工重试；**不得**改用新键或新快照 |
| 已知 `import_id` | 用 `GET` 核对后转 `confirmed` |
| 应用重启 | 从本地恢复回执并用 `GET` 复核 |

退避：最多 5 次自动尝试，间隔 1、2、4、8、16 秒（上限 30 秒）；`Retry-After` 优先。只有 503、429、网络错误与超时可自动重试；400、404、409、413、415、422 与 **500** 不自动重试。回执字段与本地提交不一致（例如 `revision` 不同）时必须保持待确认并提供定位，不得静默覆盖。

**稳定场景 ID（R-03）**：`protocol_cases.json` 固定以下可执行场景，真实 UI 运行由 PTG-3/PTG-4 执行并回传固定版本证据：

| 场景 ID | 预期 |
|---|---|
| `client-submitting-user-edit` | 提交中编辑：旧提交保留自己的键与快照，编辑产生新修订与新键，旧回执只绑定旧修订 |
| `client-stale-receipt-late-arrival` | 旧回执晚到：只更新其自身快照，不覆盖当前编辑版本 |
| `receipt-revision-mismatch-pending` | 回执 revision 与本地不一致：保持 `pending_reconcile` 并给出定位 |
| `key-unbound-after-validation-failure` | 预验证失败后键未绑定，可复用同一键 |
| `key-unbound-after-rollback` | 事务回滚后键未绑定，原键原快照重试可创建 |
| `key-bound-after-commit-before-response` | 提交后回执丢失时键已绑定，同键同字节重试返回 200 同一 `import_id` |
| `key-replay-after-lost-receipt` | 丢失回执后的重放收敛为 `confirmed` |

## 8. 派生变换与精度判据

### 8.1 变换定义

列向量约定：

```
p_model  = s · R · (p_source − c) + t
p_source = c + Rᵀ · (p_model − t) / s
```

约束 `s > 0`、`RᵀR = I`、`det(R) = +1`。`c` 为中心，`t` 为平移，`s` 为统一正尺度。P3 保存正反变换、单位（`scene_unit` 与 Å）、中心、旋转选择、尺度策略、采样位置与版本。反射（`det = −1`）、非统一尺度、非正尺度返回 `DERIVATION_INVALID`。

### 8.2 派生数值误差界（冻结）

记 `u = 2^-53`，`γ = 10u/(1−10u)`，`A(x) = max(|x₁|,|x₂|,|x₃|)`，`ε_R = max |RᵀR − I|`（存储旋转的正交残差），`ε_d = |det(R) − 1|`：

```
bound_fwd(p) = γ · ( |s| · √3 · (A(p) + A(c)) + A(t) )  +  |s| · ε_R · (A(p) + A(c))
bound_inv(m) = γ · ( √3 · (A(m) + A(t)) / |s| + A(c) )  +  ε_R · (A(m) + A(t)) / |s|
bound_rt(p)  = bound_fwd(p) + bound_inv(m)
```

依据：前向为 1 次减法、3 乘积 2 求和（`R·d`）、1 次尺度、1 次平移相加，共 8 次舍入；`γ` 取 10 阶留 2 次安全余量；`√3` 界定正规旋转行的无穷范数。第二项来自**存储的** `R` 不是理想旋转：其残差通过 `|s|·ε_R·|p−c|` 进入前向误差、通过 `ε_R·|m−t|/|s|` 进入逆向误差；残差项已包含在界内，因此任何被接受的矩阵都保持界为保守上界。

**存储旋转的冻结要求**：`ε_R ≤ 64u` 且 `ε_d ≤ 64u`（约 7.1e-15）。超过该上限的矩阵返回 `DERIVATION_INVALID`，不得直接用于映射（应先重新正交化并保存，再记录新的矩阵与残差）。`rotation_is_proper` 与该阈值一致。

验收：实测误差必须**不超过**按实际输入计算的上述界；该界是上界而非容差，不同输入的界不同，必须逐例报告。

### 8.3 精度限制与非共面性/手性

- **精度限制**：设 `L_min` 为源图任意两个不同控制点的最小距离。当 `bound_rt > 0.001 · L_min` 时，派生变换无法可靠往返关键局部几何，返回可定位的 `PRECISION_LIMIT`（`field` 指向派生变换参数），并**保留源图**、不写入派生结果。极大平移叠加微小特征会触发该限制（固定向量 `transform-precision-limit`），而常规特征在极大平移下仍通过（`transform-large-translation`）。
- **非共面性度量**：`V = (p₂−p₁)·((p₃−p₁)×(p₄−p₁))`（四点有向体积的 6 倍）；归一化 `V̂ = V / (|p₂−p₁||p₃−p₁||p₄−p₁|) ∈ [−1,1]`，对平移、正规旋转和正的统一尺度**不变**，随 `s³` 缩放。
- **稳定性判据**：`|V̂| > 1e-9` 时断言手性（`V` 的符号），否则标记退化（`degenerate = true`），不断言手性；`V̂` 的计算舍入不确定度在支持坐标范围内小于 1e-14，与阈值有四个数量级余量。
- **路径方向**：`V` 按 N→C 路径顺序计算。整条路径反向是四个顶点的偶置换，**不改变** `V` 的符号；方向是独立属性，方向敏感量（切向、带符号挠率）必须定义在有向路径上，不能借 `V` 的符号推断。反射（`det = −1`）才会翻转 `V`，这也是左手框架的识别方式。
- 退化输入（近平面、共线）**保持合法**，GTP 必须给出退化标志并使用确定性的变换策略（选择旋转时不得依赖随机或与输入顺序相关的分支）。

## 9. 逐条候选规则收敛记录

下表逐条记录对 draft.gtp.1 候选的处置与理由。所有“采用”项已写入本规范与 `rules.json`；“调整”项给出原因与影响。

| 编号 | 候选规则 | 处置 | 理由与影响 |
|---|---|---|---|
| C-01 | 结点 2—2048、坐标 ±1e6、距离 ≤1e-6 拒绝、ID 1—128 ASCII、revision 1—2^53−1 | 采用 | 边界两例（恰在限内/限外）均有案例；1e-6 采用含端点比较并声明 8u 相对余量，使跨语言判定一致 |
| C-02 | schema 版本精确匹配、未知字段 422 | 采用 | 未知字段需要独立错误码，故新增 `FIELD_UNKNOWN`（原草案只规定状态码未给码名） |
| C-03 | 检查顺序：传输→语法→版本/头→结构→ID/邻接→重复边/自环/对称→距离→分支→连通→闭环→起点→事务 | 采用 | 顺序与 `semantic_checks` 一一对应；新增“同阶段按字段顺序再按结点 ID”的首错规则，解决多字段错误歧义 |
| C-04 | JCS 全字段、集合数组排序、精确数值比较、`ptg-jcs-1` | 采用 | 增补语义投影的精确定义、ASCII 排序等价性说明与跨语言 golden vectors；负数零/整数/指数写法收敛有向量 |
| C-05 | 幂等键作用域 `producer_instance_id`、同修订新键绑定别名、键映射与导入同生命周期 | 采用 | 增补冲突优先级（键→框架→修订）与跨 producer 同键互不冲突的身份场景 |
| C-06 | 同 `graph_id` 框架固定，重定义建新 `graph_id` | 采用 | 增补“框架注册与快照/键映射同一事务”与 `FRAME_CONFLICT` 案例 |
| C-07 | 历史修订可跳号、乱序到达各自独立导入 | 采用 | 增补旧修订晚到与修订跳号身份场景；读取按各自 `schema_version` 解码 |
| C-08 | GET 返回 `{receipt, source_graph}`，未知 404 | 采用 | `source_graph` 明确为首次接受快照；冲突请求不改变已保存内容（身份场景固定） |
| C-09 | 派生映射容差 `1e-9 × max(1, max_abs_coordinate)` | **调整（撤回）** | 该界随坐标量级增长，1e6 坐标下允许 1e-3 偏差，会掩盖微小 Z 位移；改为三项独立判据：源图精确保持、派生解析误差界、非共面/退化分类（第 6.3、8.2、8.3 节），并给出反例 |
| C-10 | 错误定位只用 `node_ids` + `field` | 采用 | 增补字段路径语法（`$`、`headers.*`、`adjacency.n4[1]`）与“成对 ID 排序后输出”；未知字段保留自身路径 |
| C-11 | 请求体 1 MiB、压缩编码 415、仅 JSON | 采用 | 增补“恰为 1 MiB 接受、超一字节 413”的边界案例与 `charset` 规则 |
| C-12 | 首版未知字段拒绝、新可选字段需新 wire 版本 | 采用 | 见第 11 节兼容表 |
| C-13 | 非共面样例四点、N 端 n1、有向三重积 1 | 采用 | 增补归一化度量、稳定性阈值、退化标志与“路径反向不翻转 V”的规则（该规则由 P0 规范化时确定，gtp.1 草案未表述，已用向量固定） |
| C-14 | 派生草稿、模型条件、生成任务的版本边界 | 采用并细化 | 目标残基数只定义表示、上限 DEFERRED 到 G0/P3；不得虚构模型能力 |
| C-15 | 回执 `status = imported_needs_configuration` | 采用 | 明确 `edge_count` 为无向边计数、`edge_count = node_count − 1` 的一致性 |
| C-16 | 存储旋转矩阵的正交残差处理（P0 复审 RV-04 补充） | 采用（补充） | 误差界加入 `ε_R` 残差项，并冻结 `ε_R ≤ 64u`、`ε_d ≤ 64u`；超限返回 `DERIVATION_INVALID`，避免用一个有偏矩阵静默映射；向量 `transform-nonorthonormal` 固定拒绝行为 |
| C-17 | HTTP 500（`STORAGE_FAILURE`/`INTERNAL_ERROR`）客户端处置（P0 复审 RV-02 补充） | 采用（补充） | 明确为“确定失败、不自动重试、可原键原快照人工重试”；补齐 PTG-C0-04 要求的 5xx 分类 |

### 9.1 新增错误码（相对 draft.gtp.1）

| 新码 | HTTP | 原因 |
|---|---|---|
| `NUMBER_NOT_REPRESENTABLE` | 400 | 草案把“非有限数值”归入语法错误，但 `1e400` 语法合法却在 binary64 中溢出；需要可区分的定位 |
| `BODY_TOO_DEEP` | 400 | 资源限制需要独立定位，避免与语法错误混淆 |
| `FIELD_UNKNOWN` | 422 | 草案要求“未知字段 422”但未给码名；独立码便于 PTG 展示与测试 |
| `RATE_LIMITED` | 429 | 草案要求固定 429 处理；码名冻结，部署层可选启用 |

## 10. 协议变化与兼容

### 10.1 wire 层变化：无

`ptg-graph/1.0` 的字段集合、字段类型、必填性、常量与嵌套结构**未变化**：

| 影响面 | 变化 | 兼容方式 |
|---|---|---|
| 请求字段 | 无增删改 | PTG 现有序列化直接可用 |
| 回执字段 | 无增删改 | 现有回执解析不变 |
| 读取结构 | 无增删改 | 现有 GET 解析不变 |
| 错误结构 | `code` 枚举新增 4 个码 | 接收端可能返回新码：PTG 必须能展示未知码的 `message`/`field`，不得因未知 code 崩溃；旧码语义不变 |
| 状态 | `imported_needs_configuration` 唯一 | 无变化 |

### 10.2 判据层变化（不影响线上字节）

- 派生容差公式撤回并替换为三项判据（第 6.3、8.2、8.3 节）。
- 误差界增加存储旋转正交残差项（前向 `abs(s)·ε_R·(A(p)+A(c))`、逆向 `ε_R·(A(m)+A(t))/abs(s)`，与工具实现逐项一致），并冻结 `ε_R ≤ 64u`、`ε_d ≤ 64u`（第 8.2 节）。
- 首错确定性规则细化（字段顺序优先）；嵌套必填成员的 `field` 保留父路径（第 5.3 节）。
- 非共面性/手性增加归一化度量与退化分类；明确路径反向不改变四点有向三重积的符号（该规则由 P0 规范化时确定，gtp.1 草案未表述）。
- 重试与“结果待确认”状态机冻结（第 7.6 节），包含 HTTP 500 的“确定失败、不自动重试、可原键原快照人工重试”。
- **gtp.3（上一轮行为修复）**：
  - R-02：`UNKNOWN_NODE` 改为稳定语义对象选择，`field` 明确为原输入定位；新增 ab/ba/moved、多源、重复未知邻居与带点 ID 用例/向量。
  - R-06：统一平方距离判据与保守候选窗口 `W`；轴向 nextafter 反例由 `VALID` 变为 `COINCIDENT_NODES`（声明的预期变化），对角、临界、大坐标与随机样本用朴素全点对参考对照。
  - R-07：`field_order` 增加 `adjacency.*[*]`，明确只作用于 structure；graph/geometry/topology 按 `semantic_checks` 顺序；带点 ID 与索引路径均覆盖。
  - R-08：校验入口区分 `full`（完整请求，缺 `Idempotency-Key` 拒绝）与显式 `graph`（纯图，报告验证范围）；CLI 默认 full，库调用迁移规则见 `rules.json` 的 `validation_modes`。
  - R-10：工具报告 `error.stage` 绑定实际失败阶段；wire 错误对象仍无该字段。
  - R-11：第 3.1 节新增相机/屏幕/参考平面/对象局部坐标到图框架的完整转换责任、显示状态不进 wire、禁止二维化、视图切换与图编辑区分，以及可机器核对验收定义。
  - R-09a/c/d/f：键绑定生命周期、缺 profile/非整数 revision 边界、`import_id` 字符集与长度、不同点间距合法链（采用 PTG 提案坐标）。
  - R-03/R-09b/e：新增稳定客户端场景 ID、浏览器矩阵责任表与三点内部起点反例。
- **gtp.4（上一轮清单修正）**：仅修正 `recheck/` 同版清单与空回执模板、发布说明及版本/摘要绑定（C-GTP3-01—03、GTP-G3-N01/N02），不改变上方 gtp.3 的判据、校验行为或 wire/schema；gtp.3 的行为迁移继续适用。
- **gtp.5（本轮 A-GTP3-01）**：仅将 `rules.limits.coincidence.normative_rule.u` 及 `why_slack`/§2.4 说明统一为精确 binary64 的 `2^-53`（旧的机器字段误写为 `2^-52`，旧说明误写为 `1.8e-15`），并增加轴向 `tau+0..+5 ulp` 回归向量；距离判据仍为 `s ≤ fl(fl(τ²)·fl(1+8u))`，不改变任何输入判定。

这些变化改变**验收判据与向量**，不改变请求/回执/读取的编码。PTG 需要按其更新本地校验与验收预期（PTG-0 复核项）。

### 10.3 包兼容

- 新包 `ptg-graph/1.0-draft.gtp.5` 取代 `…gtp.4` 作为核对与实现依据；`schema_version` 仍为 `ptg-graph/1.0`。gtp.2、gtp.3、gtp.4 继续由历史提交、原回执和摘要追溯。gtp.5 只修正 A-GTP3-01 机器舍入字段/说明并增加回归向量；gtp.3 的行为修复与 gtp.4 的清单修正继续有效，见 §10.2 与 CHANGELOG。
- 历史导入按其保存的 `schema_version` 解码；包升级不触发迁移。
- 未来若新增可选字段或语义，必须发布双方明确支持的新 wire 版本或协商升级版本；首版不得“忽略未知字段”。

### 10.4 目标残基数表示（DEFERRED 上限）

- 类型：正整数；表示位置：GTP 派生草稿配置（不属于源图）。
- 下限 1；上限**不由 P0 定义**，等待 G0/P3 模型能力证据；在此之前 UI 必须显示“待模型配置”，不得显示虚构范围。

## 11. 明确 NOT_RUN 的范围

| 范围 | 状态 | 责任阶段 |
|---|---|---|
| 真实 HTTP 服务、CORS 预检、浏览器联调 | NOT_RUN | P5-I / GTP-I |
| 数据库事务、并发收敛、崩溃恢复、重启后幂等 | NOT_RUN | P5-I / GTP-I |
| 跨来源真实请求 | NOT_RUN | P5-I / PTG-5 |
| 模型推理、骨架生成、条件适配、目标残基范围 | NOT_RUN | P2 / G0 / P3 |
| 三维预览与 UI 验收 | NOT_RUN | P4-I / P4-G |
| 序列设计、回折验证、实验性质 | NOT_RUN | E1/E2 |
| 浏览器支持矩阵与真实 UI 操作（含相机/参考平面/视图切换） | NOT_RUN | **PTG-1 / PTG-4**（R-09b；验收入口与固定版本由 PTG 回传） |
| 三点链内部起点反例的真实 UI 表述 | NOT_RUN | **PTG-3 / PTG-4**（R-09e） |
| 真实事务中的键占用/回滚/回执丢失 | NOT_RUN | **P5-I / GTP-I**（R-09a；参考模型已执行） |

**责任表（R-09b/R-09e）**：`rules.json` 的 `responsibility` 与 `protocol_cases.json` 的 `responsibility` 逐项列出浏览器矩阵（PTG-1/PTG-4）、三点内部起点（PTG-3/PTG-4）、真实事务/HTTP（P5-I/GTP-I）与真实 UI（PTG-1/PTG-2）的责任、状态和验收入口。P0 只固定契约侧定义与机器可核对场景，不把上述真实运行登记为通过。

P0 用参考模型与固定场景给出**预期**，运行记录明确记为 NOT_RUN（见 `protocol_cases.json`）。

## 12. 文件与实现入口

| 文件 | 作用 |
|---|---|
| `spec.md` | 本规范（规范性） |
| `spec-draft.md` | draft.gtp.1 历史候选（保留字节，非规范） |
| `request.schema.json` / `receipt.schema.json` / `read-response.schema.json` / `error.schema.json` | JSON Schema 2020-12 |
| `rules.json` | 限制、阶段、错误注册表、字段顺序、容差、作用域、部署候选 |
| `toolchain.json` | schema 方言与验证器/参考实现版本声明 |
| `cases.json` | 机器可读案例矩阵（含覆盖表与预期） |
| `examples/` | 实际输入样例（含故意非法的字节级样例） |
| `vectors/` | JCS、语义摘要、派生变换、非共面性、重合判据、错误定位与视图变换 golden vectors |
| `protocol_cases.json` | HTTP/重试/事务/并发/崩溃/跨来源/客户端状态与键生命周期场景（NOT_RUN） |
| `CHANGELOG.md` | gtp.1 → gtp.2 → gtp.3 → gtp.4 → gtp.5 变更清单与兼容说明 |
| `recheck/` | PTG 同版本核对清单与回执模板 |
| `manifest.sha256.json` | 逐文件摘要、全包摘要与摘要规则 |

可执行入口：

```powershell
# 完整导入请求（默认；缺少 Idempotency-Key 返回 IDEMPOTENCY_KEY_INVALID）
python tools/contract/validate_contract.py --request <file> --idempotency-key <key>

# 显式纯图校验（请求头与 identity 阶段不在范围内，报告中 validation.mode=graph）
python tools/contract/validate_contract.py --request <file> --mode graph
```

退出码 0 通过 / 1 拒绝 / 2 用法错误。库入口 `tools.contract.contract.validate_request` 默认 `validation_mode="full"`；纯图调用必须显式传 `validation_mode="graph"`。应用入口 `tools.validation.validate_import` 默认完整请求模式，完整 HTTP 调用必须传 `require_idempotency_key=True` 或 `validation_mode="full"`（R-08）。
