# CoThink

CoThink 施工模式现可通过 `cothink build sync` 调用独立 agent-sync 工具，支持启动、查看、取消、恢复、显式续跑和导出。[接入与验收指南](docs/cothink/AGENT_SYNC.md)。

CoThink 是一个本地命令行工具：让两个地位相同的模型独立回答同一个问题、交换问题和修订，再各自评审全部冻结的主张版本。报告保留双方判断、理由、证据请求和未解决问题，不指定主代理、代表者或胜者。双方同意不等于结论正确。

需要 Node.js 22 或更新版本、npm，以及两个成员所使用的 API 凭据。从本仓库安装：

```bash
git clone https://github.com/XSY-28/CoThink.git
cd CoThink
npm ci
npm run build
npm pack --workspace packages/cothink --pack-destination .
npm install -g ./cothink-0.6.1.tgz
cothink setup
cothink test
cothink start --question "这个方案有哪些取舍？" --context proposal.md
cothink view SESSION_ID
```

`setup` 不调用 API；可跳过隐藏的密钥输入，使用已有环境变量。默认配置、密钥文件和会话分别保存在当前目录的 `.cothink/config.json`、`.cothink/keys.env` 和 `.cothink/sessions/`，已有文件不会被覆盖。`test` 最多进行 4 次付费 API 请求，用于检查连接及输出结构，不评价回答质量。

目前提供源码构建的独立安装包，尚未发布到 npm registry。支持 OpenAI-compatible 和原生 Anthropic-compatible 传输；真实 GPT/Claude 账户尚未验证。问题和上下文会发送给配置的 API 服务。

[讨论模式改造计划](docs/plan/discussion-v1.md)包括总思考强度、参与权重、决策权重、同版答案共识、提前结束与异议摘要。这些功能尚未实现；当前基线输出双方报告，并显示讨论过程。

完整命令与边界请参阅 [English README](README.md)、[安装](docs/cothink/INSTALL.md)、[配置](docs/cothink/CONFIGURATION.md) 和 [发布准备](docs/cothink/RELEASE.md)。基于 [onevcat/argue](https://github.com/onevcat/argue)，保留 [MIT 许可证](LICENSE) 及原作者署名。
