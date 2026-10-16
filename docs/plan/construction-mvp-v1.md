# CoThink 施工 MVP 分阶段实施计划

> **For agentic workers:** 实施时使用 `executing-plans` 按阶段推进，每阶段单独验收和交接。只有明确要求实施的阶段获得执行授权。本文件只描述计划，不代表相关源码、样本或能力已经存在。

**Goal：** 两名平等模型 worker 先取得任务所需读写锁，再通过受控工具施工；在 JSON 待办统计器中证明同文件等待、独立任务并行、最新状态读取、验证发布和故障恢复。

**Architecture：** 单机、单项目、单程序协调器；模型沿用文本/JSON 传输，只能请求 inspect、edit、check、finish 或 abort。施工状态和讨论状态分离，正式状态由一份原子施工快照中的 acceptedVersion 指向不可变 Git 版本；中间修改不直接暴露给其他 worker。

**Tech Stack：** 沿用 TypeScript、Node.js 22+、Zod、Vitest、npm workspaces。复用 ModelTransport、FileSnapshotStore 和 Git；默认采用本地 Docker 隔离运行统计器检查。首版不引入 SQLite、远端服务、外部消息系统或独立 VCS。

**Spec：** 本文件第 1–3 节是自包含的施工规格与统计器实验契约；第 4–6 节定义实施阶段与证据。既有讨论接入规则见 [discussion-v1.md](discussion-v1.md) 第 5.3 节。实施进度单独写入 [construction-mvp-progress.md](construction-mvp-progress.md)。

独立同步工具的程序接入与可替换接口另见 [construction-sync-interface.md](construction-sync-interface.md)，纳入阶段 4–5 验收。保存后通知和独立 CLI 都不能单独代替这个接口要求。

## 1. 已确认范围、默认政策与完成标准

### 1.1 范围

- 首版只有 `member-a`、`member-b` 两名 worker。程序调度不赋予某个模型命令权、裁决权或修改他人成果的权利。
- 任务、精确文件读写范围和检查 profile 先由人明确。模型不得自动扩大范围、安装依赖、执行任意终端命令或改变验收材料。
- 处理普通 UTF-8 文本文件，支持在已声明路径创建或修改；首版不支持删除、重命名、符号/硬链接、子模块、二进制和自动包管理。
- 每个受管工作区有唯一 projectKey 和固定控制目录，同一工作区只能有一个宿主 writer 和一个活动施工运行。独立实验明确导入新的受管工作区，不能让模型改变 projectKey 绕过所有权。
- 用户输入项目作为只读来源，只导入 manifest 明确列出的材料；模型在受管副本施工。最终交付可验收工作区、diff、版本和任务回执，不自动修改日常 checkout、推送或发布。
- 讨论和施工使用不同 schema、存储格式和命令入口。施工材料只有通过显式新段输入才能进入讨论；不修改已冻结讨论或自由重写 FinalResult。
- 阶段 0–5 均零真实模型请求。阶段 6 只在明确启动的有预算实验中使用真实 API，失败不能自动无限重试。
- 不推进既有 discussion 计划的未授权阶段，不把旧 representative-based `action-v0` 当作本计划的施工执行器。

### 1.2 可检查的不变量

| 编号 | 不变量                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------- |
| I1   | 任务取得完整 R/W 范围前，不开始模型施工或文件内容读取；失败申请不留下部分锁。                   |
| I2   | 同资源 R/R 可并行，含 W 的组合互斥；W 同时允许读取。                                            |
| I3   | 令牌、身份与 attemptId 由宿主绑定；所有读写/检查/交付均验证当前所有权、epoch、截止和状态。      |
| I4   | 授锁后固定当前 acceptedVersion，并记录声明文件的内容 hash；等待前材料不能成为新尝试的施工输入。 |
| I5   | 暂存修改不成为正式内容，发布不会暴露多文件半成品。                                              |
| I6   | 检查回执绑定候选内容和实际检查配置，模型自报“通过”不能生成验收证据。                            |
| I7   | 一个权威 acceptedVersion；发布回执、已接纳任务和释放锁在同一次状态提交中生效。                  |
| I8   | 撤销先于重新授锁；迟到动作和重复请求不能再次修改/发布。                                         |
| I9   | 崩溃恢复先零模型调用；不确定 owner、损坏快照和未知候选不会被静默当作成功。                      |
| I10  | 验证执行环境不能写正式源码或协调状态，不能绕过读写网关。                                        |

锁仅保护已声明资源的一致访问，不证明未声明依赖或业务行为正确。外部人工修改原目录不属于受管工作区的并发保证。

### 1.3 默认预算与公平性

冻结在 BuildPlan 中的初始默认值：每任务最多 12 次模型调用、每次最多分配 4,096 输出 tokens、每任务累计分配最多 49,152；全运行最多 36 次调用、147,456 分配输出 tokens。单调用截止 120 秒，单任务取得锁后活动截止 15 分钟，全运行截止 45 分钟。全部可显式收紧；扩额必须生成带版本的授权记录，不从模型文字中推断。

上述是有限实验的推荐初值，不是费用报价或任务必定完成的承诺。调用前预留额度；失败、取消和 unknown 不自动退款。等待不产生模型调用；已派发请求即使迟到也只能记观测数据，不能执行过期动作。

队列按稳定入队序号处理；资源不相关任务可以绕过等待者，同一冲突资源上的可运行请求先来先服务。忙碌 worker 的排队任务不提前占有锁，不能同时给一个 worker 两项活动任务。公平性以可控序列验收，不宣称无限任务流的强公平性。

## 2. 统计器样本与阶段检查

### 2.1 基线 V0 和文件职责

样本放在 `examples/todo-stats/`，不新增 npm workspace。零运行时依赖，采用仓库现有 TypeScript/Vitest；单独 tsconfig 固定 Node 22 目标。

V0 接受合法旧格式 id/title/done:boolean，输出标准化任务并生成仅含 total 的文本。CLI 读取 stdin 的 JSON 数组，成功退出 0，非法 JSON 或非法输入退出 1、stdout 为空、stderr 为固定错误代码。V0 暂不实现三个施工任务的新增功能。

| 路径                                                                                                   | 职责／所有权                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `SPEC.md`、`package.json`、`tsconfig.json`                                                             | 宿主固定功能与检查环境，worker 只读。                                                 |
| `src/types.ts`                                                                                         | 冻结 NormalizedTask：id 为 number、title 为 string、state 为 pending/done/cancelled。 |
| `src/normalize.ts`                                                                                     | normalizeTasks：未知 JSON 数组 → NormalizedTask[]；不读文件、不发网络。               |
| `src/report.ts`                                                                                        | renderReport：NormalizedTask[] → 文本；不调用 normalizeTasks。                        |
| `src/cli.ts`                                                                                           | 固定 stdin/函数接线/退出码；实验中不修改。                                            |
| `fixtures/legacy.json`、`mixed.json`、`normalized.json`、`invalid.json`                                | 宿主固定的可读示例，worker 无写权。                                                   |
| `test/baseline.test.ts`、`state-format.test.ts`、`report.test.ts`、`identity.test.ts`、`final.test.ts` | 宿主验收程序；不作为 worker 可写文件。                                                |

完整类型和模板允许三种正式 state，V0 只生成 pending/done；这使 report 可以独立开发，不需要等待 normalize 的源码。

### 2.2 已认可的任务表

共同 R：SPEC.md、package.json、tsconfig.json、src/types.ts、src/cli.ts。表中路径均相对样本根目录，W 包含对该文件的读取。

| taskId | worker   | 功能                                                         | 额外 R                                                           | 全部 W           |
| ------ | -------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------- |
| T-A    | member-a | 支持 status 新格式，保留 done 兼容、状态优先级与非法状态拒绝 | fixtures/legacy.json、fixtures/mixed.json                        | src/normalize.ts |
| T-B1   | member-b | 输出四项统计与空列表结果                                     | fixtures/normalized.json                                         | src/report.ts    |
| T-B2   | member-b | 标题 trim/空白拒绝、id 正整数/唯一性校验，保留 T-A 成果      | fixtures/legacy.json、fixtures/mixed.json、fixtures/invalid.json | src/normalize.ts |

T-B2 不预设 dependsOn=T-A：它和 T-A 是同文件的兼容改进，实验通过调度先让 T-A 持锁，证明等待原因确实是 W/W 冲突。实际项目中的真实前置依赖仍必须声明。T-B1 不得 inspect normalize.ts。

### 2.3 功能规则与固定结果

- status 存在时必须是三种合法枚举，优先于 done；非法 status 不回退。status 缺失时 done 必须为布尔值；两者都没有拒绝。
- id 为正整数且批次内唯一；title 为字符串，去除首尾空白后非空；保留内部文字、id 和输入顺序。
- 空列表合法；total 包含 cancelled；输出按 total/pending/done/cancelled 顺序，各一行，末尾有换行。
- 任一输入非法时整批失败，不输出部分统计。每个非法测试一次只改变一项条件，不依赖多重错误的优先级。
- 联合四条数据：买菜（首尾空白，done=false）、写报告（done=true）、运动（首尾空白，status=done）、旧任务（status=cancelled 且 done=true），id 分别为 1–4。标准化标题无首尾空白；最终计数为 4/1/2/1。
- 另检验空数组、其他长度与分布、顺序变化、非法状态、非布尔 done、空标题、零/负/小数 id、重复 id。不得只硬编码联合四条数据的答案。

### 2.4 检查 profile 的组合规则

定义固定检查组：`common`（类型、接线、合法旧数据状态兼容、声明文件范围）、`state-format`（T-A）、`report`（T-B1）、`identity`（T-B2）、`final`（联合 CLI 与全套边界）。

发布 profile = common + 已接纳任务对应检查组 + 当前任务检查组。T-A 不因 identity 尚未实现而失败；T-B1 检查直接输入标准化 fixture，不依赖正在改动的 normalizer。最后必须在完整正式版本运行 common + state-format + report + identity + final，不能拼接旧回执代替。

profile 定义及程序为宿主可信输入，checksHash 包含实际检查组、代码/fixture hash、参数、工具链和隔离配置。最终模型材料不含宿主执行权限或任意可执行命令。

## 3. 模块、接口与状态

### 3.1 复用依据

| 已有文件                                                        | 复用内容                                                           | 不直接复用的部分                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `packages/argue/src/transport/contracts.ts`                     | ModelTransport.respond、ModelReply/usage/失败观测                  | 不假设已有编码动作循环或原生 tool calling。      |
| `packages/argue-cli/src/runtime/model-api.ts`                   | createApiModelTransport、validateModelCall、双协议与凭据脱敏       | 不把 peer/discussion 返回体当施工输出。          |
| `packages/argue-cli/src/peer/config.ts`、`peer/local-config.ts` | normalizePeerMembers、现有环境文件读取与两成员 profile             | 不修改旧 config version 或 discussion 权重语义。 |
| `packages/argue-cli/src/storage/snapshot-store.ts`              | SnapshotCodec、writer 所有权、串行读写、revision CAS、原子磁盘替换 | writer 锁不是源码 scope 锁。                     |
| `packages/argue/src/peer/hash.ts`                               | canonicalJson、sha256/hashJson                                     | build 不依赖 discussion 专用政策。               |
| `packages/cothink/scripts/build.mjs`、现有入口测试配置          | 本地编译、入口接线与测试                                           | 分发打包及源码外安装不作为 MVP 验收。            |

Git 保存不可变内容与 diff；验证复用项目检查工具和 Docker。Agent Mail、Nexum、jj 等只作为后续对照；首版不再增加另一套锁或会话状态。讨论预算的 opening/discussion/review 政策不适合施工，新增窄 BuildBudget，仅复用调用观测和硬限制原则。

### 3.2 新模块及接口契约

以下名称是规划接口；不附实现代码。core 只处理 JSON 领域状态，不接触文件系统、Git、容器、网络和密钥。host 适配负责真实副作用。

BuildDriver 必须注入 BuildSyncPorts（WorkspacePort、VerifierPort、PublisherPort），不得绑定具体 Workspace/FileBuildStore/Git/Docker 类。MVP 的本地实现通过 LocalBuildSyncAdapter 接入；讨论来源和结果回流通过独立桥接契约关联版本，不改变已冻结讨论。详见接口补充文档。

| 模块／接口                                  | 输入 → 输出与责任                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| BuildPlan / BuildRun                        | 冻结计划、成员、文件范围、依赖、profiles、预算；保存 revision、ownerEpoch、acceptedVersion、acceptedTasks、等待、尝试、调用及回执。 |
| ScopeCoordinator.reserve / release / revoke | 当前状态、宿主身份、taskId、now → 新状态与 granted/waiting/rejected；完整范围一次授予，撤销产生失效 epoch。                         |
| BuildProtocol.decode / authorize            | 冻结请求的宿主上下文与模型 JSON → 一条合法动作或结构/权限错误；模型不能指定他人身份、伪造检查回执。                                 |
| Workspace.inspect / edit / seal             | 基线、有效尝试、相对路径及预期旧 hash → 只读内容/版本或持久暂存候选；不改 acceptedVersion。                                         |
| Verifier.check                              | 候选 hash、固定 profile → 由程序产生的 CheckReceipt，含 checksHash、工具链、退出结果和隔离观测。                                    |
| Publisher.finish                            | 有效尝试、requestId、检查证据 → 已发布或未完成回执；组合最新正式状态，串行最终验收与 CAS 接纳。                                     |
| BuildDriver.run / recover / retry           | BuildRun 和注入的 transport/store/workspace/verifier → 有限施工与公开 BuildResult；恢复先零模型调用。                               |
| FileBuildStore                              | 用新 SnapshotCodec 复用现有磁盘存储；同一受管项目固定存储身份，不通过另一个 runId 绕过 project writer。                             |

状态：queued → waiting 或 running → checking → publishing → completed；paused/cancelled 的尝试先失效再释放。授锁之后才创建活动 attempt 和冻结实际施工输入。身份、token 和 ownerEpoch 由宿主上下文绑定，模型 JSON 无权覆盖。

冻结格式标识：buildSchemaVersion=1、planVersion=build-plan-v1、actionVersion=build-action-v1、budgetVersion=build-budget-v1、checkVersion=build-check-v1、publishVersion=build-publish-v1、resultVersion=build-result-v1。未知/混用版本拒绝，不修改 discussion/peer 的版本分派。模型响应 envelope 只回显本次 requestId 和一条 action，不能携带身份或权限；严格匹配冻结请求。

动作首版为 inspect、edit、check、finish、abort；每次模型回应恰好一条动作，拒绝未知字段/额外说明/混入 shell。edit 为指定路径的新文本及 expectedContentHash（新文件为明确空值）；初版不解析任意 shell 补丁指令。inspection 的文件内容来自授锁基线或本任务已持久暂存内容。

每个动作绑定宿主 requestId、attemptId、inputHash；相同 requestId/相同请求重复执行返回既有回执，相同 ID 不同 payload 拒绝。模型调用与工具动作有不同 ID，不把工具重放误当再次调用模型。

已完成请求的重复只读回执查询可以返回原结果，即使原尝试已经结束；它不得重新执行副作用。失效尝试的新 requestId，以及从未执行成功的旧请求，均拒绝。这一区分必须进入撤销与幂等测试。

### 3.3 版本发布与恢复协议

唯一权威是持久 BuildRun.acceptedVersion。Git refs 只保留候选对象，JSONL 只作从权威状态导出的观察日志，均不是第二套正式 HEAD。

1. 固定当前 acceptedVersion，把任务声明范围的持久暂存修改组合进去，核对授锁文件前提和有效尝试。
2. 准备不可变候选 Git 对象并保留 checkpoint ref；候选准备成功不代表已接纳。
3. 在单发布队列持有的正式基线上运行组合 profile。检查输入只读，生成物另存临时区，检查前后候选源码 hash 一致。
4. 核对候选/检查/计划 hash、令牌、截止、当前正式基线；所有权或基线不符时拒绝旧证据，重新组合/验证或暂停。
5. 一次 CAS 提交 acceptedVersion、publishReceipt、acceptedTasks、任务完成和锁释放。这是正式接纳点。
6. 根据这个快照生成最终工作区/报告。导出失败保留已接纳状态，可零模型调用重试；不能反过来移动正式指针或声称导出成功。

候选 durable 写入先于权威指针。恢复检查对象存在和 hash；Git/磁盘写入中断不能留下指向缺失对象的可用状态。普通 checkout 的多文件替换不提供原子可见性，worker 只能通过版本接口读取。

最终 CAS 前重新加载最新元数据，保留其他任务在检查期间新增的暂存、额度和事件。单纯 revision 前进不等于正式基线变化：若 acceptedVersion、profile 和候选未变，可重试元数据提交；正式版本或检查依据变化才重做组合检查。不得用旧 BuildRun 覆盖另一 worker 的进度。

## 4. 阶段总览

必须按顺序推进，阶段完成后停止并写交接。只有环境预检缺少 Docker 时，阶段 0–2 的不执行代码部分可继续；进入阶段 3 前必须补齐真实隔离能力。

MVP 的完成边界是阶段 0–6：本地受控协作机制和一次有预算的真实样本验收。阶段 7 是可选的效果对照，不是 MVP 完成门禁。安装包、源码外安装兼容和公开分发在 MVP 价值得到验证后另立计划，不属于阶段 5。

| 阶段 | 主要交付                    | 复用                      | 新增                                | 核心验收                                           |
| ---- | --------------------------- | ------------------------- | ----------------------------------- | -------------------------------------------------- |
| 0    | 样本 V0、冻结规格与施工契约 | TS/Zod/Vitest/哈希        | BuildPlan/Run schema、样本与检查组  | 基线可运行，计划不合法即拒绝，无施工循环。         |
| 1    | 纯锁与任务调度              | core 测试/时间注入        | ScopeCoordinator、尝试/撤销规则     | W/W 等待、R/R 共存、全部或无、独立绕行。           |
| 2    | 权威存储与受控工作区        | FileSnapshotStore、Git    | FileBuildStore、Workspace、对象适配 | 越界/旧 token 拒绝，暂存不可见，最新基线。         |
| 3    | 真实隔离验证与原子发布      | Docker/项目检查/Store/Git | Verifier、Publisher、回执恢复       | 正确候选接纳，失败不接纳，崩溃/重复不半发布。      |
| 4    | 受控模型动作闭环            | ModelTransport、观测错误  | BuildDriver、JSON 动作、BuildBudget | 完整三任务、真实磁盘与检查；模型端仍受控。         |
| 5    | 本地施工入口与端到端验收    | CoThink 路由/配置/编译    | build 薄入口、结果/导出/恢复        | 本地离线闭环，旧讨论回归，零隐式 API。             |
| 6    | 有预算真实双模型施工        | 已配置双协议 transport    | 冻结实验输入、观测记录              | 真实等待/并行/新版本读取和最终统计；失败如实记录。 |
| 7    | 可选效果对照与实验总结      | 同样样本、检查、记录      | 对照 runner/指标、实验记录          | 机制结论与性能结论分开，本地可复现。               |

### 通用实施步骤与 Git 规则

每个阶段先写下列行为反例并确认其失败原因，再实现对应最小模块，运行定向检查，通过后运行该阶段所需的整合回归。RED 必须是目标行为错误，不以缺依赖、夹具损坏或超时冒充。临时样本、运行日志与真实凭据不进入发布包。

所有 Git 操作前检查变化并解释目的、范围与最佳实践；只暂存明确相关文件，不用 git add .。提交、推送、PR、发布按具体授权执行，实施阶段完成不自动获得这些授权。Git 对象适配的自动操作只限用户授权的受管工作区，不能修改日常 checkout。

### 阶段 0：样本基线、计划和契约

**文件：** 新建 `packages/argue/src/build/contracts.ts`、`protocol.ts`、`index.ts` 及 `test/build/contracts.test.ts`、`protocol.test.ts`；按第 2.1 节新建 `examples/todo-stats/` 的基线、fixture 和检查程序；新建 `scripts/check-build-sample.mjs`，按 baseline/state-format/report/identity/final 分组调用宿主检查。需要公开 core 导出时仅修改 `packages/argue/src/index.ts`。

**复用：** 现有 Zod、canonicalJson/hash、TypeScript 和 Vitest，不改传输、讨论或旧 action。

- [ ] 为非法计划、混用 schema、重复 task/worker、未知路径、循环依赖、写只读文件、超预算编写拒绝案例；冻结 profile 与 planHash。
- [ ] 明确成员仅 A/B，范围精确到文件；W 含读取，重复 R/W 归一化；未知路径和 ASCII 路径大小写别名拒绝。模型动作 schema 不接受身份、shell 或 fake passed 字段。
- [ ] 建立并运行可用 V0，固定 CLI/类型/config/fixture；创建各组验收程序。新增功能检查此时应给出真实功能失败，baseline 组应成功。
- [ ] 给宿主检查单独准备参考成果，证明各组 oracle 能检测正确/错误行为；参考成果不得注入真实模型或当作实际协作产出。
- [ ] 只读记录 Node/Git/Docker 能力、包版本和后续隔离环境缺项；不自动安装软件。

**验收：** 合法旧输入 V0 输出 total；非法 JSON 退出 1/stdout 空；非法计划在模型/文件动作前失败；freeze 后材料不被修改；三个新增检查组分别有能检出的反例；全部新增源码仅为本阶段范围。

样本新增功能的预期失败由阶段 0 的 oracle 自测显式核对，不把尚未完成的整套 final 测试挂成常规 CI 的无条件失败，也不能通过 skip 隐藏。core/host 既有测试仍须通过。

**阶段停止点：** 有可运行基线和可验证契约，不存在已完成的施工引擎，不调用真实模型。记录 profile 的实际 hash 和冻结样本清单。

### 阶段 1：先上锁的纯状态与调度

**文件：** 新建 `packages/argue/src/build/scope.ts`、`scheduler.ts`、`state.ts` 和 `test/build/scope.test.ts`、`scheduler.test.ts`、`state.test.ts`；补充 contracts/index 中实际接口。

**消费／产出：** 消费 BuildPlan 与 I1–I4；输出 reserve/release/revoke 及可确定重放的状态转换。不开磁盘、不调用模型。

- [ ] 检验 A 先持 W(normalize)，B2 随后申请会等待且状态无部分锁；B1 的 W(report) 与公共 R 均可授予。
- [ ] 完整实现 R/R、R/W、W/W、一次全部范围、忙碌 worker、稳定队列与不相关任务绕行；检测真实 dependsOn，与样本的锁等待分开。
- [ ] 为取消/截止/epoch 失效、旧 token 重放、同 ID 异 payload、未知 owner、错误任务释放编写反例。
- [ ] 用注入时钟验证等待无模型调用、只有有效完整授锁可进入 running；持有两项资源的请求不能出现部分成功。

**验收：** 锁矩阵和完整授锁反例通过；取消后的旧身份不能恢复所有权；释放仅影响相应尝试；同资源顺序确定；B2 未占锁时 B1 可以开始。所有结果来自纯状态验证，尚未证明文件访问被强制控制。

### 阶段 2：真实存储、固定版本和工具网关

**文件：** 新建 `packages/argue-cli/src/build/file-store.ts`、`git-snapshots.ts`、`workspace.ts`；新建 `test/build/file-store.test.ts`、`workspace.test.ts`、`git-snapshots.test.ts`。core 新建 `build/store.ts` 的窄接口；复用 `storage/snapshot-store.ts` 而不重写其恢复规则。

**消费／产出：** 消费锁/状态与新 SnapshotCodec；产出 inspect、edit、seal、固定版本内容和持久暂存快照。单一 project writer 下的状态动作串行提交，网络工作不占用调度临界操作。

- [ ] 给施工状态独立 codec；检查 projectKey、runId、revision、ownerEpoch、planHash、锁和尝试的引用一致性。拒绝另开控制目录绕过同一受管工作区 owner。
- [ ] 在临时受管 Git 对象库导入 V0；内容由 immutable commit/tree 标识，受管 metadata 和 Git 元数据永不进入模型可写 manifest。
- [ ] 实现授锁后的输入冻结和 contentHash；inspect 只读基线/本任务持久暂存，edit 检查范围/令牌/截止/expectedContentHash 后才改暂存。
- [ ] 检验绝对路径、..、链接、路径别名、配置/fixture 越界、过期 token、旧内容 hash 被拒绝，快照与其他任务内容保持不变；多文件 edit 的失败无部分动作可见。
- [ ] 检验第二宿主竞争、元数据 CAS 冲突、暂存写入中断和 owner 恢复；确认原输入目录与现有 discussion 会话字节不变。

**验收：** 真磁盘上权限拒绝、私有暂存及恢复通过；B2 授锁时读取的 normalize hash 是当时正式版本；A/B1 独立 edit 不覆盖对方。该阶段只准备候选，不将模型自报或 mock 检查视为正式接纳。

### 阶段 3：隔离验证、发布和故障一致性

**文件：** 新建 `packages/argue-cli/src/build/validator.ts`、`publisher.ts`、`recovery.ts`；core 补充 `build/contracts.ts` 中 CheckReceipt/PublishReceipt；新建 `test/build/validator.test.ts`、`publisher.test.ts`、`recovery.test.ts`、`isolation.test.ts`。新增 `tools/build-validator/Dockerfile` 及工具链说明；输入来自冻结锁文件，阶段验收记录实际 image digest，不使用可变 latest 作回执依据。

**复用：** Git 对象、FileSnapshotStore CAS/持久写入、统计器检查组、本地 Docker。新增的是调用适配和接纳协议，不自行实现沙箱或版本存储。

- [ ] 构建固定 Node 22+ 与仓库 TypeScript/Vitest 工具链镜像，检查时断网、无模型密钥/宿主 socket/特权，候选源码只读；临时编译/缓存输出与控制目录分离。
- [ ] 用真实样本运行检查，绑定 candidateHash/checksHash/toolchainDigest/隔离配置；检验检查修改输入、写正式目录/metadata、挂载配置偏离时不产生 passed 回执。
- [ ] 实现第 3.3 节准备候选→组合检查→单次 CAS 接纳；profile 依 acceptedTasks+当前任务计算，不能手动漏掉已接纳回归。
- [ ] 在候选写入、ref 保留、检查完成、CAS 之前/之后、结果导出前设置故障点，验证旧版完整或新版完整，没有半发布；同 requestId 重放返回同回执。对象适配必须确认候选持久写入，不具备这一条件就拒绝发布。
- [ ] 核对检查期间 owner/截止/acceptedVersion 变化，拒绝旧证据；正式目录导出失败保持可重试状态，不撤销已接纳版本。

**验收：** 使用宿主手工准备的候选证明正确成果能接纳，失败候选不接纳；磁盘/进程中断和重复请求保持一致；真正隔离的写入探针失败。没有 Docker 时记录环境阻塞，不能用 mock 接纳本阶段或继续真实施工。

故障证据限定为程序可见的磁盘错误及进程中断，不以此声称已经完成断电、硬件损坏或所有文件系统的可靠性验证。

### 阶段 4：受控模型动作循环与完整离线协作

**文件：** 新建 `packages/argue/src/build/driver.ts`、`budget.ts`、`requests.ts`、`result.ts`；新建 `test/build/driver.test.ts`、`budget.test.ts`、`requests.test.ts`；host 新建 `packages/argue-cli/src/build/runtime.ts` 和 `test/build/collaboration.test.ts`。检查构造使用已有 ModelTransport，不改其签名为原生 function calling。

接口文件同时包括 core `build/sync-port.ts`、host `build/local-sync-adapter.ts` 与两侧 `test/build/sync-port.test.ts`，只引用已有契约，不迁移阶段 0–2 的状态格式。

**消费／产出：** 消费阶段 1–3 模块；产出 BuildDriver.run/recover/retry，编译受范围限制的实际输入、执行 JSON 单动作循环和公开 BuildResult。

- [ ] 用受控 ModelTransport 按动作序列回应，检查每次请求只包含当前任务的合法材料；输入/输出冻结并计额度，没有“主 Agent 服从”指令。
- [ ] 用相同端口契约测试覆盖本地与确定性内存适配器；换适配器不改 BuildDriver。拒绝错误版本/hash/requestId/假 passed，不能因为后端可替换而放松权限或接纳规则。
- [ ] 对未知字段/坏 JSON、假身份、假检查回执、越界动作、错误 requestId 编写拒绝案例；同一次已成功工具动作不会重复执行，unknown 模型请求不自动重问。
- [ ] 完整运行 A 授锁→B2 等待→B1 授锁→A/B1 两请求重叠→串行接纳→B2 读新 normalize→全套 final 的样本时序；使用可控屏障，不用 sleep 猜时序。
- [ ] 交换 A/B1 完成顺序，两条次序均保留双方成果。验证 B1 无权读取 normalize；B2 待授锁时没有任何施工模型请求。
- [ ] 在网络等待时截止/取消、迟到结果、宿主退出、显式重试、预算不足和范围变更中验证暂停/撤销/重新读取；首次 recover 零模型调用。即使受控 transport 立即响应，也要证明截止/取消定时器能得到事件循环执行机会，不只用 fake clock 推进状态。

**验收：** 两种发布次序都在真实磁盘/真实 Git/真实隔离检查上得到 4/1/2/1 和完整边界结果；并行证据为 ModelTransport 请求 in-flight 重叠。模型端受控，结论仅为机制闭环，不是模型能力或性能收益。

### 阶段 5：本地施工入口与端到端验收

**文件：** 新建 `packages/argue-cli/src/build/commands.ts`、`config.ts`、`render.ts` 及相应 `test/build/` 测试；修改 `packages/cothink/src/index.ts` 增加薄的 build 路由；新增 `packages/cothink/test/build.test.ts`、`scripts/smoke-build.mjs`。该 smoke 只验证源码 checkout 中的本地入口，不生成 tarball、不安装包、不修改分发或发布配置。

新增 `build/discussion-link.ts` 与 `test/build/discussion-link.test.ts`，落实同步工具来源关联、稳定事件投影及新版材料准备；不加入自动任务分解、后台同步或默认循环执行。

**拟议入口（尚不可用）：** `cothink build start` 接收 project/plan/config；`build show RUN_ID`、`build export RUN_ID` 为零调用读取；`build retry RUN_ID` 首次恢复、下一次显式请求才续作；`build cancel RUN_ID` 撤销活动尝试并保存状态。与讨论的 start/show/retry 不混用格式。

- [ ] 实现严格独立 build 计划解析；复用现有成员 profile/环境加载，但 construction 预算在 plan 中冻结，discussion 权重不变成施工权限。
- [ ] 校验来源 session/segment/答案版本/结果 hash；只有明确批准的 BuildPlan 可施工。结果回流先准备带版本与 contentHash 的材料，显式新段才调用 continue，observer 失败/重复不新增调用或重复开工。
- [ ] 公开结果含 completed/incomplete/cancelled、最终工作区/版本/diff、任务完成或等待原因与恢复办法；默认不泄露全量内部对话、nonce、原始 provider 错误或凭据。
- [ ] 验证 show/export 不读密钥、不调用模型；错误参数、坏 schema、恢复前预算错误均在副作用前拒绝；cancel 和重复 retry 不重做已接纳任务。
- [ ] 导出固定正式版本到安全目标，拒绝覆盖控制目录/配置/密钥及链接别名；无法导出时报告具体缺口，正式版本可再导出。
- [ ] 在现有开发 checkout 中，从本地编译入口启动，用独立临时样本完成本地 HTTP 受控模型闭环；保存真实命令退出码、正式版本和恢复证据。可以使用仓库已有开发工具，不把全新环境安装兼容列为本阶段门禁。

**验收：** 本地真实命令入口通过上述离线流程与旧讨论/peer 回归；同样状态导出结果一致；没有真实模型调用。记录 Docker 前置条件，缺失时 start 返回未完成，不静默回退宿主执行。本阶段产物是能在开发环境运行的 MVP 入口及证据，不是可分发安装包。

### 阶段 6：有预算的真实双模型样本

**产物：** 新增独立实验 runner `scripts/run-build-sample.mjs` 与说明；实际实验文件在被忽略的 `work/build-calibration/`，公开资料只保留脱敏摘要。复用阶段 5 的本地运行入口和既有两成员配置，不增加模型供应商或下载模型。

- [ ] 冻结模型/endpoint/profile 参数、样本 V0、plan/checks/toolchain hash 和第 1.3 节硬限额；启动前展示最多调用/分配额度，记录环境前置检查。
- [ ] 实际调用两模型，记录 lock 等待、工具请求、调用 start/end、检查、发布和 usage。等待者不收费轮询，失败不自动扩额或换模型。
- [ ] 核对最终统计与全部边界检查；B2 的首次 normalize 文件 hash 必须等于 T-A 接纳的文件 hash；A 的新格式逻辑没有被覆盖。
- [ ] 如果没有真实请求重叠、A 提前做完 B2 或任一任务失败，标明对应分支未验证/任务划分失效，不能用离线证据补称真实通过。
- [ ] 另做一次有界失败恢复或取消验证；有需要时由显式 retry 继续，不能隐藏调用成本。

**验收：** 至少一场真实双模型完成三任务、最终组合检查及真实等待/并行/新版本读取。未满足时保存具体失败证据与下一次有限实验条件，本阶段不标完成。

### 阶段 7：可选效果对照与实验总结

**文件：** 在明确要求效果评价时新增 `scripts/compare-build-strategies.mjs`、`docs/build/USAGE.md`、`VALIDATION.md`，记录本地复现方式。本阶段为后续可选实验，不要求安装包、安装说明、公开发布或 README 产品化改造。

- [ ] 在同一 V0、任务和 oracle 下比较单模型顺序、先锁协作、独立 worktree 后整合；双模型两策略使用同一 roster，单模型分别用 member-a 和 member-b 作基线，不只挑较弱者。检查标准、预算上限固定，实际成本单列；公平比较不使用上述可控暂停点计时。
- [ ] 四个条件默认各 3 次、最多 12 场独立实验；启动前冻结整体额度，不重复直到成功。预算不够则报告覆盖不足。保留全部失败，报告有效完成、等待/施工/验证/返工、调用/token 和整合次数；样本小，不做普遍更快的统计主张。
- [ ] 核查独立工作区基线同样具有范围限制、隔离检查和完成要求，不能只给 CoThink 完整验证而给对照宽松验收。
- [ ] 从明确的开发环境演示如何输入任务、理解等待、得到最终成果、取消和恢复；复查样本 fixture 和工具链引用，并列出本地前置条件，不称为源码外安装验收。
- [ ] 将机制已验证、真实接入已验证、效果暂不确定分别写入交付摘要；更新 progress 中各阶段的证据、限制和下一阶段范围。

**验收：** 第 5 节证据全覆盖；机制即使正确但成本没有改善，也如实记录。可以判定 MVP 协作机制可用，同时不宣称其优于单 Agent 或 worktree。

## 5. 验收证据矩阵

独立同步工具接口还需通过 construction-sync-interface.md 第 5 节的适配器替换、来源版本、幂等补读和新段材料回流验收。现有 onSaved/continue 的存在不等于这些接线已通过。

| 需求                            | 主要阶段 | 必须保存的证据                                              |
| ------------------------------- | -------- | ----------------------------------------------------------- |
| 冻结任务/类型/检查与阶段 oracle | 0        | manifest、plan/checks hash、V0 与各组正确/反例结果          |
| 同文件等待、R/R 与全部或无      | 1、4、6  | 被拒申请、冲突资源/owner、无部分锁、无提前模型施工          |
| 独立任务并行                    | 1、4、6  | 不同 W 共存、真实 in-flight 重叠，而非只看状态              |
| 授锁后最新读取                  | 2、4、6  | grant 的正式版本、首次 inspect、T-A normalize 文件 hash     |
| 强制访问与过期撤销              | 2、4     | 越界/链接/旧 token/旧内容 hash 拒绝，状态字节不变           |
| 检查执行不能绕过网关            | 3        | 隔离探针、实际挂载/权限/网络配置和 candidate 前后 hash      |
| 正式发布与组合验证              | 3、4、6  | 候选与检查绑定、单 CAS 接纳、最终全套重验                   |
| 崩溃、重复和迟到请求            | 2–5      | 故障点、前后正式版本、唯一 publishReceipt、recover 调用数 0 |
| 原讨论/本地入口兼容             | 5        | 旧格式回归、本地命令闭环和零调用读取结果                    |
| 有限预算与未知成本              | 4、6     | 预留/结算/unknown 记录、截止、无隐式扩额                    |
| 效果与局限                      | 7        | 相同条件的全部试验记录，完成/失败/成本分开                  |

## 6. 验证命令、阶段交接与尚未验证项

以下是未来实施后的检查入口，本次没有运行这些命令。每阶段先运行新文件对应的定向测试；core 定向使用 `npm run test --workspace @onevcat/argue -- test/build/<文件>.test.ts`，host 定向使用 `npm run test --workspace @onevcat/argue-cli -- test/build/<文件>.test.ts`，CLI 定向使用 `npm run test --workspace cothink -- test/build.test.ts`。

样本组使用新脚本 `node scripts/check-build-sample.mjs --project DIR --groups GROUPS`，GROUPS 必须来自第 2.4 节；该脚本将被纳入 host 整合测试。阶段 0 的 baseline 成功不代表 final 成功。阶段 3 开始的隔离检查必须实际运行 Docker，普通单元测试替身不能代替。

需要整合回归时运行仓库既有 `npm run check`、`npm run test`、`npm run build`、`npm run lint`、`npm run format:check`。阶段 5 运行新增 `node scripts/smoke-build.mjs` 的本地入口检查。必要编译与分发打包不同：不为本 MVP 增加 tarball、全局安装或源码外安装门禁。仓库已有检查若因实际修改触发仍按 AGENTS 执行，但不能把未来发布验收提前变成 MVP 产品交付目标。完整通过后没有新改动/失败/未解决疑点，不无理由重复扩大测试。

每阶段交接至少写：实际改动/复用文件，定向与整合检查命令、退出码、证据位置，来源版本/hash，已验证/未验证，实际失败及修复，是否发生 Git 操作，以及下一阶段明确范围。既有 discussion-progress 的测试或 CI 成绩不能代替 build 证据。

本文件定义计划，不证明各阶段已经完成。当前实际状态与证据以 construction-mvp-progress.md 为准；计划修改不追溯改写已冻结的前序契约或验收。Docker 前置条件及隔离保证以阶段 3 的实际证据为准，不能从计划或格式检查推断。
