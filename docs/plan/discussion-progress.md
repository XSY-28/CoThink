# CoThink 讨论模式实施进度

日期：2026-10-14。阶段 0–5 已完成；阶段 6–7 未开始。

当前状态见文末阶段 5 记录。此前内容保留为阶段 0/1 当时的验收与边界。

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

## Git 里程碑与阶段 3：共识和最终选择

日期：2026-10-14。阶段 0–2 的 Git 检查点已在草稿 PR；阶段 3 实现仅保留本地，阶段 4–7 未开始。

### Git/PR/CI 检查点

- 本次读取 AGENTS、完整计划与交接，检查工作区干净、当前功能分支 `discussion-stage-0`。本地与远端均为 `5286634f61160e7a8044bfef5b82237ec7ecdc2b`，`main` 仍为 `af34aac`。阶段 0–2 的 37 个文件已在该上传提交中，因此复用现有里程碑，不制造空提交，也不重新提交相同文件。
- 本次重新运行 format、lint、release:check：917 项测试、构建、类型检查和 smoke:pack / smoke:cothink 均通过；未以历史日志代替当前验证，没有真实模型 API 调用。
- 创建并附加 [草稿 PR #1](https://github.com/XSY-28/CoThink/pull/1)，base main、head discussion-stage-0。没有合并、强推、打 tag、npm/Release 发布。
- [CI run 38501779551](https://github.com/XSY-28/CoThink/actions/runs/38501779551) 在上述提交上实际 success；[Node.js 22](https://github.com/XSY-28/CoThink/actions/runs/38501779551/job/115650174034) 和 [Node.js 24](https://github.com/XSY-28/CoThink/actions/runs/38501779551/job/115650173890) 均完成 lint/format/check/build/test 和两项安装检查。无本次变更引起的失败需要修复。通过后才开始阶段 3。

### 本地变更与职责

| 文件                                                                   | 职责                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/argue/src/discussion/consensus.ts`                           | 当前完整评议绑定、全体接受的候选计算、严格版本图上的异议关联。不排名或生成最终文本。                   |
| `packages/argue/src/discussion/decision.ts`                            | 明确停止原因下的共识优先、最高决策偏好回退、并列与 incomplete 选择。正文直接复制保存版本，不调用模型。 |
| `packages/argue/src/discussion/result.ts`                              | FinalResult/ImportantDissent、宿主约束证据、输出结构与原正文/原作者评议来源验证。                      |
| `packages/argue/src/discussion/index.ts`                               | 追加三个模块导出，已有出口保留。                                                                       |
| `packages/argue/test/discussion/consensus.test.ts`、`decision.test.ts` | 离线反例、完整 reducer 状态、来源不可伪造和确定性回归。                                                |

旧 peer、传输、存储、policy/budget、版本 schema、codec 和协议 reducer 未改动。没有网络、磁盘、调度或 CLI 依赖进入这三个新模块。

### 接口与规则

`evaluateConsensus(session, constraintChecks = [])` 返回已共同接受的 AnswerVersion 候选，不选择最终胜者。先用严格重放验证 session，再要求当前 phase 为 review、无 pending seal、最新 epoch 完整提交、全 roster、contextHash/contextVersion、当前观点/答案集合都准确匹配。历史 epoch、A1 的票或历史可读依据不能确认 A2。

每个成员必须明确接受同一个 answerVersionId 及其全部当前 basisVersionIds；任一依据 uncertain/reject 或未在当前集合中就失败。空观点和空依据不按真空条件认定共识，这是首版保守规则。与候选无关的备选观点可继续分歧，不要求所有观点或所有候选都同意。未回应定向消息阻止共识。

相关异议根据保存的答案 previousVersionId 链、依据版本链或答案的显式 unresolvedObjectionIds 判断，不用字符串相似度、ID 前缀或权重。当前 epoch 中的相关 material/blocking 异议只有原提出者明确 resolved/withdrawn 才解除；其他成员的 stance 不能替代作者状态。状态在前一完整检查点已经解决的异议，沿用前置协议的已解决状态；需要新异议时另行提出，而非偷偷改旧记录。

`selectFinalResult({ session, stopReason, constraintChecks? })` 是纯函数。stopReason 必须由宿主明确提供：

- 当前完整检查点存在共识候选时，直接复制选中候选正文和 limitations。多个候选均获共同接受才使用 decisionWeight 排序；并列按 body、排序后的 basis IDs、limitations、排序后的异议 IDs 的 canonical 内容 hash，最终等价 tie 用 versionId 固定排序。此规则属于 discussion-policy-v1，不裁决未获接受的候选。
- `checkpoint` 下没有共识，返回 incomplete/discussion_continues，不伪装正常到限。
- `round_limit` 必须达到冻结政策与 opening 复杂度导出的轮数上限，且有当前完整 review；否则 incomplete。`budget_limit` 是未来预算宿主提供的明确正常资源到限信号；本函数不计算调度或证明预算已经耗尽。
- interrupted/deadline/model_failure、缺少当前完整 review、最高偏好成员缺少有效提交答案或约束失败均 incomplete；不采用 sealed/raw 回应，不改选次高成员。缺少最高偏好答案的结果记录 missingAnswerMemberIds 供未来恢复展示，不生成答案正文。
- 无共识且正常到限，选择最高 decisionWeight 成员的当前最后有效提交版，保留原正文、限制和有来源的重要异议。participationWeight 不参与选择。
- 最高偏好并列且未共识时，outcome 为 tied_preferences，answer 为空；alternatives 逐项保留所有最高偏好的真实版本及正文，selectedAnswerVersionIds 记录它们，无固定胜者、无合并新正文，即使文字相同也不冒充同一版本共识。

重要异议只取当前完整 review 中原作者 retained 的 summary/impact/evidenceNeeded。所有 blocking 保留，其他直接关联所选答案的 material 保留，低权重不会抹掉异议；只按 objectionId 去重，不合并措辞相似的不同异议。目标版本 ID 和 severity 均保留来源，不自由重写目标或摘要。

### 约束输入与来源边界

ConstraintCheck 是宿主单独输入 `{checkId, source: host, contextHash, answerVersionId: string|null, status: passed|failed, evidence}`。null 表示全局上下文检查，具体 ID 只约束该当前候选；失败不能被权重覆盖，已失败的并列候选也不能被静默删除后单选另一成员。不同候选有共同接受且有效的方案时，可以形成该方案的共识，而非按偏好绕过失败。

重复、过期上下文、旧/未知答案或 model source 检查拒绝，不自动转移给新版本。模型 turn 不提供这些检查；其文字“已验证”不会生成 host 证据。本阶段不执行外部验证器，也不判断 evidence 的事实真伪；宿主必须负责可信来源及实际检查。

`parseFinalResultSources` 验证输出结构、session/epoch、保存正文/限制和原作者异议字段的逐项来源，不能自由补写或改写答案。它只验证这些来源，不独立证明共识 outcome、外部事实或宿主到限信号；policy 判断由 selectFinalResult 负责，运行与可信输入由后续引擎负责。

### 验证与边界

- 共识 41 项：完整双/三成员、同文不同版本票、依据拒绝/不确定、备选观点分歧、历史依据、旧票、新版本、完整覆盖与 hash、未回应消息、保留异议、作者解决、版本链关联、空集合和宿主失败/过期证据等。
- 选择 30 项：最新版本回退、只换决策偏好且讨论记录不变、参与偏好不决定来源、共同接受候选中的排名、正常到限/异常/半批、并列全保留、低偏好原作者最新摘要、不同 ID 同文本不合并、约束不能被偏好覆盖、禁止伪造正文/作者/摘要、缺少最高偏好答案等。
- 共识先写人工反例和惯性占位实现，出现 21 failed / 13 passed 的语义 RED 后实现并扩展到 GREEN。缺少最高偏好成员的恢复标识也先写失败断言，再补结果字段与来源校验。所有计算不改变输入状态，不发模型调用。

最终本地验证：`npm run build`、`npm run check`、`npm run lint`、`npm run format:check`、`npm run test` 全部通过。**71 项新增测试**，全仓 **988 项**（core 465、CLI 418、viewer 85、CoThink 20），包含旧协议/版本哈希/传输/存储回归。编译后 core 的当前共识判断及原正文选择离线 smoke 通过。独立审查 0 个可行动问题；缺失成员标识补丁也已静态复核并通过最终测试。修改前摘要确认只有 7 个约定文件变化，其余检查点源码不变，最终 Git diff 空白检查通过。

阶段 3 尚未提交或推送，PR/远端 CI 只覆盖阶段 0–2 的 checkpoint。没有阶段 4 的实际提前停止调用、attempt/ledger 接线、持久化最终结果、恢复、真实 API、施工同步、自然语言判真或 CLI/浏览界面；本阶段提供可供未来引擎消费的纯候选与结果。预算到限真实性、宿主验证证据可信性及新段政策切换由后续宿主保证。本次停止在阶段 3。

## 阶段 4：讨论调度、持久化和恢复

日期：2026-10-14。阶段 4 实现保留本地；普通 CLI 接线与展示仍待阶段 5。

### 起点及保留范围

读取 AGENTS、计划及交接后，核对 `discussion-stage-0` 和阶段 0–2 的 `5286634` 检查点。阶段 3 的源码、测试及记录已经在未提交工作区，未重复实现。修改前重新通过 workspace 类型检查和 **334 项 discussion 测试**，未将历史 988 项成绩当成本阶段验证。文件摘要比对确认 `consensus.ts`、`decision.ts`、`result.ts` 及两份阶段 3 测试原字节保留。

旧 peer 协议、固定哈希样本、传输适配、原子快照/写锁实现、CLI 命令展示、依赖、版本号及发布配置保持不变。新增 CLI 出口仅导出 FileDiscussionStore，不让普通命令创建或展示 discussion。实现过程没有真实模型 API、Git 暂存/提交/推送/合并或发布。

### 变更及职责

| 文件                                                                                                                 | 职责                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/argue/src/discussion/engine.ts`                                                                            | DiscussionEngine：独立 opening、全员交流、完整检查点、继续讨论、正常结束与暂停；通过 ModelTransport 和窄 store 接口接线，不依赖磁盘或 CLI。                |
| `packages/argue/src/discussion/store.ts`                                                                             | `discussion.runtime.v1` 运行记录、冻结 job/call、attempt 关联、seal、观测、段和事件；严格重放所有缓存及追加式 transition，重新核实真实停止条件与最终选择。 |
| `packages/argue-cli/src/discussion/file-store.ts`、`src/index.ts`                                                    | FileDiscussionStore 挂载已有 FileSnapshotStore，复用私有原子快照、writer/recovery lease、串行写入及 revision CAS；宿主在 withWriter 内使用引擎。           |
| `packages/argue/src/discussion/budget.ts`、`test/discussion/budget.test.ts`                                          | 缺失成员显式重试和独立预算扩额记录；BudgetCapacityError 区分容量不足；原冻结 policy、失败/unknown 占用不变。                                               |
| `packages/argue/src/discussion/contracts.ts`、`protocol.ts`、`index.ts`                                              | 新段的 segmentId/contextVersion 初始化与严格重放接缝、运行模块出口；默认初段仍为 1，旧协议未改。                                                           |
| `packages/argue/src/discussion/json-codec.ts`                                                                        | 校验保存的 JSON-v1 请求实际表达，绑定共享语义、真实引用槽位、system 和 schema；不调用 encode 或重新生成旧请求。                                            |
| `packages/argue/test/discussion/engine.test.ts`、`store.test.ts`                                                     | scripted transport、fake clock、严格 JSON 往返、停止反例、冻结重试、迟到、取消、CAS、observer、新段和已知约束恢复。                                        |
| `packages/argue-cli/test/discussion/file-store.test.ts`、`crash-fixture.mjs`、`signal.test.ts`、`signal-fixture.mjs` | 真实临时磁盘、双进程 writer、CAS、SIGKILL 六边界及真实 SIGINT；子进程使用本次构建产物，不使用模型网络服务。                                                |

### 运行及持久化约定

- `start(input, signal?)` 先保存初段，再运行。每批冻结模型配置、codec 版本、共享上下文、身份、输出帽、完整 messages/schema 和 inputHash；`prepared` 原子保存这些请求、attempt 和预算占用后才 dispatch。transport 收到保存 call 的副本，不能改写历史。
- 所有成员独立读取同一共享语义；没有模型主持、裁决或汇总。`settled` 只封存有效回复及观测，成功半批不修改答案。全体有效后 `commit_batch` 一次提交；review 不修订候选答案。
- `run/recover` 对 active 状态仅保存暂停，把 pending 记为 unknown；即便崩溃点没有 pending，也不自动运行下一阶段。completed/paused 读取不调用模型。首次 retry/continue 遇到 active 也仅恢复；再次显式操作才推进。
- `retry` 只补缺失成员，复用原 job、call、inputHash 和输出帽；成功 sealed 成员不重问。失败、取消、unknown 与请求输出帽均不退款；新尝试重新占用额度。缺少完整额度就保持暂停，不删除低权重成员。
- 预算不足以开始另一轮交流但足够完整评议时，使用已预留额度进入 review。只有当前完整检查点才可能正常结束：有共识为 checkpoint；达到冻结轮数为 round_limit；实际容量不能再支持交流及全员评议为 budget_limit。deadline、SIGINT、模型失败或不完整评议只暂停，不生成正常回退结果。
- 调度从保存状态重新检查交流的 readiness、未回应消息、轮数与预算；也复用已保存但未使用的新 review reservation。交流提交后或预留下轮 review 后的崩溃不会跳过检查点或重复预留。
- 完整评议后，宿主约束证据以 `constraints_checked` 追加保存。同一 checkId 不可静默覆盖；重启或缺省新 options 不能忘记已知失败。针对旧答案的检查保留历史，但不会迁移到新版本；全局检查留在所属段。有效检查、共识规则和真实 stop 都在最终保存及重放中核对，不能仅以正文来源验证替代。
- FinalResult 直接使用阶段 3 函数及保存答案，正文不补写；并列保留备选。保存后段不可修改，重启/retry 返回同一结果且零调用。已知约束失败暂停，保留检查证据，不保存虚假的成功结果。
- `continue` 追加新段，冻结新材料、模型配置、政策及两类权重，重新 opening；旧段的请求、账本、权重、答案和最终结果保持原样。新段不会继承旧上下文的宿主检查证据。
- 扩额只接受暂停状态下显式提供的 `extraCalls`、`extraAllocatedOutputTokens`、`extendMs`，作为 ledger.extensions 追加；不覆写原 policy，也不退款。不会自动扩额。时刻由宿主提供非负、单调安全整数毫秒；AbortSignal 由宿主连接 SIGINT，core 不安装全局进程信号监听。
- 保存成功后通知 observer，其同步异常/异步 rejection 不回滚、不增加调用。调用超时和取消使用独立 AbortController；忽略取消的 transport 迟到回复也不能再次 seal、提交或改写结果。写入冲突直接失败，不伪装模型失败、约束失败或正常到限。

### 本次实际验证

环境：macOS、Node.js 24.19.0、npm 11.17.0。全部模型响应为 scripted；既有传输及安装 smoke 仅访问 loopback HTTP。

| 验收               | 当前代码的实际证据                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首个检查点共识早停 | opening 2 + discussion 2 + review 2 = **6 次调用**；run/retry/reload 零新增调用，结果来自保存版本。                                                                                                                    |
| 四轮完整评议均分歧 | **18 次调用**，4 个 committed review；实际 round_limit，回退为最高决策权重成员第 4 轮最新答案。                                                                                                                        |
| 完整评议预留       | maxCalls=6 且双方尚未 ready 时也以预留额度完成 review 后正常 budget_limit；初始额度不足零调用暂停，全员保留，显式扩额另留记录。                                                                                        |
| 冻结及重试         | 原请求逐项相等，opening encode 仍只有 2 次；半批失败后只补缺失成员。unknown 重试沿用旧 job，但旧占用和新尝试均计账。                                                                                                   |
| 实际 SIGKILL       | 创建后、prepared 落盘后/dispatch 前、dispatch 后、首个成功 seal 后、整批 commit 后、FinalResult 保存后六处精确停住子进程并 SIGKILL；首次恢复均零调用。seal 后只补缺失成员；final 后原记录/结果不变。                   |
| 实际 SIGINT        | 两次 dispatch 后给真实子进程发送 SIGINT，宿主桥接 AbortSignal；provider 不主动 settle 仍正常取消退出，磁盘 paused/cancelled，2 次占用不退，无 commit/final，恢复零调用。                                               |
| 截止和迟到         | fake clock 在硬截止返回成功仍拒绝；fake timers 令不响应 transport 到单调用超时后暂停；取消后迟到 resolve 不改变保存快照，不冒充正常到限。                                                                              |
| 真实存储和 writer  | 私有 0700/0600 权限、原子快照、半写临时文件、损坏/非法版本/符号链接拒绝；双 CAS 仅一个成功、另一进程活 writer 拒绝、SIGKILL 后 lease 可回收、逃逸 lease 不可写。                                                       |
| 重放及约束         | 重算哈希仍不能改问题、槽位、system/schema；旧事件 prefix、模型配置、缓存及最终正文/结果/停止条件篡改拒绝。saved request 重放 encode 零次；已知约束失败跨新引擎重试仍拒绝，不能省略已存检查或将旧答案检查当新版本证据。 |
| 段与前置兼容       | 新段实际改变参与/决策权重、模型选项和材料，旧段整体逐项相等；旧 peer 恢复、50 份请求/哈希固定样本、路由、HTTP 适配及存储回归继续通过。                                                                                 |

最终重新构建后运行 `npm run check`、`npm run test`、`npm run lint`、`npm run format:check`、`npm run smoke:pack` 和 `npm run smoke:cothink`，全部退出 0。全仓 **1,066 项**：core 532、CLI 429、viewer 85、CoThink 20；相较阶段 3 新增 **78 项**（budget 13、store 30、engine 24、真实磁盘/进程 11）。最后一次全量运行覆盖约束持久化补丁，并复跑最终构建产物下六处 SIGKILL 和真实 SIGINT。安装检查仍证明既有 CLI tarball 可独立安装，不冒称阶段 5 尚未接线的新版命令已验收。

日志保存在源码仓库外的阶段 4 工作目录：`before-check.log` / `before-tests.log` 是修改前复核，`build-final.log`、`check-final.log`、`test-final.log`、`lint-final.log`、`format-final.log`、`smoke-pack-final.log`、`smoke-cothink-final.log` 是当前代码最终验证；`store-report.md`、`disk-report.md`、`signal-report.md` 和 `review-report.md` 记录定向证据与审查发现。日志和本地会话均未加入源码范围。

独立审查实际复现并推动修复：交流提交后的恢复跳过评议、预算不够却漏用预留评议、宿主失败与恢复 guard 冲突、重算哈希后实际共享消息可篡改，以及预留下一检查点后的恢复窗口。新增持久化约束反例也验证重启不能遗忘已知失败。修复均保留测试，不把首次失败日志改写成通过。

### Git/PR 与未验证边界

本次只读核对 [草稿 PR #1](https://github.com/XSY-28/CoThink/pull/1)：仍为 OPEN/DRAFT，head `5286634f61160e7a8044bfef5b82237ec7ecdc2b`；Node 22/24 checks 仍 success，仅覆盖阶段 0–2。阶段 3 和 4 未暂存、提交或推送；远端 CI 没有验证这些本地增量。

- 没有真实 provider 调用、付费用量、真实取消后的服务端计费或模型输出质量校准。请求输出帽和尝试预算已离线验证，不代表已验证 provider 的实际计费。
- 真实文件/进程验证为本机 macOS/Node 24；本阶段尚未执行 Node 22、其他 OS、断电/物理磁盘故障、文件系统级故障注入或大型会话性能验收。全历史严格重放会增加长记录验证成本，未做性能优化。
- JSON-v1 保存表达严格验证已经接线；不同交流语言的运行记录与表示替换验收仍在阶段 7。阶段 2 的独立 codec 领域校验保留。宿主检查的事实可信性仍由调用方负责，本阶段不运行外部检查器。
- 普通 CoThink CLI 仍使用旧 peer 路径；新版配置、结果展示、隐藏过程 sentinel 和新命令接线尚未实现，不以内部可运行引擎冒称新版 CLI 已交付。
- 既有 request-id 随机碰撞和 dependency advisory 不在本阶段修复范围。

本次停止在阶段 4。下一阶段按计划实施 CLI/配置与隐藏讨论。

## 阶段 5：配置、CLI 接线与隐藏讨论

日期：2026-10-14。阶段 5 已完成，改动保留本地；阶段 6 的真实模型校准及阶段 7 交付验收尚未开始。

### 起点与保留范围

先读取 AGENTS、计划和阶段 4 交接，检查功能分支 `discussion-stage-0` 与 `5286634` 检查点、现有阶段 3/4 未提交成果，保存修改前文件摘要。当前代码重新运行 engine/store **54/54** 回归通过；阶段 4 的历史 1,066 项成绩没有代替本次验证。

阶段 0–4 的所有 `packages/argue/` 源码和测试摘要与修改前一致；没有重复实现引擎、共识、决策、预算、codec 或存储重放。原 peer 驱动和协议也保持不变。CLI 在原功能分支上继续实施；没有新增工作树、暂存、提交、推送、合并、发布、版本调整或依赖改动。

### 变更及职责

| 文件                                                                                                  | 职责                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/argue-cli/src/discussion/config.ts`、`test/discussion/config.test.ts`                       | configVersion 2 / 旧配置严格识别、两成员 provider 解析、discussion 默认值与显式限制保留；只加载，不改写配置或密钥。                                    |
| `packages/argue-cli/src/peer/setup.ts`、`test/peer/setup.test.ts`                                     | 新 `setupDiscussionConfig` 收集强度、独立双权重和可选轮数；复用原私有、独立密钥、排他创建与遮蔽输入。原 `setupPeerConfig` 入口保持旧行为。             |
| `packages/argue-cli/src/discussion/commands.ts`、`test/discussion/commands.test.ts`                   | CLI 参数及优先级、上下文复制、版本分派、现有 DiscussionEngine/PeerSessionDriver 接线、恢复与续接、公开未完成投影和私有最终结果导出；不生成或重写答案。 |
| `packages/argue-cli/src/discussion/render.ts`、`test/discussion/render.test.ts`                       | 只消费严格 FinalResult；文本、JSON、Markdown、静态 HTML 渲染，不依赖会话、provider、账本、原始响应或完整评议。                                         |
| `packages/cothink/src/index.ts`、`src/cli.ts`                                                         | 新会话默认 discussion，setup/init 默认 v2，管理命令先识别配置版本；help/参数/退出码；可执行入口阻止 Node 将应用 `--env-file` 当作自己的预加载参数。    |
| `packages/cothink/test/cli.test.ts`、`session-routing.test.ts`、`discussion.test.ts`、`entry.test.ts` | 实际 loopback、版本/参数/优先级、隐藏标记、权重回退/并列/异议、重试/新段、双凭据脱敏、实际可执行入口与不可变读取。                                     |
| `scripts/smoke-cothink.mjs`                                                                           | 新鲜 tarball 在源码仓库外通过实际安装的命令入口运行，核对 v2、6 次调用共识、新段、四格式导出、HTML 源码、stdout/stderr 与零调用读取；无上游库依赖。    |

### 配置和输入约定

- 新配置为 `{configVersion: 2, members: {...}, discussion?: {...}}`。members 沿用现有 provider/profile 输入；对外仍严格要求 member-a/member-b。未知版本、未知根字段、缺少成员、非法权重或限制拒绝。旧 `{members: {...}}` 及显式 version 1 只在内存补 standard 和双权重 1；不会迁移或重写原文件。
- discussion 支持 effort、weights、maxRounds，以及显式调用/输出分配/时长/单调用帽。省略的派生资源帽保持省略，CLI 改 effort 后由原 policy 函数按新档计算。显式限制继续受原 effort 硬帽验证；high 不映射成 provider reasoning 参数。
- CLI → 配置 → 默认值。`--effort low|standard|high`、`--participation-weight member-a=2`、`--decision-weight member-b=3`、`--max-rounds N` 单独覆盖；未指定的另一权重保留配置值。权重必须有限且在 0.1–100，同一成员的同类覆盖不能重复；没有关闭成员或单 Agent 讨论模式。
- `start` 恰好选择 `--question` / `--question-file` 之一，拒绝空问题。文件作为 UTF-8 数据读取；`--context` 可重复输入 .md/.txt，约束仍支持重复 `--constraint`。原资料和每成员字符上限继续验证，opening 预检发现超限时不创建会话、不调用模型。
- `--rounds` 保留为 `--max-rounds` 的兼容别名，两者不可同时使用。旧的每调用 `--max-output-tokens` 不冒充新讨论的累计预算；新讨论显式帽为 `--max-calls`、`--max-allocated-output-tokens`、`--max-duration-ms`、`--call-timeout-ms`。
- `continue` 缺省沿用保存的模型与政策；显式 `--config` 加载新配置，再应用 CLI 覆盖。显式换 effort 时重新采用该档的默认资源帽，可通过新配置或 CLI 明确收紧；原段不变。新材料只复制一次，交给现有引擎冻结新段。旧格式续接仍用旧驱动，不能把新 discussion 权重默默套到旧段。
- 非法 effort、权重、成员、重复参数、非安全整数、毫秒溢出或超出政策硬帽，在首次 active 恢复分支之前拒绝；返回 1、快照字节不变，而不是悄悄忽略参数并返回暂停。
- setup/init 写 v2，默认 standard、两成员各自两种权重均为 1，轮数空输入表示不额外限制。双方可跳过密钥输入或使用既有环境；文件仍排他创建、目录 0700/文件 0600，密钥独立保存，已有文件不覆盖。进程环境优先于密钥文件。

### 命令、结果与恢复

所有 `cothink start/show/retry/continue/view/export` 都通过同一命令层处理；新 start 使用 DiscussionEngine。合法旧格式保持 FilePeerStore + 原驱动，合法新格式进入 FileDiscussionStore 的完整严格校验，不将路由头当作可执行状态。非法/混用版本在模型调用及 writer 修改前拒绝。

- 正常共识、权重回退、偏好并列退出 0；未完成或没有新版最终结果退出 2；参数、配置、损坏格式和命令错误退出 1。共识/回退正文与保存答案版本相同；并列展示实际 alternatives 和各自限制，没有固定胜者或合成正文。
- 新段未完成时输出一个安全的 incomplete FinalResult 投影，原因及恢复办法来自程序固定映射。不会把 pauseReason.message、provider error、原始响应、sealed 回应或旧段 FinalResult 冒充当前答案。已知约束失败保持未完成，并保留原宿主证据。
- 旧会话不推断新版共识：公开结果标记 legacy peer 格式及 active/paused/completed 状态，answer 为空，提供 retry/continue/新 start 办法；读取、导出和旧段完成后仍为 incomplete/2。旧冻结请求、inputHash 和全部原始内部记录继续保存，恢复/续接仍走原协议。
- 首次操作 active 会话只执行恢复，零模型调用；重复显式 retry 才补缺失成员。成功封存成员不重问，失败/unknown 占用保留。扩额参数为 `--extra-calls`、`--extra-output-tokens`、`--extend-seconds`，实际执行仍由阶段 4 账本及引擎验证。
- stdout 只输出公开结果。`--json` 在六个会话命令中输出单个可解析 FinalResult 对象，没有内部进度或外层 wrapper。必要的中断/保存提示进入 stderr。setup/help/version 和明确调用的连接诊断是独立管理入口。
- 文本/Markdown/HTML 显示状态语义、答案、必要限制、重要异议和真实备选，以及恢复所需 session/segment；没有 review hash、逐轮消息、完整评议、内部诊断或展开入口。JSON 完整保留 FinalResult 的来源字段，不带运行记录。
- HTML 只含转义后的最终结果和静态样式，没有脚本、隐藏 DOM、内嵌讨论 JSON 或完整记录。渲染器拒绝额外、继承、非枚举或 getter 形式的诊断渠道；错误为固定安全提示。
- show/view/export 不加载配置或密钥，不调用模型，显式传入不存在的 `--env-file` 也不访问它。export 支持 txt/md/json/html；view 生成同一最终结果 HTML，`--no-open` 不启动浏览器。导出文件保持 0600，私有临时文件后原子替换；拒绝会话/锁/默认配置/密钥目标及符号链接/硬链接，读取过程不会覆盖已保存会话。
- 可执行入口使用 `env -S node --`，避免 Node 24 把应用 `--env-file` 提前处理。安装后的实际 `.bin/cothink` 已验证；直接用解释器运行文件时，应使用 `node -- FILE ...`。Windows npm shim 对这类 shebang 的解析仅检查了本机 npm 源码，尚未实机验证。

### 本次实际验证

环境：macOS、Node.js 24.19.0、npm 11.17.0。没有使用真实账户或模型 API。mock 和 loopback 响应将 `INTERNAL_DISCUSSION_SENTINEL` 只放在内部观点、依据、评议理由、evidenceRequests、provider reasoning/失败诊断或生成选项中，公开答案和异议使用独立文本。

| 验收         | 实际证据                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新版完整 CLI | 实际 loopback start 6 次共识，show/export 返回保存 FinalResult；config v2 和旧配置均进入新 discussion。                                                                                               |
| 隐藏过程     | start/show/retry/continue/view/export 的 stdout/stderr，txt/json/md/html 导出和完整 HTML 源码均不含内部标记或 fake 密钥；内部 session.json 确实含标记，证明测试不是没有植入数据。                     |
| 决策与异议   | 6 次到限分歧按较高决策权重采用最后有效答案；原作者重要异议保留。下一段权重并列时展示两个真实 alternatives，answer 为空。                                                                              |
| 优先级与冻结 | 问题文件、上下文、effort/独立双权重/轮数覆盖逐项在保存政策中核对；继续切换 low→high 与决策偏好，旧段整体相等；原配置字节未改写。                                                                      |
| 重试和恢复   | 模型失败先返回 incomplete/2，sealed 半批不提交；retry 只补缺失成员、旧 call/hash 相等。两格式 active 首次恢复零调用、零密钥读取，unknown 占用不退；原 legacy 驱动完成重试及续接，格式不迁移。         |
| 读取与安全   | 缺失密钥文件及抛错的密钥 getter 不妨碍 show/export/view；快照字节不变且零调用。非法版本、引用/hash、权重、超限输入及恢复前非法参数拒绝；链接导出不能覆盖原快照。                                      |
| 双凭据脱敏   | 实际 loopback 失败同时回显双方 fake 凭据与内部标记；公开结果无标记、无任一凭据，私有保存失败记录保留标记但双方凭据已脱敏。                                                                            |
| 源码外安装   | 新鲜 tarball 无 `@onevcat/argue` 运行依赖，实际安装命令运行 help/version/init、4 次旧连接诊断、6 次新协议共识、6 次新段；四种导出及离线 view、缺失密钥文件的读取、stdout/stderr/HTML 源码检查均通过。 |

最终重新构建后，`npm run check`、`npm run test`、`npm run lint`、`npm run format:check`、`npm run smoke:pack`、`npm run smoke:cothink` 全部退出 0。全仓 **1,164 项**：core 532、CLI 516、viewer 85、CoThink 31；相较阶段 4 新增 **98 项**。旧请求/哈希、旧协议/恢复/传输/存储及阶段 4 六处 SIGKILL、真实 SIGINT 回归也在本次全量中通过。

配置、渲染、命令及最终接口组合分别经独立审查；当前无待处理问题。最终组合审查独立运行 **134 项** 定向测试，包含最新 active continue 上限校验和实际可执行入口，全部通过。全仓与安装成绩来自主任务上述当前运行，未冒称审查重复了全部测试。

整合中的实际反例与修复：旧 completed continue 预检错误地请求“下一请求”，改为窄的 provider 配置检查；active continue 的非法参数被恢复快捷分支忽略，改为恢复前完整校验；硬链接导出目标会截断保存快照，改为链接拒绝和原子替换；安装测试发现 Node 提前读取应用 env-file，改为解释器参数边界。语义 RED/GREEN 与最初测试夹具/缺失导入的错误日志均保留，未以夹具错误代替拒绝规则的证据。

工作目录内的 `before-runtime.log`、`build-final.log`、`check-final.log`、`test-final.log`、`lint-final.log`、`format-final.log`、`smoke-pack-final.log`、`smoke-cothink-final.log` 保存本次证据；config/render/commands/final review 报告及各反例日志也保留在仓库外的阶段 5 工作目录，没有加入源码或发布包。

### Git 与尚未验证边界

阶段 3–5 的增量继续未提交、未推送。PR/远端 CI 只覆盖阶段 0–2 的检查点，不能当作阶段 5 的 CI 验证；本次没有创建、合并或更新 PR。

- 真实 DeepSeek/GLM 及其他 provider 的新版协议输出、费用、取消后的实际计费、协议有效率和模型质量尚未验证，留在阶段 6；明确调用的 test/doctor 仍为原有 bounded peer 连接诊断，并不是新版完整讨论校准。
- 本次实际可执行入口、文件权限、磁盘/进程和 tarball 验证为 macOS/Node 24。阶段 5 没有运行 Node 22 或 Windows/Linux 实机；Windows shim、交互 TTY 的真实密钥输入、浏览器实际打开/视觉验收仍未验证。HTML 静态源码与转义已验证。
- 三成员面向用户配置、交流语言实际替换、断电/磁盘故障、大型会话性能以及阶段 7 的完整文档/开源交付验收尚未完成。内部 roster 算法保留，没有引入两成员专用的核心讨论/决策算法。
- 不新增施工同步、单 Agent 讨论或讨论浏览入口。既有 request-id 碰撞和依赖 advisory 保持此前边界。

本次停止在阶段 5。下一阶段再按计划进行有硬上限的真实模型校准。

## Git 上传检查点：阶段 0–5（2026-10-14）

用户本次授权保存并上传当前开发成果。阶段 0–2 已在 `5286634` 检查点；本次纳入 37 个明确的源码、测试和交接文件，保存阶段 3–5 增量。各阶段末尾“未提交、未推送”描述的是当时的状态；本节随当前功能检查点保存。没有纳入本地配置、密钥、会话、依赖、构建产物或仓库外工作日志，版本和依赖保持不变。

上传前重新运行 build/check/test/lint/format:check 与 smoke:pack/smoke:cothink，全部退出 0，测试 **1,164 项**（532/516/85/31）。没有以阶段 5 的历史日志代替本次检查；没有真实模型 API 调用。文件清单逐项暂存，不使用 `git add .`，推送目标仍为现有功能分支和 [草稿 PR #1](https://github.com/XSY-28/CoThink/pull/1)。

推送 SHA 及 Node 22/24 的远端验收以该 PR 的当前 head 和对应 CI 检查为准；本地通过不能代替远端通过。此次只是 Git 检查点，不合并 main，不创建 npm/GitHub Release，也不进入阶段 6。

### 上传后的 CI 修正（2026-10-14）

`f191e11` 已普通推送到功能分支，草稿 PR #1 的范围更新为阶段 0–5。首轮 [CI 38522956464](https://github.com/XSY-28/CoThink/actions/runs/38522956464) 的 Node 22 上全部 **1,164 项断言通过**，但 core 的 Vitest worker 报 `Timeout calling onTaskUpdate`，整次作业仍失败；Node 24 被矩阵 fail-fast 取消，安装检查未执行。因此不能把该轮标成 CI 通过。

从日志及 Vitest 本地实现确认 RPC 默认超时 60 秒，内存存储替身的连续纯重放在该 CI 机器上使整个 engine 测试文件占用约 81 秒，只让出微任务，通信回调无法及时处理。新增“提交之间监督事件循环可以推进”回归，修正前定时回调只能在 6 次调用全部结束后触发，语义断言失败。测试替身现在在提交后显式让出事件循环，模拟真实磁盘 I/O 的调度；fake clock 的硬调用计时断言保留。没有调整业务引擎、预算、停止规则、测试断言或 RPC 超时，也没有忽略未处理错误。后续远端成绩以本修正提交的 Node 22/24 检查为准。

修正后本地全量 **1,165 项**（core 533、CLI 516、viewer 85、CoThink 31）、check/lint/format:check 通过。独立审查 5 项调度、硬截止、CAS 与新段回归通过；本修补只涉及测试替身及本记录。
