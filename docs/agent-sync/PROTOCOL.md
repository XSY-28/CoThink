# AgentSync 项目协议 v1

阶段 7 的项目/程序调用契约；不定义阶段 8 的 JSONL/stdio、工具进程或连接身份协议。当前实现进度与实际门禁见[独立进度](../plan/agent-sync-progress.md)。本说明随阶段 7 施工收尾，未通过的门禁以进度记录为准。通用核心只解释声明、范围、版本、检查引用与回执；任务选择、模型和文本生成属于调用方。

当前收口出口为 **S7-complete**：两个项目、固定1/2/3成员、真实组合拒绝反例、原120秒Local门禁及当前兼容/隔离/恢复门禁均已通过。三成员cart采用明示的真实接纳加后置核验组合证据，原脚本结束断言失败保留。实际命令、身份与限制见独立进度及仓库外 `work/agent-sync-stage7/acceptance.json`；不改公共协议、状态格式、权限或接纳门槛。

## 格式和兼容

新格式分别使用 `agent-sync-project-v1`、`agent-sync-state-v1`、`agent-sync-request-v1`、`agent-sync-lease-v1`、`agent-sync-candidate-v1`、`agent-sync-tool-receipt-v1`、`agent-sync-workspace-v1`、`agent-sync-check-v1`、`agent-sync-publish-v1` 独立识别。固定成员可为任意符合 ID 规则的声明列表，不动态增删；成员数量不与旧双成员绑定。

旧 BuildPlan/BuildRun 和 build-\*-v1 字段、枚举与原快照保持原样，经显式 legacy-v1 路径使用。新协议不把旧对象静默视作新对象，不在旧目录写新 codec。旧项目若导入新格式，须显式建立新的项目声明/新存储；不迁移或覆盖原会话/版本历史。新的项目入口与旧兼容入口分离，通用依赖闭包不加载旧业务 schema 或模型/讨论/供应商模块。

## 项目

AgentSyncProject 包含 projectVersion、projectKey、memberIds、manifest、tasks、profiles、finalProfileId、checkConfigurationHash、resources，以及冻结后的 planHash。保留 planHash/plan 等结构名是为了共用已有机制，不代表使用旧 BuildPlan schema。

manifest 为精确 ASCII 文件路径、`read-only` / `writable` 标记与初始内容 hash。无绝对路径、点段、大小写别名、文件/目录冲突；只读内容必须存在。任务包含 taskId、已声明 workerId、read/write 精确范围、dependsOn 及 checkProfileId。写范围非空且仅 writable 文件；依赖无环。profile 名称和 checkIds 均为宿主声明的普通 ID，核心不枚举业务检查；所有任务及最终 profile 必须可解析且检查非空。

planHash 是独立版本、完整规范化项目、检查配置引用与资源的 canonical JSON SHA-256；任何差异产生不同项目声明。checkConfigurationHash 绑定宿主的可信检查配置，不包含可供调用请求选择的 shell。

resources 包括 taskTimeoutMs、runTimeoutMs、checkTimeoutMs、maxSessionRequests、maxEditsPerRequest、maxTextBytes。默认为900000、2700000、120000、4096、32、262144，截止满足 check≤task≤run；新协议不要求模型调用/token/供应商字段。maxSessionRequests 只限制一个服务会话中的不同请求 ID，不承诺跨会话累积预算；新 owner 会话重置该内存限制。文本按 UTF-8 字节累计，修改先检查全批次再执行，不能通过多个 edit 项绕过大小限制。

## 权限和版本

可信宿主绑定成员客户端，正文不能覆盖身份。整体授锁，只读共享、写互斥；依赖或忙成员不占保留锁，互不冲突任务可绕过等待者。调用方查询等待/当前 lease，不会触发模型或自动施工。

新 lease 包含 leaseVersion、projectKey、runId、planHash、taskId、workerId、attemptId、ownerEpoch、leaseEpoch、token。新旧格式、项目/run/plan、owner/task 代次及 token 必须全部一致。正式版本只有原子权威快照中的 acceptedVersion；Git refs 只保留对象，不是另一条接纳路径。

获锁后 freezeInput 固定 attempt 的正式基线和授权范围 hash；read 读取该固定版本或本 attempt 私有 overlay；edit 只改声明 write 文件并匹配 expectedContentHash；seal 封存私有候选。candidate 包含独立版本、attempt、基线、Git version、overlayHash、candidateHash。

独立 check 验证当前私有封存候选，仅为观察，不推进正式指针。finish 不拼接旧通过回执，而是将当前 overlay 组合到最新正式 head，重跑既有任务+本任务及必要最终检查，再验证最新配置/owner/lease/input/overlay/正式 head 后 CAS。它可以直接接纳有效暂存或规范空 overlay，不强制先 seal；正式组合候选可能不同于 earlier 私有候选，也可能以不同于 attempt 初始版本的最新 head 为基线。回执必须将这两个角色区分。

## 回执和幂等

请求外壳显式携带 requestVersion、requestId、operation 及身份/lease；严格拒绝未知字段。工作区成功回执包含独立 receiptVersion、完整请求、requestHash、operation、outputHash 与结果。成功重放必须完全匹配原绑定，且只读，不重新授权或施工。

正式 check 和 publish 关联 receiptId/checkReceiptId、attempt、候选/base/formal版本、plan、原始input/overlay、owner/task epoch、配置/程序/参数/工具链/隔离/image/source hashes。passed 只接受可信 verifier 实际产生并拥有的回执及独立证据，不能由调用正文声明。普通私有检查绑定原 attempt.base 和封存记录；正式检查绑定其发布回执和最新组合内容，原 overlay 由持久 staging 或规范 empty hash 证明，不要求组合候选出现在私有候选列表。

成功工作区/发布回执持久化；历史成功重试只读。独立检查成功观察与此前被拒绝 ID 的同会话绑定不构成失败/unknown 或跨重启 exactly-once 承诺。失败的显式检查重试可能重新执行；恢复本身从不重跑未知动作。

## 可信检查

profile→checkIds 和最终组合来自冻结声明；宿主提供这些 ID 对应的受信程序、参数、数据桥/解码器和隔离运行时。所有选中检查必须存在、实际执行且结果完整。没有任意 shell/模型请求命令入口。

候选只在真实 Docker 的只读、无网络、无密钥、非特权和有限资源环境执行；宿主 oracle 只接收有界数据结果，不在宿主导入候选。候选不能通过退出0、伪造 stdout 或写 passed 字段生成正式通过回执。配置、每个程序及导入helper、参数、编译器/worker/桥接代码、工具链、镜像和实际隔离描述进入证据 hash，并在检查前后及接纳前复核。

## 恢复与边界

首次恢复只校验已提交对象/回执链、撤销旧授权并推进 owner；未完暂停，完成和取消保留。没有自动任务选择、模型调用、检查/接纳重做或 deadline 延长。续作需新显式请求/lease。恢复不修改 run 或既有 attempt 的截止；显式申请的新 attempt 仍按固定 taskTimeout 分配，并受原 run 截止限制。关闭的客户端不能继续 IO；执行中的可信后端副作用不能由 close 倒回，后端自身继续负责 owner/CAS 保护。

UTF-8 普通文本、精确文件范围和受信宿主边界保留。不提供 AST 合并、动态成员、分布式锁、通用 VCS 或任意本地恶意进程安全承诺。真实两个项目/1,2,3成员/拒绝及最终组合反例的证据由本阶段进度明确列出；未执行项不得标为通过。

## 程序调用顺序与错误（共享服务 Task3 已审查）

宿主初始化/打开与一个 writer 会话绑定；`forWorker(id)` 只创建绑定客户端，不启动任务。新协议先同步检查 ID 语法，首次异步操作才从权威冻结声明检查成员存在。调用顺序为 requestScope → 获得 granted/currentLease → freezeInput → read/edit → 可选 seal/check → finish。waiting 只返回结构化原因；下一次显式申请/调度机会可能授锁，release 不承诺自动派发循环。cancel/release 结束权限，恢复后重新显式申请。

`status` 是脱敏投影，版本 `agent-sync-project-service-v1`；`recover` 返回同一投影及 ownerEpoch、replayedActions=0。`diff` 只比较已接纳版本；`exportVersion` 只导出已接纳版本到明确目标。上述宿主操作不以正文身份替换受信连接上下文。阶段8新增的显式JSONL/stdio封套与薄客户端另见 [USAGE.md](USAGE.md)，继续调用这些现有服务操作。

稳定错误以 AgentSyncError.code 区分：invalid_input/invalid_clock；unknown_worker/unknown_task/worker_task_mismatch/identity_mismatch/scope_violation；run_id_mismatch/plan_hash_mismatch/owner_epoch_mismatch；request_id_conflict/candidate_mismatch/port_rejected；session_request_limit/edit_limit/text_limit；service_closed/host_operation_unavailable。协调器还返回具体 lease/截止拒绝码，不能把 rejected 或 failed receipt 当作通过。公共消息只包含安全 code，底层 cause 仅给可信宿主诊断，不转发原始候选 stdout、token 或文件内容。

会话达到请求 ID 上限后，status/currentLease/diff/export/close 仍可用；需要新 ID 的 release/cancel/recover 也受限，可关闭会话并显式开启新宿主会话处理。恢复不清空当前会话计数。已进入 admission 的被拒请求仍占一个槽，重试同 ID 不再占槽；校验前拒绝的非法或硬上限输入不占槽。限制只描述会话操作资源，不是模型 token 预算。

## 操作权限与副作用

| 操作                | 权限／前置                                     | 成功效果与重试                                                                         |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| 初始化／打开        | 可信宿主；冻结项目、检查配置、明确 run         | 初次导入 Git；打开已有状态不重导源，不自动施工；新格式先核对预期 run/plan 再推进 owner |
| requestScope        | 绑定成员，任务由该成员负责                     | 整体授锁或结构化等待，不产生部分锁；ID 绑定完整上下文                                  |
| currentLease/status | 当前会话；成员只取自己的 lease                 | 查询，不启动模型或收费轮询，不消耗新请求 ID 槽                                         |
| freezeInput         | 当前有效 lease                                 | 固定授锁基线和授权文件 hash；成功同请求只读重放                                        |
| read/edit           | 已固定输入；精确 R/W；edit 旧 hash 全部匹配    | read 从固定版本或私有 overlay；edit 先验证整批再写，不推进正式指针                     |
| seal/check          | 当前私有成果；check 要求已知封存候选和当前依据 | seal 保留不可变私有候选；check 只观察，passed=false 是失败检查数据；依据变化拒绝旧缓存 |
| finish              | 当前 lease/input/overlay；最新组合完整检查通过 | 唯一原子提交同时更新正式版本、任务、锁和检查/发布回执；历史成功重试不重验、不重发      |
| release/cancel      | 绑定成员的任务／lease                          | 撤销权限；取消／完成终态不复活；历史 release 重试不能撤销新 lease                      |
| recover             | 可信宿主；当前 run/plan/owner                  | 校验已提交资产和链，推进代次、暂停未完；零自动重放、无 deadline 延长                   |
| diff/export         | 可信宿主；只允许已接纳链                       | diff 返回 hash 变化；export 安全完整落盘，精确同目标重试不覆盖其他目录                 |
| close               | 会话宿主                                       | 禁止随后及逃逸客户端 IO；不能倒回已发生的可信后端副作用                                |

ownerEpoch 是工具宿主会话代次，leaseEpoch 是某任务授锁代次；新动作须同时匹配。正式检查的 baseVersion 指本次最新组合基线，attempt.baseVersion 则仍指最初授锁输入，两者不必相等。正式 receipt 中的 inputHash/overlayHash 保留原尝试及私有修改关联；candidateHash/source hashes 证明实际组合内容。

服务自身的 admission 与本地后端缓存绑定是不同边界。服务对已进入 admission 的请求保留同会话上下文绑定；本地适配器对未成功执行的异常允许显式重试，已完成的失败检查数据仍保留观察及身份，后续缓存依据错误不会抹去成功绑定。两者都不承诺失败／unknown 请求跨重启 exactly-once；正式接纳的持久成功回执则支持只读重放。

## 公共入口与存储识别

| 入口                                    | 职责                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| `@onevcat/argue/agent-sync/project`     | 新项目契约、纯协调机制、AgentSyncService                  |
| `@onevcat/argue-cli/agent-sync/project` | 新格式磁盘／Git／工作区／接纳／恢复、可信检查配置和验证器 |
| 两包的 `agent-sync/legacy-v1`           | 显式旧 v1 兼容路径                                        |
| 两包原 `agent-sync`                     | 保留阶段 6 原 v1 API；不自动识别或升级新格式              |

新格式使用 `.agent-sync`，项目身份 `agent-sync-project-storage-v1`、Git 身份 `agent-sync-git-v1`、codec `agent-sync-project`；旧格式保留 `.cothink-build` 和原识别。对同一个规范工作目录，两个控制目录即使对方尚无正式状态也不能作为兼容导入路径。并发首次创建失效关闭，可能留下无权威状态的目录；不承诺创建前排他。已有正式状态的 plan/run 预期不符时，在推进 owner 前拒绝。

检查配置独立为 `agent-sync-trusted-checks-v1`。先由可信宿主准备程序／资料并量取实际 hash，再冻结配置及项目；配置改变使用新的项目声明／新存储，不能替换旧项目配置后重用旧回执。历史成功回执可只读查询，不能用于当前不同候选或不同配置的正式接纳。

`configurationHash` 绑定完整 registry/profile/final/参数/期望 case/资源／artifact／dependency／image 配置；`programsHash` 绑定实际程序与辅助文件及生成模板；`argumentsHash` 绑定选中检查、固定 Node／Docker／编译参数、环境和有效限制；`toolchainHash` 绑定实际镜像元数据、Node／Docker 二进制及依赖树；`isolationHash` 绑定实际模式和镜像的固定隔离策略。`checksHash` 再绑定 checkVersion、选中 IDs 及这些依据；正式回执同时绑定候选、输入、overlay、版本和授权代次。实际 Node oracle、decoder 和固定 Vitest/Vite 路径只允许解析／加载声明复制且 hash 匹配的文件；新检查需宿主支持 Node `registerHooks`，能力缺失时失效关闭。整次检查分别累计原始子进程与包装层输出；非预期 stderr、越界或被捕获的基础设施错误均使检查失效。

候选执行用只读源码和 runtime 配置两份独立挂载。runtime 配置只含声明编译／操作／限制，不含 oracle、答案、case IDs、检查参数、Docker socket 或宿主路径。oracle 留在宿主私有目录并只调用受限数据桥；它属于可信宿主程序。工具不承诺防御恶意可信宿主／Docker daemon，也不把可写编译 tmpfs 当作不同 probe 之间的安全边界。

## 本地组合 API

新宿主入口的 `LocalAgentSync` 接受 `workspaceRoot`、冻结 `project`、`runId`、固定 digest 的 `image`、可信 `config`、`trustedRoot`、`programRoot` 和既有规范目录 `home`。初次导入另给 `sourceRoot`，重开可省略。可选项为 `clock`、`allocateLease`、`timeoutMs`、私有证据 `onUsage`，以及互斥的 `dockerEndpoint` / `dockerContext`。新入口不搜索 CoThink checkout 或模型配置；`programRoot` 显式包含固定 validator/checks 两个目录。

`host.withSession(async service => { ... })` 在整个 callback 内持有同一个真实 writer。宿主先绑定 `service.forWorker(workerId)`，成员调用 `requestScope(taskId, requestId)`；granted 后使用返回 lease 调用 `freezeInput`、`read`、`edit`、可选 `seal` / `check`、`finish`。edit 项为 `{ path, expectedContentHash, text }`；它不是无旧 hash 的覆盖写。waiting 只记录/返回等待，调用方以后显式查询或申请。callback 结束总会关闭已经构造的 service；同一 host 对象同时开启第二个 callback 会拒绝 `session_active`。

新 Local 在 writer 前验证 config/profile/hash 及声明资产／依赖字节；已有项目预期 plan/run 不符时也在推进 owner 前拒绝。验证器内部惰性构造，open/status/recover/diff/export 不执行 Docker 发现、检查或模型行为；首次显式 describe/check 才固定本次验证器的本地 Docker 连接。`home` 归调用方所有，工具不删除其既有内容。

每次新 writer 会话都会获得新的 owner，不能将重新打开误认为整个元数据逐字节只读重放。初次导入流程本身在同一 writer 上重复时，已有相同 plan/run 直接返回，不重导 source、不刷新原 run 截止。受信宿主底层入口 `initializeAgentSyncProject(writer, { project, runId, config, sourceRoot?, clock? })` 验证冻结配置后复用同一导入流程；它接收的 writer 已由宿主取得，不承诺撤销此前取得 owner 的动作。

Host 初始化／配置错误以 schema 校验异常或具体后端错误拒绝，包括非法 image digest、目录、Docker 连接参数、缺失／变化资产、初次缺 source 和已有身份不符。成员服务操作仍按前述 `AgentSyncError.code` 及结构化协调结果处理；底层原始 cause 留给受信宿主，不作为客户端协议。阶段 8 的统一进程错误封套不在本阶段定义。

check 回执的 `groups` 字段在新格式中承载配置选中的普通 check IDs；保留字段名以复用后端结构，不表示旧业务枚举。配置变更需要新的冻结项目／新存储；保留旧历史回执不等于允许它授权新候选。
