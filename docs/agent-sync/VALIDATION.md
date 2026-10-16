# AgentSync 阶段8验证

2026-10-16：**阶段8机制验收完成**。阶段7已按 `work/agent-sync-stage7/acceptance.json` 完成，7.5已有有界测量/唯一局部优化结论，不要求任意提速比例。此前前置受阻报告保存在 `work/agent-sync-stage8/resume-20261016/previous-blocked-preflight/`；不覆盖原S7失败或检查点。

## 当前实现及证据身份

新增内容只在 `tools/agent-sync/`、两个进程验收脚本和5个stdio定向测试文件。wire版本 `agent-sync-stdio-v1`，4个编译入口模块；共享kernel、Local组合、存储、Workspace、Verifier、Publisher、项目/状态schema与包元数据未改。首个根构建后盘点有63个旧viewer重复ignored产物未在目录，其余544个原编译内容一致；末次构建接受快照为602个编译文件，对照S7旧快照19个viewer资源未在该快照、14个新增输出，共同项内容不变。两个盘点时点不同，不推断未测的产生原因。宿主/库/CoThink及两次实际工具入口的编译闭包保持；见compiled-rebuild-audit.json和final-compiled-basis-note.json。阶段9只绑定本地运行相关编译文件，不把viewer资源作为模型入口前置。CoThink现有BuildDriver继续调用同一共享kernel，本阶段未另建协调/驱动算法，也未把讨论provenance移入工具。

真实项目均用Node24.19.0宿主、固定Node22.23.3验证器镜像 `sha256:d7133178e08d36486618a4431029db066f15e57c22a0c75738d9506c7decbdbe`，真实磁盘/Git/Docker与Date.now；工具/两个客户端从任意临时cwd启动。输入、检查、源码/构建身份、运行命令、退出码及独立PID保存在 `work/agent-sync-stage8/resume-20261016/`。

| 门禁                   | 当前证据与结果                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 双项目同核心、双客户端 | `cart-main-run.json`、`todo-main-run.json`；各3次真实接纳，等待/独立范围/私有改动/授锁后最新输入/最终组合/导出/重开                                 |
| 忙时status/撤权        | `controlled-real.json`真实检查后用明确entered/release控制晚回执；`busy-production.json`原生产检查观察及 `busy-production-complete.json`独立后置核验 |
| 重放与恢复             | 相同edit/finish成功只读重放；异context拒绝；客户端重开、工具重开/首次recover零检查/零自动动作；关闭/撤销后的晚动作拒绝                              |
| 可信绑定和范围         | worker不能代办其他任务、越界read、正文覆盖身份/lease；启动前无效类型/未声明成员拒绝且权威字节不变                                                   |
| 配置/镜像              | 启动时检查配置hash、run、固定image及字段白名单拒绝；旧不符profile镜像真实finish拒绝、正式头不前进                                                   |
| 交接与原仓库保护       | 基线/正式版本、精确文本patch、真实验证摘要及导出；源hash/BOM/导出hash绑定；脏原仓库/不同HEAD拒绝直接覆盖                                            |
| 静态/运行中立闭包      | full closure不开tree shaking，禁止模型/讨论/SDK/密钥导入；实际PID import guard均allowed，环境探针无模型变量、fetch0                                 |
| 回归/包                | root check/build/lint/format及5文件12项stdio定向测试，exit0；临时tarball安装兼容单独记录，不是发布/正式安装                                         |

## 真实流程与时间

| 实际项目 | 完整调用方墙钟 | 锁等待区间 | 最终finish往返 | Git/Docker/oracle启动 | 结果           |
| -------- | -------------- | ---------- | -------------- | --------------------- | -------------- |
| cart     | 373.187s       | 85.074s    | 55.895s        | 4324/49/11            | exit0，3次接纳 |
| todo     | 991.322s       | 250.729s   | 158.298s       | 8967/49/15            | exit0，3次接纳 |

每个项目有6个独立进程环境探针、6份运行导入trace、20条客户端协议timing；分别680次导入判定全部allowed、modelFetch0。每项真实新检查的容器移除完成记录保留。完整墙钟含显式重放、关闭/重开、恢复、导出和交接，不能直接作为正常施工吞吐；项目前置材料准备未单独计时。原始子span不能与这些父区间直接相加。

响应 `queueMs`仅为帧回调至分派，不包含后端内部锁/存储等待；`toolMs`包含现有后端工作。客户端往返另记，Git/Docker/oracle子span及等待见原始诊断。并发、父子span不能求和作总墙钟。验收runner准备固定材料，不是模型生成；没有模型策略/成本优势结论。人工准备时间未单独测量。

## 忙检查与取消证据边界

控制试验经过真实ProjectDockerVerifier得到可信通过回执，再在显式entered/release闸门持有返回。status和cancel在释放前均获确认，释放后的旧finish拒绝、正式版本不前进。闸门时真实验证进程已经结束；它证明调度/晚回执安全，不宣称仍有容器在运行。

生产观察在真实oracle子进程启动事件后立即提交status/cancel。原运行exit1原因是诊断器按容器ID寻找rm，而现有清理按容器名调用，导致缺失清理观测的断言失败。原始日志/exit1保留。独立后置核验按原实际create ID只读inspect证实容器已不存在，并核对物理状态、正式头、pub0和新显式工具recover0，形成明确的组合证据；没有把原exit1改成exit0，也没有重跑同一真实检查。

按同一生产观察的父进程时轴：首次真实oracle启动20.389s；status确认21.251s；cancel确认24.473s；finish拒绝25.302s。最后oracle实际退出在工具时轴23.241s，早于工具时轴cancel返回24.461s。父/子进程时轴分别标注，不混减。

四个oracle子进程均有实际close/status0记录；它们最后退出早于撤权确认。因此本次**不证明cancel杀死了在途oracle**，也不把cancelled当进程停止。容器删除完成精确时间在原观察中缺失，后置inspect提供后来已不存在的界限。诊断器随后修复name→真实create ID的仅观测映射，定向反例RED→GREEN，后续完整项目保留清理完成事件；无权威缓存。

## 失败记录与局部修正

初始transport/stream/client/handoff RED为模块尚不存在的导入失败，没有运行行为断言；随后保留replay、脱敏filemap、error timing、named cleanup、BOM的实际行为断言失败及首次57项lint错误。审查发现启动绑定校验过晚和启动中信号仍可能ready：先保存实际磁盘/进程反例，再修薄入口，GREEN显示坏绑定不改变权威字节、SIGTERM后不再ready。复审无阻塞；已开始合法初始化的完成/释放不宣称原子回滚。

handoff模块后补UTF-8 BOM保持的2项反例。cart实际交接使用此前ASCII路径的格式化器版本；todo使用修复后版本。报告分别保留callerInputs，不把两版格式化器说成同源码实际运行；共享核心/编译工具4模块相同，已有cart字节由独立审查与patch核对复用。

独立审查见 `transport-review-fixed.md`、`handoff-review.md`。末次root format第一次exit1仅stdio-diagnostics测试排版；格式化该测试后补最终format及12项定向回归，不重跑真实长流程。未扩大核心权限/状态或业务deadline。

## 回归复用及限制

复用S7明确不重叠的host74文件864项、core41文件839项、viewer9文件85项、CoThink5文件38项以及旧真实快照只读/原Local120秒独立成功证据；复用依据按当前未变源码/编译闭包逐hash核对。新增stdio测试共12项，另列，不重复累计定向重跑。S7保护的旧样本/schema/0–5历史保持；没有为入口变更再次运行46分钟全host矩阵。

close确认writer释放与所有子进程/容器停止分开；进程重开不保证未知/失败操作exactly-once。没有远程服务、daemon、任意shell、跨操作passed缓存或自动接入原仓库。受管Git历史是验收后端正常行为；原开发仓库没有暂存/提交/推送/发布。

## 阶段9当前状态

阶段8不证明真实模型可用。阶段9将按原配置与历史总账独立预检；未确认配置/支出前不发真实或探测请求。旧阶段9零API报告保留在仓库外，当前更新见本节后续追加。

### 阶段9预检更新（2026-10-16）

**BLOCKED-PREFLIGHT，阶段9未完成，真实机制门禁未过。** 当前S7、7.5、S8前置均已满足，当前源码/编译运行闭包与S8接受记录一致，固定镜像只读身份复核通过；不再沿用旧“阶段8未实施/7.5未测”阻塞。原Local120秒独立门禁与真实工具任务在冻结限制下均通过，但没有真实模型deadline结论。

实际预检exit3，仅剩CONFIG_BINDING_UNCONFIRMED、HISTORY_UNRECONCILED、PAID_RUNNER_UNIMPLEMENTED。公开原A/B配置模板仍为空，未定位已确认provider/model/endpoint/参数/apiKeyEnv与私密环境路径绑定，未打开私密环境或发探测。历史消费/余额保持null，原预算核对记录与预算实现字节不变，未初始化live消费journal、不重新分配39次。零APIrunner没有HTTP/付费派发，不退回旧BuildDriver冒充独立工具。

当前13项离线预算/恢复反例exit0，保持真实fsync预占、崩溃/取消/unknown不退款、重启零派发、上下文冲突、并发最后槽、损坏日志与原分场/每任务较低限制。旧错误变体和原失败保留；合成journal/callback不是模型在途取消，重复测试不累计成额外覆盖。主场和取消场均not-run，无真实A/B1重叠或模型最终组合通过；真实逐请求usage/跨度缺失，不填造0或价格。当前实际请求0、探测0、密钥载入0；人工工时未单测。完整当前结果/预算/绑定审计见work/agent-sync-real/RESULT.md和resume-20261016/，旧前置报告保留在previous-preflight/。按连续授权自主预检并在明确缺口停止，不追加至成功、不提问、不进入10。

### 阶段9指定模型续接（2026-10-16）

用户已明确指定A：智谱BigModel/openai-compatible/glm-5.3；B：Moonshot/openai-compatible/kimi-k3，使用指定endpoint及两个密钥变量。仓库外model-binding.json已冻结，外部预检确认私密文件0600/owner/普通文件和两变量非空，不输出值、不读入工具环境。未指定的temperature/top_p/thinking不自造覆盖；max_tokens4096、stream及120/900/2700限制保持。此处不宣称供应商实连或模型可用性已验证。

已补窄外部HTTP/SSE请求器、原持久预算桥、固定三任务及取消/恢复runner，复用S8ToolHost/taskContext/原工具动作与后端；核心/公共协议/schema/旧样本和检查未变。先fsync占用再读key/发请求，未知/取消不退还、同ID不重派，未知历史不能初始化。A/B1准备完毕后并发首轮，B2等待零模型调用、授锁后最新输入；模型文本唯一经工具编辑/检查/接纳。截止不因预算锁等待延后，故障/记录失败及时暂停同场peer后续收费；取消的本地请求停止、撤权确认与远端未知分别记录。报告绑定输入hash、实际当前组合与单独的模型流/记账时长。

新增22项离线测试exit0，原13项预算回归exit0，分列且不累计重复；控制替身不是真实模型取消。审查发现故障暂停遗漏和DONE等待EOF，两项已修并复审关闭；其他截止、晚回复、准备严格schema、取消ACK、报告关联/时间反例及初始挂起替身清理均保留。最终源码/测试身份以work/agent-sync-real/runner-offline-ready.json为准，复审快照与后续格式/报告修正分别记录。

当前预检exit3，**只剩HISTORY_UNRECONCILED**；不再列配置缺失或runner未接通。实际入口带fetch计数拒绝于预检：fetch0、无受管main项目/工具启动、未初始化live账本。原budget-ledger.json和预算实现字节未变，历史消费/余额仍null；本轮0请求不能证明过去0。真实主/取消场均not-run，阶段9未完成、真实机制门禁未过。没有替换模型、探测、扩额、提交发布或进入10。完整当前报告为work/agent-sync-real/RESULT.md和configured-20261016-103301/；不把离线就绪称为真实通过，不追加问题。

### 阶段9真实场次收尾（2026-10-16）

用户直接确认此前真实调用/历史消费均0，已将原话及原预算上限绑定到同一live-budget.jsonl的init proof hash，原unknown报告保留。原预算不增加、不重置：实际主场4次+取消1次，共5次/20480分配输出；余额主32/取消2，共34次/139264。取消预占不退还，所有API响应/任务失败保留，未继续调用到成功。

**真实执行已收尾，阶段9机制门禁未通过，阶段9未验收完成，不进入10。** A glm-5.3首轮HTTP200但finish_reason=length，input2284/output4096/reasoning4093/cached0，content为空，动作解析失败。B kimi-k3三轮edit/check/finish使B1唯一正式接纳；真实common/report检查通过，文本与模型编辑完全一致，只改src/report.ts，normalizer仍为V0。A无编辑，B2等待0模型轮询；授锁后最新normalizer读取和三任务/完整最终16案例组合未覆盖，未将未执行写成“已经跑最终检查失败”。没有人工补写答案或提前实施另一任务的实际编辑。

A/B1的客户端请求区间真实重叠14.545s，双方已收到服务端headers后的共同在途11.800s，响应流11.799s。原120s/900s/2700s不变，无额外sleep或场次。独立取消副本在首个实际模型片段后2ms停止本地读取，2.956s收到工具撤权；晚控制inspect拒绝attempt_invalidated，0检查/0接纳，正式头保持V0。远端模型终止/usage未知；不把cancelled当远端结束。主/取消两场关闭重开与首次recover0，新模型计数及预算字节不变。

显式runner墙钟430.463s；主场观测297.840s、取消52.244s均含输入/工具/状态核验。模型/协议/Git/Docker/oracle/检查/接纳跨度及不可相加口径见work/agent-sync-real/live-20261016-112600/measurement.json。三笔Kimi和一笔GLM取消usage缺失保持未知，只有A首轮usage完整，不编全场total或金额；人工工时未单独测量。Docker启动2.037s属收费前环境准备，原固定镜像核对未换。

只读FileAgentSyncStore审计真实磁盘/Git关联通过，writer锁已释放；3个本轮容器实际清理并只读确认不存在。部分B1成果patch/导出独立标记不完整，显式导出无新模型/检查、ledger字节不变；原仓库没有应用/提交/发布。当前源码/编译闭包和所有runner冻结输入未变；旧离线/兼容证据复用不重跑。完整结果、总账/人类历史依据、逐调用输入输出和当前失败证据见work/agent-sync-real/RESULT.md及live-20261016-112600/。按冻结规则保留有效失败后停止，不补跑或进入10。

### 阶段9同一账本显式续接（2026-10-16）

用户再次明确授权主场/取消场；原历史0初始化不重做，上一轮5次消费完整保留。外部runner仅改为残余额度准入（main最多32/task11、9、12/cancel1），原累计36+3/39及159744、模型/endpoint/参数/deadline/工具核心不变。先红后绿，26项离线控制与12项预算回归exit0，当前0API预检通过420源码/483编译hash，独立审查无阻断。原“历史未知”上下文测试不再冒充当前适用，旧证据保留。

本轮再次实际5次（main4/cancel1），累计10次/40960分配输出；余额main28/cancel1，共29次/118784。原live-budget.jsonl旧4078字节前缀保持，全部消费结算且取消不退款；没有重置/扩额。原轮和本轮分列，不叠加为额外门禁覆盖。

**本轮执行已收尾，阶段9未验收完成、机制门禁未通过，停止，不进入10。** A HTTP200/length，4096输出含4092推理、content空，动作拒绝；B1真实edit/check/finish并正式接纳，唯一修改report且与模型文本相同，normalizer仍V0。B2真实waiting0模型，授锁后最新输入和三任务最终组合未覆盖。双方headers后共同在途12.369s，未额外sleep。独立取消首实际片段后3ms本地读取停止、2.961s撤权确认，晚控制inspect拒绝，0检查/0接纳/头保持V0；远端终止/usage仍未知。两场重开首次recover0，预算字节保持。

本轮runner exit1/393.418s，主场264.299s、取消51.539s；check41.383s、finish62.621s；分层时间见continuation-20261016-122057/measurement.json。Kimi3笔和取消1笔usage缺失null，不编总token/价格；人工工时未单测。不把墙钟变化当提速/策略收益。真实store只读核验、writer锁释放、3容器移除及不存在确认、部分成果导出/模型文本一致性均保留。当前报告work/agent-sync-real/RESULT.md，本轮原始输入/输出/总账/命令/证据在continuation-20261016-122057/，原live-20261016-112600/失败不覆盖。无源Git暂存/提交/推送/发布，无重置卡兑换，不再收费、不进10。

### 阶段9 A截断修正及新阻塞（2026-10-16）

用户授权先修A空正文再用剩余预算续接。依据两次length/4096几乎全为reasoning及官方GLM5.3默认max/支持low文档，只给A显式reasoning_effort=low，模型/endpoint/4096/任务/原检查及120/900/2700期限不变；B默认。旧binding/失败冻结保留，变体stage9-A-low-effort-v1分列。29项Node离线控制、12项预算回归exit0，独立审查通过；0API预检仍匹配420源码/483编译，首个真实任务请求兼作参数验证，无付费探针。

A本轮HTTP200/stop，输出516含48推理、正文1645字符，空正文/截断本轮未再现。但正文带Markdown围栏，被原严格JSON解码拒绝，A零编辑；内部还可见existing-file expectedContentHash=null，未走到实际hash检查。宿主未剥围栏/补hash/代写/放宽协议/追加格式重试。B1真实edit/check/finish接纳、只改report且与模型文本相同；B2waiting0调用，授锁后最新输入和三任务最终组合未覆盖。**阶段9仍未完成，遇到新模型协议阻塞后停止，不进入10。**

本轮新增5次（main4/cancel1），原10次保留，同一journal累计15次/61440分配输出，余额main24/cancel0，共24次/98304；无重置/扩额/退款，取消预算用尽。真实重叠、独立取消/撤权/晚控制动作拒绝及两场首次恢复0调用见fix-a-20261016-123700/measurement.json；远端终止/缺失usage仍未知，无价格或策略优势结论。实际Git/Docker/store审计、容器清理、B1部分成果导出和脱敏证据同目录；原失败未覆盖。当前报告work/agent-sync-real/RESULT.md。核心/后端/协议/schema/样本/检查/包未改，源仓库仅更新脱敏报告，无Git暂存/提交/推送/发布，无重置卡兑换。

### 阶段9 A裸JSON/当前hash与主场单独续接（2026-10-16）

用户授权保留15次消费、仅用剩余24次main并复用有效cancel。只改A/main提示与工具当前hash模板，去掉误导性的通用null示例并明确裸JSON；编辑后用新工具读值更新。B/main及A/cancel消息与原快照完全一致，严格decoder/hash/lease/owner/真实检查/接纳/恢复核心均未改。34离线Node+12预算回归exit0，独立审查通过，420源码/483编译闭包未变；主场单独准入24/task9、3、12/cancel0，旧取消证据hash链/记账/权威关闭状态有效，不重发。

本轮A没有围栏、hash与当前工具输入一致，但完整JSON后多出引号及右花括号，严格解码Extra data拒绝；未执行A编辑或旧hash门禁，没有裁尾/补hash/代写/免费重试。B1独立edit/check/finish接纳，B2waiting0模型，最新输入及三任务最终组合未覆盖。**阶段9未通过，已在新JSON尾部阻塞处停止，不进入10。** 新A/B1共同headers在途3.975s，主场首次恢复0；取消明确复用fix-a-20261016-123700/的真实证据，本轮新cancel请求/墙钟均0，远端终止仍未知，不把旧passed当新运行。

新增4次main/16384分配输出，原15次前缀保留；累计19次/77824，余额main20/cancel0，共20次/81920。B1累计12次上限已用尽（A剩8/B1剩0/B2剩12），不再从V0完整重跑，不重置/扩额/退款。真实runner exit1/319.446s，main263.420s；本轮3笔Kimi usage未知null，无金额/策略优势声明。当前报告work/agent-sync-real/RESULT.md，原始命令/usage/协议诊断/分层测量/证据与部分B1交接在fix-a-json-20261016-125356/；原三个失败轮次全部保留。无原仓库Git暂存/提交/推送/发布，无重置卡兑换。

### 阶段9 JSON mode及保留B1的同目录续接（2026-10-16）

只为A/main外部fetch wrapper加官方response_format=json_object，原Response、ModelRequester/模型绑定/scene/core字节不改。37离线Node+12预算回归exit0，旧trial哈希绑定P2已修/复审关闭。原B1版本及回执保留，未从V0重做；沿原绝对deadline1792129397772，通过public requestScope显式新lease，不修改旧attempt截止/权威快照。首次与最终recover均0模型/0重放/账本字节保持。B2旧waiting先grant-release且无读/施工/model，再真实等待A，零B2模型；取消和同一旧run overlap明确复用，本轮新B1/cancel请求0。

A 8/8真实回复HTTP200/stop且严格JSON合法、hash校验通过，尾部问题本轮消除。但8次edit文本完全相同，无check/finish；剩余8次耗尽后task_call_cap。提示无条件“使用edit模板”可能有调用方偏置，未做因果对照，不宣称模型固有能力失败。**阶段9仍未通过，当前因A累计额度耗尽与未进入检查/接纳停止，不进10。** A只有未检查/未接纳私有候选；B2最新输入及最终组合未覆盖，新publication0，不补finish或伪造passed。

原19次前缀完整保留，本轮8次/32768，累计27次/110592；剩余12次/49152仅B2，A12/12、B1=12/12、B2=0/12，cancel3/3。无重置/退款/扩额/任务额度转移。真实runner exit1/730.279s，内部区间726.586s；模型/工具/Git等分层和逐请求usage见resume-a-jsonmode-20261016-131439/measurement.json，人工工时/价格未知。原B1正式export与模型文本一致，另保留unaccepted-proposal/normalize.ts，不是完成成果。FileStore只读审计、原B1receipt/原deadline不变、writer锁释放及脱敏证据同目录。当前报告work/agent-sync-real/RESULT.md，原失败均保留。无源Git暂存/提交/推送/发布，无重置卡兑换，不进入10。

### 阶段9零API控制诊断与caller-v2离线修复（2026-10-16）

本轮真实模型/供应商探测0、私密key读取0，账本仍27次/110592，余额12/49152仅B2；原run/回执/版本/期限/旧lease和原候选不变。候选1281字节与8次真实A回复逐字节关联，在明确标记的独立诊断副本使用原A status-cases（common/state-format）及原固定镜像/检查配置，通过真实磁盘/Git/Docker检查，pub0。不是原场次成功，也没有正式接纳。

只改仓库外scene.mjs为stage9-caller-control-v2：模板仅在确需不同内容时适用，编辑/检查后明确私有/待检查/待接纳状态；精确无进展检测经公共read核对当前lease/hash/文本，在重复写入和下笔请求前停止。无自动check/finish、JSON裁剪/hash修补或core/schema/存储/验证发布算法变更。原8动作离线重放从8请求/8写入降为2请求/1写入并no_progress_edit；这是控制行为证据，不是新真实模型收益。

11项新反例、27项相关回归及5项真实public-port负向拒绝通过；预算fixture复制已消费27次journal，synthetic占用保留，canonical字节保持，不新建满额账本。首次诊断job额外字段被严格拒绝的失败保留，修正后检查通过，未放宽工具入口。原27笔费用记录/所有旧失败不覆盖；不重跑S7/S8长门禁，原420源码/483编译后端依据复用并核对。完整诊断见work/agent-sync-real/zero-api-control-fix/RESULT.md。

**诊断与离线控制修复通过，阶段9真实验收仍未通过。** 旧真实入口pins未重写，未启动新真实调用或自动接纳候选；未提交/推送/发布/兑换额度卡，不进入10。

## 2026-10-16：唯一新主场补验，阶段9未通过

授权 `S9-ONE-RETEST-20261016-AB10` 使用一次后failed关闭。先完成零APIcaller-v2修复和旧A候选真实检查；新增预算兼容/bridge/launch与控制回归39项通过。旧27账本前缀不变，新增A2+B1 2/B2 0共4次，累计31次/126976分配输出；18次账面余量不授权重开。

同一独立工具/原V0/原oracle/固定镜像，A low+JSONmode、B默认，4096/120秒/任务900秒/场2700秒保持。真实A/B1响应在途重叠3.958秒，B2等待模型0。首轮两个edit成功；第二轮A省略actionVersion/requestId，B1输出JSON代码围栏，严格拒绝、无裁剪/填补。check0/pub0，最新B2输入及最终五组16案例未验；不得标为通过。

原真实取消/撤权/晚动作拒绝/恢复按未变实际依赖复用；新增main预算事件的兼容通过旧cancel行对照，取消预算仍0。新场关闭重开两次恢复零自动动作；工具903闭包未改。正式版本/基线相同，handoff导出V0和空patch，拒绝直接覆盖；私有候选另存，不算成果接纳。

脱敏逐请求usage/协议/工具/Git/等待/接纳时间及身份见 `work/agent-sync-real/one-retest-20261016-ab10/measurement.json`、`retest-ready.json`、`checkpoint.json`；B usage/远端取消终止未知，不报价格或策略收益。所有旧失败保留，零新取消/探测，无提交发布安装，不进入10。

## 2026-10-16：model-action-v2仅离线就绪

新外部调用方协议把模型动作与host信封分开：模型只输出action，host按发送时原TaskContext和固定输入绑定版本/requestId/旧hash。旧严格v1/TaskContext/工具wire及核心903源码构建闭包未改。单json围栏只包装精确新版对象，旧v1信封及权限字段拒绝；实际raw/decoded/host action/wire记录分离，不把宿主字段写成模型原文。

新变体22项、旧调用方40项、原wire9项最终回归通过（明示不同集合，重复运行不累加）。真实service+现有MemoryProjectSync端口覆盖推进/旧hash/owner/取消/recover，属于离线核心/边界验证，非新真实隔离验收。SSE意外工具参数/截断/非法结束和同步异步记录失败都停止后续调用；真实31账本只在临时副本模拟占用，原账本/authority不变。旧A/B失败的原contextHash均重建匹配，旧回复未换上下文执行。详见work/agent-sync-real/model-action-v2/RESULT.md与evidence.json。

A/B新输出协议使用官方文档response_format/json_object，A low/B默认参数和资源上限不变；本轮真实模型/探测0，未读取真实密钥，不新增/认领授权。阶段9真实验收仍未完成；下一次最多6次/24576输出的小型接入仅建议，须另行明确授权，未执行；不进入10。

## 2026-10-16：model-action-v2阶段9真实验收通过

授权S9-MODEL-ACTION-V2-ONE-RUN-20261016-01唯一执行。原V0与oracle、固定镜像和原4096/120s/900s/2700s保持；A low+B默认，JSON object输出协议。真实A/B1请求重叠189ms，B2冲突等待模型0；A/B1检查/正式接纳后，B2授锁读取最新f66f032…及匹配A的normalizer，再由模型完成检查与接纳。最终common/state-format/report/identity/final五组16冻结案例真实通过，正式版本ea1831ef5ea7f29b7aa2b966c189587296c96783。

旧取消不能代表新v2输出/SSE/异步记录路径，因此执行且只执行新增1次v2取消：真实片段触发中止，本地请求结束8ms、工具撤权确认3007ms；晚旧lease动作attempt_invalidated，cancel check/pub0、头不变。远端执行终止与取消usage未知。cancel/main关闭重开后首次recover零模型/自动重放，预算不变。raw/decoded/host action/实际wire分离且九条主场关联核验；host不补代码/动作/passed，不替换发送时hash或旧lease。

本轮主场9+取消1共10次/40960分配输出；累计41次/167936，旧31前缀及旧v1失败保持。追加只B1+1/cancel+1，新claim completed关闭；10次账面余额不授权再开。A主场已知输入7301/输出365/缓存0/推理13，其余7笔usage未知，无金额或策略收益声明。原生执行1653.004s，额外零API交接263.689s单列；父子并发时间不相加。

核心420源码/483构建闭包未变、19051冻结文件前后匹配；25项受影响Node、40旧caller、6新预算、9旧预算、2launcher门禁通过，不重复整套S7/S8长检查。真实状态只读审计、源/目标hash、16例配置证据和正式导出见work/agent-sync-real/model-action-v2-one-run-20261016-01/acceptance.json、provenance.json、RESULT.md、measurement.json。handoff/changes.patch仅normalizer/report，directOverwrite=false，原仓库前进/本地修改必须重新核对与接纳；未自动覆盖/提交/推送/发布/安装。本变体阶段9通过后停止，不进入10。

## 2026-10-16：源码交付独立复现

工具交付已单独验收，不以CoThink接入或阶段10效果评价为门槛。当前形式是完整源码checkout，非独立npm安装器或已发布工具。入口见[QUICKSTART](QUICKSTART.md)。

从当前未提交/未跟踪源码一起复制的干净目录开始，排除Git元数据、node_modules、dist、私密配置/环境、日志和work证据；执行锁文件npm ci、全workspace构建及tools/agent-sync/build.mjs。483个运行相关新编译文件与原S9冻结构建逐字节一致；工具核心/原协议/存储/接纳语义未改，旧S7/S8/S9未变门禁按身份复用，没有重跑长矩阵。

新增Dockerfile.source和专属最小构建上下文，从公开Node digest直接安装锁定工具链，不需要旧本机donor。实际以--pull --no-cache构建exit0；公开base registry元数据获取成功，构建仍使用本机Docker daemon的不可变base层缓存，未宣称在空daemon/其他机器复现。新本地镜像ID `sha256:a8d7b03228c7ae13b9cb6ee4945d3af1156c4e12afc8bc7d2be5ce28f193ba6a`，Node22.23.3；它不是镜像发布，重建ID可以不同。Node/npm/Docker Hub registry和Docker环境需操作者准备。旧Dockerfile保持不变。

公开确定性示例 `examples/agent-sync/cart/run.mjs` 使用现有cart单成员fixture、新目录、新镜像与真实Git/Docker：申请范围、freeze/read/edit、私有check、显式finish、diff、4文件逐字节导出、close、无sourceRoot重开、首次recover、再次close全部exit0。脚本墙钟88.740秒，check/任务/run上限仍120/900/2700秒。独立check后正式头未动/publication0；显式finish后1次接纳并关联真实四组money/lines/invalid/joint检查。恢复replayedActions0且check/publication数和原截止不变；两次writer释放及3个工具容器不存在均实查通过，新镜像下无存留容器。单成员交付smoke不替代旧多成员/取消门禁，也不是协作收益样本。

宿主Node24.19.0/npm11.17.0、Apple silicon macOS、Docker Desktop4.95.0/Engine29.8.2、Linux arm64。中立运行静态闭包70输入，无模型/供应商SDK/讨论模块；实际job和模块解析均指向新快照或本次输出，不依赖原checkout/work。全程模型/供应商请求0，未加载私密环境。

本轮clean check/build/tool-build、正确选择的5文件12项stdio回归、现有smoke:pack兼容门禁exit0；新增示例定向ESLint与文档格式核对通过。没有运行会初始化讨论的smoke:cothink，复用其未变历史兼容依据，不声称本轮执行。

第一次新示例read返回invalid_input：调用方将文件名点号拼入requestId，工具正确拒绝，未check/接纳。已保留失败，新示例只在调用方生成合法ID；原schema不放宽，反例与修正ID核对通过，再用新目录完成上述全链。另一次测试文件选择不完整只执行2文件3项，原日志保留，不冒称5文件通过，也不与最终12项相加。清理检查中的No such object输出表示预期的容器不存在，以最终verified摘要/result.json为准。

本次交付清单、命令/退出码、源码/构建/输入身份及失败/成功原始复现证据保存在本地release-readiness交接目录；不属于工具运行依赖，也未随公开源码上传。公开命令、fixture、oracle、辅助程序、镜像配方和锁文件均在源码内。本轮无提交/推送/发布/正式安装，无阶段10或CoThink接入。
