# Automation 公开分层划分协议 v2

状态：固定题单；尚未启动本协议下的模型实验。该协议由本仓库定义，不属于 MFlow 原划分或 AutomationBench 官方划分。

## 固定体量与分层

使用历史固定版本 `4a8e1061254004d9dac807054eed33fad7d1ff14` 的全部 800 道公开题，保留原题面和官方世界评分。Search 200 道，Test 600 道，任务互斥、并集完整。种子为 `20261118`。

| 来源 | Search | Test |
|---|---:|---:|
| simple | 50 | 150 |
| sales | 25 | 75 |
| marketing | 25 | 75 |
| operations | 25 | 75 |
| support | 25 | 75 |
| finance | 25 | 75 |
| hr | 25 | 75 |
| 总计 | 200 | 600 |

两侧都含 25% simple、75% 业务题。各业务领域比例一致。低中高复杂度在各领域内部按公开题面复杂度指标排序分为三档，并尽量按照 1:3 分配，结合能力覆盖同时优化。**相对档位不能用于断言 simple 高档与业务高档同难度**。

## 可复现标注与选择方法

只读取公开 user 题面，移除共有 system 前缀。依据题面长度，以及政策、时效、条件、计算、时间安排、验证六类显式需求计算复杂度指标。能力采用多标签：policy、recency、conditional、calculation、temporal、evidence、entity、write、verification、cross_app。关键词规则及权重完整写在生成脚本中。

这些标签是确定性的题面代理指标，尚未经专家逐题验证；关键词不能证明真实最小执行步数、实际跨应用数量或模型难度。例如 cross_app 只代表相关应用词出现，不能保证多个应用被调用。已在 manifest/annotations 中明确记录这一限制。不读取历史预测、正确率、私有世界、评分断言或本次运行反馈来选题。

模板分组：`simple.email_sf_contact_*_update` 的字段变体整组分配；另外，以公开 user 题面的单词集合 Jaccard 相似度 ≥ 0.70 建立连通分组。分组不能跨 Search/Test。当前共 791 个分组。该保守方法不能排除语义改写泄漏，后续人工确认若需调整必须发布新协议版本，不能静默改 v2。

在每领域内，以固定种子的 512 次随机分组顺序生成满足精确配额的子集，最小化复杂度档位和能力标签与全域 25% 目标的偏差；总样本数 ≥4 的标签缺失增加惩罚。同分按排序后的 ID 确定选择。该次数只控制离线划分算法，不涉及实验预算。完整分布见 `manifest.json` 的 domains/features。

## 评分、反馈与历史暴露

Search 上优化并冻结候选；Test 不进入优化器反馈。主要分数使用官方严格世界断言的任务完成率，partial credit 只作诊断。同时分别汇报混合分数、simple 分数、六业务领域总体及各领域分数，并按复杂度档位和能力标签汇报。混合分数含 simple，因此不能称为官方 AutomationBench 总分；业务部分也只是公开任务子集。

这 800 道公开题已有历史搜索、测试及人工错题分析暴露，v2 Test 不是全新盲测。本次划分不根据这些结果选题；不能以重新划分宣称消除了历史开发影响。需独立新题才能得到真正新盲测。

重新运行基线及搜索，使用新的输出目录；原协议 checkpoint、冻结候选成绩和汇总不能直接复用为 v2 成绩。旧候选可以作为显式历史对照，须在 v2 题单上重新评测。候选上限、收敛规则、重复次数、模型、运行权限等保持独立配置，本次划分不新增实验预算或启动实验。

## 文件与加载

- `search.jsonl` / `test.jsonl`：已提交的完整公开题单；只有 dataset.protocol/split 随新协议更新。
- `annotations.json`：逐题领域、复杂度代理、能力标签和分组。
- `manifest.json`：输入/输出哈希、上游版本、种子、详细分布及限制。
- `scripts/prepare_automation_balanced_split.py`：从原先固定的 simple-v1 两文件可确定性重建。

加载器通过固定文件哈希识别 v1/v2，并严格核对行内协议及 split。v1 保留支持。常规 CLI 的 `--data-dir` 直接传给适配器，选择 v2 时指定 `--data-dir protocols/automationbench-balanced-public-v2`。`DITTO_AUTOMATION_DATA` 只用于部分验证脚本，不能替代 CLI 的这个参数。正式启动前仍需提供原有模型、上游源码和 Python 环境配置。

重建命令（在仓库根目录）：

```powershell
python scripts/prepare_automation_balanced_split.py --source <原simple-v1数据目录>
```

生成器首先核验两个原始文件哈希。不得更换上游版本后沿用 v2 名称。
