# HumanEval 与 MBPP 逐节点工作流搜索

[English](code-workflow-search.md)

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
