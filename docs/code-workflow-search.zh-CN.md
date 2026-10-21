# HumanEval 与 MBPP 逐节点工作流搜索

[English](code-workflow-search.md)

## 当前分步搜索协议（v7）

当前覆盖HumanEval、MBPP与AutomationBench。下方原有v1/v2/v3内容保留为历史记录，其中“两新候选、优化器自由选分支、官方只测五题”不适用于v7。[Automation使用说明](automation-workflow-search.zh-CN.md)记录真实工具执行边界。

分步入口显式限定每题每重复跨恢复累计保存的失败工作流尝试最多5次。已失败4次只剩1次，已失败5次在runner/模型派发前拒绝。有效0仍复用；judge故障必须有保存的评分checkpoint，不自动重新生成。运行目录残留running状态，或Automation只有预算记录而没有题目尝试证据时，拒绝自动继续，先交审核；不承诺任意硬崩溃都可透明恢复。其他旧evaluator调用者保留每次调用的默认重试语义。协议v7绑定此范围，早先真实运行保留原源码/协议身份。

每套先评价代码预定义初始工作流，单列且不占最多10个新有效候选额度。程序从全部完整有效工作流按均分降序、评价序号稳定排序，取Top-4抽父。权重为`exp(0.2×100×(score−max(score)))`，概率为`0.3/n＋0.7×weight/sum(weights)`。seed42的xorshift32状态及抽样前后、概率、随机数、所选父流程均保存；每个新候选只抽父一次。

优化器只能继续给定的当前草稿，每步增/改/重连/删一个节点，或仅装配Graph/Loop。一个候选允许连续多步修改多个节点；可运行草稿不会自动评价。最终编辑设置`submit:true`，或单独`operation:'submit', submit:true`才提交。中间依赖或装配可未闭合，提交时必须通过完整类型/配置、依赖可用性、Graph/Loop、输出和语义去重。每批最多3份回复，连续3批被拒或24个接受编辑未提交即暂停，不冻结。

三套搜索入口代码默认每工作流全量Search独立重复 **5次**，初始和新候选相同；显式`--repeats 1`覆盖为1次。caseId包含重复索引，精确`N×R`成员全部完整有效后才排名/冻结。排名分数是各次全量Search均分的均值，标准差按重复级均分计算总体标准差。5次仍只算一个候选，不是HTTP重试。正常0分保留，工程无效留pending；恢复只复用原重复索引的有效结果，1↔5身份变化拒绝。中断后保留原父与PRNG，pending不重抽父/重提案。

本轮所有真实主实验显式采用1次。5次路径完成离线集成回归，尚未运行5次完整模型搜索。冒烟、两端诊断、官方冻结流程评价各自1次，不继承搜索默认5；Test调用和评分保持0。

本机Docker相关命令先运行`docker-ready`。项目门为`npm ci`、`npm run check`，Provider使用维护库存指定的Python环境。`CODE_SEARCH_SOURCE=ark-plan`读取`ARK_PLAN_KEY_LIU`，请求`deepseek-v4.1-flash`且锁返回`deepseek-v4-1-flash-261017`；`official`读取`DS_API_KEY`，请求/返回`deepseek-flash`。身份变化先停报，不自动换模型；密钥不入记录。

```powershell
npm run build
$env:CODE_SEARCH_SOURCE='ark-plan'
$env:CODE_SOUL_CONCURRENCY='3'
node dist/cli.js search --dataset humaneval --data-dir '<锁定代码数据目录>' --output-root '<新运行根>' --rounds 10 --repeats 1 --docker-image '<预载镜像digest>'
node dist/cli.js search --dataset humaneval --data-dir '<锁定代码数据目录>' --resume-dir '<同身份Search目录>' --rounds 10 --repeats 1 --docker-image '<同一digest>'
```

MBPP替换dataset，仍用锁定代码数据目录；HumanEval/MBPP固定33/86题。冒烟只取原序前5；官方入口使用冻结选中的同一计划评价**全量Search**，不再取前5，不重新搜索。最后的显式重复参数为1：

```powershell
node dist/code-search-cli.js smoke humaneval '<冒烟目录>' '<锁定代码数据>' '<镜像digest>' ark-plan '' 10 1
node dist/code-search-cli.js official humaneval '<官方目录>' '<锁定代码数据>' '<同镜像digest>' official '<已完成方舟Search目录>' 10 1
```

官方入口在已完成短路前验证Search正常候选预算/收敛/可复算时间预算停止、完整有效评价账、最高分同分最早、冻结计划原始字节、数据成员及顺序、源码/依赖与运行环境。Search到官方允许来源/模型和阶段重复数变化；计划和其他实际身份须相符。官方结果目录独立，不回灌优化器；三套全量复核共33＋86＋200＝319题。

收敛保留原函数逐前缀Top-3均分、z0、连续5次稳定转移，含不足3的前缀；完整历史少于4不收敛，6个同分完整评价可收敛。抽父Top-4与收敛Top-3分开；每个有效评价后检查，预算与收敛同时触发时主因converged。从全部有效流程选最高分，同分最早，不看Test/官方分数。

离线`staged-search`、`repeated-entry`、`code-search-selection`及传输/Automation测试验证多节点草稿、显式提交、种子恢复、重复成员/均分/标准差、故障和来源/字节/成员拒绝及实际入口。原代码任务Provider局部消息、checker采纳与Docker回归继续适用。

## 历史协议记录

代码数据集入口复用既有单节点构造搜索及显式Graph/Loop装配，其它数据集入口保持原有行为。依赖固定为`@codesoul-co/ditto@0.1.1`，不修改Core。

## 环境与数据

要求Node24+、npm11+、Python3.13及`python -m pip install -r requirements.txt`安装的依赖，还需可用Docker。维护中的Windows主机先运行`docker-ready`，再把`DITTO_PROVIDER_PYTHON`指向选定Python。执行`npm ci`和`npm run check`；设置`DITTO_DOCKER_TEST=1`及已加载的`CODE_JUDGE_IMAGE`可包含真实容器测试。内存紧张时设置进程级`GOMAXPROCS=2`，测试脚本最多并发两个测试进程。

数据使用原始锁定文件：HumanEval Search33/Test131，MBPP Search86/Test341。正式加载核验完整原文件SHA-256、数量、成员和顺序；Search只读取validate。工程小测先验完整文件再取原序前5题。Test需要独立授权，本次验证不调用Test模型。

镜像须事先审查并加载，验证镜像为`sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4`（`python:3.12-alpine`）。评分途中不自动下载。容器无主机挂载、无网络，根目录只读，使用uid65534、受限内存/CPU/PID及独立tmpfs；候选内执行期限10秒，Docker外层监督60秒。随机起止标记用于区分执行故障，并阻止已复现的固定成功字符串加提前退出伪通过。

## 来源与命令

交付默认使用DeepSeek官方端点和模型，从`DS_API_KEY`取密钥。显式选择`CODE_SEARCH_SOURCE=ark-plan`时，使用独立的`ARK_PLAN_KEY_LIU`、固定Plan端点及`deepseek-v4.1-flash`。两种来源身份和成绩分别记录。密钥只留在进程环境，不提交`.env`。

```powershell
npm run build
$env:DITTO_PROVIDER_PYTHON='<选定Python>'
$env:CODE_SOUL_CONCURRENCY='3'
$env:CODE_SEARCH_SOURCE='official'
node dist/cli.js search --dataset humaneval --data-dir '<锁定数据目录>' --output-root '<运行目录>' --rounds 2 --repeats 1 --docker-image '<已加载镜像digest>'
```

`--rounds`只计初始流程之后完成有效评价的新工作流，增加数量须在已授权实验范围内。固定五题工程入口如下：

```powershell
node dist/code-search-cli.js smoke mbpp '<冒烟目录>' '<锁定数据>' '<镜像digest>' official
node dist/code-search-cli.js official mbpp '<官方目录>' '<锁定数据>' '<镜像digest>' official '<已完成方舟搜索目录>'
```

官方验证只运行Search已选定的冻结计划，不重新搜索，也不根据官方成绩换候选。重用目录可恢复身份匹配的未完成案例和pending构造，已完成评价不能冒充独立重复。源码、数据、模型、规则或提示身份变化时，另建目录并说明哪些旧证据仍适用。独立工程入口可在已选Search目录参数后追加新候选预算，默认2。

## 搜索与执行边界

优化器选择真实存在的历史构造，再新增、替换、重连或删除一个节点，或单独调整装配。允许CONTEXT.LOAD、SAMPLE、TRAJECTORY、REFLECT、DELIBERATE；已有提示、criteria、模式、策略参数和显式连接可搜索，生成参数、Provider、工具、judge和私有测试固定。代码任务不开放CONTEXT.UPDATE或外部工具。

未装配的中间构造落盘但没有分数。完整装配须核验全部节点/Graph、target、依赖、路由和终止输出。仅改名会去重，有效配置和路由进入身份。构造父边不成为执行依赖，节点只接收显式本次依赖和可缺省的前次已提交feedback。

verify/critique只检查；revise沿用明确错误证据门控，并匹配真实target与反馈。缺失实质字段时，评价仍属工程无效，程序不补造结论或代码。需要时可在节点criteria显式补格式提醒，作为新身份候选记录。正常错题、语法失败和候选自身超时计0；服务、格式及评分基础设施故障不进入优化器经验。

## 证据与恢复

每次运行保留manifest、resume-state、完整Provider请求/响应/尝试、构造事件、逐评价计划/结果/尝试和冻结best计划。结果保留实际提取Python、私有评分证据、checker目标与采纳审计、真实Graph路径及每次Graph输出快照。优化器只收到有效得分、工作流定义和公开预测的过滤投影。

模型、内部策略和格式修复调用共用并发门。默认最多3次传输尝试、5次分类工作流尝试，请求期限600秒，工作流外层监督30分钟；监督未解决时评价无效。提案失败批次和连续中间构造另有有限停滞保护。持续故障时停止并检查状态，不轮换账号，不为改对正常错题重复请求。

身份覆盖提示、完整ID顺序、原始数据SHA、包/代码、模型来源、judge镜像和评价计划。无法取得的HTTP用量记为未知，不能记零。完整本地证据与可转交材料分开。本地检查通过不代表托管CI通过，也不代表独立Test表现。

## v2：节点输入与官方恢复身份

协议为`humaneval-mbpp-node-search-v2`，搜索策略为`code-node-configuration-v2`，生成参数和候选计数规则不变。SAMPLE消息只由解析后的配置和显式绑定输出决定。CONTEXT.LOAD中与根消息重复的公开题面不再重复拼接，其他上下文及前置答案仍保留；整图身份、节点改名和等价默认值不再切换消息格式。证据按依赖位置标记，避免把节点ID变化带入消息。其他数据集的旧执行路径保持。

TRAJECTORY将配置中的正安全整数maxSteps实际传给Runtime，上限仍为原有Number.MAX_SAFE_INTEGER。到达max_steps后带正常部分结果返回，属于预算结束，不按服务故障剔除。token、并发、期限及评分规则不变。

官方入口在任何完成返回前读取并验证匹配的已完成v2方舟Search、选中评价和冻结best计划。官方身份包含选中Search身份哈希及原始best/plan.json字节SHA。更换选择、改变文件字节、缺失或非法选择、旧未绑定官方目录均拒绝。v1历史材料保留，不以v2身份恢复。相同选择的离线恢复测试只证明校验门，不代表新增官方API实验。

## v3：明确代码revise的必填Message

当前身份为humaneval-mbpp-node-search-v3及code-node-configuration-v3。仅组织化代码任务的revise请求增加既定要求的明确表达：无须修改也必须返回含完整代码的revisedResult assistant Message。verify/critique请求、schema及采纳规则保持；仍缺字段的回复仍属无效，程序不补造修订代码。旧v1/v2目录保留原身份，不作为新身份恢复。

## 完整候选边界的时间停止

程序接口`CodeSearchOptions.timeBudget`接收固定截止时间、保护窗、候选耗时下界、安全系数和预留。仅在完整有效评价后、无草稿或pending时正常停止，保存的停止证据由官方selection独立复算；服务故障和部分数据集不能改成时间正常结束。

## 显式提交已有草稿

v8协议仅在当前尚未提交的草稿已有接受编辑时，将节点binding完全相同且`submit:true`的replace规范化为既有独立submit操作。先验证原提案；附带assembly、实际binding变化、跨分支、无草稿和普通no-op均不规范化。原动作和规范动作均留审计，评价前仍执行完整计划校验与已评价拓扑去重；旧停滞运行保留原身份。
