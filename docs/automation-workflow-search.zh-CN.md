# AutomationBench完整工作流搜索

[English](automation-workflow-search.md) · [共用分步搜索协议](code-workflow-search.zh-CN.md)

本入口使用固定官方AutomationBench世界、`api_search`/`api_fetch`/`base64_encode`三工具，以及严格终态断言。实验依赖公开Ditto0.1.1，MFlow固定对照副本依赖0.1.2；依赖和组织差异须随对照披露，不修改Core或官方工具实现。

预定义初始流程包含实际节点：CONTEXT.LOAD→actor SAMPLE→ACT.TOOL→OBSERVE→CONTEXT.UPDATE→actor，正常final后OUTPUT。Graph转移在下一次actor前排空全部pending动作。每个ACT只执行一个未消费调用；OBSERVE保留callId。两个顺序ACT须分别提交Graph结果，后续actor轮次可以复用ID。不完整的assistant/tool消息组在下一模型请求前拒绝；推理文本不构成工具效果证据。

共用抽父、草稿与显式提交机制可搜索现有Contract内的节点配置、增删与绑定、Graph成员、反馈、next/switch/repeat、停止和交付来源。实际搜索得到的Graph/Loop直接驱动工具，不在规划流程后附固定隐形ReAct。生成参数、Provider、公开schema、工具实现、世界目标及评分固定；代码任务仍不启用工具。

设置`DITTO_AUTOMATION_ROOT`到干净官方固定版本`4a8e1061254004d9dac807054eed33fad7d1ff14`，`DITTO_AUTOMATION_PYTHON`到独立官方环境，`DITTO_PROVIDER_PYTHON`到Provider SDK环境。入口核查版本、uv.lock SHA、实际模块位置及包版本；API索引派生缓存位于源码外。Search200题保持原字节与原顺序，不接受正式抽样limit。

```powershell
npm ci
npm run check
$env:CODE_SEARCH_SOURCE='ark-plan'
$env:CODE_SOUL_CONCURRENCY='3'
node dist/cli.js search --dataset automationbench --data-dir '<锁定Automation数据>' --output-root '<新运行根>' --rounds 10 --repeats 1
node dist/cli.js search --dataset automationbench --data-dir '<锁定Automation数据>' --resume-dir '<同身份Search目录>' --rounds 10 --repeats 1
node dist/code-search-cli.js smoke automationbench '<冒烟目录>' '<锁定Automation数据>' unused ark-plan '' 10 1
node dist/code-search-cli.js official automationbench '<官方目录>' '<锁定Automation数据>' unused official '<已完成方舟Search目录>' 10 1
```

共用工程入口为兼容保留位置镜像参数，Automation填`unused`，因为评分对象为官方模拟世界，非Docker内生成Python。代码任务仍需预载digest与Docker门。命令示例不替代实际任务阶段的模型批次放行。

搜索默认每工作流独立重复5次；本轮所有主搜索/恢复命令显式1次，冒烟、两端诊断及官方各自仍1次。5次路径完成离线集成覆盖，尚未执行5次完整真实模型搜索。每题、每重复、每工作流重试均fresh world；有效0分同样按原重复索引恢复。评分器故障后可只重评私有快照，不重做已成功工具效果。

仅官方严格成功0/1进入排名，partialCredit只诊断。正常参数错误反馈给actor作为任务观察，正常提前final/预算退出按实际世界评分；桥接、必填schema、评分器与监督故障使评价无效。文本“完成”不能代替评分。`finalWorld`、`taskContract`、`assertions`、toolTrace、逐节点输出和Graph转移留在私有证据侧，优化器只接许可的公开计划、分数和预测。

离线检查覆盖固定动作通过MFlow原生ReAct及修前/集成Ditto Graph/Loop、写后读、多动作、错误参数修正、不同题隔离、fresh retry、快照/合同拒绝和进程中断。仅比较时归一化世界构造/写入生成的易变时间戳，原始快照保留。假Provider证明工程执行行为，不证明模型能力，也不解释转述40%/90%成绩。固定10题两端真实模型诊断及全量搜索仍须分别通过阶段审核。

## 统一执行预算

Search及官方入口在题目开始及每次actor准入前先保存绑定身份的小型原子预算记录，写入失败则不派发。即使进程在大体积题目结果落盘前硬退出，原开始时间与计数仍保存；若缺少工作流尝试证据，分步恢复拒绝新开runner，先交审核，不承诺任意硬崩溃透明续跑。已过期的中断题仍为工程故障，不新开世界将崩溃改成正常0。缺少这些记录的旧运行不能声称精确恢复硬崩溃时的预算。

每题每个独立重复共享最多60次actor调用或600000毫秒，跨全部节点及工作流重试，恢复保留开始时间和计数。整组Graph actor须能放入剩余额度，不能越上限，阻断组大小另记。已发工具组可沿声明的非推理Graph排空，不添加隐藏工具循环；相同pending集合的无进展排空循环不能绕时间门。预算输出明确来自监督层，不伪造模型final或声称工具效果；仍保存实际世界并严格评分，正常0有效。在途取消保留未知用量账；服务、桥接及评分故障即使发生在预算边界也无效。Search和官方身份绑定相同政策。

仅已验证的只读Salesforce查询解析深度错误可转为MALFORMED_QUERY工具观察；桥通过官方解析栈的代码对象确认边界，通用递归、写入和桥故障不吞。官方源码与断言不改。
