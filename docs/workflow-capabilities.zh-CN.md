# 工作流能力与时间预算

[English](workflow-capabilities.md)

通用入口`src/cli.ts`继续由优化器生成完整工作流，可插入、删除、替换节点及修改合法依赖，不改成历史实验的逐次追加模式。

## 节点范围

| Worker | 可搜索节点 |
| --- | --- |
| Context | LOAD、SELECT、UPDATE、COMPRESS |
| Memory | WRITE、GET、SEARCH |
| Interaction | ACT.TOOL、OBSERVE |
| Infer | REASONING.SAMPLE、TRAJECTORY、REFLECT、DELIBERATE |

保留一个起始题面LOAD（`config: {includeTaskMetadata: true}`），额外LOAD通过`sourcesSource`从已声明的上游结果载入内容。同Graph来源必须列入dependencies，证据要被后续答案节点消费，最终输出来自Infer。完整配置见`src/workflow/capability-schema.ts`的`CAPABILITY_SCHEMA_GUIDE`，优化器实际收到相同说明。例如，在已有solver前增加SELECT：

```json
{"id":"selected-context","type":"CONTEXT.SELECT","graphId":"prepare","dependencies":["context-load"],"config":{"contextSource":{"from":"node","nodeId":"context-load","view":"context"},"limit":1}}
```

来源可为公开题目字段、已有Context、Memory记录/ID、真实工具结果、Observation或答案文本。Context处理后的工作证据传给solver，同时保留原题。Memory按题目、重复、尝试隔离，GET/SEARCH要求之前实际写入。工具仅包括受限算术和文本字面查找，在受限Worker中执行，不接受模型代码、shell、联网工具或隐藏答案。OBSERVE只接收真实工具调用结果。Memory和工具证据不充当REFLECT、DELIBERATE的候选答案。

原Infer工作流保持既有消息路径；扩展流程使用类型化绑定及题内资源。来源引用也参与去重，单纯改节点ID不算新方案。Graph阶段仍为prepare/solve/refine，Loop沿用原顺序调度。

## 启动前明确时间预算

正式CLI必须显式提供两项预算：正整数毫秒，或`unlimited`并用`--time-budget-reason`说明原因。下面只是命令示例，不是所有benchmark的统一时限：

```bash
npm run search:math -- --request-timeout-ms 600000 --workflow-timeout-ms 1200000
```

如已批准沿用历史不限时协议：

```bash
npm run search:math -- --request-timeout-ms unlimited --workflow-timeout-ms unlimited --time-budget-reason "Preserve the approved historical timing protocol"
```

- 请求预算从取得共享调用名额后计时，包括服务等待和完整响应；持续输出不重置。优化器请求同样受请求预算约束，但优化器超时不是一道题的零分。
- 工作流预算从单题单次评价开始，包含提供商队列、工具、全部调用、重试和格式修复，不包含评分；重试不重新获得预算。
- 耗尽已声明预算时，取消调用/工作流，记录`timeBudgetOutcome`，作为有效评价记零分、保留原分母，不补测，不隐式采用先前答案。
- 网络、明确服务错误和评分故障仍按工程无效处理。被取消请求的未知用量保留未知，不能假定免费。

时间策略写入manifest、冻结checkpoint和恢复身份；Search、冻结Test、独立逐轮测试必须一致。策略变化另开运行，不追溯改判历史结果。自定义评价入口需向`evaluateTasks`传入`timeBudget`，并通过受管runtime/runner传播取消信号。

新benchmark启动前确定时限、排队和等待的计时方式、超时评分及恢复规则；相同条件可沿用已确认配置，不设巨大默认值代替决策。墙钟耗时包含模型和提供商表现，分析时记录运行条件。

## 验证

执行`npm ci`和`npm run check`。离线检查覆盖通用解析/执行入口、多次LOAD、Context消费、真实Memory与工具操作、题内隔离、持续流截止、重试共用预算、取消释放、超时零分及工程故障分类，不需要重新发起付费全量实验。
