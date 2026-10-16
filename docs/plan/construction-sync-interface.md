# 讨论与独立施工同步工具的接口补充

日期：2026-10-14。状态：接口设计与验收补充，未新增接口源码。此文落实 [discussion-v1.md](discussion-v1.md) 第 5.3 节保留独立施工同步工具接入点的要求。

## 1. 当前证据和缺口

当前讨论实现有 DiscussionEngineOptions.onSaved：持久保存后通知，观察者异常隔离。DiscussionEngine.continue 接受新 sources，并创建新讨论段；DiscussionSource 有 contentHash。这些是真实程序入口，不是完全没有接口。

但 onSaved 的参数是 DiscussionRun 和原始 DiscussionRunEvent（另有 created 通知），不是计划中完整的稳定 InternalEvent envelope。不能把原始运行事件格式直接承诺为独立工具的长期协议，也不能把保存通知当作开工授权。

施工侧已有 BuildStateStore/BuildStateWriter 与本地 Workspace 等模块；这证明职责有分离，但尚未形成统一的可替换同步工具端口。施工计划必须要求 BuildDriver 依赖端口，不在 driver 内实例化 FileBuildStore、Workspace、GitSnapshots、Docker 或发布实现。

以上入口和类型来自本次源码读取。另定向运行现有 observer 异常隔离测试，1 项通过、其余 24 项未运行；它只验证观察者失败不影响调度/结果，不是同步工具完整接线已经验收的证据。

## 2. 两层接入职责

### 2.1 讨论与施工之间的桥接

讨论侧输出的是已保存的结果、业务引用和版本化材料。施工侧输入是明确批准的 BuildPlan。FinalResult 不自动等于可执行任务图或写入授权。

桥接请求至少包括：独立 integrationVersion、requestId、已校验 BuildPlan、origin（来源 sessionId/segmentId/selectedAnswerVersionIds/finalResultHash）及材料引用。origin 是桥接层 provenance，不增加进已冻结的旧 BuildPlan/DiscussionRun 格式；独立施工也可以没有讨论 origin。

宿主从持久讨论状态校验 origin 属于相应完成段，引用版本存在、结果 hash 匹配；不能仅相信模型输出的 sessionId 或“已批准”。MVP 的批准来自明确的用户任务计划，不自动把自然语言正文转换成任务。

施工返回版本化结果，关联 requestId、runId、计划 hash、正式代码版本、候选/检查/发布回执的引用。讨论桥接只接受可验证且与本请求对应的记录；版本不符、缺少正式接纳和重复异 payload 均拒绝。

结果回流先准备新的 source 材料，contentHash 由程序生成。只有显式授权的新段操作才调用 continue；不得在 onSaved 回调里自动追加讨论或开启施工模型请求。当前 continue 会驱动模型，因此“准备材料”和“实际继续讨论”必须分开。

BuildCheckReceipt 证明指定候选通过指定程序检查，不自动证明自然语言答案正确。若以后使用 ConstraintCheck，必须满足已有 contextHash/answerVersionId 绑定；不能把旧施工回执直接当成新段的有效检查或共识票。

### 2.2 施工执行与同步后端之间的端口

新增 BuildSyncPorts：由 WorkspacePort、VerifierPort、PublisherPort 组成的接口集合。它使用现有 BuildLease、BuildWorkspaceRequest、BuildToolResult 和实际 Check/Publish 回执 schema 所定义的类型；实现与这些公共类型相分离。

| 端口          | 行为                  | 必须保持的语义                                                     |
| ------------- | --------------------- | ------------------------------------------------------------------ |
| WorkspacePort | inspect / edit / seal | 固定版本读、私有暂存、范围/lease/旧 hash 校验、请求幂等。          |
| VerifierPort  | check                 | 真实宿主证据，绑定候选/检查配置/工具链，失败或未知不产生 passed。  |
| PublisherPort | finish                | 当前授权和组合检查、唯一正式指针、原子接纳、重复成功回执只读重放。 |

程序协调器仍拥有任务调度、预算、请求身份与范围规则。同步后端不得扩大计划范围、绕过截止、修改冻结讨论或以任意“成功”响应替代版本与权限校验。

本地 LocalBuildSyncAdapter 组合已有 Workspace 与计划中的 Verifier/Publisher，作为 MVP 唯一正式实现。其他独立同步工具通过相同端口适配；其版本和回执要映射到兼容契约，不承诺任意 VCS 或任意外部工具都能无条件接入。

BuildDriver 只接收 BuildSyncPorts，不依赖上述具体类、宿主路径或 Git/Docker 命令。FileBuildStore 的程序状态存储接口仍独立，不把模型传输 ModelTransport 当成同步工具接口。

## 3. 保存后通知与可恢复消费

稳定事件 envelope 使用原讨论计划的字段：schemaVersion、sessionId、segmentId、seq、type、refIds、data。它是已持久状态的只读投影，不修改旧 DiscussionRunEvent 的持久格式。

onSaved 作为新状态可读的唤醒通知，消费者用独立游标补读已保存事件。通知可能丢失或重复，不能把一次回调当作 exactly-once；去重键至少包含 sessionId/segmentId/seq。created 通知与已持久事件序列明确区分，不能向旧日志补造事件。

只向工具传它所需的业务资料，不默认发送完整运行状态、原始模型输出或内部评议。消费者故障不改变讨论保存、调度和额度；补读只读，不产生额外模型调用。

MVP 不新增消息总线、MCP server、远程 RPC、后台同步服务或自动任务分解；保留程序端口和桥接契约即可。

## 4. 纳入现有阶段，避免重做

- 阶段 0–2：保持已完成的 schema、lease、请求和工作区规则；不迁移旧快照，不因新增端口重写已有状态机。
- 阶段 3：Verifier/Publisher 可以按既定职责开发，但它们的公共行为要满足上述端口语义，不能将调用方固定为某个 CLI 类。
- 阶段 4：新增 `packages/argue/src/build/sync-port.ts`，使 BuildDriver 注入 BuildSyncPorts；新增 `packages/argue-cli/src/build/local-sync-adapter.ts` 组合本地实现。
- 阶段 5：新增 `packages/argue-cli/src/build/discussion-link.ts`，校验讨论来源/计划、准备结果回流材料；本地入口负责选用适配器。可在测试中验证显式的新段接入，不默认自动执行讨论→施工→讨论。

稳定事件投影在桥接模块中实现，不为此重写 DiscussionEngine 的共识、选择、预算或持久事件格式。未来真正需要独立跨进程协议时再定义版本化传输。

## 5. 接口验收

1. 不改 DiscussionEngine 的决策规则，也不改 BuildDriver 的施工循环，仅换端口适配器即可接入另一实现。
2. 同一套端口契约测试覆盖本地适配器和确定性内存适配器；后者证明可替换，不冒充真实隔离或真实发布。
3. 故意返回错误候选 hash、旧版本、异 requestId 或假 passed 的适配器，必须被边界校验拒绝，权威状态不变。
4. Observer 抛错、重复通知、漏通知后的游标补读，不回滚讨论、不增加模型调用或重复开工。
5. 来源段/答案/结果 hash 不能匹配时拒绝桥接；重试相同请求不生成第二个施工运行。
6. 成功施工记录可准备为新版 source；接入新段后旧讨论、观点、评议、预算和冻结输入字节不变。
7. 回流材料准备本身零模型调用；只有已授权的 continue 触发受控讨论请求，施工回执不自动变成共识或 ConstraintCheck。
8. 本地结果与来源可追溯，公开输出不含租约 token、原始评议或凭据。

新增测试位置：core `test/build/sync-port.test.ts`；host `test/build/sync-port.test.ts`、`discussion-link.test.ts`。只有通过上述接线验收，才可以说“独立同步工具接口已保留并可替换”；当前仅完成设计补充。
