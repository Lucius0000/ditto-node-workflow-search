# DROP v3：答案边界、证据标签与多 Worker 小批量验证

## 结论与证据范围

真实模型小批量已完成。确认面板 F1 从 **75.00% 提升到 91.67%**，增加 16.67 个百分点；发现面板从 **58.21% 提升到 83.11%**。胜出图只包含一个 SAMPLE，实际执行了 Context、Memory 和 Infer；没有继续扩充 SAMPLE 链。

**这不等于四类 Worker 都验证成功，也不等于整个提案过程没有工程错误。** 四个方向各获得一轮独立设计机会，但其他三个方向耗尽提案机会，未产生完整有效候选。12 次模型提案只有 1 次最终完成评测，另有 8 次声明校验失败、3 次动态接口预检查失败。它们均不计有效候选，不把未测题记为零分，也不参与选优。

所有 **103 个完整答题执行记录**独立重算和离线重放均一致，未发现完成记录中的答案接收、转化或评分适配错误。三次失败预检查另行保留，不能合并成“工程失败为零”。

本轮复用已知诊断面板，不是新盲测，也不是正式 Test；多个 user 指令、证据呈现、图结构同时改变，没有消融实验，不能把提升单独归因于 Memory。

## 修改内容

1. user 答案协议升级为 `ditto-drop-answer-v3`。数值包含直接查找、比较/排序和计算；不能再以“是否算术”划分数值与原文片段。`How many <unit>` 返回数值；请求原文测量短语时取最短充分的带单位片段，不附加事件名。实体及集合保持独立。
2. 推理 evidence 标明真实生产节点、Graph、操作、原生路径/视图和声明用途。标签不证明内容正确；原生输出、绑定值和最终答案不做数值归一化或重写。
3. 默认轮换 Interaction、Context/Retrieval、原生推理、Memory/Cache 四个方向。基线和四方向各保留独立调用/token 配额；某方向耗尽不吞掉其他方向机会。同轮工程修复不改变方向。
4. 搜索候选最多一个 SAMPLE；允许编辑已有 SAMPLE，允许声明自定义 Graph/Loop，允许必要前后置新节点。必须连接并执行本方向原生操作，声明空壳节点不算覆盖。
5. 系统提示词保持冻结，LLM 仍只写 Graph/Loop 声明及允许的纯工具函数，SDK/NodeResult/执行入口由执行器负责。主评分器、主数据划分和父候选选择概率未改。

## 实验协议与开销

- 模型：实验清单记录 `deepseek-flash`，不据此推断服务端具体模型修订版本。
- seed：`20261029`；主协议 Search 池 200 题，本次发现面板 24 题各一次，独立确认面板 12 题各两次。
- 最多四个设计轮次，每方向最多三次提案，即初始提案加两次修复；有效候选上限五个，实际只有基线和 0013 共两个。
- 搜索每桶最多 100 次模型调用、140,000 tokens；独立工具修复与回归不进入选优。
- 真实付费阶段使用代码提交 `79c61aed25cea4803d22991fcfb0e1913401863b`。批次完成后补充的输入守卫及接口说明采用离线重放和原生 Worker 测试验证，没有再跑一轮付费搜索，也没有把旧结果冒充新提示词的在线成绩。

| 阶段 | 实际调用 | 已知 tokens |
|---|---:|---:|
| 工具 schema 修复检查 | 2 | 5,554 |
| 搜索（含基线、优化器、修复与候选答题） | 60 | 276,812 |
| 冻结后确认 | 48 | 54,939 |
| 旧图定向回归 | 28 | 33,320 |
| 合计 | **138** | **370,625** |

HTTP 失败、未知用量和遗留在途调用均为零。

## 每轮组合与提案变化

所有提案都以有效基线 0001 为父候选；前面失败的图不会自动成为下一轮父候选。以下编号省略 `unified-`。

| 设计方向 | 尝试 | LLM 声明的组合/变化 | 处理结果 |
|---|---|---|---|
| 基线 | 0001 | LOAD → SAMPLE，直接解题 | 24 题 F1 58.21% |
| Interaction | 0002 | LOAD → SAMPLE(JSON 提取/表达式) → ACT.TOOL(compute) → OBSERVE(finalize)，尝试确定性算术 | Graph 层错误新增 `dependencies` 字段；Graph 只允许 id/nodes，依赖应在 Node 上 |
| Interaction 修复 | 0003 | 保留同一工具链 | 仍有相同 Graph 字段错误 |
| Interaction 修复 | 0004 | 保留同一工具链 | 再次重复相同错误；本方向结束，未答题评分 |
| Context/Retrieval | 0005 | LOAD → SELECT → 原有 SAMPLE；将选出的证据传给 solver | 把主新增节点 select 同时写进辅助新增清单，声明无效 |
| Context/Retrieval 修复 | 0006 | 移除错误辅助声明，保留 SELECT | `config.context` 绑定为 LOAD.items 数组；原生 SELECT 要完整 `{items:[...]}` 对象。第一题预检查失败，模型答题调用为零 |
| Context/Retrieval 修复 | 0007 | 仍为 SELECT 图 | 又把主新增 select 放回辅助清单；本方向结束 |
| 原生推理 | 0008 | 尝试 SAMPLE 后接原生 DELIBERATE 校验/选择 | 返回的 JSON 语法不完整，未形成可解析定义 |
| 原生推理修复 | 0009 | LOAD → SAMPLE → DELIBERATE | 只提供一个 candidate，DELIBERATE 至少需要两个 |
| 原生推理修复 | 0010 | 增加 candidate，保留 DELIBERATE | 旧输出写法使用 `view:"result.content"`，应为 `view:"answer"` 或声明 output.answer 原生路径；本方向结束 |
| Memory/Cache | 0011 | LOAD → WRITE → GET → 原有 SAMPLE，增加任务内写入和回读 | GET.ids 收到 Memory records 数组，而非 ID 字符串数组；预检查失败 |
| Memory/Cache 修复 | 0012 | 保留 WRITE/GET，尝试改为读取 WRITE.id | WRITE 输出是数组，没有顶层 id；预检查失败 |
| Memory/Cache 修复 | 0013 | 将 GET 换成 SEARCH，按完整公开任务查询；SEARCH 输出作为 SAMPLE evidence，同时改进原有 SAMPLE 的 user 指令 | 完整有效，24 题 F1 **83.11%** |

胜出图实际执行：

```text
CONTEXT.LOAD(context)
  ├─ MEMORY.WRITE(remember：存公开 passage/items)
  │    └─ MEMORY.SEARCH(recall：query=公开任务，limit=5)
  │          └─ INFER.REASONING.SAMPLE(solve：消费带来源标签的回读结果)
  └───────────────────────────────────────┘
```

Loop 为一个 Graph 执行一次后结束，没有新增第二个 SAMPLE。新增主节点 remember，必要辅助节点 recall。Memory 每题次独立初始化，无跨题记忆或答案泄漏。本图写入一条完整公开材料后搜索回读，不足以证明多文档检索、长期记忆或复杂 Loop 的收益。

LLM 同时将 solve 的 user 指令改为：先区分数值、实体集合、带单位片段；数值只给数值；实体集合完整保留；带单位片段取最短充分表达；不返回中间证据或推导串。

## 冻结后确认

| 图 | 完整题次 | F1 | 全对题次 | tokens |
|---|---:|---:|---:|---:|
| 基线 | 12×2 | 75.00% | 18/24 | 21,807 |
| 0013 | 12×2 | **91.67%** | **22/24** | 33,132 |

胜出图 tokens 约为基线 **1.52 倍**。与上一轮四 SAMPLE 胜出图的费用变化不构成严格同条件消融对比。

## 胜出图的全部失分题次与归因

| 阶段/题次 | 问题 | 输出 / 参考 | F1 | 原因 |
|---|---|---|---:|---|
| 发现 drop:4035#1 | What was unable to resupply Vaudreuil and Montcalm? | the British blockade of the French coastline / French shipping（另有等价参考项） | 33.33% | 模型返回阻碍补给的原因，未对准无法补给的主体；语义选择错误 |
| 发现 drop:1142#1 | How many more people, by percent, living in Springfield who were made up of two or more races were White and African American compared to White and some other race? | 0.5 / .5 | 0% | 数值等价但固定主评分器不做该形式的数值归一化；原始模型输出就是 0.5，执行器未转错 |
| 发现 drop:4844#1 | Which age group had the third most people? | 25 to 44 / 45 to 64 | 33.33% | 年龄组排序/目标选择错误，部分文本重合得分，不是执行格式损坏 |
| 发现 drop:1919#1 | How many years old was Prince Akishino when his son was born? | 认为出生年未给出，无法确定 / 41 | 0% | 未从文中 1965 与 2006 的关联推断年龄；模型语义推理问题 |
| 发现 drop:0#1 | Which age groups each made up more than 20% of the population? | under the age of 18, from 25 to 44, and from 45 to 64 / under the age of 18 and 25 to 44 and 45 to 64 | 88% | 目标集合已覆盖，但输出含多余 from 等表述，固定文本 F1 扣分；不是适配器增加文字 |
| 发现 drop:543#1 | Who did Suleiman meet with in Constantinople? | Polin / Jerôme Maurand and Polin（另有参考项） | 40% | 相对集合参考遗漏实体；需改善指代/参与者关系识别 |
| 确认 drop:131#1 | Which age group had the third most people? | 25 to 44 / under the age of 18 | 0% | 原文 55.2%(18–24)、15.3%(25–44)、12.0%(under18)，模型选了第二名 |
| 确认 drop:131#2 | Which age group had the third most people? | 25 to 44 / under the age of 18 | 0% | 同上，再次稳定出现的模型排序错误 |

其他完成记录、包括基线与旧图回归的所有非满分题次，均见本地 `REPORT.zh-CN.md` 和 `ALL-LOSSES.json`。它们保留原始问题、答案、参考、分数和逐节点模型输出；不能仅凭 F1 降低推断程序出错。

## 旧胜出图的针对性回归

旧四 SAMPLE 图不作为本轮合法搜索候选，仅在冻结选优后用新公共契约独立测试七道已知问题；原图的候选级旧 user 指令也原样保留，因此仍可能与新契约产生冲突。该回归也同时使用了本轮证据来源标签，并非单独答案契约的消融实验。

- drop:8499：`How many yards…` 最终 **49**，不再是 49-yard，满分。
- drop:1432：最终 **35-yard**，不再附加 field goal，满分。
- drop:5333：最终 **1**，满分。
- drop:1142：0.5 与 .5 仍被固定主评分判为零。
- drop:0：仍遗漏 under18，部分得分。
- drop:543：仍只答 Polin，部分得分。
- drop:131：仍答第二名的年龄组，零分。

七题 F1 59.10%。这支持已知单位边界问题得到改善，不支持“旧图所有问题已修复”。

## 本轮暴露的工程问题与完成后的补正

1. **运行前绑定类型错误**：0006 将 items 当作 Context，0011 将 records 当 IDs，0012 从数组取顶层 id。执行器没有擅自猜测或转换；保留原始失败并排除无效评测。
2. **具体错误反馈仍有缺口**：0006 原生抛出的 `INVALID_INPUT: context must be an object` 没有 publicMessage，给优化器的反馈退化成通用提示。这是本地错误反馈层的缺陷，不能归为模型答题失误。完成批次后已加应用层 Context/Memory 输入守卫，明确节点、config 字段、期望类型和合法绑定示例；不开放私有评分/参考答案。
3. **user 接口指南存在歧义/一处错误**：此前列出的 Context.items 是输出证据路径，未充分区分 SELECT 的完整 Context 输入；Memory 只写“返回数组”，缺少 ID 投影例子；注册算术工具曾误写 `{value,...}`，实际是 `{result:number}`。现已补正这些声明，明确 Graph 不能有 dependencies、DELIBERATE 的候选数及最终输出必须为字符串。系统提示词未改。
4. **模型修复有效率不足**：三次 Graph 字段错误重复出现；0007 甚至误把运行期失败理解为辅助声明错误。增加配额只能保证尝试机会，不能保证模型按错误修复。后续应优先验证结构化修复有效率，再扩大搜索；不能把这些未执行方案报告成 Worker 收益。

最后补正未再次付费搜索。它们的验证证据是：**285 项测试全部通过**，包括重现上述三种绑定失败并验证具体反馈、修复后的原生 Memory WRITE→GET 执行、指南所述算术结果路径的真实 Worker 执行；另对原批次 103 个完整执行离线重放，差异为零。提示词审计确认跨数据集 system 冻结、私有参考排除；证据来源标签缺失及已接受候选方向覆盖违规均为零。

## 可复核的本地产物

根目录：`../output/drop-multiworker-20261030-v3/`（相对于仓库）。

- `manifest.json`、`code-snapshot/`：在线实验版本、参数和完成状态。
- `search-state.json`：全部提案、完整定义、拒绝理由及同轮修复记录。
- `provider-direction-budgets.json`、`usage.jsonl`：方向配额及实际消耗。
- `validation-summary.json`、`AUDIT.json`、`ALL-LOSSES.json`：独立评分与失分审计。
- `REPORT.zh-CN.md`：包含所有阶段全部非满分题次的可读报告。
- `AUDIT.before-final-guards.json`：最终输入守卫补正前的原审计快照。
- `check-final.log`、`replay-final.log`、`prompt-audit-final/audit.json`：最终代码的离线验证。

原始日志和数据未上传 Git；仓库保留本报告与可复现脚本，避免将实验凭据或大体积运行产物纳入提交。
