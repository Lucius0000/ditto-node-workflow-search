# 优化器主导的流程搜索（v6，2026-10-20）

本协议取代 v5 的 AFlow 父流程抽样与末尾追加机制。AFlow 只提供收敛判断；MFlow 的固定数据划分、基线种子提示词与评分协议继续保持优先。

## 候选生成

正式入口 `src/cli.ts` 使用 `searchDirectedWorkflows` 与 `DirectedWorkflowProposer`。应用不抽样或指定父流程。优化器收到所有已完成候选的完整节点配置、有效 Search 分数、标准差及每个有效候选最多三个未满分预测；无效评估仅提供故障类别计数。参考答案、评分器私有错误与 Test 结果不进入优化器提示词。

优化器返回 `{referenceCandidateId, rationale, nodes}`。`referenceCandidateId` 可以由模型选择任意已有候选或为 null，仅记录来源。`nodes` 是完整新流程，可在任意合法位置插入、删除、替换、重排节点及重接依赖，也可修改初始 solver。完整提示词导出为 `DIRECTED_OPTIMIZER_PROMPT`，位于 `src/search/directed-proposer.ts`。

节点包括四种INFER及Context、Memory、Interaction的已实现操作，完整清单与输入绑定见[工作流能力说明](workflow-capabilities.zh-CN.md)。保留一个首部题面LOAD，允许额外LOAD读取真实上游结果；保留2–24节点、唯一ID、阶段顺序、同Graph前序依赖和checker规则。删除节点后修复悬空依赖，证据须有后续答案消费者。Graph/Loop仍按顺序阶段构建，输出来自Infer节点。

节点 ID 改名但配置及依赖结构不变，视为重复候选。固定生成参数不可由优化器修改。`sample-1` 若接入前置答案，会实际消费这些答案；仅无前置答案时使用原始基线输入路径。

## 预算与收敛

`--rounds 20` 现在表示最多完成 20 个有效完整流程评估，**包括初始单模型流程的一次评估**。每次完整评估内部仍为 Search 全集 × 5 次重复，不是 20 个样本或 20 次 API 调用。

- 正常答错、空答案或达到长度上限但得到可评分答案：完整有效评估完成后计 1。
- 非法/重复候选：计 0。
- provider、执行或评分工程故障使评估无效：不计有效实验，不产生排名或收敛的占位分。耗尽显式配置的执行时间预算则是有效零分、不补测；网络超时不因此改判为模型失败。见[时间预算规则](workflow-capabilities.zh-CN.md)。
- 中断中的候选：计 0，先保存 pending；恢复同一候选，完成后只计 1。

只在有效评估序列上调用现有 AFlow Top-3、z=0、连续 5 次不变的收敛规则。没有 Top-K 父候选池、概率抽样、树回传或深度预算。正式 search 明确拒绝 `--top-k` 和 `--maximum-depth`；seed 不控制候选生成。

无效提案会进行格式修复；连续三次相同提案故障、累计 100 次无效提案或连续三次无效评估会停止等待排查，剩余有效预算保留。这是故障保护，不是提前消耗预算或判定收敛。

## 文件与恢复

`resume-state.json` schemaVersion=2 保存完整历史、有效计数和待评估候选；`workflow-history.json` 保存不含逐题结果的流程历史摘要。每个候选完整计划仍写入不可覆盖的 `checkpoints/search-NNN.json`，逐题证据保存到 evaluations，最佳有效流程保存到 best。

`--resume-dir ... --resume-round N` 中 N 必须是该运行最新有效评估计数，允许 0；pending 恢复不重新提案。CaseRecovery 以代码、模型、协议、提示词、数据哈希、固定 ID 集及完整计划匹配逐题结果，继续排除 Test 反馈。v5 状态不能作为 v6 恢复状态，历史结果单独保留。

旧 `NodeWorkflowSearch`、selector 与树实现保留用于历史兼容及回归测试，不再由正式文本/代码基准 CLI 调用。独立的 AutomationBench 工作目录未在本次修改范围内；不能据本协议声称其独立入口已迁移。

## 验证

新增针对任意位置增删、非最优历史来源、重复候选去重、无效评估不扣预算、正常零分计预算、中断恢复、收敛、完整快照格式与 checker 依赖、私有参考隔离、checkpoint 持久化，以及实际前置输出传递的测试。正式实验必须使用提交后的独立源码快照，继续校验固定 MFlow 文件哈希，DROP Search 200 题、GSM8K Search 264 题，各 5 次重复。
