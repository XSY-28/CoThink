# CoThink 讨论模式改造计划书

日期：2026-10-13。状态：设计与实施计划；本文件所列新功能尚未实现。

> **For agentic workers:** 执行时使用 executing-plans 的逐项检查方式，每阶段完成后核对验收证据。本计划描述后续功能，不代表它们已经实现。实施中的 Git 操作先检查变化，只暂存相关文件；提交、推送和发布按仓库流程执行。

**Goal：** 用户输入一个问题和思考强度，多个平等 Agent 在有限预算内讨论；有共识便提前结束，否则按决策权重采用最新观点并保留重要异议，用户默认只看到最终结果。

**Architecture：** 用确定性的讨论状态机组织 Agent，用独立策略模块控制预算和选择，用独立编码器表达交流内容。模型接入、持久化和用户展示分别通过明确接口连接，不设置负责指挥、裁决或自由汇总的模型。

**Tech Stack：** 沿用当前 TypeScript、Node.js 22+、Zod、Vitest 和 npm workspaces；复用已实现的 OpenAI-compatible / Anthropic-compatible API 适配，不增加服务端依赖。

**Spec：** 本文件第 1–6 节为设计规范，第 7 节为实施阶段，第 8–10 节为整体验收与交接要求。以下源码路径均相对现有源码仓库根目录。

## 1. 目标、范围和完成标准

### 已确认的目标

1. 总思考强度决定整个讨论可用的资源上限，而不是某一个模型的特定 API 参数。
2. 参与权重影响讨论资源分配，决策权重影响无共识时的选择；两者独立。
3. 所有 Agent 都保留独立表达、反驳、回应、修订自己观点和评议候选答案的权利。
4. 共识成立后提前结束；到计划轮数上限仍没有共识时，输出最高决策权重 Agent 的最新有效答案和重要异议。
5. 讨论过程暂时隐藏。用户界面不显示逐轮内容、原始 JSON、完整评议或可展开的讨论记录。
6. 架构允许以后替换 Agent 之间的交流表示，并接入独立开发的施工同步工具。

### 本轮范围

- 面向用户仍先支持两个 Agent，复用 DeepSeek / GLM 接入；内部成员集合、评议覆盖和决策遍历按 roster 处理，不在新协议中固定写死两个成员。
- 支持 `low / standard / high` 三档总思考强度；支持独立参与权重、决策权重和显式轮数上限。
- 提供一份可直接阅读的最终结果，支持文本和 JSON 输出以及离线查看、导出。
- 保留内部记录、版本引用、完整评议和显式重试，支持故障恢复。
- 为开放式判断、解释、建议和方案讨论服务。

### 本轮不实现

施工分工、执行代码、文件同步、自动合并、Agent 工具调用、单 Agent 模式、讨论过程浏览器、自然语言持续聊天界面，以及交流语言的实际优化。也不为尚未出现的需要搭建插件市场、通用消息总线或分布式服务。

### 可检查的完成标准

- 共识案例实际停止后续调用，输出被所有成员确认的同一版答案。
- 分歧案例准确选取最高决策权重成员的最新答案，包含其余成员的重要异议。
- 参与权重变化可测量地改变讨论额度，但不改变版本所有权或共识条件。
- 所有调用、重试、失效响应均计入预算；程序不会自行提高预算。
- 普通命令输出不含内部讨论；最终结果本身不依赖原始消息格式。
- 旧会话能够继续读取、恢复；冻结输入和历史哈希保持原样。
- 更换编码器或存储实现不需要改共识与选择规则；内部三成员测试能通过。

## 2. 当前实现基线与改造路线

编写本计划时直接核查源码确认的状态：

| 当前能力                                   | 依据                                                     | 改造方式                                     |
| ------------------------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| 独立 opening、同快照交流、成对提交         | `packages/argue/src/peer/protocol.ts`、`driver.ts`       | 延续同快照、整批校验与提交，新增讨论协议     |
| 不可变观点版本、只允许作者修订自己的观点   | `packages/argue/src/peer/contracts.ts`、`protocol.ts`    | 保留，增加最终答案版本                       |
| 对冻结集合的完整逐条评议和 `reviewSetHash` | `packages/argue/src/peer/protocol.ts`                    | 保留，扩展到候选答案和关键异议               |
| 最少讨论轮数、最后一次 review 后结束       | `packages/argue/src/peer/protocol.ts`                    | 新协议支持多次检查点与失败后继续讨论         |
| 原子快照、写入者锁、CAS 和中断恢复         | `packages/argue-cli/src/peer/file-store.ts`、core driver | 提取必要存储机制，旧格式继续独立校验         |
| 同时记录双方结论和争议，未选择统一答案     | `packages/argue/src/peer/report.ts`                      | 新增确定性 FinalResult，保留内部 AuditRecord |
| 终端显示已提交轮次的完整 JSON              | `packages/argue-cli/src/peer/commands.ts`                | CoThink 普通输出改为最终结果                 |
| OpenAI / Anthropic 兼容接入和密钥脱敏      | `packages/argue-cli/src/runtime/peer-api.ts`             | 窄化传输接口，复用网络实现                   |
| `cothink` 入口转发旧 peer 命令             | `packages/cothink/src/index.ts`                          | 按会话版本分派；新会话使用新讨论模式         |

此前的测试成绩不作为新功能已通过的证据。计划编写阶段未重新运行代码测试；实施第一步应记录当时可重现的基线。GitHub 基线上传的验证结果单独记录。

### 路线比较与推荐

| 路线                                     | 优点                                         | 代价                                                       | 判断         |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------ |
| 直接在旧 peer 状态机中增加条件           | 文件少，初期快                               | 多检查点和答案版本会改变旧会话语义、输入和哈希             | 不作为主路线 |
| 新建 discussion 协议，复用存储与传输机制 | 新规则边界清楚，兼容旧会话，便于替换交流格式 | 需要维护明确的格式分派                                     | **推荐**     |
| 新增一个汇总 Agent 读取全程并生成答案    | 容易产出流畅文本                             | 汇总者能改变结论，新增调用与事实来源，形成事实上的裁决中心 | 不采用       |

新协议使用 `schemaVersion: 2`、`promptVersion: peer-v6` 和独立的 codec 标识。旧 `peer-v1` 至 `peer-v5` 保持冻结，不将旧会话强行转换成新格式。

## 3. 默认政策与权重的准确含义

以下数字是**推荐的首版工程默认值，尚未经过新流程的真实 API 校准**。它们是上限，不是预计消耗。

### 3.1 总思考强度与复杂度

| 强度     | 简单问题轮数上限 | 中等问题轮数上限 | 复杂问题轮数上限 | 双成员最坏调用上限 | 分配的输出额度上限 | 整段时间上限 |
| -------- | ---------------: | ---------------: | ---------------: | -----------------: | -----------------: | -----------: |
| low      |                1 |                1 |                2 |                 10 |      65,536 tokens |       180 秒 |
| standard |                2 |                3 |                4 |                 18 |     163,840 tokens |       480 秒 |
| high     |                3 |                5 |                6 |                 26 |     262,144 tokens |       900 秒 |

- 两名 Agent 在独立 opening 中分别给出 `simple / moderate / complex` 估计和理由；程序取较高等级，采用表中对应轮数。复杂度没有事实正确性的保证，程序不将它用于事实裁决。
- 不增加“复杂度评估模型”调用。opening 前冻结该强度的硬上限，opening 后冻结具体轮数。
- `--max-rounds N` 是显式轮数上限：实际轮数取复杂度建议和该参数的较小值；不能暗中抬高调用、输出或时间预算。
- 每个交流轮次包含所有成员针对同一共享快照的一次讨论回应。opening 和 review 检查点分别记账，不混入交流轮数。
- 每轮至多触发一个完整检查点。N 个成员、R 轮的最坏调用数为 `N × (1 + 2R)`，分别对应 opening、讨论、逐轮检查点；真实流程可少于这个上限。
- 每次调用超时的建议值分别为 low 45 秒、standard 60 秒、high 90 秒，并始终受整段剩余时间约束。开始新轮前保守预留一个完整 review 的调用时间窗口；这不是 provider 时延保证，硬截止仍可能导致未完成。内部三成员测试按成员数计算调用预算，讨论池和总输出额度按 N/2 缩放，不直接套用表中的双成员数字。
- 强度控制的是 harness 资源，不承诺各家模型同档具有等量的内部推理。现有 provider 参数保持显式配置；不自动把 `high` 映射成某家 API 的高推理档。
- 最大输出额度按每个实际尝试的请求上限累计，包括失败、取消和结果未知的尝试。它不包含输入 tokens，不能称为总 token 或金额上限。观察到的输入、输出和推理用量另行记录；缺失 usage 保持未知。
- 继续保留本地资料总字符上限和每成员请求字符上限，默认沿用 20,000 / 100,000；上下文超限在网络调用前拒绝，不静默删掉其他成员的观点或引用。

### 3.2 参与权重

- 每名成员默认 `participationWeight: 1`，要求有限正数，首版接受 `0.1–100`；暂不以 0 表示关闭成员。
- 每轮都保留所有成员的必需发言和回应，不用权重决定谁能被排除。
- 首版通过分配每轮讨论的输出额度体现参与权重，不先实现不对称的额外交流轮次。
- opening 保持每人 2,048 tokens 的相同额度。讨论每人至少 2,048 tokens，剩余额度按参与权重比例分配。双成员每轮总池暂定：low 6,144、standard 8,192、high 12,288 tokens。
- 例如 standard、权重 2:1 时，8,192 的总池先给双方各 2,048，再按 2:1 分配剩余 4,096，得到 4,779 和 3,413；权重交换后额度也交换。
- 分配先取整，再按小数余数从大到小补足；小数余数相同时采用记录在政策中的轮换次序，不长期偏向某个固定成员。它只影响最后几个 token，不用于最终决策。
- review 的完整覆盖额度不按参与权重缩减。每名成员预留 `max(4096, 256 × requiredReviewItems)`，其中 requiredReviewItems 包括全部活跃观点、全部最新候选答案和该成员须解释的未解决重要异议。
- 当前行动数量限制下，双成员最多六轮所需 review 额度可控制在每人 8,192 以内；该值是结构容量估计，不保证任何模型不会截断。模型或预算无法提供完整评议额度时，提前缩短后续轮数或暂停，不能删掉评议条目。
- 不把“权重更高”写进模型提示词作为服从依据。模型只获知自己的输出约束；完整权重表用于程序的预算和决策审计。

### 3.3 决策权重

- 默认 `decisionWeight: 1`，范围与参与权重相同，独立配置。
- 不用于加权认定共识。共识仍要求所有参与成员明确接受。
- 没有共识时，选取决策权重最高成员在当前段、最后一次完整提交中的有效答案版本；不使用 opening 的旧观点，也不把无效或未提交响应当作最新观点。
- 最高权重并列且答案仍有分歧时，输出一份标记为“偏好并列”的结果，包含简短的并列方案及重要异议。程序不偷偷选择固定 Agent，也不将其标成共识。用户可通过调整决策权重使下一段有明确偏好。
- 对用户明确约束的可执行检查失败，或外部验证器提供的可复现反例，不能用权重覆盖。没有验证器时，模型提出的反例仍是有来源的异议，程序不能把它冒充为已证明的错误。
- 最高权重成员缺少有效答案时，不自动改选次高权重成员；保留未完成状态，提示恢复该成员或显式修改新段的政策。

本轮不执行外部验证器，也不承诺自动判断任意自然语言约束是否被违反。程序只直接检查可执行的结构约束；宿主显式提供的验证结果需绑定上下文和答案版本，作为独立的可信输入校验。模型自己的“已经验证”文字不能生成这种结果。外部施工工具如何产生验证结果不在本计划实现范围。

权重只改变资源和程序选择，不改变观点所有权、上下文可见性、评议覆盖或其他 Agent 的权利。

## 4. 讨论、共识与最终输出协议

### 4.1 主流程

```text
冻结问题、上下文、成员集合、政策和硬预算
    ↓
所有成员独立 opening：观点、候选答案、复杂度估计
    ↓
确定具体轮数；冻结本轮共享上下文和各成员请求
    ↓
全体交流：回应 → 反驳 → 修订自己的观点及候选答案
    ↓
整批校验、原子提交
    ↓
符合检查点条件？
    ├─ 否：在预留完整评议预算后进入下一轮
    └─ 是：冻结评议集合 → 全体独立完整评议
               ├─ 存在共识答案：保存最终结果并停止
               ├─ 无共识且还有预算/轮数：继续交流
               └─ 无共识且达到计划上限：按决策权重结束
```

至少经过一轮相互交流再检查共识。opening 自身不是“已经讨论过”。所有成员都表示可进入评议、且没有未回应的定向问题时，可以提前触发检查点；最后一轮无论 readiness 如何都进行完整评议。readiness 只是检查时机，不是共识票。

模型异常、中断或硬截止发生在完整评议之前时，走暂停/未完成分支；不能伪装成正常的无共识结束。

### 4.2 不可变候选答案

- 每名成员都有自己的候选答案，可在每轮修订，程序生成不可变 `answerVersionId`。
- 答案包含 `body`、支撑它的 `basisVersionIds`、已知限制和声明的未解决重要异议；这些引用必须存在于该成员可见的冻结快照中。
- opening 无法引用同批尚未生成的全局 versionId 时，使用本成员草稿索引；整批提交时由程序解析成真实版本。模型不能自行创造或代用 ID。
- 只有作者可以修订自己的答案；其他成员通过评议或提供自己的替代答案影响它。
- 新观点、新答案、新上下文或相关异议都会使旧的共识确认失效。
- review 不允许修订候选答案。评议中的备注只进入评议记录，不能悄悄变成被确认答案的新版本。若需要改答案，必须返回下一轮讨论，再重新冻结和评议。

### 4.3 共识针对答案，而不要求所有替代主张一致

一个候选答案被认定为共识，必须同时满足：

1. 全体 expectedMembers 独立返回有效 review；冻结的 `reviewSetHash` 与上下文版本准确匹配。
2. 每个 review 对全部活跃观点版本、全部最新候选答案恰好评议一次；不得漏项、重复或添加新对象。
3. 全体明确接受**同一个 answerVersionId**，并接受该答案依赖的全部 basisVersionIds。
4. 该答案涉及的重要异议，由原提出者明确标记解决、撤回或仍保留；不能由答案作者代替对方消除异议。仍保留、状态不明或缺少覆盖的关键异议阻止共识。
5. 没有未回应的定向问题，没有已知的用户硬约束检查失败。

可以对没有进入答案依据的备选观点继续分歧。完整评议不等于强迫接受每个观点。空观点集合、沉默、`uncertain`、失败响应和高权重成员单独接受，都不能形成共识。

多个候选答案都获全体接受时，程序优先选择作者决策权重较高的那个；并列时按答案内容哈希的固定顺序选择。这里所有候选均已获全体确认，因此不会把未获同意的观点偷换成共同答案。所有排序规则都写入 policyVersion。

### 4.4 到限没有共识

程序直接采用最高决策权重成员的最新有效答案正文，不另请一个模型自由改写或“统一结论”。

重要异议采用原提出者在最后完整评议中写下的简短摘要，每条包含：反对什么、成立时的影响、需要什么证据。内部保留目标答案/观点版本及原始异议引用，普通展示只显示必要的摘要。

去重只针对同一异议 ID，不用字符串相似度合并实质不同的反对意见。阻断性异议全部保留；其他直接影响采用结论的重要异议也保留。不得把尚未解决的异议描述成已经被驳倒。

### 4.5 用户看到的结果

共识时：答案正文 + 很短的“已达成共识”状态 + 答案自身必要的不确定性。

正常到限时：被采用的答案正文 + “尚未达成共识，按你的决策偏好采用此方案” + 重要异议。

并列时：一份简短的备选方案结果 + 并列状态 + 关键分歧，不声称已经选出胜者。

未完成时：简短的状态和恢复办法；可以附明确标记为暂存、未经完整确认的最新有效观点，但不能冒充正式结果。

### 4.6 隐藏的含义

- `start / show / view / export` 默认都使用 FinalResult，不只是关闭实时日志。
- 不输出各轮消息、逐条评议、原始模型 JSON，也不提供展开讨论的产品入口。
- 文本 stdout 只输出最终结果；可选的“正在思考 / 已保存 / 需要恢复”等进度进入 stderr，且不含模型观点。`--json` 输出单个完整 FinalResult JSON。
- HTML 和 Markdown 导出同样只包含最终结果；不能把完整 AuditRecord 放进隐藏 DOM、脚本或 JSON 内嵌后声称已经隐藏。
- 内部记录继续保存在本地私有会话文件，供恢复和开发验证；隐藏不等于删除。它们不自动上传或公开分享。
- 旧会话在 CoThink 普通命令中也不能默认打开完整讨论。没有新版最终结果的旧会话显示“旧格式，尚无可确认的最终答案”和必要的恢复状态，不从旧记录编造新版共识。原始文件仍由维护者显式读取。

## 5. 按 Unix 思路划分模块

原则落实到可检验的边界：一个模块做一件事；输入输出契约明确；计算策略不访问网络；程序能通过文本输入输出组合；能替换实现而不改变决策语义。不为“灵活”预先制造大量空接口。

```text
CLI / 未来其他宿主
        │ DiscussionRequest
        ▼
Policy + Budget ──► DiscussionEngine ──► FinalResult ──► Renderer
                         │
                   ProtocolCodec
                         │ ModelCall / ModelReply
                         ▼
                    ModelTransport
                         │
                  各家模型 API

DiscussionEngine ◄──► SessionStore
DiscussionEngine ───► InternalEvents / AuditRecord
```

### 5.1 模块职责

| 模块              | 输入 / 输出                      | 应负责                                | 不应负责                           |
| ----------------- | -------------------------------- | ------------------------------------- | ---------------------------------- |
| Policy            | 用户配置 → 冻结政策              | 默认值、权重、强度、版本              | 发起 API 请求、裁决观点真假        |
| Budget            | 政策与额度账本 → 调用分配        | 硬限制、完整评议预留、权重分配        | 删除低权重成员的评议               |
| Engine / Protocol | 已校验轮次 → 状态转换            | 阶段、快照、全部成员、不可变版本      | 含 CLI 文案或供应商特例            |
| Codec             | 语义快照 ↔ 模型输入输出          | 提示词、JSON Schema、解析、局部规范化 | 改最终选择规则、发明缺失的关键评议 |
| Transport         | 冻结 ModelCall → ModelReply      | API、取消、usage、错误脱敏            | 修改成员集合、重试额度、共识       |
| Consensus         | 冻结评议 → 共识候选列表          | 确定性校验与计算                      | 使用模型再次判断谁更可信           |
| Decision          | 完整状态 → 最终采用来源          | 决策权重、并列、未完成情况            | 自由补写新观点                     |
| Store             | 版本化状态 ↔ 本地快照            | 原子写入、锁、CAS、完整性             | 将某个成功半批当作已提交结果       |
| Renderer          | FinalResult → 文本 / JSON / HTML | 用户可读结果                          | 偷读 AuditRecord 拼装更多观点      |

### 5.2 最小接口契约

以下是设计接口，尚不是已经导出的 API：

```ts
type AgentId = string;
type Effort = "low" | "standard" | "high";
type Complexity = "simple" | "moderate" | "complex";

interface AgentWeights {
  participationWeight: number;
  decisionWeight: number;
}

interface DiscussionPolicy {
  policyVersion: "discussion-policy-v1";
  effort: Effort;
  weights: Record<AgentId, AgentWeights>;
  maxRounds?: number;
  maxCalls: number;
  maxAllocatedOutputTokens: number;
  maxDurationMs: number;
  callTimeoutMs: number;
}

interface DiscussionRequest {
  question: string;
  context: Array<{ sourceId: string; content: string }>;
  constraints: string[];
  memberIds: AgentId[];
  policy: DiscussionPolicy;
}

interface AnswerVersion {
  answerVersionId: string;
  authorId: AgentId;
  previousVersionId?: string;
  body: string;
  basisVersionIds: string[];
  limitations: string[];
}

interface ImportantDissent {
  objectionId: string;
  authorId: AgentId;
  targetAnswerVersionId: string;
  targetClaimVersionId?: string;
  severity: "material" | "blocking";
  summary: string;
  impact: string;
  evidenceNeeded: string;
}

interface FinalResult {
  resultVersion: "discussion.result.v1";
  sessionId: string;
  segmentId: number;
  outcome: "consensus" | "weighted_fallback" | "tied_preferences" | "incomplete";
  answer: string;
  selectedAnswerVersionIds: string[];
  importantDissent: ImportantDissent[];
  limitations: string[];
}
```

补充契约：

- `normalizeDiscussionPolicy(raw, memberIds): DiscussionPolicy`：只做校验与默认值；全成员权重必须齐全，无未知成员。
- `resolveRoundLimit(policy, complexities: Record<AgentId, Complexity>): number`：确定性计算轮数，没有网络调用。
- `allocateDiscussionTokens(memberIds: AgentId[], weights: Record<AgentId, number>, totalPool: number, floor: number, roundIndex: number): Record<AgentId, number>`：所有成员满足底线，分配和不超过总池；底线不足时返回明确错误。
- `evaluateConsensus(frozenReview): AnswerVersion[]`：只接收完整的冻结评议集合；返回满足第 4.3 节的候选，不生成文本。
- `selectFinalResult(completedState): FinalResult`：从持久化答案和评议中确定来源，不调用模型。
- `ModelTransport.respond(call, signal): Promise<ModelReply>`：窄接口只包含网络必需字段和观察数据；不要求携带完整领域状态。
- `SessionStore.load(sessionId)`、`commit(expectedRevision, state)`：与当前 CAS 约定一致；新旧状态使用各自格式校验器。
- `ProtocolCodec.encode(semanticSnapshot, memberContext)`、`decode(raw)`：输出格式可变，但仍须经过同一个领域权限和引用校验器。

Codec、state schema、prompt 和 policy 分别版本化并冻结在会话中。更换 codec 必须创建新段；运行中与重试时不能重新计算或替换旧请求。初版只实现现有 JSON 交流方式。

### 5.3 后续同步工具的边界

本轮只保留 `InternalEvent` 的稳定字段：`schemaVersion / sessionId / segmentId / seq / type / refIds / data`，以及带 contentHash 的 source 输入。不定义施工任务图、文件锁或同步协议。

将来外部工具可以订阅已提交事件，向**新段**提供带版本的材料或验证结果；不能直接修改已冻结上下文、观点、评议或账本。观察者报错不能回滚已提交讨论，也不能生成额外模型调用。

内部事件可以序列化为 JSONL；首版不开放面向普通用户的讨论事件命令。最终结果 JSON 使用独立契约，适合 `cothink start ... --json > result.json` 或后续工具消费。核心库不依赖终端，也不依赖该 JSONL 存储格式。

## 6. 持久化、预算与故障规则

每次 dispatch 前持久化请求、额度占用和 attempt；收到回复后先规范化、校验并封存，再对全部成员整批提交。规范化仅处理已允许的可省略空元数据，不补造 phase、reviewSetHash、版本引用、关键异议状态或评议条目。

新状态保存：政策版本及快照、复杂度与具体轮数、答案版本、每个 review epoch 的冻结集合和评议、调用/输出额度账本、停止原因、最终结果、内部记录。旧会话没有这些字段时，通过旧格式读取，不用补默认值假装它们已存在。

| 情况                                     | 行为                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| 下一轮会挤占完整评议额度                 | 停止增加讨论轮次，使用预留额度评议并正常结束                    |
| 正常计划轮数达到上限，评议完整但没有共识 | weighted_fallback 或 tied_preferences                           |
| 评议遗漏、错误引用、截断、API 失败       | 暂停，保留有效封存成员，显式重试缺失部分                        |
| 重试额度不足                             | 请求显式扩充额度；不自动加调用、不重问已经封存成功的成员        |
| 网络调用后进程崩溃，是否计费不明         | attempt 标记 unknown，保守保留额度占用；第一次恢复不发 API 请求 |
| SIGINT / 硬截止                          | 持久化暂停、取消在途请求；迟到回复不能修改正式答案              |
| 共识保存后崩溃、再次读取                 | 返回同一已保存最终结果，零额外调用                              |
| reviewer 同意旧答案，而作者已修订        | 旧票无效，不形成新答案共识                                      |
| 成员权重、模型配置或材料在磁盘上被改动   | 当前段继续使用冻结配置；明确创建新段才应用变更                  |
| 存储冲突或观察者失败                     | CAS 冲突拒绝写入；观察者失败与调度隔离                          |

未知尝试不退还调用和输出额度。provider 取消不保证不计费。硬截止保证的是停止接纳和调度，不保证 provider 侧立刻停止计费。

## 7. 实施阶段与验收

执行顺序：0 → 1 → 2 → 3 → 4 → 5 → 6 → 7。先证明离线规则，再接真实模型；每阶段都应有独立可检查的交付物。

### 阶段 0：冻结基线与模块接缝

**实现什么**

- 记录当前构建、测试、打包的真实基线及旧会话样本。
- 在 core 新建 `discussion/`，保留 `peer/` 老协议。
- 从现有传输中提取窄的 ModelCall / ModelReply 契约；从存储中提取与领域格式无关的原子快照、写入者 lease 和 CAS 机制。旧 peer 使用旧校验器继续工作。
- 定义新版状态识别和路由；非法版本明确拒绝，不静默降级。

**文件范围**

- 新增：`packages/argue/src/discussion/contracts.ts`、`index.ts`、`packages/argue-cli/src/storage/snapshot-store.ts`。
- 修改：`packages/argue/src/index.ts`、`packages/argue-cli/src/peer/file-store.ts`、`packages/argue-cli/src/runtime/peer-api.ts`。
- 测试：既有 peer/file-store/API 测试；新增 `packages/argue-cli/test/storage/snapshot-store.test.ts`。

**执行检查点**

- [ ] 先记录基线，不调整版本号或发布配置。
- [ ] 为同一个存储机制挂载两种格式校验器，运行恢复、锁与 CAS 回归。
- [ ] 验证旧 peer 请求的冻结 messages、inputHash 和输出 schema 没有变化。
- [ ] 在本地 mock transport 下确认重构前后 API 请求正文和脱敏行为一致。

**怎么检验 / 通过条件**

旧会话可只读、可恢复；旧版本哈希固定样本相等；错误 schemaVersion 在零网络调用下拒绝。旧网络适配和存储回归通过。此阶段不要求新讨论已经可运行。

### 阶段 1：政策、强度与权重预算

**实现什么**

- 三档总思考强度、双权重、复杂度归并和轮数计算。
- 所有成员的基础额度、额外讨论额度按权重分配，以及完整评议预留。
- 冻结 policy 和 BudgetLedger；每次尝试先占用额度，未知尝试不退回。
- 独立纯函数实现，不依赖 API、磁盘或 CLI。

**文件范围**

- 新增：`packages/argue/src/discussion/policy.ts`、`budget.ts`。
- 测试：`packages/argue/test/discussion/policy.test.ts`、`budget.test.ts`。

**执行检查点**

- [ ] 先写额度不足、非法权重和缺少成员的失败案例。
- [ ] 实现第 3 节默认值和确定性分配接口。
- [ ] 加入 2:1 / 1:2 / 1:1 和三成员分配的参数化测试。
- [ ] 验证每个 attempt 和最终评议预留都能在账本上追溯。

此阶段至少保留以下行为测试；导入路径在阶段 1 建立的模块中：

```ts
import { expect, test } from "vitest";
import { normalizeDiscussionPolicy, resolveRoundLimit } from "../../src/discussion/policy.js";
import { allocateDiscussionTokens } from "../../src/discussion/budget.js";

test("参与额度按权重改变，但保留所有成员底线", () => {
  const ids = ["member-a", "member-b"];
  expect(allocateDiscussionTokens(ids, { "member-a": 2, "member-b": 1 }, 8192, 2048, 0)).toEqual({
    "member-a": 4779,
    "member-b": 3413
  });
  expect(allocateDiscussionTokens(ids, { "member-a": 1, "member-b": 2 }, 8192, 2048, 0)).toEqual({
    "member-a": 3413,
    "member-b": 4779
  });
});

test("没有全体基础额度时拒绝分配", () => {
  expect(() =>
    allocateDiscussionTokens(["member-a", "member-b"], { "member-a": 100, "member-b": 0.1 }, 4095, 2048, 0)
  ).toThrow();
});

test("复杂度取双方较高值，显式轮数只收紧上限", () => {
  const policy = normalizeDiscussionPolicy({ effort: "standard", maxRounds: 2 }, ["member-a", "member-b"]);
  expect(resolveRoundLimit(policy, { "member-a": "simple", "member-b": "complex" })).toBe(2);
});
```

**怎么检验 / 通过条件**

- 决策权重单独改变时，讨论额度逐项相等；参与权重单独改变时，不影响决策排序。
- 所有额度不低于底线，分配和不超池；无穷、NaN、负值、0、未知成员均拒绝。
- 相同输入得相同政策；不同成员顺序不改变总预算或谁拥有评议权。
- 无法同时给全体评议时返回明确错误，不能只资助其中一名。

### 阶段 2：答案版本与完整检查点评议

**实现什么**

- 每名成员的 AnswerVersion、作者所有权、依据版本引用。
- 可重复 review epoch：冻结全部活跃观点、全部最新候选答案和待处理重要异议。
- 全体完整评议；review 阶段不能修订候选答案。
- 新版 prompt / schema 的具体模板、真实 ID 和逐条 slot，减少第一次输出错误；仍不补造关键内容。

**文件范围**

- 新增：`packages/argue/src/discussion/answers.ts`、`protocol.ts`、`context.ts`、`codec.ts`、`json-codec.ts`。
- 修改：新版 `discussion/contracts.ts`。
- 测试：`packages/argue/test/discussion/answers.test.ts`、`protocol.test.ts`、`codec.test.ts`。

**执行检查点**

- [ ] 先写作者越权、伪造引用、旧 hash、漏项和重复评议的拒绝案例。
- [ ] 实现领域状态与 JSON codec，编码器仅负责表示和解析。
- [ ] 为 opening 同批本地草稿索引和 discussion 旧版本引用分别测试。
- [ ] 验证双方请求包含相同共享语义快照，差异只来自身份和已冻结额度。

**怎么检验 / 通过条件**

缺少 phase/hash/条目时拒绝；只改别人的答案时拒绝；无法引用已撤回、未见或同批未知全局版本。每个成员都必须覆盖完整集合。某成员失败时另外一名的有效回应只能 sealed，不能单独改变领域状态。

同样的领域校验接受测试用第二编码器解出的相同语义对象；说明 JSON 表示不是权利与共识的唯一实现位置。

### 阶段 3：共识、提前终止与到限选择

**实现什么**

- `evaluateConsensus` 和 `selectFinalResult` 纯函数。
- 全体确认同一答案及其依据、关键异议状态后认定共识。
- 多个共同接受答案的选择、最高决策权重回退、并列政策、已知约束失败。
- 来源可追溯的异议摘要和明确的 outcome；不新增汇总模型调用。

**文件范围**

- 新增：`packages/argue/src/discussion/consensus.ts`、`decision.ts`、`result.ts`。
- 测试：`packages/argue/test/discussion/consensus.test.ts`、`decision.test.ts`。

**执行检查点**

- [ ] 先以人工构造的完整评议证明早停条件与回退规则。
- [ ] 实现第 4.3 节所有共识条件，明确空集合行为。
- [ ] 以答案从 A1 修订到 A2 的案例验证来源选择。
- [ ] 核查所有展示异议均来自原提出者的最终有效评议。

**怎么检验 / 通过条件**

| 案例                                   | 必须得到的结果                             |
| -------------------------------------- | ------------------------------------------ |
| 双方接受同一候选及其依据               | consensus，正文与该答案版本完全相同        |
| 字面相似但分别只接受自己的候选         | 无共识                                     |
| 同意 A1，之后答案变成 A2               | A1 的票不确认 A2                           |
| 对备选观点分歧，但共同接受答案及其依据 | 可以共识                                   |
| 对答案关键依据 uncertain / reject      | 无共识                                     |
| 只有高权重成员接受                     | 无共识                                     |
| 到限且 B 的决策权重较高                | 采用 B 的最后有效版本，不采用 B 的 opening |
| 权重互换，讨论记录保持不变             | 回退答案来源随决策权重互换                 |
| 最高权重并列且未共识                   | tied_preferences，无固定胜者               |
| 已知可执行约束检查失败                 | incomplete，不能靠权重通过                 |

重要异议不得因来自低权重成员而消失。任何来源无法验证的摘要不能进入正式 FinalResult。

### 阶段 4：可运行状态机、持久化与恢复

**实现什么**

- 新 DiscussionEngine 串联 opening、讨论、检查点、继续、早停和最终保存。
- 新版本 FileDiscussionStore，使用阶段 0 的快照机制。
- 同快照全成员封存和整批提交；调用/额度预留与 attempt 在 dispatch 前落盘。
- 显式 retry，保留成功封存成员；continue 创建新段，冻结新政策与材料。

**文件范围**

- 新增：`packages/argue/src/discussion/engine.ts`、`store.ts`、`packages/argue-cli/src/discussion/file-store.ts`。
- 测试：`packages/argue/test/discussion/engine.test.ts`、`packages/argue-cli/test/discussion/file-store.test.ts`。

**执行检查点**

- [ ] 用 scripted runtime 和 fake clock 运行完整流程，不消耗真实 API。
- [ ] 第一轮成功共识后，证明请求数不再增长。
- [ ] 每轮 ready 但始终分歧，证明最多 N × (1 + 2R) 次尝试且按最新观点结束。
- [ ] 在 dispatch 前后、sealed 后、完整 commit 后、FinalResult 保存后注入进程终止。
- [ ] 运行两位 writer、迟到响应、取消和未知 usage 的恢复场景。

**怎么检验 / 通过条件**

正常早停案例为双成员 opening 2 次、首轮讨论 2 次、review 2 次，共 6 次；不会继续进行后续轮次。R=4、每轮都评议且无共识的案例最多 18 次。

崩溃后第一次恢复零调用；显式重试仅补缺失成员；成功半批复用且不能提前影响答案。新段应用新权重，旧段 frozenInput 与最终结果不变。快照与事件一致，账本没有重复记账或未知额度退款。

### 阶段 5：CLI、配置与隐藏讨论

**实现什么**

- 新 configVersion: 2，扩展现有两成员配置，增加 discussion 政策；旧配置只在加载时应用默认值，不自动重写文件或密钥。
- 配置向导提供默认强度与独立权重；启动时允许参数覆盖，真正使用的政策冻结到会话。
- `cothink start/show/retry/continue/view/export` 按会话版本分派；新会话默认使用 discussion。
- 普通命令全部展示 FinalResult。旧报告不再自动作为用户最终答案显示。
- `--json` 保证 stdout 是一个结果对象；无额外模型原文、进度 JSON 或内部状态混入。

**文件范围**

- 新增：`packages/argue-cli/src/discussion/config.ts`、`commands.ts`、`render.ts`。
- 修改：`packages/cothink/src/index.ts`、`packages/argue-cli/src/peer/setup.ts`；管理命令读取配置时先按版本分派，不将新版根字段直接交给旧 strict schema。
- 测试：`packages/cothink/test/cli.test.ts`、`packages/argue-cli/test/discussion/config.test.ts`、`commands.test.ts`、`render.test.ts`、既有 setup 测试。

**计划命令示例（尚未实现）**

```bash
cothink start --question "这个方案是否可行？" --effort standard
cothink start --question-file question.md --effort high --max-rounds 5 \
  --participation-weight member-a=2 --participation-weight member-b=1 \
  --decision-weight member-a=1 --decision-weight member-b=2
cothink start --question-file question.md --effort standard --json > result.json
cothink show SESSION_ID
cothink export SESSION_ID --format html --output result.html
```

配置优先级：显式 CLI 参数 → 新版 discussion 配置 → 工程默认值。输入问题在 `--question` 与 `--question-file` 中恰好选择一项；文件按 UTF-8 读取，不额外执行其中内容。

**执行检查点**

- [ ] 在所有内部消息中注入特征字符串 `INTERNAL_DISCUSSION_SENTINEL`，最终答案和必要异议使用不同内容。
- [ ] 捕获 start/show/retry/continue 的 stdout、stderr 及 md/json/html 导出。
- [ ] 验证所有正常输出与 HTML 源码均不包含该内部标记，错误信息也不回显模型原始内容。
- [ ] 对新旧会话、不同输出模式验证命令退出状态和零调用读取。
- [ ] 测试向导跳过默认选项、私有文件权限、配置未覆盖、进程环境优先及双方密钥脱敏。

**怎么检验 / 通过条件**

无需打开讨论报告便能得到直接可用答案。JSON 可直接解析为 FinalResult；普通读取和导出不调用 API、不读取密钥。缺少新结果的旧会话明确显示旧格式状态，不泄露原讨论或制造新版共识。

共识与正常回退的 CLI 退出码为 0；偏好并列也为 0，JSON outcome 清楚可区分；暂停/未完成为 2；参数、配置或版本错误为 1。core 不依赖这些退出码。

### 阶段 6：真实 DeepSeek / GLM 校准与场景验收

**实现什么**

- 让新版配置与两个现有 API 适配真正运行新协议。
- 更新连接测试以校验新版 opening 和完整 review；双成员最多 4 次调用，仍无自动重试。
- 对 prompt slot、评议容量、总强度默认值进行有证据的校准。
- 真实结果只能说明兼容性、具体一次协议执行和观察成本；不能用一次成功宣称多 Agent 普遍更好。

**文件范围**

- 新增：`packages/argue-cli/src/discussion/diagnostics.ts`；修改 `packages/cothink/src/index.ts` 按新旧配置分派，复用 `packages/argue-cli/src/peer/diagnostics.ts` 的旧格式路径；更新 `scripts/peer-api-smoke.mjs`。
- 新增场景记录：`docs/peer/DISCUSSION_VALIDATION.md`。
- 测试：`packages/argue-cli/test/discussion/diagnostics.test.ts`、本地 HTTP 传输测试、显式 live smoke 脚本。

**怎么检验 / 通过条件**

- 先完成离线和本地 HTTP 测试，再做真实付费调用。
- 开始真实校准前列明场景和硬上限；本批最多 30 次调用，不循环试到成功。
- 场景包含：明确有依据的简单判断、存在取舍的方案、intent/spec/impl 差距与聊天协作的开放式设计问题。模型不一定在指定轮次产生共识；未产生共识如实记录。
- 至少完成一场双方完整评议，验证 FinalResult、权重回退和异议来源；真实早停若未出现，则保留“真实早停未观察到”，离线场景已证明其机制。
- 对参与权重分配，以实际冻结请求额度验证；不把答案长度当成唯一效果证据。
- 统计首次有效输出率、无效原因、总调用、usage 覆盖、是否提前结束、有效答案来源和异议是否遗漏。
- 不存在因省略允许空元数据而额外重问的调用；关键结构缺失时仍暂停。全部原始无效响应留在内部记录。

真实 GPT / Claude 联调不在此阶段强行进行。协议与传输接口须保持兼容；未来接入需要独立实测。

### 阶段 7：灵活性验证、文档与开源交付

**实现什么**

- 完成“能增加步骤、能替换实现”的证明，避免只在文字中声称架构灵活。
- 文档围绕输入问题、设置强度/权重、得到最终结果、恢复错误组织。
- 更新独立 tarball 的安装 smoke，确保新讨论路径不依赖源码仓库或上游未发布包。
- 输出版本化计划与验收记录，准备开源材料；不自动发布 GitHub/npm。

**文件范围**

- 修改：`README.md`、`README_CN.md`、`README_JP.md`、`packages/cothink/README.md`、`docs/cothink/CONFIGURATION.md`、`INSTALL.md`、`RELEASE.md`、`scripts/smoke-cothink.mjs`。
- 新增：`docs/adr/` 下编号 ADR、`docs/plan/` 下正式实施计划、`docs/peer/DISCUSSION_VALIDATION.md`；编号按实施时实际目录决定。
- 测试：codec 替换、三成员 engine、最终结果外部消费、独立安装 smoke。

**怎么检验 / 通过条件**

1. 测试用不同交流编码器解码出同样语义轮次，运行相同领域校验，得到相同 FinalResult；共识/决策模块零改动。
2. InMemoryStore 与 FileDiscussionStore 跑同一 scripted 流程，结果和恢复不变量一致；预算/共识模块零改动。
3. 用三个 scripted Agent 验证全体覆盖、加权资源和回退来源；不以二成员特殊分支凑过测试。
4. Observer 故障不会影响提交或额外调用；新增一个只读事件处理步骤不需要改协议规则。
5. FinalResult JSON 由独立消费者读取，无须了解完整讨论记录。
6. 全量 CI、lint、format 与独立 tarball 安装验证通过；从新目录可配置、运行 local HTTP mock、读取结果、导出最终答案。
7. 文档明确 consensus 是参与者共同接受，不代表外部事实验证；不包含私人密钥、内部讨论样本或本地私有绝对路径。

此阶段交付可以安装的 CLI 包、源码、安装文档和验收记录。对外“多于两成员”“实际替换了交流语言”“施工同步”仍列为未实现。

## 8. 整体验收矩阵

| 核心要求             | 最少必须保留的证据                                  | 阶段 |
| -------------------- | --------------------------------------------------- | ---- |
| 平等交流             | 同快照、作者权限、全成员提交与完整覆盖测试          | 2、4 |
| 总思考强度           | 各档 policy 快照、round/call/output/time 边界测试   | 1、4 |
| 参与权重             | 权重互换后的冻结 token 分配与底线测试               | 1、6 |
| 决策权重             | 相同记录下仅改决策权重的选择测试                    | 3    |
| 共识早停             | 共识条件矩阵、首次检查成功只调用 6 次               | 3、4 |
| 最新观点回退         | 多次修订后选取最后有效版本、遗漏/无效响应不冒充新版 | 3、4 |
| 重要异议             | 来源引用、低权重异议、撤回/保留和阻断案例           | 2、3 |
| 讨论暂时隐藏         | stdout/stderr/所有导出/HTML 源码 sentinel 测试      | 5    |
| 故障不伪装共识或分歧 | timeout/crash/unknown/late/恢复零调用测试           | 4    |
| 旧会话兼容           | 旧哈希相等、旧恢复、版本分派测试                    | 0、5 |
| 架构可组合           | codec/store 替换、三成员、只读 observer 测试        | 7    |
| 真实模型能运行       | 有硬上限的 DeepSeek/GLM 有效评议与结果来源记录      | 6    |

## 9. 验证命令与检查纪律

以下是实施时使用的验证命令，本次计划编写不将其通过情况预先算作新功能证据：

```bash
npm run -w packages/argue test -- test/discussion
npm run -w packages/argue-cli test -- test/discussion
npm run -w packages/cothink test
npm run check
npm run test
npm run build
npm run lint
npm run format:check
npm run smoke:pack
npm run smoke:cothink
```

- 纯策略和状态机先用反例测试，跑失败、实施最小修改、再跑通过。
- 文件存储和网络适配需要真实本地 I/O 场景；mock 不能代替崩溃恢复或 HTTP 请求契约验证。
- 真实 API 只验证模型接入与实际输出，不代替确定性的权限、预算和失败测试。
- 每阶段记录“已验证 / 推断 / 未验证”，不以测试数量代替需求覆盖。
- 对正确性、预算或隐藏内容有未解决问题时继续处理；不以“未来优化”为由放过核心验收项。
- 不为了文档变更重复支付模型调用，也不因为测试已通过而无限扩大验证范围。

## 10. 阶段结束时留下什么

每阶段维护三项记录：实际变更文件与职责、已通过的具体验收、仍然未验证的边界。正常交接必须能让下一位开发者从记录继续，而不依赖本聊天。

本轮最终产品验收画面应当是：用户输入一个问题，选择强度和权重，看到简短进度；随后得到可使用的答案、必要的共识/偏好状态，以及真正影响选择的重要异议。内部交流怎样编码、经过几轮、由哪个 API 产生原始 JSON，都不应成为用户完成这一操作的负担。

后续施工同步工具和交流语言优化通过独立接口接入。当前先把最终答案来源、共识成立条件、预算边界和故障恢复做正确，再依据真实使用证据增加能力。
