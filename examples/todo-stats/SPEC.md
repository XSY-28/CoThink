# JSON 待办统计器：冻结施工样本

这是可运行的 V0 输入，不是 Agent 施工成果。它不属于 npm workspace，运行时无依赖；使用宿主仓库已有 TypeScript/Vitest，Node 22+。阶段 0 检查在宿主临时目录运行，不提供 Docker 隔离保证。

V0 只接收数组中的旧格式 `{ id: number, title: string, done: boolean }`，按顺序返回 id/title/state，done 映射 pending/done。V0 不接受 status，不 trim 标题，不要求正整数或唯一 id；报告仅 `total: N\n`。三项施工任务尚未实现。

冻结类型允许 pending/done/cancelled。T-A 只改 src/normalize.ts：status 存在时必须合法且优先于 done，非法值不得回退；status 缺失时 done 必须为 boolean。T-B1 只改 src/report.ts：直接消费 NormalizedTask[]，不导入或调用 normalizer，输出 total/pending/done/cancelled 四行且末尾换行；total 包含 cancelled，空数组为四个零。T-B2 只改 src/normalize.ts：id 必须为正整数且批次唯一，title trim 后非空，保留内部空白、id、输入顺序及 T-A 的行为。T-B2 不设 dependsOn=T-A；后续调度以文件冲突展示等待。

CLI 从 stdin 读 JSON；合法成功退出 0，无 stderr。非法 JSON 退出 1、stdout 空、stderr `E_JSON\n`；任一非法输入整批拒绝，退出 1、stdout 空、stderr `E_INPUT\n`。不得输出部分统计。

共同只读：SPEC.md、package.json、tsconfig.json、src/types.ts、src/cli.ts。fixture 和 test 都是宿主只读材料；manifest 明确列出可导入材料，test/oracle 不导入模型工作区。

`node scripts/check-build-sample.mjs --project examples/todo-stats --groups baseline` 运行 V0 检查。common 是 baseline 的别名；可组合 state-format/report/identity/final。组合 profile 必须包含 common、已接纳任务和当前任务检查组；最终运行全部五组。`--self-test` 显式验证 V0 的预期功能失败、正确参考成果以及错误反例；不使用 skip。oracle 位于 test/oracle，仅证明验收程序，不能作为真实施工产出。检查失败退出 1；参数或环境错误退出 2。

运行 V0 CLI 可用 `node scripts/check-build-sample.mjs --project examples/todo-stats --groups baseline --stdin fixtures/legacy.json`；--stdin 仅允许 manifest 中的固定 fixture，先检查然后执行，不能接受 shell 命令。
