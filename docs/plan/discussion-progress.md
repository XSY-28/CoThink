# CoThink 讨论模式实施进度

日期：2026-10-14。阶段 0–2 已完成；阶段 3–7 未开始。

当前状态见文末阶段 2 记录。此前内容保留为阶段 0/1 当时的验收与边界。

## 范围与起点

依据 [discussion-v1.md](discussion-v1.md) 第 7 节阶段 0。源码基线为 `af34aaceb40155d010e0e9f7e8abd1f4945c6a0d`（CoThink 0.6.1）。从远端克隆时 HEAD 与该基线一致，工作区无未提交变化；在独立 `repo/` 克隆中使用 `discussion-stage-0` 分支，原调研资料未覆盖。未提交、推送、发布、调整版本或修改依赖。

本阶段只建立新协议的边界，保留旧 peer 协议。新版讨论引擎、权重、共识、最终选择和隐藏过程均留在后续阶段；目前 `start` 仍创建旧 peer 会话，旧命令展示行为保持基线。

## 实际变更与职责

| 文件                                                                                                     | 职责                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/argue/src/discussion/contracts.ts`、`index.ts`                                                 | 独立 discussion 入口及路由头：schema 2、prompt peer-v6、codec discussion-json-v1、policy discussion-policy-v1；不伪造完整可执行状态。                                                                     |
| `packages/argue/src/transport/contracts.ts`                                                              | 窄 ModelCall / ModelReply / ModelTransport、usage 和带观测数据的失败；无 session、member、phase、hash、领域快照。                                                                                         |
| `packages/argue/src/session-format.ts`、`index.ts`                                                       | 识别旧 config.schemaVersion 1 与新版顶层 schemaVersion 2，旧会话完整校验；缺失、未知、混用版本拒绝，不迁移或降级。                                                                                        |
| `packages/argue-cli/src/runtime/model-api.ts`、`peer-api.ts`                                             | 复用原 provider 请求、取消、无自动重试、usage、JSON 响应及凭据脱敏实现；peer 适配器投影传输字段，并映射回原 PeerRuntimeFailure。                                                                          |
| `packages/argue-cli/src/storage/snapshot-store.ts`、`peer/file-store.ts`                                 | 共用私有原子快照、writer/recovery 锁、租约内串行化及 revision CAS；通过窄格式校验器注入 parse、identity、revision、transition。旧 peer 的 schema、冻结 config、source 完整性和追加规则留在 peer wrapper。 |
| `packages/argue-cli/src/storage/session-routing.ts`、`peer/commands.ts`、`packages/cothink/src/index.ts` | 使用同一旧参数语法进行只读版本分派；旧格式进入 peer 命令，新版格式进入明确的阶段 0 不可执行分支；拒绝发生在凭据加载、写锁和模型调用之前。                                                                 |
| `packages/argue/test/discussion/`                                                                        | 从未改动的 af34aac 捕获 50 个完整请求摘要和 inputHash（v1–v5、双方、全部阶段），以及由旧 driver 生成的合成暂停会话样本；独立格式识别回归。                                                                |
| `packages/argue-cli/test/storage/snapshot-store.test.ts`                                                 | 同一个存储机制挂载两种不同字段布局的严格格式校验器，运行真实磁盘、CAS、锁和进程恢复回归。                                                                                                                 |
| `packages/argue-cli/test/runtime/model-api.test.ts`、`test/discussion/legacy-recovery.test.ts`           | 两种 provider 的精确 HTTP 正文、脱敏和失败观测映射；读取捕获的旧暂停会话，显式恢复并复用冻结请求与哈希。                                                                                                  |
| `packages/cothink/test/session-routing.test.ts`                                                          | 旧会话只读路由；新版 show/retry/continue/export/view 明确拒绝执行；非法版本零 fetch、无写锁、快照字节不变。                                                                                               |
| `packages/argue-cli/test/peer/file-store.test.ts`                                                        | 原子进程测试改用构建后的模块路径，保留原真实 SIGKILL/driver 恢复场景；拆文件后 Node 原生 TS 不能解析源码中的 .js 导入，因此先 build。                                                                     |

旧 `peer/contracts.ts`、`context.ts`、`hash.ts`、`protocol.ts`、`driver.ts` 和 `report.ts` 未改动。磁盘 session.json、锁文件名、JSON 序列化、目录权限与文件权限沿用基线。

## 重新验证基线

环境：macOS，Node.js 24.19.0、npm 11.17.0。`npm ci` 使用原 lockfile。

- `npm run build`、`check`、`lint`、`format:check`、`smoke:pack`、`smoke:cothink` 全部通过。
- 首次 `npm run test` 为 621 通过、1 失败：旧 `request-id` 在同毫秒的 1000 个 ID 中碰撞一次，只有 999 个唯一值。实现使用时间戳加 3 字节随机数；碰撞是已有实现的可能结果，未调整此范围外代码。
- 未改源码情况下完整重跑为 622 通过：core 131、CLI 400、viewer 85、CoThink 6。首次失败仍保留为基线问题，不能据重跑称其已修复。
- `npm ci` 仍报告 23 项依赖 advisory（7 low、3 moderate、8 high、5 critical）；本阶段保持依赖不变，未重新进行 production-only audit。

## 阶段 0 验收证据

| 核心验收           | 实际证据                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧会话可读和恢复   | 捕获的 peer-v5 paused JSON 经 FilePeerStore 读回完全相等，只读不改文件；显式 retry 离线完成 opening、两轮 discussion、review，8 次合成回复。首次重试请求与旧 frozenInput 的传输字段相等，原 jobs 的 inputHash 不变。原 killed-driver 测试仍验证恢复为 unknown、零重新 dispatch。 |
| 旧请求与哈希不变   | v1–v5 每种 5 个阶段快照、两位成员，共 50 份请求的 inputHash 和完整 JSON SHA256 均匹配 af34aac 捕获值，覆盖 messages、outputSchema、身份与共享上下文；reviewSetHash 同样固定。                                                                                                    |
| 传输兼容           | 原 OpenAI-compatible 20 项与 Anthropic-compatible 36 项回归全部通过。新增 3 项检验窄接口的精确 loopback HTTP 正文、usage、凭据脱敏，以及 PeerRuntimeFailure 的 code/retryable/rawContent/payload/usage 兼容。                                                                    |
| 存储可替换         | 14 项两格式存储回归与原 11 项 peer 存储回归通过，覆盖重叠 CAS 仅一个成功、损坏权威快照、临时文件忽略、活/未知 owner、失效租约、残留 recovery 锁及真实 SIGKILL 后接管。                                                                                                           |
| 非法版本零调用拒绝 | core 校验非法和混合版本；CoThink retry 测试验证 fetch 次数 0、仅 session.json 存在、文件字节不变。合法 v2 在五种会话命令中也明确 unavailable，不尝试旧 peer。                                                                                                                    |
| 包独立可用         | smoke:pack 与 smoke:cothink 通过；CoThink 新鲜 tarball 在无上游库安装的临时项目运行 help/version/init、4 次诊断、8 次旧讨论和 show/export/offline view。                                                                                                                         |

独立只读代码审查未发现可行动问题或阶段 0 核心验收遗漏；最终 diff 检查无空白错误，并确认旧 peer 协议、版本和 lockfile 未改动。

最终验证：`npm run build`、`npm run check`、`npm run lint`、`npm run format:check`、`npm run test`、`npm run smoke:pack`、`npm run smoke:cothink` 通过。全量 **673 项**：core 150、CLI 418、viewer 85、CoThink 20。所有网络验证使用 loopback HTTP 和合成密钥；没有调用真实模型 API。

整合时的首次 check 发现新 core 测试 JSON 导入缺少 NodeNext 的 `with { type: "json" }`，已修正并重新通过 check 和受影响测试。恢复测试最初使用空 claims，使旧协议跳过空集合 review；改为非空 claims 后才覆盖完整 review，未改动旧协议。

## 尚未实现或验证

- discussion 路由头仅验证版本身份，不是完整状态 schema；新版执行状态及其持久化不变量将在阶段 2 建立。未知新版字段不会被写回或当作可运行状态。
- 新版政策/预算、候选答案、共识与决策、codec、隐藏过程及 CLI 新 start 尚未实现。合法 v2 会话明确不可执行，不生成新版默认值或迁移旧会话。
- 真实 DeepSeek/GLM 接入、新讨论输出质量和真实 API 校准未验证；本阶段未使用账户密钥。
- 旧 request-id 碰撞与既有 dependency advisory 未解决，需独立范围处理。
- 本机仅 Node 24/macOS 已验证；未执行远端 CI、其他 OS 或 Node 22。

下一阶段按原计划进入纯 policy/budget，但本次停止在阶段 0。

## 阶段 1：政策、强度与权重预算

日期：2026-10-13。本阶段已实现纯 policy/budget；阶段 2–7 尚未开始。

### 起点与保留范围

先读取 AGENTS、计划和阶段 0 交接，核对当前分支 `discussion-stage-0`、HEAD `af34aac`、原未提交文件和阶段 0 检查日志。使用修改前文件摘要比较本次增量，保留阶段 0 代码、旧协议和固定样本；未重新安装、克隆或重复执行阶段 0 基线打包。继续保留当前分支与未提交工作，未调整版本、依赖、bin 或发布配置。

### 实际变更

| 文件                                                              | 职责                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/argue/src/discussion/contracts.ts`                      | 追加 AgentId、Effort、Complexity 及 readonly AgentWeights、DiscussionPolicy；既有版本路由头保持原样。                 |
| `packages/argue/src/discussion/policy.ts`                         | 纯 normalizeDiscussionPolicy、resolveRoundLimit、成员校验和默认值；复制并深冻结政策，完整 roster 和两种权重分别校验。 |
| `packages/argue/src/discussion/budget.ts`                         | 纯额度分配、完整评议预留、冻结轮数、整批 attempt 占用、失败/unknown 观测与显式重试记账；时间全部由调用者显式传入。    |
| `packages/argue/src/discussion/index.ts`                          | 导出 policy/budget 接口，沿用 core 既有 discussion 出口。                                                             |
| `packages/argue/test/discussion/policy.test.ts`、`budget.test.ts` | 强度/复杂度、独立权重、精确分配、全员覆盖、额度与时间边界、不可退款和不可变输入回归。                                 |

### 默认值与接口约定

采用计划第 3 节的全部默认值：三档的复杂度轮数分别为 1/1/2、2/3/4、3/5/6；双成员调用上限 10/18/26，输出分配上限 65,536/163,840/262,144，总时长 180/480/900 秒，每调用超时 45/60/90 秒。N 成员的调用预算用 N × (1 + 2Rmax)，讨论池和总输出分配上限按 N/2 缩放；总时长和单调用超时保持该强度默认值。

- `normalizeDiscussionPolicy(raw, memberIds)`：缺省 effort 为 standard；省略整个 weights 表时全员两种权重均为 1。显式 weights 表必须有全部成员且无未知成员，成员 entry 内缺省的单项权重为 1。权重范围 0.1–100，拒绝非有限数、0、未知字段和版本。显式资源帽只收紧默认帽，不自动扩充；maxRounds 只限制复杂度建议，不扩大其他额度。
- `resolveRoundLimit(policy, complexities)`：必须收到完整成员集合的独立估计，取最高复杂度对应轮数，再与显式 maxRounds 取小；没有额外评估调用。
- `allocateDiscussionTokens(memberIds, weights, totalPool, floor, roundIndex)`：先全员 floor，再按参与权重分配剩余；使用精确整数比值和最大余数法，不依赖浮点近似凑总数。相同余数按政策记录的 `roundingOrder` 轮换，roundIndex 为零基索引。默认 roundingOrder 是传入 roster 的顺序，显式值必须为完整排列。
- `allocateRoundTokens(policy, roundIndex)`：低/标准/高讨论池为双成员 6,144/8,192/12,288；每成员至少 2,048。opening 均为 2,048。decisionWeight 只保存，不参与这些额度计算。
- `allocateReviewTokens(memberIds, requiredReviewItems)`：每成员 max(4096, 256 × requiredReviewItems)，必须覆盖全员；成员覆盖量由后续协议提供，不能根据权重减少条目。

### 账本的使用顺序

`createBudgetLedger(policy, startedAtMs)` 复制并冻结政策与硬截止时刻。`freezeBudgetRoundLimit` 一次性记录复杂度导出的轮数；不能重算覆盖已冻结轮数。

1. `reserveReviewBudget(ledger, reservationId, requiredReviewItems, nowMs)` 整批预留全部成员的完整评议调用、输出帽和一个并行评议时间窗口。覆盖增长时，未开始 dispatch 的同一预留可以增加；不能缩减原额度，开始后不能改写。每次调整都在 reservation.updates 留下记录。
2. `reserveAttemptBatch(ledger, batch, nowMs)` 生成全体 opening/discussion 或该评议预留的全部待调用 attempt，先占用调用次数和请求输出帽，状态为 pending。整体不足就抛错，输入账本不变，不返回只有高权重成员的半批；非评议调用不能侵占预留评议额度。
3. **后续宿主必须先持久化新账本和冻结请求，再 dispatch。** 本阶段只有上述纯计算，不含持久化或网络执行。每个 attempt 记录 ID、成员、阶段/轮次、请求输出帽、占用时刻、超时与截止；review attempt 关联 reservation ID。
4. `settleBudgetAttempt` 保存 succeeded/failed/cancelled/unknown 及可选 usage，但从不退还已占用调用或输出帽。usage 缺失仍为未知，不补 0；实际输出少于帽也不释放帽。重复 attempt ID、重复结算和截止时刻及之后的成功拒绝。
5. 失败/取消/unknown review 若显式重试，`reserveReviewRetry` 在原 checkpoint 下重新占用该失败成员的完整帽；成功成员不被重新询问。没有自动重试或自动扩额。

时刻使用非负安全整数毫秒，操作拒绝时钟回退。全员 review 采用一个并行调用窗口；新的非 review attempt 超时为 min(单调用帽, 剩余时长 − 已预留评议窗口)，无正数窗口时拒绝。review 也必须容纳完整预留窗口；恰好达到段截止时刻时不生成调用。迟到 failed/cancelled/unknown 可以记录，迟到成功不能变成有效完成。

这些输出额度是每次尝试的请求上限累计，不含输入 tokens，不表示金额上限；provider 自身用量可另行记录，不能改变冻结帽。

### 已验证

- policy 75 项，budget 38 项，共 **113 项新增测试**。保留阶段 0 的 19 项格式/旧请求测试，discussion 目录共 132 项通过。
- 等权与 standard 2:1 / 1:2 精确分配分别为 4096/4096、4779/3413、3413/4779；三成员池按 N/2 缩放，所有成员的基础与 review 额度保留。
- 只改变 decisionWeight 时讨论额度逐项相等；participationWeight 改变不改已有决策偏好。非法数、缺少/未知成员、重复成员、稀疏顺序、未知 policy/reasoning 字段拒绝。
- 权重 0.1:100、分数权重、余数轮换和最大安全整数池均不突破 floor 或总池；成员 ID 为对象原型属性名仍保留完整额度。直接分配接口也验证非枚举成员权重并拒绝 symbol 成员。
- 三档双/三成员最坏计划完整模拟（每次 review 32 个条目/成员），调用次数分别准确用尽 10/18/26 与 15/27/39，累计输出帽不超总预算；多申请一次全员 review 拒绝。
- 全员 review 8192 tokens 的最小预留不足一个 token 时拒绝；opening 加预留恰好到帽时通过，少一个 token 时整批拒绝。缺少任何成员、调用帽不足和窗口不足都不删除低权重成员。
- 成功、失败、取消、unknown 在零观测用量下仍不退款；重复/显式重试继续占用新额度；失败 reviewer 单独重试时原成功记录与完整覆盖额度保留。
- 覆盖增长保留预留历史，无法修改已开始的预留；政策、账本和嵌套记录冻结，外部输入修改不影响已创建账本。
- 精确截止、窗口裁剪、时钟回退、未知迟到与无效 usage 的反例通过。

最终验证：`npm run build`、`npm run check`、`npm run lint`、`npm run format:check`、`npm run test` 全部通过。全仓 **786 项**：core 263、CLI 418、viewer 85、CoThink 20。编译后的 core index 可直接导入新 policy/budget 并执行 2:1 分配和全员 review 预留。本阶段未改变打包配置或依赖，因此未重复阶段 0 的 tarball 打包验收；无真实模型 API 调用。

独立审查的评议消费表问题已修复，非枚举 ID、getter 单次读取、拒绝重复消费均经独立定向复核，当前无未解决审查项。最终 Git diff 空白检查通过，版本、依赖和 lockfile 未变。

修改前后文件摘要比较确认本次增量只含上述 6 个源码/测试文件及本交接记录，既有 discussion 路由头逐字节保持不变，阶段 0 其他代码与 fixtures 未改。

先写失败案例再实施。policy 的占位实现产生预期行为失败后变绿；budget 的精确截止和非枚举权重反例也分别先失败、修复后通过。独立审查指出非枚举 attempt ID 在消费表复制时丢失的问题；非枚举和 getter 两个反例先失败，改为从已验证的 attempt 记录构建消费表后通过，避免同一预留重复 dispatch。

### 未验证与后续接线

- 本阶段没有把账本接入 discussion 状态 schema、driver、传输或文件存储；“持久化占用之后再调用”、取消在途请求、进程崩溃恢复和迟到回复不写正式答案的实际执行验收在阶段 2/4。纯函数验证不能冒充这些端到端保证。
- 评议条目数必须由未来协议提供完整且保守的冻结覆盖集合。新增讨论可能增加覆盖，调用者须在发起下一轮前增加完整预留；不足时停止新增讨论，不删条目。本阶段不判断自然语言回应或评议是否充分。
- 默认政策未进行真实 DeepSeek/GLM 校准，不将 effort 映射为 provider reasoning 参数；无最终选择或 CLI 展示改造。
- provider 是否遵守输出帽、收到取消后是否停止计费均未验证；这些帽不能称作总 token/费用保证。
- 阶段 0 已记录的 request-id 随机碰撞、dependency advisory 与跨平台未验证边界继续保留。

本次停止在阶段 1。下一阶段才实现候选答案版本和完整检查点评议。

## 阶段 2：答案版本与完整检查点评议

日期：2026-10-14（本阶段于 10-13 开始）。阶段 2 完成；阶段 3–7 未开始。

### 前置核对与变更范围

读取 AGENTS、计划和前两阶段交接，核对原分支 `discussion-stage-0`、HEAD `af34aac`、未提交文件及阶段 1 的 786 项通过记录。保存本阶段修改前的文件摘要，沿用现有源码、policy/budget、传输与存储接缝；未重新克隆、安装或进行基线打包。前置实现及旧 peer 固定请求样本保留，未调整版本、依赖、bin 或发布配置。

| 文件                                                                                                        | 职责                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/argue/src/discussion/contracts.ts`                                                                | 追加不可变领域类型、严格 turn/位置/版本/epoch/封存/状态结构，保留阶段 0 头及阶段 1 政策契约。                                |
| `packages/argue/src/discussion/answers.ts`                                                                  | 当前成员最新答案、活跃观点和保留异议的视图；opening 本地索引解析，discussion 作者权限和冻结引用验证，不选择最终答案。        |
| `packages/argue/src/discussion/protocol.ts`                                                                 | 纯创建、封存、全员原子提交、review 冻结/返回讨论、状态结构与提交历史重放校验、全员 review 条目数。没有 dispatch 或自动重试。 |
| `packages/argue/src/discussion/context.ts`                                                                  | 全体共享的已提交语义快照及其摘要；完整冻结 review 集合，补齐必要的只读历史答案和观点依据，不公开封存半批或权重。             |
| `packages/argue/src/discussion/codec.ts`、`json-codec.ts`                                                   | 表示接口、JSON 首版、冻结成员请求及 inputHash、具体模板/真实引用槽/输出 schema；领域权限另由协议验证。                       |
| `packages/argue/src/discussion/state-utils.ts`、`index.ts`                                                  | 深冻结和 portable canonical hash 的窄复用、导出新接口。未改旧 peer hash 实现。                                               |
| `packages/argue/test/discussion/answers.test.ts`、`protocol.test.ts`、`codec.test.ts`、`stage2-fixtures.ts` | 作者/引用反例、真实 reducer 构造的全员批次与重复 review、持久化结构损坏、半批、表示替换及边界回归。                          |

### 领域与接口

- `createDiscussionSession` 创建版本 2 的领域状态；问题、约束、成员、复制来源及政策独立冻结。来源复制有 contentHash/行数，拒绝重复 sourceId、非法行区间和超过 20,000 字符的输入资料。
- `AnswerVersion` 有程序生成的 ID、作者、前版、段/轮次、body、basisVersionIds、limitations、unresolvedObjectionIds。所有输出状态深冻结，原答案和观点版本不改写。每次完整 discussion 批次给各成员追加自己的新答案；review 不创建答案版本。
- opening 明确声明 `basisDraftIndices`，只解析本成员同批草稿，不能自行提交全局 versionId，也不能引用对方草稿。discussion 明确引用自己本段的最新 previousVersionId，basis 只接受原冻结快照中的当前活跃观点版本；同批新造、旧、撤回、重复或未知引用拒绝。
- 观点 propose/revise/withdraw、定向 ask/challenge/reply 和 important objection 使用独立命名空间。修改观点限本人最新活跃版本；消息指向另一目标作者；每个待回应的定向消息必须由收件人恰好回复一次。每人每批最多 1 个新观点、1 个重要异议和 2 个 ask/challenge，保证行为对称。
- `validateDiscussionReply` 接受宿主绑定的 memberId/snapshotId 和解码后 payload；所有 codec 解出的对象都经过相同的严格结构及领域校验。新版类型使用 `DiscussionProtocolTurn` 命名，避免覆盖旧 peer 的同名导出。
- `sealDiscussionReply` 保存成功回应及规范化 payloadHash。封存只影响 pendingBatch 和 revision，观点、答案、复杂度与 review 仍不提交，语义快照和剩余成员请求不变化。`commitSealedDiscussionBatch` 必须拿到完整 roster，重新验证同一原快照，再一起提交。有效半批遇到对方失败仍保留；不能单独采用其答案。
- `applyDiscussionBatch` 是纯全员批次便利入口，不发网络；部分、重复、未知成员及任意无效回应都拒绝，原输入状态不变，不覆盖已有 seals。
- `freezeDiscussionReview` 至少在一次互相交流完整提交后使用，每个讨论轮最多一个 checkpoint。冻结全部当前活跃观点、每成员最新答案、全部本段未解决重要异议、expectedMembers、上下文摘要、epoch 与轮次；reviewSetHash 绑定这些完整内容。可经 `resumeDiscussionAfterReview` 在全员 review 完成后进入下一轮，并产生新 epoch/hash；不能复用旧票或旧集合。
- 全体逐条评议被冻结的 claim/answer/objection，phase、hash、命名空间、引用和覆盖都要准确，每个对象恰好一次。遗漏、重复、额外/过期对象和假 hash 均拒绝。异议作者必须明确给出 retained/resolved/withdrawn 及 summary/impact/evidenceNeeded，其他成员不能消除或改写它；这些状态只在全员 review 提交后生效。review 备注和 stance 不修改候选正文。
- `discussionReviewItemCounts` 在 review 阶段使用该 epoch 的冻结集合计算全员覆盖量，不因本次 owner 将异议标 resolved 而缩小原检查点；该纯输出可以提供给阶段 1 的 review 预算预留。

### 共享快照与 codec

`sharedDiscussionSnapshot` 对所有成员提供同一段、同一上下文和同一已提交语义集合；排除磁盘 revision、pending seals、policy 权重和 provider 配置。JSON 编码的 user 消息对全体逐字节相同，共享 responseContract 含全部成员的真实模板；system 消息只按身份、已冻结输出额度和作者可用槽位区别。没有主持人、裁决者或高权重命令权。

`ProtocolCodec.encode(snapshot, memberContext)` 只给出表示层 messages/schema，`decode(raw)` 只解析表示和允许省略的空元数据。首版 `JsonDiscussionCodec` 提供 opening、discussion、review 的明确模板、真实 source/claim/answer/message/objection ID、完整 review 位置及准确 hash。判断/理由/正文保留 null 待填，不预写接受票。`buildDiscussionMemberRequest` 冻结 codec 版本、身份、quota、messages、schema、snapshotId 和 inputHash；拒绝不匹配 codec、非法额度和超过 100,000 字符的编译请求。

仅 assumptions/sourceRefs/evidenceRequests/limitations 的缺省空数组可以规范化。不能补造 phase、hash、basis、异议引用、readiness、复杂度或 positions；不丢弃未知 commentary 或协议字段。非空文本必须含非空白字符，保留有效文本的原始空格与换行，不自由改写。

同批引用遵循原快照，不静默重基：其他成员答案若依赖同批被修订/撤回的观点，仍保留原不可变版本。共享上下文中的 `historicalClaimVersions` / `historicalAnswerVersions` 补齐旧依据、待回应消息或重要异议目标，以及历史目标答案的原依据正文。它们只供阅读，不能重新进入新 basis 或 review 引用槽。**阶段 3 必须检查候选全部 basis 已被当前完整 review 覆盖且接受；历史文本可读不等于已有有效接受票。**

### 持久化结构校验边界

`DiscussionSessionSchema` 是严格结构 schema；存储适配应使用 `parseDiscussionSession`，后者还重放已提交批次，重新构造版本链、所有权、定向回应、epoch、冻结集合和 seals，检查图与摘要一致。此重放只检查现存数据，不调用模型、不重新 dispatch。畸形版本图、历史正文改写、半批伪提交、覆盖改写、source/policy 副本摘要及 seal payloadHash 损坏拒绝。

这提供结构完整性和意外损坏检测，不是对本地文件的密码签名认证。前置存储的 CAS/lease 与领域 transition 校验仍须在阶段 4 正式接线，不能把纯 parser 当作跨进程运行保证。

### 验证证据与修复

- 新增 **131 项**：answers 53、protocol 45、codec 33。discussion 目录合计 **263 项**（含前两阶段 132 项），全部通过。
- 越权答案/观点修订、跨段/过期/伪造/撤回/同批未知引用、opening 索引越界、缺少关键字段、review 漏项/重复/错误 namespace/hash，以及非作者异议状态全部有拒绝案例。
- 双/三成员使用相同共享语义快照；封存不改变快照、未提交答案或 review。有效 review 半批遇到对方漏项仍 pending，并能结构读回。
- 多轮 review 保留旧 epoch，但新 hash/答案版本使旧 review 无效；review 完成前后候选答案逐项相同，没有 summary 偷改正文。
- 测试用第二编码器改变表示，解出相同对象，经同一领域 validator 接受有效 review 并拒绝错误 phase/hash/覆盖/引用。codec 放宽或表示变化不能绕过权限。
- 有效 source 行范围及 source/claim/answer/message/objection 槽位、owner-only review 元数据、输入字符帽和 codec 版本冻结均有回归。
- 读取经过 reducer 生成的 JSON 状态，重放完全相等；损坏的历史、冻结集合和 payload hash 拒绝。任意成员名称如 `__proto__`、`constructor` 保留复杂度条目和版本归属；捕获 Zod record 丢该键的反例后改为保持自有键的严格复杂度结构验证。
- 独立审查发现纯空白理由可被当作完整 owner 描述、以及旧目标答案的历史 basis 未完全提供两项问题。两者都先写失败测试，再修复非空白谓词和历史依据闭包；未开放旧引用槽。review coverage count 在 resolved 后仍依 frozen epoch 计数的反例也已先失败后修复。

最终 `npm run build`、`npm run check`、`npm run lint`、`npm run format:check`、`npm run test` 全部通过，全仓 **917 项**（core 394、CLI 418、viewer 85、CoThink 20）。编译后的 core 在纯离线流程中完成封存、全员提交、重复 review、JSON 模板解码及严格状态读回；无模型调用。没有依赖/bin/打包配置变更，因此未重复前置 tarball 验收。

两项审查 P2 已修复并经独立复验，当前 0 个未关闭问题；24 组空白输入被拒绝，有效正文空格/换行保留，历史依据可读但伪历史 review 槽被拒绝。修改前摘要核对本阶段只改变上述 12 个源码/测试文件及交接记录，前置 contracts/index 原内容完整保留，policy/budget、传输、存储、旧 peer 与固定样本未修改。最终 Git diff 空白检查通过，版本和 lockfile 未变。未提交、推送或发布。

### 未验证与后续阶段

- 没有共识判定、提前结束、最高决策权重选择或 FinalResult；完整 review 保存不代表已达成共识，accept 只记录该成员的意见。
- 没有 scheduler/driver、调用 intent、BudgetLedger 与领域 state 的正式运行接线、真实 API、取消/超时、跨进程恢复或新段 continuation；这些在阶段 4。阶段 2 的 seal/commit 是纯领域转换，不冒充持久化调用执行。
- 当前 constructor 创建首段、原始上下文；运行 codec 替换和材料/政策变更须由后续新段流程冻结，不在当前段原地切换。第二编码器是测试证明，不是已发布的运行模式。
- CoThink CLI 仍沿用前置旧 peer 功能，新 v2 路由仍拒绝执行；本阶段没有改 CLI、输出隐藏或讨论浏览器，普通产品展示在阶段 5。
- 自然语言观点真假、理由充分性、模型输出稳定性和真实服务校准未验证；只有结构、引用、权限、覆盖与同快照批次语义已验证。
- 前置 request-id 随机碰撞、dependency advisory 及 Node 22/其他 OS 未验证边界继续保留。

本次停止在阶段 2。下一阶段才处理共识和到限选择。

### 重复请求复核（2026-10-14）

再次收到同一阶段 2 请求后，重新读取 AGENTS、计划与本记录，核对现有实现和 Git 状态。本次定向运行 answers/protocol/codec 三个测试文件，**131/131 通过**；Git diff 空白检查通过。阶段 2 已满足本次范围，因此没有重复实现、改动源码或进入阶段 3；仅补充此复核记录。全仓 917 项及 build/check/lint/format 的证据仍为上述阶段 2 完成时的运行，本次未重复全仓检查。没有提交、推送、发布或真实模型调用。
