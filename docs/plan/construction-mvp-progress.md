# CoThink 施工 MVP 实施进度

日期：2026-10-15。对应 [construction-mvp-v1.md](construction-mvp-v1.md)。本文件与讨论模式的 discussion-progress.md 分开，阶段编号互不替代。

阶段 0–5 已完成。阶段 5 本轮收尾修复了恢复旧等待者时的 lease 漏派发和重复状态解析，并补齐默认时钟完整施工、取消、SIGKILL 恢复/显式续作、读取导出与旧入口回归。旧失败记录保留在下方历史交接，最新证据见末尾“阶段5收尾”节；原 main harness 最后一步的 Node 启动参数错误由同一完成样本补验，未覆盖原 FAILED 记录。CoThink 本地接入 MVP 已验收；独立工具 agent-sync 尚未实现。后续以 [agent-sync-after-stage5.md](agent-sync-after-stage5.md) 为准：新阶段 6 为无模型独立核心，新 6–10 本轮均未开始，没有真实施工模型调用。

| 阶段 | 交付                     | 状态   | 实际证据                                                   |
| ---- | ------------------------ | ------ | ---------------------------------------------------------- |
| 0    | 样本 V0 与施工契约       | 已完成 | 见下方阶段 0 交接                                          |
| 1    | 纯锁与调度               | 已完成 | 见下方阶段 1 交接                                          |
| 2    | 存储与受控工作区         | 已完成 | 见下方阶段 2 交接                                          |
| 3    | 隔离验证与发布恢复       | 已完成 | 真实 Docker 隔离/发布门禁及1423项回归通过，见续验          |
| 4    | 受控动作离线闭环         | 已完成 | 原门禁及本轮恢复派发补修通过；两种真实 Docker 接纳顺序复验 |
| 5    | CoThink本地接入与端到端  | 已完成 | 默认时钟施工、同一结果补验、取消/恢复/导出及完整回归通过   |
| 旧 6 | 真实双模型施工（现新 9） | 未开始 | 不再作为下一阶段；新 6–8 见独立工具计划                    |
| 旧 7 | 可选效果对照（现新 10）  | 未开始 | 无；须独立工具及新 9 先通过                                |

## 阶段交接记录模板

每次实施追加一节，注明执行的阶段与具体授权范围；填写实际结果，不复制历史成绩冒充本次检查。

- 改动/复用文件与接口：
- 目标行为反例及实际失败原因：
- 定向检查、整合检查、退出码及证据位置：
- 基线、计划、候选、检查配置、工具链版本/hash：
- 真实模型是否调用、调用/额度上限与实际观测：
- 已验证、推断、未验证：
- 环境/故障缺口与后续动作：
- Git/安装/发布操作及范围：
- 下一阶段的明确范围与停止点：

## 实施前的计划整理检查（历史记录）

已阅读当前 AGENTS、实际 ModelTransport/provider、FileSnapshotStore、哈希、配置、打包与讨论接入接口。旧 action-v0 的单代表/free-form 执行与本次施工隔离。任务表保持 T-A/T-B1/T-B2；检查组合、唯一正式指针、过期拒绝和真实/受控证据均写入计划。

文档检查结果写入本次整理工作的 notes；这项检查仅说明计划结构与引用已复核，不代表阶段 0–7 的能力通过验收。

两份新增文档的 Prettier 检查退出 0；8 阶段/I1–I10/三任务覆盖和本地引用复核通过。没有实现代码或运行施工验收。

## 阶段 0 交接：样本基线、计划和契约

日期：2026-10-14。仅实施阶段 0，核心验收通过后停止。用户指定本目录且禁止提交、推送、合并、发布；保留现有分支和未提交工作。实施前仅发现两份未跟踪的施工计划文档，没有已有 build 模块或 todo-stats 实现；construction-mvp-v1.md 原文未改。

### 实际新增与复用

- core 新增 `packages/argue/src/build/contracts.ts`、`protocol.ts`、`index.ts`；测试为 `test/build/contracts.test.ts`、`protocol.test.ts`、`fixtures.ts`。主 `src/index.ts` 仅追加 build 导出。
- 样本新增 `examples/todo-stats/SPEC.md`、`package.json`、`tsconfig.json`、`manifest.json`、`build-plan.json`，`src/{types,normalize,report,cli}.ts`，四个固定 fixture；未增加 workspace。
- 宿主新增样本 `vitest.config.mjs`、`test/harness.ts`、baseline/state-format/report/identity/final 五组测试；`test/oracle/` 包含正确 state、report、final 参考函数及说明。反例由脚本确定性构造，参考函数不属于可导入的 manifest.files 或 worker 读范围，只列为 hostOnly。
- 新增 `scripts/check-build-sample.mjs`：`--project DIR --groups GROUPS`、可选固定 fixture `--stdin`、显式 `--self-test`。baseline 规范化为 common，未知组在打开候选前拒绝。检查读取可信宿主测试/配置/fixture，只消费候选 normalize/report。
- 复用已安装 Zod、TypeScript、Vitest，以及 `peer/hash.ts` 的 hashJson/canonicalJson；没有修改 ModelTransport、discussion/peer 协议、旧 action、依赖、锁文件或发布配置。

### 契约与边界

严格冻结七项版本标识；BuildPlan 验证成员仅 A/B、任务/成员/manifest/profile 唯一、精确路径、ASCII 大小写别名、只读写入、依赖缺失/循环、profile 组合和预算。W 包含读权限，重复 R/W 归一化，材料复制并深度冻结，planHash 覆盖实际材料。

预算固定每任务 12 次调用、每次最多 4096 分配输出 tokens、每任务最多 49152，全运行 36 次/147456；调用/任务/运行截止分别 120 秒/15 分钟/45 分钟。允许显式收紧；本阶段不实现扩额授权记录，扩大或无效额度均拒绝。BuildRun 严格验证版本、计划 hash、项目和任务/尝试/调用/回执引用、deadline 边界及分配总量；failed/cancelled/unknown 记录仍占额度。

模型 envelope 仅 actionVersion、requestId、一条 action；五种动作是 inspect/edit/check/finish/abort。身份、attemptId、inputHash、token、epoch 来自宿主上下文，JSON 无法覆盖。拒绝未知字段、shell/patch、假 passed/receipt、错 requestId、混用版本及重复 JSON 键。edit 只携带字面新文本和明确 hash/null。B1 可读 report 的 W，不能 inspect normalize，也不能写共享 R。

本阶段 authorize 只做冻结请求与静态范围绑定；当前锁、截止/epoch 有效性、重放幂等、旧内容 hash-CAS 必须由阶段 1–4 的实际执行网关补齐。receipt 是宿主 JSON 数据格式，没有 verifier、publisher、存储或执行循环，不能凭 schema parse 视为真实验收通过。

### 行为证据与 oracle

- `core-red.log`：临时宽松、无副作用基线导致拒绝断言和冻结/归一化断言实际失败，随后替换为严格实现。最初共享夹具从 test 文件导入造成重复注册，已移入 fixtures.ts，最终定向共 115 项通过；没有把 import 缺失当 RED。
- `sample-red.log`：仓库外无校验直通/hardcoded 替身导致 8 项真实功能断言失败；替身未写入 V0。先前启动配置错误已修正后重新取得行为 RED。
- V0 的 common 3/3；legacy CLI exit 0，stdout 严格为 `total: 2\n`、stderr 空。非法 JSON/输入 exit 1、stdout 空，stderr 分别固定 E_JSON/E_INPUT。V0 不接受 status、不 trim、不校验 id 正整数/唯一性，也不输出新增四项统计。
- `sample-oracle.json` 显式自测 27 条：V0 的 state-format/report/identity/final exit 1，并匹配具体功能失败断言；参考 T-A、独立 T-B1、T-A+T-B2 和最终组合通过。完整最终参考 16/16，输出 4/1/2/1；其结果只证明 oracle，不能称 Agent 施工成果。
- 每组可检出错误：common 的 done 映射；state 的优先级/非法回退；report 的硬编码/顺序；identity 的 trim/空白/重复 id；final 的输入顺序。另有报告不调用 normalizer、改 fixture/types/config/test、目录链接和未知组的执行前拒绝。
- 独立审查发现 UTF-8 跨 stdin 块解码损坏。`sample-utf8-red.log` 中正确参考编译 exit 0，仅分块标题断言失败；固定 CLI 改用流式 UTF-8 解码后通过。回归用确定性 Buffer 边界加载真实编译 CLI，不用 sleep 猜分块；审查者另用真实 stdin 管道复核。已刷新全部冻结 hash。
- 新功能失败由 self-test 显式断言，未挂入 workspace CI 的无条件失败项，也没有 skip。

### 冻结材料与实际 hash

`manifest.json` 固定 11 项可导入样本和 hostOnly 验收材料。`build-plan.json` 的 T-A/T-B1/T-B2 范围与计划第 2.2 节一致，T-B2 dependsOn 为空；B1 不读 normalize。冻结计划已通过 FrozenBuildPlanSchema，五个 profile 与实际 getChecksMetadata 输出逐项一致。

- V0 candidateHash：`sha256:f957e2a76eef5592199b77f2f4dcbffb44e2b8ed981817ec80ad42946cf6662e`。
- planHash：`sha256:744be9849b56e2cfc59e93ace9d2e8f5c8b6e51b27efc60694f2c5e125bf270d`。
- checksHash 包含实际组、manifest、可信代码/fixture/config/CLI/类型、脚本、peer/hash.ts、参数、Node 二进制、工具链/锁文件和显式 host-stage0 配置；build-plan 不参与，避免自引用。

| Profile      | 实际组合组                                    | checksHash                                                                |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------- |
| common       | common                                        | `sha256:dde977dd2e5582aa69c6a8cdfeff1e851b48fd1294ec8370f513c160e872653b` |
| state-format | common, state-format                          | `sha256:511bdf2cbcddf5e0baed34e3eb24e9111214ac3d314608e92705a63e309b3300` |
| report       | common, report                                | `sha256:233f1620abd9df846b69eed31c3fa2845b337020bfa6b4a821743371c038c9f1` |
| identity     | common, identity                              | `sha256:b5bffafe07685829bed86b34522422d3388253330e4da035e6431884ad137ba9` |
| final        | common, state-format, report, identity, final | `sha256:ef3ae41199fe554d2ad88b035021e500f8fdbf4ae381b9faae3442c25e98ddd0` |

这些 hash 绑定本次宿主环境；阶段 3 切换真实隔离工具链时须重新冻结真实检查依据，不能把 host-stage0 hash 当 Docker 证据。

### 检查命令、退出码与日志

所有工作日志位于源码仓库外 `/Users/xubibi/Documents/CoThink/work/construction-stage0/`。命令从 repo 根运行，最终汇总见 `validation.json`。

| 命令                                                                                                               | 退出码 | 日志 / 结果                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------- |
| `npm run test --workspace @onevcat/argue -- test/build/contracts.test.ts test/build/protocol.test.ts`              | 0      | core-tests-final.log，115/115                                              |
| `node scripts/check-build-sample.mjs --project examples/todo-stats --groups baseline --stdin fixtures/legacy.json` | 0      | sample-baseline.json，3/3、total 2                                         |
| `node scripts/check-build-sample.mjs --self-test`                                                                  | 0      | sample-oracle.json，27 条                                                  |
| `node node_modules/typescript/bin/tsc -p examples/todo-stats/tsconfig.json --noEmit`                               | 0      | sample-typecheck.log                                                       |
| `npm run check`                                                                                                    | 0      | check.log，全 workspace                                                    |
| `npm run test`（允许 loopback）                                                                                    | 0      | regression-tests.log，1280 项；core 648 / CLI 516 / viewer 85 / CoThink 31 |
| `npm run build`                                                                                                    | 0      | build.log，全 workspace；最新 core 另见 core-build-final.log               |
| `npm run ci`（最终树、允许 loopback）                                                                              | 0      | final-ci.log，类型/1280 测试/构建                                          |
| `npm run lint`                                                                                                     | 0      | lint.log                                                                   |
| `npm run format:check`                                                                                             | 0      | format.log                                                                 |
| 冻结计划解析 / 实际 profile hash 逐项比较                                                                          | 0      | plan-freeze.log、plan-validation.json                                      |

首次未提升权限的既有测试因 `listen EPERM` 失败（baseline-tests.log），单独 loopback 预检复现；获沙箱外执行后全套通过。没有把环境失败或历史讨论成绩冒充通过。样本类型检查和 lint/format 也有单独日志。

### 已验证、缺项与停止点

已验证：阶段 0 纯契约拒绝与冻结、样本旧行为、实际宿主 oracle 的正反例、UTF-8 流修复、profile/hash 一致、现有回归及本次源码范围。独立审查证据见 `review.md`，无剩余重要发现。

环境能力见 capabilities.json：Node v24.19.0、Git 2.54.0；TypeScript 5.9.3、Vitest 3.2.4、Zod 3.25.76、Node 类型 22.19.17。Docker 未在 PATH（spawn ENOENT，未启动进程，无正常退出码）；未自动安装，阶段 0 不阻塞。未在 Node 22 实机重跑，仅固定 >=22 / Node22 类型与兼容编译目标。

未验证且未实现：当前锁/调度、强制文件访问、真实 Docker 隔离、版本发布/恢复、施工循环、真实双模型行为和性能收益。宿主检查只运行已知本地参考，mode=host-stage0、docker/networkIsolation/filesystemIsolation=false；不能作为阶段 3 的隔离通过依据。

Git 仅源码状态/差异和版本只读检查；既有回归在临时测试仓库执行其受控 Git 操作，未修改源码仓库历史。没有源码暂存、提交、分支切换、推送、合并、PR、安装或发布。

下一阶段仅阶段 1：纯 ScopeCoordinator、任务调度与尝试状态，验证 R/R、R/W、W/W、全部或无、稳定排队/独立绕行、忙碌 worker、撤销/截止与旧身份；不接触真实工作区或发布。须另获明确实施授权，本轮停止。

## 阶段 1 交接：先上锁的纯状态与调度

日期：2026-10-14。仅实施阶段 1，经过验收后停止；阶段 2 未获本轮实施授权。**纯状态测试通过尚不证明实际文件写入受到限制。**

### 前置核实与文件范围

实施前重新读取完整施工计划、阶段 0 源码/测试、冻结样本及交接证据；没有发现已有 scope/scheduler/state 模块。先现场运行阶段 0 的 115 项契约测试和 27 条 oracle 自测，并逐项比对五个 profile 实际 hash。V0 仍只输出 total，计划 hash 仍为 `sha256:744be9849b56e2cfc59e93ace9d2e8f5c8b6e51b27efc60694f2c5e125bf270d`，未重做阶段 0。

- 新增 `packages/argue/src/build/scope.ts`、`scheduler.ts`、`state.ts`。
- 新增 `packages/argue/test/build/scope.test.ts`、`scheduler.test.ts`、`state.test.ts`（33 项）。
- 必要修改 `build/contracts.ts`：coordination/lease/queue/request 元数据，支持授锁后尚未绑定输入的 attempt，以及保留精确 own path key 的内容 hash schema。
- 修改 `build/index.ts`，公开经过验证的领域入口和类型；内部 mutable draft/commit/drain helpers 不从公开包入口导出。主 src/index.ts 的阶段 0 导出已足够，本阶段没有再改。
- 更新本进度文档；工作日志全部在仓库外 `/Users/xubibi/Documents/CoThink/work/construction-stage1/`。
- 复用阶段 0 Plan/Run/schema、严格动作解析、hashJson/canonicalJson、测试夹具、Zod/TS/Vitest。SHA-256 初始/最终比对确认阶段 0 protocol、原测试/fixture、冻结样本、旧 core 与施工计划原文均未修改；保留原有未提交工作。

### 领域接口与失败行为

`ScopeCoordinator.reserve/release/revoke` 是纯函数入口，接收状态、宿主身份或 lease、requestId、注入的 now，返回新冻结状态及 granted/waiting/released/revoked/replayed/rejected。reserve 另接收宿主 lease ID/token allocator，只在全部范围可授予时调用。它只能申请固定 plan 任务的精确范围，不能传入扩张 scope。

`scheduleBuildTasks` 对稳定队列做有限遍历。依赖未接纳、worker 忙碌、资源锁冲突和同资源队列等待有不同 reason；dependency/worker 等待不占锁，也不形成资源优先屏障。已有可运行等待者在冲突资源上优先，不相关任务可绕行；序号不因轮询、重放或移除而倒退。同一 worker/任务最多一个活动 attempt。

`createBuildState/parseBuildState` 验证完整锁归属、R/W 冲突、task/attempt/queue/epoch/receipt 引用并冻结输出；不从旧活动历史猜所有权。旧阶段 0 格式仍可由 BuildRun parser 读取，阶段 1 入口要求显式 coordination 元数据。结构损坏、非法字段和无效/倒退时钟抛出错误；合法结构中的语义拒绝返回 rejected/code，原输入不变。宿主 allocator 抛错或复用 ID/token 时不提交草稿，无部分状态落入输入。

授锁创建 running attempt，固定当时的 acceptedVersion 和宿主 ownerEpoch/per-task leaseEpoch，inputHash=null、contentHashes={}。这是持锁但未绑定内容的状态，不可进入新工具请求。`bindBuildInput` 在完整有效 lease 下接受宿主提供的精确范围 hash 与固定 baseVersion，一次绑定不可变输入。这里没有读取文件，也不证明提供的 hash 对应真实文件。

`validateBuildLease` 校验完整身份、当前 epoch/状态、整项锁范围与调用时截止。`expireBuildState`/调度按注入时钟失效过期尝试；撤销先改 status/leaseEpoch、使未完成请求 invalidated，再移除锁。单任务撤销保留独立 worker 的锁；宿主 owner epoch 前进失效全部旧 lease。新 reserve 是显式重试，截止到达时先失效旧尝试，再判断能否授锁；取消/截止本身不自动重试。

`admitBuildAction` 只登记受控工具请求，不执行动作。未绑定输入、错 token/worker/task/epoch/inputHash、截止、越界动作、新请求使用失效 attempt 都被拒绝。pending 重复为 request_in_flight，invalidated 不能返回成功；同 ID 异 payload 为 request_id_conflict。`settleBuildAction` 仅登记宿主观察的 outputHash，不生成真实 check/publish 证据。成功请求的精确历史查询返回原 receipt 和相同状态，即使 lease 已失效；只读重放不会释放替换尝试或增加回执。动作指纹绑定 requestId+action hash、输入 hash 和完整 lease hash；解析时核对指纹与 receipt 的 request/attempt 身份。

release 只结束尝试并释放锁，不改 acceptedVersion/acceptedTasks，不自动启动等待者。测试中的依赖接纳和版本前进是明确的宿主 JSON 夹具，不能称真实发布结果。

### 反例与实际证据

- `red.log`：临时无副作用的宽松/全授予基线运行 27 项测试，26 项真实行为失败，揭示锁冲突、部分范围、busy/dependency/FIFO、错误身份、过期动作和错误重放。缺模块/import 错误不计 RED；临时基线随后完全替换。
- 首轮严格实现 26/27 通过；剩余失败来自依赖测试只写 acceptedTasks 而未同步 completed task 状态，修正为一致宿主接纳夹具后通过；没有放宽生产校验。
- 独立审查及自检发现三项 P2，均先补反例再修复：
  - `expiry-retry-red.log`：到达 attempt 截止时，新 requestId 显式重试仍被旧 running 状态拒绝。先 sweep 克隆草稿，再检查 active；新尝试 epoch=3，旧 lease 拒绝。
  - `review-red.log`：合法文件名 **proto** 的 own hash 被 Zod record 丢掉；改为从未知对象验证路径/hash entries 并安全重建，完整范围绑定保留该 key。
  - 同日志：复制另一成功请求的 binding/result 并移除原 receipt 后，错误请求可能返回他人回执；增加请求指纹重算及 requestId/attemptId/inputHash/status 等引用校验。
- 独立修复探针 3/3，build 定向 148/148，审查无剩余重要发现，见 review.md / review-probes-final.log。
- `sample-sequence.json` 用原冻结三任务 plan 与编译后的公开 core 运行：A 持 normalize W；B2 等待无锁/attempt；B1 与 A 活动并共享公共 R；撤销 A、释放 B1、显式调度后 B2 获得完整范围。全过程 calls=[]；只有配置/fixture 元数据，未读取施工文件内容或产生文件写入。
- R/R、R/W、W/R、W/W 矩阵、两项 W 首项空闲次项冲突的全或无、稳定 eligible-writer 队列/独立绕行、真实依赖和 busy 等待均有定向测试。没有 sleep、真实模型或后台调度器；现在只是可确定重放的领域序列，未证明真实并行请求。

### 检查命令、退出码与证据位置

所有以下日志位于上述 construction-stage1 工作目录。最终文件 hash、范围检查及命令汇总见 `validation.json`。

| 命令                                                                                                                   | 退出码 | 结果 / 日志                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| 阶段 0 契约定向：`npm run test --workspace @onevcat/argue -- test/build/contracts.test.ts test/build/protocol.test.ts` | 0      | prerequisite-core.log，115/115                                        |
| `node scripts/check-build-sample.mjs --self-test`                                                                      | 0      | prerequisite-oracle.json，27 条；样本不变                             |
| `npm run test --workspace @onevcat/argue -- test/build`                                                                | 0      | directed-final.log，148/148（阶段 1 33，阶段 0 115）                  |
| `npm run ci`（允许 loopback）                                                                                          | 0      | ci.log，类型/1313 测试/构建；core 681、CLI 516、viewer 85、CoThink 31 |
| `npm run lint`                                                                                                         | 0      | lint.log                                                              |
| `npm run format:check`                                                                                                 | 0      | format.log                                                            |
| 编译后的冻结样本领域序列                                                                                               | 0      | sample-sequence.mjs / sample-sequence.json                            |
| 独立定向反例复核                                                                                                       | 0      | review-probes-final.log，3/3                                          |
| 初始 SHA-256 对比、核心无 I/O 依赖审计、只读 Git diff 检查                                                             | 0      | scope-audit.json / git-diff-check.log                                 |

没有安装新依赖或工具，没有修改讨论/transport/旧 action/CLI/发布配置。完整回归仅使用已有受控本地 HTTP 和临时 Git 测试夹具；源码仓库仅做只读状态/差异检查，没有暂存、提交、分支切换、推送、合并、PR 或发布。

### 已验证边界与阶段 2 接口

本阶段已验证纯状态 I1–I3 与 I4 的版本/hash 绑定时机和格式：只有完整授锁可创建活动 attempt；等待无模型/工具输入；错误身份、旧 lease 和不一致回执不能改变领域状态。**纯状态测试通过尚不证明实际文件写入受到限制。** Hash 正确性、文件内容的新鲜度、实际网关强制性、磁盘持久/崩溃恢复、Git 对象与原子发布、Docker 隔离、真实模型调用或性能收益均未验证，也未实现。既有 Node24/Node22 类型工具链复用；未安装 Docker，本阶段不要求 Docker。

阶段 2 仅消费这些接口：

1. FileBuildStore 保存完整 coordination/lease/request 元数据，通过 parseBuildState 和 revision CAS；固定项目 writer 身份与控制目录由宿主验证，不能仅凭传入的 ownerEpoch 认为已取得真实 writer 所有权。
2. 授锁后从 attempt.baseVersion 读取声明范围的不可变版本，取得真实 contentHashes，再 bindBuildInput；不得把排队前材料当作新尝试输入。allocator 在后续宿主提供真实唯一 token，本阶段没有实现密钥生成。
3. Workspace.inspect/edit/seal 在实际副作用前重载并校验 validateBuildLease、状态、now、token/epochs、范围和 expectedContentHash，完成后只登记对应宿主观察；不能把一次 admit 返回 ready 当作永久执行授权。
4. 精确成功重放只返回已有 receipt；pending/invalidated 不能重新执行。真实候选暂存与 authoritative acceptedVersion 仍由阶段 2–3 实现，不能以本阶段纯回执当发布证明。

本轮阶段 1 已经过验收并停止，不继续阶段 2。

## 实施范围修正：安装交付后置（2026-10-14）

阶段 5 改为本地施工入口和端到端验收，不要求生成 tarball、安装包或源码外安装。阶段 6 使用本地入口进行有预算的真实模型验收；阶段 7 是可选效果对照，不是 MVP 完成门禁。安装分发在价值验证后另立计划。

此前阶段 5 提示词中的安装包、源码外安装和分发打包要求作废，后续以修正后的 construction-mvp-v1.md 为准。必要编译、实际修改触发的仓库质量检查与分发产品交付分开。

本次只修改未来实施范围，保留阶段 0、1 的全部交接与验收记录，不追溯改写其冻结契约。没有改动施工源码或执行 Git 操作。

## 同步工具接口补充（2026-10-14）

核对当前程序：讨论有 onSaved 保存后通知和 continue/sources 新段输入，但尚无完整的稳定同步事件 envelope 与讨论→施工→证据回流桥接。施工侧已有存储/工作区职责分离，完整 BuildSyncPorts 和可替换接线仍需阶段 4–5 实施及验收。

新增接口说明 construction-sync-interface.md，并补入阶段 4–5：公共端口、本地适配器、来源版本关联、结果材料准备及替换/幂等/新段验收。讨论通知不自动授权开工；continue 本身会驱动模型，因此材料准备与显式继续必须分开。

本次只改文档，没有迁移已完成阶段的 schema、修改源码或运行接口测试。源码已存在的入口与补充设计分开报告，不能据此把接口完整接线标为已验证。

## 阶段 2 交接：真实存储、固定版本和工具网关

日期：2026-10-14。阶段 0–1 的实际能力先现场核验，阶段 2 完成验收后停止。阶段 3 没有实施。

本轮期间计划与进度出现并行文档修改（后续本地入口、可选对照及相应表述）。已复核第 1–3 节与阶段 2 契约保持一致；本轮未修改 construction-mvp-v1.md，在当前进度原文上追加交接，保留并行变化。现场快照见工作目录 concurrent-plan-preserved.md / concurrent-progress-before-handoff.md。

### 复用机制与新增文件

- 新增 core `packages/argue/src/build/store.ts`，仅声明 load/commit/完整事务/提交前条件校验的窄接口。
- 新增 host `packages/argue-cli/src/build/file-store.ts`、`git-snapshots.ts`、`workspace.ts` 及对应 `test/build/` 三个真实磁盘测试文件，共 71 项（24/36/11）。
- 必要调整 core `build/contracts.ts` 的 workspace/staging/candidate/完整 host tool request/receipt 数据与引用、hash 校验；`build/index.ts` 导出这些类型及复用 hashBuildValue。没有修改阶段 1 转换、阶段 0 模型动作/传输协议、讨论、发布配置或依赖。
- 完整复用 `storage/snapshot-store.ts` 的 writer nonce/进程存活判断、recovery lock 策略、串行存取、revision CAS、临时文件/fsync/原子替换；该文件初始/最终 SHA-256 完全相同。新增的是施工 codec 与包裹事务，不另造其恢复规则。

工作日志全部位于源码仓库外 `/Users/xubibi/Documents/CoThink/work/construction-stage2/`。命令、退出码、文件 hash 和范围汇总见 validation.json，保存性见 preservation.json，独立审查见 review.md。

### 实际存储与网关行为

固定 canonical 受管根目录及 `.cothink-build/project.json`，控制目录固定，身份绑定 real root/projectKey；状态槽与 writer 锁使用 projectKey 而非 runId。另 key、另控制目录、复制 marker 到另一根目录、链接/别名或源 Git checkout 不能绕过所有权。单项目一个宿主 writer 与各任务 R/W 锁职责分离：前者控制状态/对象存取，后者决定 worker 的精确资源范围。

`FileBuildStore.withWriter` 包住宿主会话；完整 transaction 的读→准备对象→校验→CAS 在 writer 内串行，避免两个 worker 都读旧 revision 后互相覆盖。再次取得 writer 先验证全部持久资产，再推进 owner epoch、撤销旧 lease。活 owner、存活性不确定、坏 nonce 和残留 recovery lock 均不偷锁；真实子进程被 SIGKILL 后仅按已有恢复规则回收。callback 结束后逃逸的 writer/Git 权限失效。

V0 只导入 manifest 的普通 UTF-8 文件进入受管裸 Git 库，无日常 checkout；Git 配置/环境、目录身份与真实 blob/tree/commit hash 均校验，禁 hooks、外部 alternates、链接/硬链接和路径命名冲突。版本接口接受明确 SHA，保留 refs 仅防对象丢失，没有正式 HEAD。对象和 ref 完成持久化步骤后才返回候选；失败准备不声称成功。

完整授锁后 `Workspace.freezeInput` 才按 attempt.baseVersion 取得实际声明文件 hash，固定 inputHash=`hashBuildValue({planHash,attemptId,baseVersion,contentHashes})`。等待者无 attempt/材料读取结果；B1 不能 inspect normalize。宿主恢复的一致性验证可以读取所有已引用对象，worker 输出始终只来自合法范围及自己的私有覆盖层。

inspect 选择冻结基线或本 attempt 的持久暂存。edit 校验完整身份、token、owner/lease epoch、截止、精确 W、重复路径和私有当前 expectedContentHash；先验证整批，再写不可变 blob，最后一次原子状态提交替换本 attempt 的暂存指针。A/B1 不覆盖对方；配置/fixture、未知路径、绝对路径、点段、大小写别名、旧 token/hash 被拒绝。中断可能留下未引用对象，但没有部分暂存指针/成功回执，对 worker 不可见，正式 acceptedVersion 不变。

seal 组合冻结基线与本 attempt 的覆盖层，生成持久不可变候选和回执，仍不接纳任务、不改 acceptedVersion、不释放范围锁。候选验证必须精确等于其 owner 的 base + 已知 own overlay，正确 hash 不能掩盖夹带他人文件。

完整工具请求与输出持久保存并绑定 hash。相同 ID/相同 payload 的成功重复只查询历史回执，包括原 lease 已失效的情况；不同 payload 冲突，失效尝试的新请求拒绝。加载按工具回执顺序重建每 attempt 覆盖层，核对历史 inspect 的当时实际文本、edit 的 CAS/完整合并、seal 的当时覆盖层及最终暂存，不能仅以自报 text/hash 一致当真实读取。

### 反例、故障与修复证据

- git-red.log：初始实际 Git 代码错误接受 NUL 文本及未知已有库，2 项行为 RED，随后 Git 36/36 通过。
- store-red.log：宽松 codec 放行 schema 合法的 runId/deadline/ownerEpoch 篡改；严格施工 codec 拒绝。store-candidate-red.log 又证明正确 candidateHash 的候选仍可夹带另一任务文件，修复为 base + own overlay 精确检查。
- workspace-permission-red.log：B1 的越界 normalize inspect 实际返回了文本，拒绝断言失败；严格网关后通过。此前 workspace-red.log 对逐路径重复校验的超慢运行被明确终止，不当作功能 RED。readFiles 改为每操作局部已验证版本视图，无跨动作缓存或删减校验。
- workspace.test.ts：多文件第二项 hash 错误、第二 blob 写前中断、截止越界、旧 token、成功请求重复及异 payload 均有实际磁盘断言，失败时 session.json 字节不变；原 source 文件和邻接既有状态对照文件不被写入。
- 独立审查发现两项 P2，先保留真实磁盘 RED 后修复：资产核验期间跨过截止仍提交（review-late-red.log）；早期 inspect 回执被替换为后来合法文本并重算自身 hash 后被接受（review-receipt-red.log）。现在 transaction 在资产核验后重载 metadata，由 Workspace 以新 clock 复核 lease/revision，再委托原 CAS；历史结果按当时覆盖层核对。原探针 2/2 通过（review-probes-green.log）。
- 元数据 FIFO 测试立即拒绝且没有 writer/state 目录产生：先 lstat，再 NONBLOCK/NOFOLLOW open、fstat 复核 regular/nlink/dev/ino，未改共享恢复实现。
- CAS 冲突、对象缺失/损坏、部分坏 JSON、历史 blob 丢失、nonce 变化、owner 恢复与未知 recovery 都有真实磁盘/进程证据，不以 mock 代替。

### 固定版本与“最新正式读取”的证据界限

使用原冻结 11 文件样本验证 A/B1 独立暂存、旧 Git 版本仍读到完整 V0、候选仍非正式状态。

B2 最新读取测试先使 A 持 normalize W、B2 等待，再由宿主手工准备一个已知不可变 Git 快照，显式构造合法 acceptedVersion 状态，然后释放/调度、授锁与冻结。B2 的首个 normalize hash 和内容等于该已知新快照。**这是测试准备，不是真实发布；没有实现 Publisher、检查接纳或发布 CAS 协议。**

### 检查命令与退出码

| 命令                                                                                                                                         | 退出码 | 证据                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `npm run test --workspace @onevcat/argue -- test/build`                                                                                      | 0      | prerequisite-core.log / core-regression.log，148 项                                                           |
| `node scripts/check-build-sample.mjs --self-test`                                                                                            | 0      | prerequisite-oracle.json，27 条                                                                               |
| Git/Store/Workspace 三个真实磁盘定向文件                                                                                                     | 0      | git-green.log 36、store-final.log 23 + FIFO 定向 1、workspace-green.log 10 + late 定向 1；最终整合完整覆盖 71 |
| `npm run check`                                                                                                                              | 0      | check.log，四 workspace                                                                                       |
| `npm run build`                                                                                                                              | 0      | build.log，先构建当前源码再跑子进程回归                                                                       |
| `npm run test --workspaces --if-present -- --maxWorkers=2 --minWorkers=1`                                                                    | 0      | tests.log，1384 项：core 681 / CLI 587 / viewer 85 / CoThink 31；无过滤、无 skip                              |
| `npm run test --workspace @onevcat/argue-cli -- test/build/git-snapshots.test.ts test/build/workspace.test.ts --maxWorkers=2 --minWorkers=1` | 0      | portable-disk-final.log，47/47；临时目录改用系统 tmpdir+realpath 后重验                                       |
| `npm run lint`                                                                                                                               | 0      | lint.log / lint-final.log                                                                                     |
| `npm run format:check`                                                                                                                       | 1      | format.log                                                                                                    |
| 独立真实磁盘两项修复复核                                                                                                                     | 0      | review-probes-green.log，2/2                                                                                  |
| 保存性 / 范围 SHA-256 / 只读 Git diff 检查                                                                                                   | 0      | preservation.json / scope-audit.json / git-diff-check.log                                                     |

两个测试 worker 仅控制跨测试文件资源竞争；并发 writer/事务测试仍用实际竞争和确定性 barrier，没有降低断言。定向 -t/namePattern 的过滤仅用于 RED/修复定位，完整 1384 项和最终 47 项没有隐藏失败或 skip。

### 保存性、已验证与未验证

24 个冻结样本/契约/宿主文件与初始 hash 逐项相同，原 V0 没有提前实现三个施工任务；测试的输入副本只读导入，旧版本仍完整。旧讨论源码与固定夹具，以及 shared SnapshotStore 字节不变；CoThink 目录含被忽略路径的扫描未发现已有保存的 discussion session.json。本轮另外用真实磁盘邻接状态对照文件验证写入后字节不变，不能把这个对照文件称为已发现的真实用户会话。

已验证：本阶段受控 API 的真实文件/版本权限拒绝、私有暂存、整批原子可见性、持久对象引用、固定版本、成功只读重放、元数据 CAS/owner 恢复及旧讨论回归。阶段 1 的纯状态证据因此新增了本受管网关的真实磁盘证据。

尚未验证：任意执行代码的 OS/容器隔离、断网/密钥隔离、真实检查通过、原子发布/正式接纳、模型循环/CLI、真实模型能力或性能收益。fsync/进程中断证据不证明物理断电或硬件故障可靠性；未实机运行 Linux/Node22 或其他文件系统，系统临时目录修正只消除显然的平台路径假设。没有运行 Docker、安装软件、调用真实模型或实现阶段 3。

所有 Git 对象/refs 操作仅临时受管库；源码仓库只读状态/diff，不暂存、提交、切换分支、合并、推送、PR 或发布。并行修改的计划原文保持不变，本轮仅追加当前进度交接。

下一阶段仅阶段 3：真实 Docker Verifier、候选/检查证据绑定、Publisher 与单 CAS 正式接纳及故障恢复；需另行明确授权。本轮阶段 2 已验收并停止。

收尾补记：全仓库 format:check 退出 1，唯一警告来自本轮期间并行新增的 `docs/plan/construction-sync-interface.md`；该文档不在本阶段修改范围，保留原文。阶段 2 十个实际修改文件的 Prettier 定向检查退出 0（scoped-format.log）；这是外部格式缺项，不是阶段 2 核心验收失败。没有因此覆盖并行工作或把全仓库格式成绩写成通过。

## 阶段 3 交接：隔离验证、发布和故障一致性（未完成）

日期：2026-10-15。仅实施用户授权的阶段 3。沿用当前 checkout，阶段 0–2 源码与未提交成果均存在，没有另行克隆、切换或新建丢失成果的工作树。用户明确允许 Docker 缺失时继续不受影响部分；这不等于通过阶段 3 核心门禁。

### 前置与文件范围

现场重新验证 core build 的 148 项与 host Git/Store/Workspace 的 71 项，均退出 0。实际前置包括完整范围锁、epoch/token/注入时钟、固定不可变 Git 版本、私有暂存、成功请求重放、原子快照与 writer 恢复，而非只读取进度标签。

本轮新增 11 个文件：host `src/build/{validator,publisher,recovery}.ts`，`test/build/{validator,isolation,publisher,publisher-contract,recovery,recovery-process}.test.ts`，`tools/build-validator/Dockerfile` 和 `README.md`。现有文件仅必要扩展 core `build/contracts.ts` 回执契约，并更新本进度文档；公共 build star 导出已能导出新增回执类型，不额外改发布或路由配置。

完整复用 `GitSnapshots` 的 blob/tree/commit 与持久 checkpoint ref、`FileBuildWriter` 的串行事务/最终提交守卫，以及原 `FileSnapshotStore` 的 writer nonce、恢复锁、revision CAS、fsync/原子替换规则。源码范围锁与 session writer 所有权继续分离，没有重写版本存储或恢复策略。五组检查直接复用冻结样本 Vitest 测试、harness、配置与 fixture，没有把 oracle 参考成果当作 Agent 产出。

### 实现与证据边界

`DockerVerifier.describe` 要求不可变 image ID/repository digest，拒绝可变标签；在实际 source-free 容器读取 Node、锁文件、编译器和固定脚本 hash，核对冻结工具链，再生成包含实际镜像、宿主可信 oracle、组、参数和隔离描述的 checksHash/toolchainHash/isolationHash。Dockerfile 的 base digest 与精确 Node 版本由显式操作提供，编译工具取自现有锁文件；程序不自动构建、拉取、安装或回退宿主执行候选。

候选通过版本接口读出，只将 manifest 文件物化为只读 bind；编译和缓存分别在 tmpfs。限制 network=none、nonroot、read-only rootfs、private PID/IPC、cap-drop ALL、no-new-privileges、CPU/内存/进程数，环境为精确 allowlist，禁止额外 mount/volume/device/特权。实际 Docker inspect 在执行前后复核。可信宿主 Vitest 只运行生成的数据代理，候选 JS 仅在容器子进程中执行；返回数组、报告字符串或 CLI 数据，不接受候选自报 passed/exitCode 作为宿主断言。

CheckReceipt 由验证程序生成并冻结，绑定 attempt、candidateHash、base/version、planHash、checksHash、toolchainHash、isolationHash、实际 imageDigest 与执行前后源码指纹；具体 verifier 用对象身份拒绝伪造或复制回执。历史阶段 0 回执格式保持可读，新上下文必须全部提供，新发布必须提供完整证据。JSON schema 可解析并不证明真实隔离通过。

`Publisher.finish` 共享同 writer 的发布队列。完整 lease 与授锁文件前提通过后，将本任务暂存组合到最新 acceptedVersion，先持久化不可变对象与保留 ref，再做 common + 已接纳任务 + 当前任务组；最后一项必须重新运行完整 final 组合。检查期间不占 writer 状态事务，其他 worker 可继续暂存与登记额度/回执。检查后重新读取元数据，只追加本次检查/发布回执并一次 CAS 更新 acceptedVersion、acceptedTasks、任务完成、epoch 失效和锁释放，保留他人的最新内容。

最终 CAS 前再次核对 owner/完整身份/token/epoch/截止、正式基线、overlay 与检查依据；仅 revision 前进可保留其他元数据，正式基线或检查依据改变就拒绝旧证据。已完成同 requestId+完整 payload 的请求只读返回原发布回执；异 payload 与失效尝试的新请求拒绝，不重新检查、接纳或导出。

`recoverBuild` 依已有 writer 恢复协议，只读核对权威状态、发布链和实际 Git/源码 commitment；孤立 refs 从不接管正式指针。`exportAcceptedVersion` 只接受当前或历史已接纳版本，在同父目录准备完整结果、同步并验证后单次 rename。失败不撤销接纳，也不称导出成功。rename 后父目录同步失败，可对同目标零调用重试：完整核对已有内容/namespace/links/inode/owner 并同步，不覆盖或替换现有目录；不匹配目标仍拒绝。

### 反例、磁盘与进程证据

- 契约 RED：旧格式不支持完整 stage-3 上下文，完整合法回执断言失败；新契约 GREEN，拒绝半套上下文、可变镜像标签和源码变化却自报成功。日志 `contracts-red.log` / `contracts-green.log`。
- 发布 RED：最小 throwing scaffold 不能完成新接纳、正确 profile 或指定故障回执，目标行为断言实际失败。实现后验证并发新暂存/额度/事件不丢失、两个 Publisher 共用队列、最终组合新检查、无效/陈旧/复制回执、最终证据复核期间截止、CAS 前后故障和成功重放。日志 `publisher-red.log`、`publisher-green-attempt.log`、`publisher-final-guards.log`。
- 验证器反例包括非法组/继承属性、实际配置偏离、错误候选 commitment、编译器/候选 stdout 假通过、临时宿主 oracle 依赖解析与冻结工具链变化。使用实际宿主 Vitest 执行五组可信数据桥检查，但 Docker 传输是明确测试替身，只证明适配/宿主 oracle，不能替代容器证据。日志 `validator-*.log`；镜像脚本仅做离线语法检查。
- 恢复 RED 覆盖 check/publish 相符却与 Git 内容不符、缺失检查对象、错误源码 commitment、准备目录被篡改和 rename 后同步失败；修复后完整恢复/导出 14 项通过。日志 `recovery-*-red.log` / `recovery-final.log`。
- 真实 IPC 指定 beforeCAS/afterCAS 后 SIGKILL 子进程，恢复分别保持完整旧版或完整新版；afterCAS 回执、任务完成与锁释放一起保留，重放检查/导出调用均为零。日志 `recovery-process.log` 与 `recovery-process-{beforeCAS,afterCAS}.json`。这些采用宿主可信 verifier 夹具，不能称为真实容器发布。

### 检查命令与当前结果

所有工作日志在仓库外 `/Users/xubibi/Documents/CoThink/work/construction-stage3/`，完整命令、退出码和分项说明见 `validation.json`，保存性见 `preservation.json`，独立审查见 `review.md`。

| 检查                         | 退出码 | 日志 / 结果                                                                                                                                                       |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core build 前置定向          | 0      | prerequisite-core.log，148 项                                                                                                                                     |
| Git/Store/Workspace 前置定向 | 0      | prerequisite-host.log，71 项                                                                                                                                      |
| validator/isolation 定向     | 0      | validator-final-tests.log，12 项；实际 Docker 门禁 NOT VERIFIED                                                                                                   |
| publisher/contract 首轮定向  | 0      | publisher-green-attempt.log，7 项                                                                                                                                 |
| 新并发/最终 CAS 守卫定向     | 0      | publisher-final-guards.log，2 项；最终整合无过滤覆盖全部用例                                                                                                      |
| recovery 完整定向            | 0      | recovery-final.log，14 项                                                                                                                                         |
| IPC/SIGKILL 完整定向         | 0      | recovery-process.log，2 项                                                                                                                                        |
| npm run check                | 0      | types-final.log，四 workspace                                                                                                                                     |
| npm run build                | 0      | build-final.log，当前源码编译                                                                                                                                     |
| npm run lint                 | 0      | lint-final.log                                                                                                                                                    |
| 首轮 npm run test            | 1      | full-test.log：导出修复写入期间混用新测试/旧源码，以及无并发限制的真实磁盘用例超时；不记为通过                                                                    |
| 完整受限并发回归             | 0      | tests-final.log；1420 项（core 681 / CLI 623 / viewer 85 / CoThink 31），无过滤、无 skip；npm run test --workspaces --if-present -- --maxWorkers=2 --minWorkers=1 |
| npm run format:check         | 0      | format-final.log，全仓库                                                                                                                                          |

首轮失败保留原日志，没有覆盖或隐藏。完整重验固定稳定源码、限定跨测试文件并发数，没有降低范围/断言或修改旧测试。名称过滤仅用于补充定位，新功能在 V0 的预期失败仍显式测试，没有通过 skip 隐藏真实门禁。

### 保存性、缺项与停止点

已有 291 个文件的初始 SHA-256 对照中，施工契约与本进度为允许的现有修改；24 个冻结样本文件、原输入 V0、共享 SnapshotStore、阶段 1–2 源码、旧讨论与 peer 源码、依赖/锁文件及发布配置保持不变。原输入副本也在真实测试中逐字对照。旧讨论整合回归保留；没有将人工邻接状态夹具冒称实际用户会话。

Docker 命令缺失（shell exit 127；Node spawn ENOENT），无镜像构建、实际 image digest、真实容器运行或隔离通过回执；`docker-capability.json` 的 actual digest 为 null；常见绝对安装位置也未发现 Docker（docker-known-locations.json）。真实 gate 显式输出 NOT VERIFIED，无 skip、无 mock 门禁通过。阶段 3 核心验收尚未通过，状态保持未完成。

已验证非容器契约、可信宿主 oracle 数据边界、真实磁盘/受管 Git 的版本绑定、最新元数据 CAS、故障/进程中断恢复与零副作用重放。未验证实际容器编译/权限/断网/秘密/socket 探针、真实正确/失败候选的隔离接纳、物理断电、硬件损坏、对不合作宿主进程最终系统调用竞态的防护，或其他 OS/文件系统的可靠性。不能从纯状态、模拟适配器或 SIGKILL 证据推断这些边界。

没有安装软件、真实施工模型调用、工作区/存储重写、模型动作循环、施工 CLI、源码 Git 暂存/提交/切换/合并/推送或公开发布。Git 对象操作仅临时受管测试库。沿用仓库外一次重置授权记录，周窗口剩余 36%，五小时值未知，未消耗重置卡；助手额度规则没有进入产品源码或样本预算。

本轮到此阶段停止。下一步仍是补齐阶段 3 的真实 Docker/固定镜像门禁并记录实际 digest；只有阶段 3 核心验收通过且另获授权，才能进入阶段 4 的受控模型动作循环/完整离线协作。现在不开始阶段 4。

## 阶段 4 前置检查：受阻，未开始（2026-10-15）

本轮只获得阶段 4 实施授权。用户明确要求“前置不满足时报告缺口，不重复或补做其他阶段”，因此先核实阶段 0–3 源码与证据，发现阶段 3 真实隔离门禁仍缺失后停止，没有补做阶段 3，也未创建阶段 4 模块或反例 scaffold。

沿用 `/Users/xubibi/Documents/CoThink/repo`；阶段 3 交接保存的 13 个修改/新增文件 SHA-256 与当前文件逐项一致，无丢失或覆盖。阶段 0 的冻结契约/样本、阶段 1 的锁/调度和阶段 2 的存储/网关源码与测试存在；阶段 3 验证器/发布器/恢复源码也存在。上轮完整 1420 项通过是历史非容器回归，不能替代本轮真实隔离前置。

本轮现场检查：

- `docker version` 无法启动，spawnError=ENOENT、exitCode=null；Node 预检脚本自身退出 0 不代表 Docker 通过。六个常见绝对安装位置均不存在，验证镜像环境变量未配置。
- 阶段 3 `validation.json` 保持 accepted=false、actualImageDigest=null、actualDockerIsolation=NOT VERIFIED。
- `npm run test --workspace @onevcat/argue-cli -- test/build/isolation.test.ts` 退出 0，2 项测试通过；真实 Docker gate 明确输出 NOT VERIFIED / Docker binary unavailable / receiptProduced=false。通过的是探针离线类型检查及不可用时拒绝，没有实际容器、没有隔离 passed 回执，也没有 skip。

具体前置缺口是可用 Docker、固定工具链的实际镜像 digest，以及真实候选的只读/断网/秘密/socket/挂载探针和成功/失败隔离检查记录。阶段 4 要求两种完成顺序都在真实隔离检查上接纳，因此不能用内存 verifier、宿主执行或阶段 0 oracle 的 4/1/2/1 参考结果替代。

只更新本进度及仓库外日志 `/Users/xubibi/Documents/CoThink/work/construction-stage4/`。没有新增或修改施工源码、测试、契约、样本、传输、CLI 或发布配置；没有 Git 操作、安装、宿主环境修改或真实模型 API 调用。阶段 4 的模型动作循环、两种协作轨迹/in-flight 重叠、最终统计、预算/恢复/事件循环取消验收均未实施或验证，阶段 4 未标完成，阶段 5 未开始。

额度读取优先 rateLimitsByLimitId.codex：开始时周窗口 usedPercent=64、剩余 36%；前置检查结束时 usedPercent=65、剩余 35%。五小时值未返回，按未知处理。沿用原一次重置授权、同一 idempotencyKey 和未使用状态，不消耗重置卡、不扩样本预算。

本轮停止点是前置阻塞交接。下一步必须先在另行明确授权的阶段 3 范围完成真实隔离核心门禁；之后才能继续本轮提出的阶段 4 验收。

## 阶段 5 前置检查：受阻，未开始（2026-10-15）

本轮授权仅为修正后的阶段 5“本地施工入口与端到端验收”。已阅读最新版计划全文、AGENTS、进度和阶段 0–4 交接，确认安装包、tarball、全局安装、源码外安装测试均不属于本阶段。沿用 `/Users/xubibi/Documents/CoThink/repo`，没有克隆或切换分支。

前置能力不能只看标签。本轮直接检查源码/测试路径与公开导出、扫描实际符号，并对照阶段 3 源码/工具/测试 SHA-256，确认原成果仍在且未改变。具体阻塞是：

1. 阶段 4 的 `packages/argue/src/build/{driver,budget,requests,result,sync-port}.ts`、host `build/{runtime,local-sync-adapter}.ts` 和 driver/collaboration 测试均不存在。`build/index.ts` 没有 BuildDriver 或 BuildSyncPorts 导出，全 packages 符号搜索也没有 BuildDriver/BuildSyncPorts/LocalBuildSyncAdapter/runBuildCommand。阶段 4 交接记录 accepted=false、status=prerequisite_blocked_not_started，无双次序、in-flight 重叠、预算/unknown/事件循环取消验收。
2. 阶段 3 真实隔离未验收。当前 `docker version` 仍无法启动（spawnError=ENOENT，exitCode=null），六个常见安装位置不存在，验证镜像未配置；前序 validation 仍为 actualImageDigest=null、actualDockerIsolation=NOT VERIFIED、accepted=false。阶段 3 的可信夹具和历史完整 1420 项回归不能代替实际容器证据。

当前 `packages/cothink/src/index.ts` 只有既有讨论管理/会话路由，没有 build 路由。阶段 5 的 commands/config/render、build 入口测试和 smoke-build.mjs 也不存在；这符合“尚未开始”，不是已有接线可以直接补一个选项。补齐运行引擎会越出本轮允许范围，因此遵守用户“前置不足时报告具体缺口，不擅自补做其他阶段”，本轮不创建反例 scaffold、空壳命令或宿主验证替身。

只修改本进度及仓库外工作日志 `/Users/xubibi/Documents/CoThink/work/construction-stage5/`。没有源码/测试/样本/协议/依赖/打包/版本/发布配置修改；没有 Git 操作、安装、tarball、编译或真实模型 API 调用，也未进入阶段 6。原输入与 peer/discussion 源码保持不变。

### 本轮检查与证据

| 检查                                                                              | 退出码 / 结果                                        | 日志                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------ |
| Node 只读文件/Docker 预检                                                         | 脚本 0；Docker 无退出码，ENOENT；所需阶段 4 模块缺失 | preflight.json                 |
| rg 实际 BuildDriver/BuildSyncPorts/LocalBuildSyncAdapter/runBuildCommand 符号搜索 | 1，无匹配；是缺项证据，不当作行为 RED                | build-symbol-search.log        |
| 前序源码、工具与测试 SHA-256 比对                                                 | 0，阶段 3 的 12 个非进度文件均匹配                   | prior-source-preservation.json |
| npx --no-install prettier --check docs/plan/construction-mvp-progress.md          | 0                                                    | progress-format-check.log      |

未运行阶段 5 定向/整合/本地 HTTP smoke，因为必要引擎不存在且隔离前置缺失。start/show/export/retry/cancel、本地零调用读取、取消/迟到、CLI 恢复/导出和实际端到端全部未验证。阶段 0 的 oracle 输出及阶段 3 的恢复/导出夹具不能冒称阶段 5 本地入口结果。没有把缺模块/import 错误当作功能 RED，也没有用 skip 隐藏未通过的验收。

额度在阶段开始通过 get_usage_limits 读取实际 rateLimitsByLimitId.codex：周窗口已用 65%，剩余 35%；五小时窗口未返回，按未知处理。沿用仓库外原授权记录的唯一 idempotencyKey、used=false/automaticUses=0，不重新计数或消耗卡；产品源码与样本预算不含助手额度逻辑。

阶段 5 核心验收未通过，保持“前置受阻，未开始”。下一步应先完成阶段 3 的固定镜像/真实隔离验收，再完成阶段 4 的动作引擎与完整受控协作验收，之后才具备阶段 5 本地接线条件。当前授权不用于补做前序阶段，本轮到此前置交接停止。

## 阶段 3 续验：等待 Docker 安装与启动（2026-10-15）

用户重新授权先解决 Docker 前置并补齐阶段 3 真实隔离验收，完成后停止；不推进阶段 4、不调用真实施工模型、不提交或发布源码。当前 Mac 为 Apple silicon/arm64（macOS 27.0.1）。现场 Docker 仍为 ENOENT，常见安装位置均不存在，验证镜像未配置。

已按 Docker 官方安装文档提供 Apple silicon 下载、拖入 Applications、首次启动及 version 检查步骤。安装和首次启动由用户操作，尚未发生自动安装、镜像拉取、镜像构建或真实容器运行；不将 CLI/引擎未启动当作隔离通过。

续验材料位于仓库外 `work/construction-stage3/docker-acceptance/`：预检 preflight.json、最小 11 文件构建上下文 context/、逐文件 hash context-manifest.json 和 resume-plan.md。构建上下文只含 Dockerfile 显式 COPY 所需的锁文件、各包元数据、冻结配置/类型/CLI 和 Dockerfile，不发送源码 Git、凭据或候选代码。恢复执行前仍需对照当前源文件重新核对 hash。

Docker 就绪后，在本阶段内核实本地 daemon、固定官方 Node base digest/版本、构建并记录实际验证镜像 ID，再运行真实隔离与 Docker-backed 发布/故障检查。实际 image digest 当前仍为空，阶段 3 核心门禁未通过，状态保持未完成。原额度授权与 idempotencyKey 沿用，周窗口剩余 35%、五小时未知，未消耗重置卡。

## 阶段 3 真实隔离与发布续验（2026-10-15）

本次沿用原工作目录和已实现模块，补齐先前 Docker 环境缺口。只做阶段 3，不实施 BuildDriver、模型动作循环或 CLI。本阶段核心门禁与必要整合检查均通过，阶段 3 标记完成后停止；历史“未完成/未安装”记录保留为当时的事实。

### 环境、固定版本和唯一修复

实际环境：Apple silicon/arm64、macOS 27.0.1，用户安装并启动 Docker Desktop 4.95.0，Docker 客户端/引擎 29.8.2，desktop-linux context 指向本机 Unix socket。没有由 Agent 安装 Docker或修改宿主设置。

- 基础镜像固定为 `node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`，实际 Node 22.23.3。
- 验证镜像实际 ID：`sha256:5879132a5e9a30001eb3aff1655af70bc2681d80cba7666e66d12a21d726d1ce`。镜像只在本机构建/保留，没有推送；不把可变标签作为回执依据。
- 使用仓库外 11 文件最小 context，仅 Dockerfile 的锁文件/包元数据/冻结类型及 CLI 接线等输入和 Dockerfile；排除可编辑 normalize/report、源码 Git 和凭据。未改变依赖或锁文件。
- 首次实际容器运行暴露 Env 数组顺序不稳定，误报 BUILD_DOCKER_ISOLATION。保存 daemon 重复观察及真实失败日志，再写 Env 乱序行为 RED。最小修复仅将完整 Env 数组排序后比较；额外项、重复项和变更值仍拒绝，未放宽环境白名单。

本次新增 `packages/argue-cli/test/build/publisher-isolation.test.ts`；修改 `src/build/validator.ts`、`test/build/{validator,isolation}.test.ts`，补充 tools/build-validator/README 和本进度。原 Publisher/Recovery、阶段 0–2 的状态/锁/存储/版本/工作区及 shared SnapshotStore 直接复用，无重写。

### 真实隔离与发布证据

真实 isolation 3/3：冻结 V0 的 common 成功、V0 final 按预期失败、正确参考 final 成功；候选写源码/原输入/协调目录、外网连接及密钥/socket 可见性探针通过“禁止动作未成功”的断言；伪造 passed stdout 失败。真实 daemon 另外创建四种描述（正确、错误网络、额外 dummy credential 环境项、额外挂载），偏离项在执行候选前拒绝，全部 State.Running=false，sentinel 不变。

真实 Publisher 1/1（986.16 秒）：6 次真实 Docker 检查 = V0 拒绝 1 + 检查成功后的故障 2 + 正式接纳 3。afterCheck/beforeCAS 故障未产生接纳；A 接纳保留检查期间新增的 B1 暂存/工具回执；成功重放不再检查或提交；B1 的组合 profile 含 A 回归；真实导出 rename 后父目录同步故障不撤销接纳，同目标验证重试成功，11 文件字节匹配；B2 授锁/冻结后读到已接纳 normalize，最后重新检查全部五组，零调用恢复保留回执。

本次全部候选由宿主明确使用 oracle 参考准备，调用真实磁盘/Git/Docker/Publisher，施工模型调用数 0。不能称为 Agent 产出、阶段 4 机制闭环或性能收益。4/1/2/1 来自实际通过的冻结 final.test.ts 联合 CLI 断言与 Docker 数据桥，不是另存的一份 CLI stdout。

| 受管测试版本    | Git version                                |
| --------------- | ------------------------------------------ |
| V0              | `20b50e9a4cb61049b624203ed53aa1cb87f3c0c2` |
| T-A 接纳        | `42937b67b38b3ef8ca1fc3db72dc3a61488d7f09` |
| T-B1 接纳       | `29a7bc70b83270f0533905e6dd10376917131bf0` |
| T-B2/final 接纳 | `1d4ecd6ba0d5e3b6c343ba486c6cfdfeb417701a` |

最终 checksHash=`sha256:cce31d4b7c5a895eb9dd7d63e7bf635966ad193b9d18345217dfea1924770651`；toolchainHash=`sha256:039ea242c63df5f8009ab950601d679fb3c29a0890b136963ed95f0d73f7f24d`；isolationHash=`sha256:c23c05a840cde8dbe3770f6410b2eb6c26ec1b0abf88ef249187795d33ffb68c`。最终源码检查前后同为 `sha256:66443b50bb5628d1a4cf3c97b8223782aca0bdc440658d87daadd2693204ca02`。独立只读审查从冻结文件与参考源码重建候选/源码 hash，核对 6 次检查、3 次接纳及版本链，无剩余重要发现。

### 命令与证据

本轮日志统一在仓库外 `/Users/xubibi/Documents/CoThink/work/construction-stage3/docker-acceptance/`，结构化总表为 validation.json；完整回执为 real-isolation.json、real-publisher.json，实际配置为 real-daemon-deviations.json，构建/基础镜像信息为 image.json、base-image.json、context-manifest.json。

| 检查                                                                                                         | 退出码    | 日志                                                      |
| ------------------------------------------------------------------------------------------------------------ | --------- | --------------------------------------------------------- |
| docker version / 本地 context / 固定基础镜像与实际 Node 查询                                                 | 0         | docker-version.json / base-image.json                     |
| docker pull --platform linux/arm64 node:22-bookworm-slim（仅用于发现 digest）                                | 0         | base-pull.log                                             |
| docker build（固定 base digest/Node 版本，最小 context）                                                     | 0         | image-build.log                                           |
| 首轮真实隔离 / Env 乱序行为 RED                                                                              | 1 / 1     | isolation-first-real.log / env-order-red.log              |
| 修复后 validator+真实 isolation                                                                              | 0         | isolation-second-real.log，13 项                          |
| 扩展真实 isolation 门禁                                                                                      | 0         | isolation-evidence.log，3 项                              |
| 实际镜像下 Publisher 门禁                                                                                    | 0         | publisher-first-real.log，1 项，6 次真实检查              |
| core build 前置定向                                                                                          | 0         | core-prerequisite.log，148 项                             |
| npm run check / npm run build / npm run lint                                                                 | 0 / 0 / 0 | types.log / build.log / lint.log                          |
| env -u COTHINK_BUILD_VALIDATOR_IMAGE npm run test --workspaces --if-present -- --maxWorkers=2 --minWorkers=1 | 0         | regression.log，1423 项（681/626/85/31），无过滤、无 skip |
| npm run format:check / 范围 SHA-256 检查                                                                     | 0 / 0     | format.log / preservation.json                            |

完整回归的未配置镜像分支必须打印 NOT VERIFIED，不能拿这条分支当真实隔离通过；真实门禁来自另一次显式传入实际 image ID 的命令及上述 VERIFIED 完整回执。没有 skip、真实模型调用或把失败日志覆盖成通过。

### 范围与停止点

真实 Docker 故障证据覆盖 afterCheck、beforeCAS、导出 rename 后同步失败与重放/恢复；其余故障矩阵由先前真实磁盘/Git、可信 verifier 替身和 IPC/SIGKILL 测试分别支持，不混称每个点都执行过真实 Docker 或进程终止。进程中断证据不等于断电、硬件损坏、所有文件系统或恶意宿主竞态验收。

原 V0、24 个冻结样本文件、阶段 0–2 源码、shared SnapshotStore、旧讨论/peer、ModelTransport、预算及发布配置未改变。源码 Git 只读核对，无暂存/提交/推送/合并/公开发布；所有自动 Git 对象写入均临时受管测试库。镜像只本地构建保留，不推送。阶段 4、5 未实现，本轮到阶段 3 验收停止。

收尾额度 checkpoint：周窗口已用 68%、剩余 32%，五小时窗口未知；沿用同一仓库外授权记录与 idempotencyKey，未消耗重置卡，未扩产品预算。下一阶段仅阶段 4，须按用户下一次明确指令实施；本轮不继续。

## 阶段 4：受控模型动作循环与完整离线协作（2026-10-15）

本轮按最新版施工计划与 construction-sync-interface.md 实施阶段 4，保留现有工作目录与阶段 0–3 成果。启动时核对真实 Docker daemon、固定镜像、阶段 3 的 VERIFIED 隔离/发布回执及源码测试，未将 discussion 阶段编号当作施工前置。两条完整真实轨迹及本节列出的核心门禁均已通过，阶段 4 标记完成后停止；不实施阶段 5。

### 模块与职责

新增 core `build/{driver,budget,requests,result,sync-port}.ts`，对应 `test/build/{driver,driver-boundaries,budget,requests,sync-port}.test.ts` 及测试专用 sync-port-fixture.ts。新增 host `build/{local-sync-adapter,runtime}.ts` 和 `test/build/{sync-port,runtime,collaboration}.test.ts`，共 16 个新文件。已有 contracts.ts 仅公开 BuildToolResultSchema，build/index.ts 增加上述模块导出，没有迁移持久格式。根 core 导出沿用阶段 0；没有修改 ModelTransport、讨论/peer/旧 action、依赖、锁文件、版本或发布配置。

BuildDriver 只依赖程序状态窄接口 BuildStateWriter、ModelTransport 和 BuildSyncPorts。WorkspacePort 包含授锁后的宿主 freezeInput，以及 inspect/edit/seal；VerifierPort.check 返回绑定 requestId 的实际 CheckReceipt；PublisherPort.finish 返回实际 PublishReceipt。LocalBuildRuntime 组合 FileBuildStore、LocalBuildSyncAdapter、DockerVerifier；本地适配器直接复用 Workspace、GitSnapshots、Publisher 和已有恢复规则。没有在 core 引入 Node 路径、磁盘、Git、Docker 或具体发布器，没有远程协议、消息总线或后台服务。

协调器检查冻结计划/owner、lease、每次请求及动作前的截止，编译当前任务精确范围的复制/冻结材料，严格解码单动作 JSON，并把工具返回与重新读取的权威状态绑定。适配器负责真实路径/内容 hash/候选/Git 校验、程序回执归属、工具链/隔离描述及源码完整性复核；正式接纳仍由原 Publisher 新组合检查和单次 CAS 执行。完成的旧回执只读重放；standalone check 不成为正式接纳的捷径，缓存限本适配器生命周期，重启后旧 lease 不能重新检查。

内存适配器只证明循环可替换和契约行为，绝不充当隔离证明。后端是受信程序组件：边界校验拒绝错误候选 hash、旧基线、异 requestId、缺上下文的 passed/发布结果；但普通 schema/hash 比对无法抵御能重写整个权威存储与证据的恶意后端。共享契约同时运行于内存和真实本地适配器；本地契约中的 scripted verifier 明确不算 Docker。

### 反例、预算与恢复

先运行 driver 4 项和完整 collaboration 2 项的行为 RED（临时合法夹具已建立，失败为未实现的行为），以及 budget/requests 拒绝案例 RED，再接线。继续审查与真实磁盘验证又发现并修复：

- 计划替换后，旧循环收尾仍将新状态改为 paused；现在所有读取/事务均绑定计划及 owner，新权威状态不被旧协调器更改。
- 回复已到调用截止，但 timer 未获执行机会，过期动作仍执行；现在回复后重新核对冻结调用截止，按 unknown 保留分配并暂停。
- owner 替换异常退出时兄弟模型请求未 abort；现在 finally 中止剩余请求，不尝试写入替换权威。迟到响应只产生观测，不执行动作。
- 纯调度无变化或一次事务组合多个纯转换，导致真实 SnapshotStore 拒绝 revision；现在事务只读时不提交，有变化时统一为一次 revision CAS。内存 writer 也加严为相同 revision 规则，取得对应 RED/GREEN，没有修改已有恢复/存储实现。
- 成功显式重试后仍展示旧失败原因；新授锁/成功接纳清除过期原因。

调用先持久预留完整输出分配，再向现有 ModelTransport 发送冻结请求；所有历史 failed/cancelled/unknown 仍占调用次数和完整分配，没有隐式退款或扩额。无法确定的模型请求不自动重问；已成功工具请求按宿主 ID/lease 重放。首次 recover 或首次 retry 仅将遗留 reserved 标为 unknown、撤销旧 epoch 并展示，零模型/工具调用；第二次显式 retry 才重新授锁/读取。已接纳任务不重复施工。

当前 Driver 18 项通过，覆盖坏 JSON、错误 requestId、伪身份/回执、越界、unknown、宿主退出历史、预算耗尽、取消、迟到、计划/owner 替换与真实 timer。立即返回的 transport 在调用前及动作前主动给出实际 macrotask；真实 setTimeout 的取消和截止事件能运行，不只靠 fake clock。公开 BuildResult 只投影状态、正式版本、任务原因、调用/分配和恢复办法，不输出 token、内部请求或 provider 原文。观测者失败不获得权限或新增请求。

宿主 runtime 另外在真实磁盘/Git 的精简样本上验证初始导入、真实 Docker 能力描述、受控 abort、首次 retry 零调用、第二次显式 retry 和持久取消，共 3 项通过（另有真实 Driver 子进程 IPC 屏障后 SIGKILL，reserved→unknown、保留 4096 分配、恢复零重问）。它不是阶段 5 本地命令入口；完整三任务协作另通过 Driver + 本地实际适配器验收。

### 两条真实协作轨迹

下列门禁使用完整冻结 todo-stats 计划、独立临时受管库、真实文件/Git/Docker/Publisher。模型只由受控 transport 返回宿主 oracle 参考源码，不能称真实模型产出或能力/性能收益。可控屏障只安排本次测试的两 worker 请求重叠和接纳顺序；每条轨迹自身必须有实际 in-flight 区间，不能把不同测试进程的并行当作 worker 重叠。

| 次序     | 真正接纳顺序      | 正式最终版本                               | 调用 / 分配 | 完整验收                        |
| -------- | ----------------- | ------------------------------------------ | ----------- | ------------------------------- |
| A-first  | T-A → T-B1 → T-B2 | `99fc6e8eef93ef2895799bba7a1e153c738c260e` | 6 / 24576   | 全五组，4/1/2/1，恢复新增调用 0 |
| B1-first | T-B1 → T-A → T-B2 | `ab5e362833f2a5b580a09b8f058c73b93a80fa91` | 6 / 24576   | 全五组，4/1/2/1，恢复新增调用 0 |

每条运行均先 A 授锁、B2 原子等待、B1 授锁；等待者零模型请求。每任务两次受控请求，合计 6 次 / 24576 分配，低于冻结 36 次 / 147456；所有 6 条持久调用均为 succeeded。独立报告与 normalize 修改在第二次接纳后同时保留，原输入 11 个 manifest 文件字节不变，公开结果与完成后的 recover 不新增检查/调用。

两次的 B1 请求序号 3 开始，A 序号 4 开始，B1 序号 5 响应准备好，A 序号 6 响应准备好，形成严格交叉的在途顺序。B1 无 normalize 材料。毫秒时间戳的保守交集为同一毫秒（毫秒级采样的交集下界为 0ms），不是串行证据；两请求均在屏障上实际未完成。end 在写测试日志前采样，真正 Promise 此后仍在途，因此记录区间是实际区间的子集，不当作完整时长/性能数据。完整时间戳、首读 hash、事件和现代检查/发布回执见 collaboration-a-first.json、collaboration-b1-first.json。

B2 首次 normalize hash 在两次都为 `sha256:0120427f5cfa2b020fb4db3160ca976075443a613ce28d8968b3e02cee14a015`，逐字等于 T-A 已接纳内容；B2 首个模型请求之前已经取得新正式版本并完成范围材料读取。每次最后一份真实回执均为 common/state-format/report/identity/final，包含标题、正整数/唯一 id、旧 done、状态优先级和非法输入边界，实际通过冻结 final CLI 的 4/1/2/1 断言。没有另存 CLI stdout，不把 expectedStdout 字段本身当证据。

最终两份源码 hash 同为 `sha256:b000e045e072cada3770dfdee38173f2f34945d2e8d1956b88d8d755216ec5a8`；checksHash=`sha256:cce31d4b7c5a895eb9dd7d63e7bf635966ad193b9d18345217dfea1924770651`，toolchainHash=`sha256:039ea242c63df5f8009ab950601d679fb3c29a0890b136963ed95f0d73f7f24d`，isolationHash=`sha256:c23c05a840cde8dbe3770f6410b2eb6c26ec1b0abf88ef249187795d33ffb68c`。真实门禁分别耗时约 2425 秒/2445 秒；域时钟注入的边界见下方，不把耗时用于策略效果评价。

固定验证镜像继续使用 `sha256:5879132a5e9a30001eb3aff1655af70bc2681d80cba7666e66d12a21d726d1ce`。没有重建、拉取或推送镜像。Daemon 曾中途退出，runtime 实际预检返回 BUILD_DOCKER_UNAVAILABLE；保留失败日志，仅重新打开已安装 Docker Desktop，恢复后 version/image inspect 均退出 0，未安装或修改设置。修复前轨迹仅有 T-A 实际接纳及后续 CAS 失败，单独保存为 revision-red，不能计作完整成功。

### 检查与证据

全部日志在仓库外 `/Users/xubibi/Documents/CoThink/work/construction-stage4/current/`；最终结构化总表为 validation.json，改动清单 changed-files.json，范围核对 preservation.json，独立审查 independent-review.md。RED、不可用、中断和最终运行分别留档，不以初次中断/环境错误冒充功能 RED。

| 检查                                          | 退出码/实际结果              | 日志                                                           |
| --------------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| 初始 Driver / collaboration 行为 RED          | 1 / 1，4 / 2 项目标行为失败  | driver-red.log / collaboration-red.log                         |
| 替换计划/过期调用 RED                         | 1，原先 13 项中 2 项失败     | driver-boundaries-red-clock.log                                |
| owner 兄弟请求清理 / 严格 revision RED        | 1 / 1                        | owner-cleanup-red.log / noop-cas-red.log                       |
| 当前全部 core build 定向                      | 0，185 项                    | core-build-final.log                                           |
| 本地同步端口，共用契约                        | 0，4 项真实磁盘/Git          | sync-port-local-final.log                                      |
| runtime，实际 image 预检及真实 Driver SIGKILL | 0，3 项，无过滤              | runtime-all-final.log                                          |
| 独立审查反例复核                              | 0，3 项                      | review-repro-cas-final.log                                     |
| 四 workspace 常规回归                         | 0，717/634/85/31，共 1467 项 | regression.log                                                 |
| CAS 修复后全部 core 回归                      | 0，718 项                    | core-regression-final.log                                      |
| npm run check / npm run build                 | 0 / 0                        | typecheck-cas-final.log / build-cas-final.log                  |
| 新增测试文件的显式 tsc                        | 0                            | all-stage4-tests-typecheck-final.log                           |
| npm run lint                                  | 0                            | lint-final.log                                                 |
| 实际 image 下 A-first / B1-first 门禁         | 0 / 0，共覆盖 2 项           | collaboration-cas-a-first.log / collaboration-cas-b1-first.log |
| 两份完整 JSON/回执/源码 hash 审计             | 0，均 VERIFIED               | evidence-audit.json / collaboration-acceptance-audit.json      |
| npm run format:check                          | 0                            | format-final.log                                               |

常规回归显式取消 COTHINK_BUILD_VALIDATOR_IMAGE，镜像缺项分支打印 NOT VERIFIED；不把它的测试计数当真实 Docker 成功。实际隔离验收仅以显式 image ID 的两条完整轨迹及真实回执判定。两条按名字互补分运行的门禁会在各自 Vitest 输出中显示另一条被过滤，合并覆盖完整两种次序；没有 .skip 隐藏失败。

### 边界与停止点

完整协作轨迹注入固定协调时钟来控制权限状态，另以 Date.now 保存真实请求区间；它不证明在本机实际墙钟的 15/45 分钟内完成全样本。截止/取消的拒绝与事件循环让步由单独的确定性时钟和真实 setTimeout 测试支持。尚未验证真实施工模型能力、性能或成本收益，也没有实际模型 API 调用。受控调用的 usage 是测试数据；预算记录的是冻结分配，不声称供应商实际计费。信任后端会有限返回；若自定义端口永不 settle，cancel 可以持久撤权，但 run 仍可能等待它。现有本地工具命令有超时，部分同步调用会延迟事件循环，未承诺强制抢占任意后端。既有进程中断证据仍不等于断电验收。

已有 24 个冻结样本、阶段 0–3 非必要文件、shared SnapshotStore、旧讨论/peer 和 ModelTransport 保持不变；自动 Git 对象操作仅临时受管测试库，源码 Git 仅只读核对，没有提交、推送、合并或公开发布。未实现施工命令、打包、安装包或阶段 5 接线。

共享额度授权仍使用原持久记录和唯一 key，尚未消耗卡；有效周窗口最新检查剩余 27%，五小时未知。工具曾短暂读不到额度，已记录错误且未按 0 处理，随后恢复读取。助手额度规则未进入产品或 worker 预算。

阶段 4 的机制、同步适配器替换和本地真实隔离/接纳验收通过，标记完成并在此停止。下一阶段仅阶段 5：按最新版计划接本地 build start/show/export/retry/cancel、严格配置/结果呈现、本地受控 HTTP smoke 和来源关联；须另行明确授权，不包括打包/安装/发布，不自动进入阶段 6。

## 阶段 5 收尾：CoThink 首个接入与离线验收（未完成，2026-10-15）

沿用原 checkout；现场核对阶段 0–4 源码及实际证据，阶段 3 真实 Docker、阶段 4 两种接纳次序与本地/内存同契约验收均存在。未把 discussion 阶段成绩当施工证据，未重做前序模块。

新增 host `build/{commands,config,render,discussion-link}.ts` 与对应四组测试，新增 CoThink `test/build.test.ts` 和 `scripts/smoke-build.mjs`。最小修改 `packages/cothink/src/index.ts` 接独立 build 路由；`build/runtime.ts` 仅增加可选 trusted repoRoot 传递与 recover({initialize:true}) 的零调用初始导入。复用 BuildDriver/BuildSyncPorts/LocalBuildSyncAdapter、冻结计划/预算、FileBuildStore/Workspace/GitSnapshots/DockerVerifier/Publisher/Recovery、既有配置/profile/环境读取与 ModelTransport。未改传输签名、core 循环、讨论协议/权重/共识、旧持久格式、依赖、版本或发布配置。

依赖为 CLI → LocalBuildRuntime → BuildDriver（仅依赖 BuildSyncPorts）→ LocalBuildSyncAdapter → 既有真实 Workspace/Verifier/Publisher；程序状态 store 独立。内存适配器替换证据沿用阶段 4，不能代替本轮真实 Docker。

桥接采用独立 integrationVersion/requestId/frozenBuildPlan/materialRefs/optional origin；外部显式批准 planHash，不能由 JSON 自报批准。来源从 FileDiscussionStore 校验已完成段、答案版本集合与 FinalResult hash。初始请求关联和不含密钥值的冻结宿主描述原子保存；相同 ID/载荷/源目录/配置映射同一 run，不同载荷拒绝，崩溃后可不读取原配置/请求/密钥文件重建 CLI 元数据。无讨论来源的 CoThink 施工允许省略 origin；这不等于独立工具服务已完成。

回流仅接受 completed 且所有任务正式接纳、版本及 candidate/check/publish 引用完整关联的记录；prepare 计算新版 source contentHash，零模型调用；单独显式授权 continue 才新建讨论段。真实 FileDiscussionStore + 受控 transport 测试中旧段完整 JSON、旧事件前缀和初始输入字节保持不变，准备时 6 次调用不变，授权 continue 后为 12 次，新段不自动产生 ConstraintCheck 或共识。

稳定事件是旧持久事件的只读投影，包含 schemaVersion/sessionId/segmentId/seq/type/refIds/data；created 通知单独处理、不补造事件。onSaved 只唤醒；独立持久游标按稳定键补读/ACK，验证漏通知、重复通知、observer 抛错、重启与重放。语义是至少一次读取加幂等关联，不声称任意副作用 exactly-once，也不自动开工或继续讨论。

反例先于实现：CLI 旧入口拒绝 build、参数/schema/预算与危险导出；桥接伪批准/坏来源/hash/同 ID 异载荷、缺失证据和非 completed 成功；评审又复现原子元数据崩溃缺口、未完成状态回流、取消仅写 intent 即声称成功，并修复通过。smoke 修复有效旧内容 hash/活进程释放边界、输出保存前隐私准入及子进程/屏障 watchdog。详细 RED/GREEN 与评审见仓库外任务报告，初始超时或漏插断言没有冒称行为 RED。

本地使用：先 npm run build；node packages/cothink/dist/cli.js build start --project DIR --request REQUEST.json --approve-plan PLAN_HASH --config CONFIG.json --root CATALOGUE --image sha256:IMAGE [--env-file KEYS.env] [--discussion-root SESSIONS] --json。show/export/retry/cancel 使用相同 --root 与 RUN_ID；export 另加 --output DIR [--version ACCEPTED_SHA]。施工预算只来自冻结计划，无扩额旗标。首次 retry 只恢复，下一次显式 retry 续作；show/export 不读密钥、不调用模型。取消 intent 未确认撤销时返回 incomplete/code2，不能当成功。

边界：开发 checkout 接线与受控模型机制通过不证明真实模型能完成施工，也不证明速度/成本收益或安装兼容。真实模型实验、产品发布、安装包不属本轮。HTTP 取消只在记录的活进程/通道状态范围证明；关闭 socket 不等于 SDK 消费迟到动作，旧授权拒绝另由阶段 4 的 live Driver 边界验证。SIGKILL 是进程中断，不等于断电验收。同步后端属于可信宿主边界，schema/hash 校验不等于防恶意验证器。

### 真实默认时钟门禁与失败现场

证据根目录：`/Users/xubibi/Documents/CoThink/work/construction-stage5/current/`。`validation.json` 的 accepted 保持 false。主流程命令为 `COTHINK_BUILD_VALIDATOR_IMAGE=sha256:5879132a5e9a30001eb3aff1655af70bc2681d80cba7666e66d12a21d726d1ce COTHINK_BUILD_SMOKE_SCENARIO=main node scripts/smoke-build.mjs`，smoke 退出 1，内部编译 CLI 退出 2/incomplete，总耗时 1873307ms。真实 Date.now，原 120000/900000/2700000ms 调用/任务/运行截止和 36 调用/147456 输出分配均未扩展。

实际 A/B1 HTTP 起止序列分别为 2→4、1→3；服务端两个请求同时 pending，毫秒时间戳的重叠差为 0，不能据此报告正的重叠持续时长或性能收益。受控屏障用于机制验收。B1 从未收到 normalize；B2 授锁后首读 hash 为 `sha256:0120427f5cfa2b020fb4db3160ca976075443a613ce28d8968b3e02cee14a015`，等于 A 的已接纳 normalize。

实际接纳次序为 B1→A：V0 `20b50e9a4cb61049b624203ed53aa1cb87f3c0c2` → `60ec2c70e7564a0d1716820e1995b338ace346ea` → 当前正式版本 `51014feef9c24ad003374813bd91c6a183cbbe16`。两张真实 Docker 回执退出 0，分别执行 common/report 和 common/state-format/report，已独立复核 candidateHash、checksHash、imageDigest、前后源码 hash、checkReceiptId 与正式版本链的关联（main-partial-receipt-verification.json）。不是最终完整五组检查。

B2 从授锁到首次 HTTP 已耗 774140ms（约12分54秒），只余125860ms；私有编辑后因 deadline_exceeded 暂停，未接纳，正式指针保留 A/B1。调用数5、输出分配20480，未返回成功 integrationResult。完整 final/identity/标题/id/旧格式/非法输入及4/1/2/1在本轮编译入口未通过，不能借阶段4或 oracle 参考补称通过。失败样本和原始脱敏记录保留：local-http/smoke-main-1792036668157.json、smoke-main.log、default-clock-failure-analysis.json。重复完整资产/owner校验是待 profiling 的耗时疑点，尚无逐方法归因；未越出本阶段修改存储或放宽冻结政策，也未重试到成功。

取消首次真实 HTTP 运行已完成活动撤销，cancel命令0、原运行2；两个调用reserved→unknown，保留8192分配，正式版本V0、零编辑/发布。原进程存活时释放合法旧hash响应，两条socket均已关闭，因此不声称SDK消费迟到动作。该严格 smoke 后续因终态 retry 再次取得 writer 改写 epoch/revision/coordination 而失败1，证据 local-http/smoke-cancel-1792038499242.json 原样保留。已先补两项字节反例再修 CLI 终态只读投影，并通过2项GREEN、类型/格式和独立复核（terminal-fix/）；修复后完整真实取消复验0/VERIFIED（local-http/smoke-cancel-1792040732500.json、smoke-cancel-fixed.log），cancelled retry后全状态字节不变、零新增HTTP，保留unknown2/8192分配。新增字节用例及真实复验均针对cancelled，completed完整CLI生命周期本轮未形成。已观察终态与最初为active、随后才终态的竞态分开；后者沿既有writer路径，不声称全程元数据绝无变化。

### 读取、导出与检查记录

真实附加读取在已接纳A/B1的未完成运行上执行，不冒称完整样本。仅测试子进程PATH移除Docker，start返回2/BUILD_DOCKER_UNAVAILABLE，零HTTP，无宿主回退。移除临时假密钥文件后，show返回0，两次固定同一正式版本export均0，11文件逐字节一致；原输入仍匹配冻结manifest。既有exporter取得writer可能推进owner/revision，但正式指针及调用/检查/发布账本不变。危险配置目标返回2/BUILD_EXPORT_PROTECTED_TARGET且全状态字节不变；first retry返回2、零新增HTTP，5次调用/20480分配和2个接纳保留，无活动旧尝试。

附加脚本最初误期望危险导出code1而失败1，保留read-export-docker-negative.json.initial与初次日志；续验按确切code2、错误码及状态字节断言通过0（read-export-resume.json/log）。不删除失败记录，不将脚本期望错误称产品缺陷，也不重复已成功的两次导出。该旧运行恢复时全场截止已到，不证明它还能继续；显式续作另用新鲜恢复样本。

| 本轮命令/检查                                                        | 退出码与证据                                                            | 边界                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| npm run build / npm run check                                        | 均0；build-terminal-fix.log、typecheck-terminal-fix.log                 | 开发编译，不是安装/分发                                                |
| core全套，maxWorkers2/minWorkers1                                    | 0；34文件718项；core-regression.log                                     | 包括旧peer/discussion与施工纯状态                                      |
| CoThink全套，相同worker参数                                          | 0；5文件37项；cothink-regression.log                                    | 含原讨论/路由；终态修复后另跑6项编译入口0                              |
| viewer全套，相同worker参数                                           | 0；9文件85项；viewer-regression.log                                     | 原有兼容回归                                                           |
| host旧套件，排除新增4文件                                            | 1；634通过/1超时，共635项49文件；host-legacy-regression.log             | 同时重磁盘检查下workspace B2用例触及原120秒，不隐去                    |
| 新增commands/config/render/discussion-link及原workspace，maxWorkers1 | 0；5文件41项；host-final-isolated.log                                   | workspace B2为85.732秒、CLI retry为91.863秒，均低于原120秒；旧失败保留 |
| contracts/bridge行为与审查                                           | 初始9项桥接、19项CLI及终态2项GREEN；任务RED/GREEN日志及review-result.md | unit可信Verifier不是Docker证据                                         |
| 实际main / cancel / recovery                                         | main1；原cancel1；修复后cancel0；recovery1（前置缺口）                  | 各独立临时样本，真实Git/磁盘/Docker及受控HTTP                          |
| ESLint/Prettier                                                      | 全仓lint0、format0；最终文档增补后另存格式复验日志                      | 只格式化本阶段文件                                                     |

### 新发现的阶段4调用方恢复缺口：不在阶段5越界修复

实际命令：同一固定image，`COTHINK_BUILD_SMOKE_SCENARIO=recovery node scripts/smoke-build.mjs`，smoke退出1。宿主SIGKILL已证实；首次retry退出2、零新增HTTP，2个reserved转unknown，8192输出分配、V0和零发布保持。第二次显式retry仍退出2，但HTTP累计仍为2，未续作。证据：local-http/smoke-recovery-1792041310085.json、smoke-recovery.log、recovery-failure-analysis.json。停止时无活动锁/尝试，B2已暂停且inputHash=null，A/B1等待；没有半发布、退款或旧授权复活。

固定时钟1000/1100/1101的纯状态反例 `node /Users/xubibi/Documents/CoThink/work/construction-stage5/current/recovery-queue-counterexample.mjs` 退出1，失败是行为断言 `[]` 不等于 `['T-B2']`，不是导入/环境错误，也不靠sleep。它复现A先授锁、B2等待、B1授锁，owner epoch变化撤销旧尝试后保留B2排队。显式重试首先申请A时，`reserveBuildScope`按完整队列正确先授予较早B2，但返回的是当前A的waiting结果；`BuildDriver.execute`初始化只收集当前result.lease，漏掉这次为其他排队任务产生的B2 lease。随后B2被判already-active、B1因worker忙等待；初始jobs为空，驱动收尾再次撤销无人执行的B2。与真实跨进程结果一致。

该纯脚本实际执行既有reducer，并按当前Driver收集条件作最小复现，不冒充完整Driver单元测试；完整驱动行为另由真实跨进程失败提供。独立复核确认P1并核对driver/scope/scheduler/state四文件SHA与初始一致，见predecessor-gap-review.md。

问题定位在既有 `packages/argue/src/build/driver.ts` 的初始授锁结果收集，而非CoThink新命令的模型选择、可选讨论桥接或同步后端替换。锁的完整授予、队列优先级和旧权限撤销仍有证据；这暴露阶段4恢复覆盖不足，不把所有工具核心机制一并判失效。原阶段4通过记录及源码不改写；新反例追加到本节。按用户“前置不足不擅自补做其他阶段”的限制，未修改driver/scope/scheduler/state，也未清队列、改样本顺序或扩预算来绕过反例。需要另行修复该前置、补Driver含旧等待者的恢复回归，再复验阶段5真实续作；默认15分钟完整流程的耗时门禁也仍须补齐。

只读诊断（read-only-overhead-diagnostic.json）在保留样本上测得20次桥接目录查询平均约0.70ms、5次parseBuildState平均约2.13ms，不能将主流程774140ms直接归因于这两者；尚无完整Git/owner/资产验证逐方法profile。没有为猜测性能原因修改核心规则。宿主实际日志为Node24.19.0，未据此宣称其他宿主Node/OS通过。

### agent-sync 方向与尚存耦合

本节单独记录用户补充，不追溯改写旧阶段或删除失败门禁。CoThink 是首个接入方；正确方向为 CoThink/其他Agent/脚本 → 独立同步与版本工具 → Git/文件系统/验证后端。当前 BuildSyncPorts 只是可替换后端接口，阶段4的本地/内存同契约通过不等于独立工具对外接口验收。origin/答案版本/回流/事件游标留在可选桥接层；无讨论来源路径实际成立，onSaved不自动施工，prepare零调用。CLI不另写锁/授权/接纳规则，权威状态仍共享前序模块。

| 具体耦合/现有边界                                                                                     | 后续归属                                                           |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| commands.ts导入FileDiscussionStore、bridge、环境和供应商transport；config.ts复用parseDiscussionConfig | CoThink接入层，配置兼容不作工具核心契约；新6/8明确中立服务和调用方 |
| runtime.ts要求ModelTransport/models并组合BuildDriver                                                  | 上层模型客户端；新6无模型服务不依赖它                              |
| core build/index.ts混合导出driver/budget/requests与状态/端口；本地后端引用顶层@onevcat/argue          | 新6中立入口和依赖闭包验收；本轮未大规模移动模块                    |
| commands.ts按T-A/T-B2/T-B1排列样本派发顺序                                                            | CoThink调用方策略，不是工具锁规则；新7/8不能强加给普通客户端       |
| contracts.ts v1固定member-a/member-b、业务检查组及模型调用/token字段                                  | 原格式保留；新7独立版本和显式适配，不原地迁移                      |
| validator.ts引用todo-stats、开发checkout检查资源；CLI工具链定位依赖可信checkout                       | 新7可信项目检查配置，新8显式资源/任意cwd入口                       |

已有机制证据是阶段1锁/授权、阶段2真实版本/暂存、阶段3真实Docker/CAS/恢复、阶段4受控循环及后端替换，以及本轮列明的局部接线验收。尚未完成无模型AgentSyncService、无模型/SDK依赖闭包、项目/成员泛化、独立进程入口和外部客户端验收，不能称独立工具MVP完成。详细审计在agent-sync-boundary-audit.md。

本轮实际验收和交接到此停止，阶段5未标完成。当前须先修复上述前阶段恢复派发缺口，再补齐阶段5真实默认时钟完整门禁；通过且另获授权后，下一阶段按agent-sync-after-stage5.md为新6“独立核心与无模型服务”，不是旧真实模型6（现新9）。本轮不进入新6–10，不调用真实施工模型，不提交/推送/合并/发布/制作安装包；共享额度授权仍使用原stage3–5记录，未兑换。

### 改动与停止点核对

初始320个文件SHA中317个保持原样，仅runtime.ts（两个可选接口）、CoThink index.ts（薄路由）和本进度为允许的既有文件变化；新增10个阶段5源/测试/脚本文件。用户补充的agent-sync-after-stage5.md另列为输入文件，未覆盖。core Driver/锁/状态、真实store/workspace/publisher/recovery、shared SnapshotStore、旧讨论/peer、ModelTransport、冻结样本与依赖/版本/发布配置未修改。文件清单及hash见preservation.json、stage5-current-source-hashes.json及各次实际入口冻结记录。

源码Git只读status/diff --check均0，保留原branch/checkout和未提交成果；关闭可选索引写入，未暂存、提交、推送、合并或发布。自动Git对象仅临时受管测试库，原输入与正式版本的比对证据见读取导出及preservation记录。未制作tarball、安装包、全局安装或源码外安装测试，未安装软件或改用户密钥/账户配置。假密钥只在独立临时样本使用/删除。源码审查通过与真实门禁未通过分开记录；不能称本轮CI或阶段5核心验收全部通过。

本轮额度收尾读取周窗口已用82%、剩余18%，五小时值未知；原stage3–5共享记录、唯一idempotencyKey和一次授权计数保留，未兑换重置卡。新计划的后续编号不产生新授权。

## 阶段5收尾：恢复派发、默认截止与完整验收（2026-10-15）

状态：阶段 5 已完成；旧失败与停止记录作为历史保留，本节更新当前验收结论。

本轮按“将阶段5收尾并完成”处理阻断其验收的必要前置缺陷。保留原阶段0–5的未提交成果及历史失败，不进入新阶段6–10。

### 修复与原因

1. `BuildDriver.execute` 的一次范围申请可能同时给更早的等待者授锁。原程序只消费当前请求返回的lease，恢复时会漏掉已经获锁的B2/B1。现在按事务前后新增的活动attempt收集全部新lease，各启动一次；队列顺序、权限和预算继续由已有reducer验证。两个完整Driver行为反例先RED再GREEN，覆盖“没有直接返回lease”和“与直接返回lease并存”。
2. 原底层Git每个目录/对象守卫都用raw.load确认owner，重复解析整份历史状态。新增`SnapshotWriter.assertOwner`复用原PID/nonce租约检查及序列队列，FileBuildStore的完整读取/写入仍验证状态、资产、历史与CAS。两种codec的新行为测试先RED，再与存储全套通过。等价独立副本withWriter+load测量58046ms→14576ms，检查次数不变；这是局部证据，不推论普遍吞吐收益。
3. 本机Node24会预扫描没有`--`隔开的`--env-file`。完整施工后重复start的原harness在Node启动阶段因已删除假密钥而退出9，未进入CoThink。给Node脚本调用补`--`，保留`-e`及Docker调用，记录真实spawnargs；真实编译入口回归先RED（Node退出9），修复后GREEN（故意无效的CLI参数按预期退出1，测试通过）。开发命令推荐`node -- packages/cothink/dist/cli.js build ...`。

### 实际门禁与证据

仓库外根目录：`/Users/xubibi/Documents/CoThink/work/construction-stage5/closeout/`。

- `local-http/smoke-main-1792043135091.json`：编译施工命令0，723582ms；原120秒/15分钟/45分钟及调用/token硬限额未改；A/B1/B2均正式接纳，6次受控HTTP、3次真实固定镜像检查，最终五组通过，覆盖4/1/2/1及边界。A/B1请求实际重叠；B2首次normalize hash等于A正式版本。show、两次export、两次retry均0；11文件逐字节一致且原输入未改。
- 原main原始harness退出1保留：最后重复start在Node层退出9。`main-resume.json`只补验同一已完成run的该最后步骤，实际0且缺少假密钥；正式版本、acceptedTasks、6calls、3checks/3publishes全部保持。没有重跑或冒称原harness一次性退出0。施工生产源码及编译入口hash与main启动记录一致，仅harness后来修正。
- `local-http/smoke-cancel-1792044160826.json`：harness0/VERIFIED；start2、cancel0、retry2、show0；2次调用保留unknown分配，终态cancelled，首次retry零新增请求，状态稳定。原进程释放时仍存活，但SDK已关闭socket；不宣称客户端实际消费了迟到响应。
- `local-http/smoke-recovery-1792044355607.json`：harness0/VERIFIED；原宿主SIGKILL，首次retry2且0新增请求；第二次显式retry2但成功执行B2/A/B1，2unknown+3succeeded共5calls/20480分配。预设abort动作保留V0与零发布，不将此称恢复后项目完成。它证明恢复能够续作、旧预算不退款。
- `missing-image.json`：真实编译入口在固定镜像缺失时2/BUILD_DOCKER_UNAVAILABLE，0calls；daemon保持运行，无宿主回退。

### 本轮完整回归与审查

四个 workspace 全套本地回归均通过：core 720、host 667、viewer 85、CoThink 38，合计 1510 项；无失败/跳过，定向子集不重复计数。宿主使用固定镜像与 maxWorkers=1，真实隔离/daemon偏差、两种协作顺序、真实Publisher均产生本轮 VERIFIED 回执。build/check/lint通过；最终文档格式结果见 format-final.log。一位独立审查者分三次检查恢复派发、owner快路径及harness修复，均无阻断发现；源级审查不替代实际验收。

### 保留、边界与停止点

冻结样本24文件、原施工计划、依赖锁文件均与开工hash一致；无文件删除。原失败记录不覆盖。既有固定文件名的后端验收材料先备份，再将本次新结果放入fresh-backend-evidence，并恢复原字节。没有真实供应商调用、安装、打包、源码Git暂存/提交/推送/合并/发布或新6–10实现。主机Node24.19.0与本地固定Node22镜像的证据分开；不宣称CI、断电或真实模型能力已验证。

阶段 5 收尾门禁已补齐，在此停止；下一阶段是独立同步工具阶段 6，需要独立实施和验收。

本轮原始命令、退出码与测试计数见 acceptance.json / remaining-complete.json；固定文件名后端报告的新结果位于 fresh-backend-evidence/docker-acceptance/ 与 fresh-backend-evidence/current/，旧原件已恢复。开工369文件的保留核对见 preservation-final.json。额度观察独立保存为 quota-observation.json；本轮未调用兑换工具，未改旧3–5及新6–10的一次授权计数。
