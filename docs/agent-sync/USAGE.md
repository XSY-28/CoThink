# AgentSync：显式本地工具进程

阶段8提供一个显式启动、单writer的本地工具进程，以及只负责路由和上下文封装的薄客户端。核心仍是项目版 `AgentSyncService`、`LocalAgentSync` 和既有磁盘/Git/Docker后端。调用方选择任务、模型和文本；工具管理精确文件范围、lease、版本、真实检查与原子接纳。

这是当前源码checkout的入口，尚未发布或安装到用户环境。阶段8的确定性验收不证明真实模型收益，真实接入状态见 [VALIDATION.md](VALIDATION.md)。项目和持久化协议见 [PROTOCOL.md](PROTOCOL.md)，成本边界见 [PERFORMANCE.md](PERFORMANCE.md)。

首次使用请先走 [完整源码 quickstart](QUICKSTART.md)：包含无私有 donor 的镜像构建、实际 job 准备、确定性 cart 事务、导出与恢复。下面是自定义调用方的接口参考。历史模型 runner 和仓库外 work 证据不是工具运行依赖。

## 构建与启动

在仓库根目录执行：

```sh
npm run build
node tools/agent-sync/build.mjs
```

用本机checkout的绝对路径启动编译入口，cwd可以是任何临时目录：

```sh
node /absolute/checkout/tools/agent-sync/dist/stdio.mjs --config /absolute/trusted/job.json
```

可选 `--trace` 只向stderr输出脱敏诊断。stdout仅输出JSONL协议。编译器保留四个独立模块与动态bootstrap顺序；入口清除非白名单环境变量后才导入中立模块。不能把模型配置、密钥路径、SDK或讨论状态放入job。

job由可信宿主准备，格式为 `{ "options": { ... }, "connections": { ... } }`。`options`使用已有Local组合配置：绝对且规范化的源目录、工作目录、home、可信检查目录、programRoot、冻结project/config、runId、固定镜像digest和本地Docker连接。目录及检查材料须由宿主预先准备，首次启动通过现有初始化路径建立受管项目，重开校验既有项目身份。字段清单见 `tools/agent-sync/stdio.mjs`；不接受自定义clock、后端函数或模型字段。

`connections`固定绑定，例如：

```json
{
  "admin": { "role": "host" },
  "a": { "workerId": "declared-member-a" },
  "b": { "workerId": "declared-member-b" }
}
```

worker必须在项目中声明。绑定在取得writer前验证，进程内不热更新。配置文件和工具stdin属于可信宿主；不得把整个stdin或admin客户端直接交给模型。

## 薄客户端与两个调用进程

`tools/agent-sync/client.mjs` 导出 `ToolHost`、`createStreamClient`、`createClient` 和任务上下文封装。宿主显式启动工具后，使用 `host.attachProcess(childA, "a")`、`host.attachProcess(childB, "b")` 将每个子进程的stdout/stdin接到固定连接。路由层只加绑定身份和关联ID，不选择任务、不重试施工、不生成文本、不编排Git。

```js
import { ToolHost } from "/absolute/checkout/tools/agent-sync/client.mjs";
const host = new ToolHost({ entry, configFile, cwd: temporaryDirectory });
await host.ready;
const worker = host.client("a");
const grant = await worker.requestScope(taskId, "scope-1");
if (grant.result.kind === "granted") {
  const task = grant.task;
  const input = await task.freezeInput("input-1");
  // 调用方把固定输入交给自己的模型；文本生成与预算不在工具内。
  await task.edit([{ path, text, expectedContentHash: input.contentHashes[path] }], "edit-1");
  const publication = await task.finish("finish-1");
}
await host.client("admin").call("close", {}, "close-1");
await host.exited;
```

调用方遇到waiting时暂停该任务的模型调用，在已有事件/显式查询后取当前lease，再冻结最新输入。等待本身不发模型请求。任务上下文捕获授锁时的capability；晚到文本不能自动换成新lease。`task.descriptor()`供可信调用方保存上下文，不能作为模型可改写的权限字段。

模型可继续输出既有窄动作 `inspect/edit/check/finish/abort`；`task.runAction(action, requestId)`薄转发到已有工具操作。`check`先封存后检查；`abort`释放当前范围。模型不提交shell、检查配置或passed。CoThink的BuildDriver与讨论provenance继续由原调用方维护；本阶段没有重接或复制驱动算法。

## JSONL协议与权限

wire版本为 `agent-sync-stdio-v1`，与已有项目/状态格式分开。工具收到的可信外层帧如下；普通客户端内层只有routeId和request，由路由宿主补connectionId：

```json
{
  "connectionId": "a",
  "routeId": "route-1",
  "request": {
    "protocolVersion": "agent-sync-stdio-v1",
    "requestId": "scope-1",
    "method": "requestScope",
    "params": { "taskId": "task-1" }
  }
}
```

| 方法                             | 权限与顺序                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| status                           | 任一已绑定连接，只读当前正式状态及等待状态                                                      |
| requestScope/currentLease/cancel | worker仅操作自己声明的任务；cancel撤销等待或当前尝试                                            |
| freezeInput/read/edit            | worker持原任务capability；授锁后冻结输入，read/edit限精确范围；edit绑定旧内容hash               |
| seal/check/finish/release        | worker持原上下文；check须已有封存候选，finish仍由核心执行当前组合检查及CAS；release放弃当前尝试 |
| diff/exportVersion/recover/close | host专用；export为独占目标目录，recover不自动施工或重放未知动作                                 |

响应含版本、routeId、requestId、`ok`、结构化result或稳定error.code、timing。授锁时返回capability及owner/lease/attempt上下文，原始lease token不出协议。结果中的普通文件名 `token`/`lease`不会因脱敏丢失。错误不返回后端消息、堆栈、路径、正文、命令参数或环境值；常见错误包括 `wire_version`、`wire_invalid_request`、`wire_forbidden`、`wire_lease_context`、`request_id_conflict`、`scope_violation`、`attempt_invalidated`、`port_rejected` 和 `backend_rejected`。

单帧上限8MiB，严格UTF-8；最多32个在途帧、4096个请求上下文，项目自身资源限制继续生效。关闭不受请求上下文额度耗尽阻挡。语义错误仍使用既有核心的较低资源、权限和截止限制，不增加任意shell或RPC扩展点。

## 重放、撤销与关闭

同一进程requestId绑定连接、方法和精确params；不同上下文拒绝。每个完成请求仍进入核心，不在路由层缓存passed。跨重启仅复用既有磁盘**成功**回执：需匹配旧requestId、任务、worker及原capability，再由核心核对原请求。历史成功只读返回原回执/版本，不表示当前lease仍有效。未知/失败请求、进程内检查候选和check-session回执不增加跨重启exactly-once承诺。

客户端断开只关闭它的管道，不隐式撤销任务；调用方要放弃任务须显式cancel/release。host close/SIGTERM停止接收新操作，通过现有Local session终结路径失效owner/lease并释放writer。close成功中的 `writerReleased:true`发生在writer终结完成后；进程退出和检查子进程/容器清理分别观察。启动中收到信号不会随后宣告ready；已经开始的合法初始化可能完成后释放，未增加初始化回滚协议。

取消确认代表授权撤销已经生效，不代表模型、Git或容器此时已停止。忙检查时status/cancel可被调度，旧执行结果仍需经过核心重新核对；晚到结果不得接纳。重开和首次recover不自动发模型、重新验证或重新施工。

项目/检查hash、可信程序/参数/工具链、固定镜像和隔离证据继续由后端绑定。配置或检查材料变化不能复用旧通过证据；需要新冻结依据和验证。镜像替换必须符合实际profile/工具链，否则拒绝。原成功回执的只读查询与新的接纳资格分开；进程不热载入变化配置。

## 成果交接与原仓库接入

host取得diff、导出和验证摘要后，调用 `tools/agent-sync/handoff.mjs` 的 `createHandoff`生成独占交接目录，包含原始基线副本、changes.patch、validation.json、handoff.json，以及基线/接纳版本和逐文件hash。原始UTF-8字节与BOM保持；源或导出hash不符立即拒绝。该格式化器不验证/发布候选，也不覆盖原目录。

受管基线Git版本与原开发仓库HEAD是不同身份。`repositoryGuard`只读核对宿主给出的原HEAD及脏工作区：前进为 `base_moved`，本地改动为 `local_changes`，无法确认则 `repository_unverified`；即使干净仍要求显式人工审查。所有结果的 `directOverwrite`均为false。

先审查patch和验证摘要，重新核对原HEAD/本地变更；需要接入变化后的基线时，显式准备新的受管基线，再检查并接纳。旧回执不能授权覆盖新基线。本阶段不自动应用patch、创建分支、提交、推送或安装。

## 时间解释

响应queueMs是帧解码回调至分派开始，toolMs包含后端内部排队、Git/磁盘、真实检查和接纳。客户端往返另记，不能从queueMs很小推断内部无等待。`--trace`记录单调父子span、Git/Docker/oracle启动与实际close、容器创建/清理；不记录argv或内容。父子和并发时间不能直接求和。实际数据、失败历史和恢复边界见 [VALIDATION.md](VALIDATION.md)。
