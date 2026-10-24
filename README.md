# Ditto Node Workflow Search

节点调用范围、额外Context载入及启动前必须指定的时间预算，见[工作流能力与时间预算](docs/workflow-capabilities.zh-CN.md)（[English](docs/workflow-capabilities.md)）。本文下方历史命令需补充显式时间预算参数。

这是一个独立的 TypeScript 实验仓库：只使用已发布的 `@codesoul-co/ditto` npm 包，通过数据集反馈搜索更好的 Agent 结构，不修改 Ditto 源码或 `node_modules`。

## 当前正式协议（DROP / GSM8K）

所有新实验统一使用 DeepSeek 官方 `deepseek-flash`：关闭 thinking、temperature=0、max_tokens=393216、n=1、text 模式、上游流式返回；不传 top_p 或 reasoning_effort。Trajectory 步数与执行 Loop 使用 Number.MAX_SAFE_INTEGER，不设单题累计 token 或工具调用上限。

正式入口按 MFlow `aflow-fixed-v1` 加载完整固定样本及原始顺序，校验原始文件 SHA-256 与数量；禁止分层抽样，`--search-limit` / `--test-limit` 必须为 0。DROP 为 200/800，GSM8K 为 264/1055；保留并披露 DROP 五对已知重复题干。MFlow 的划分规则优先。

DROP/GSM8K 使用固定 MFlow 种子提示词和首轮输入格式，运行记录与检查点保存提示词来源及哈希。旧参数或旧评分的运行不能直接恢复到新协议。细节、评分口径及运行命令见 [正式协议说明](docs/drop-gsm8k-protocol.md)。

> Experimental / not Ditto Core. 当前仓库保持 `private: true`，表示禁止误发 npm；GitHub 仓库本身可以公开审查。

## 核心定义

负责人提出的关系在代码中被严格拆成三层：

```text
Node   = 一个最小的 Ditto 语义操作
Graph  = 由一个或多个 Node 组成的局部工作流（不可变 DAG）
Loop   = 串联、重复或按结果切换多个 Graph 的总调度器
```

搜索树中的每个顶点只保存一个真实 Ditto Node。根到叶的一条路径才代表一个候选 Agent 程序；程序被物化为局部 Graph，最后只通过一次 Ditto Loop 执行。

```text
搜索构建路径（一点一 Node）
CONTEXT.LOAD → TRAJECTORY_A → TRAJECTORY_B → DELIBERATE → REFLECT
       │
       └─ parent 只表示“先构建了谁”，不是运行依赖

物化后的运行结构
prepare Graph:  CONTEXT.LOAD
solve Graph:    TRAJECTORY_A ─┐
                TRAJECTORY_B ─┴→ DELIBERATE
refine Graph:   REFLECT

Loop: prepare → solve → refine → 结束 / 有界重复 / 条件切换
```

同一 Graph 内只有 `dependencies` 会成为 DAG 边；跨 Graph 的信息由 Loop state 传递。替换一个 Node 表示从其父节点创建另一条兄弟分支，删除表示回退祖先并生成新后缀，不创建 `ADD`、`DELETE`、`MUTATION` 等伪 Node。

## 搜索过程

搜索思想参考 AFlow 的高分倾斜、随机探索、历史反馈和收敛停止，但不是 AFlow 复现：

1. 建立与 AFlow round 1 对齐的单次原始生成基线：`CONTEXT.LOAD → INFER.REASONING.SAMPLE`。
2. 从已有搜索顶点中选择父节点；高分路径更容易被选中，同时保留随机探索。
3. 优化模型通过一个标准 Ditto `SAMPLE` Graph 只提出一个 Node JSON。
4. 可信编译器校验 Node 类型、配置、Graph 位置、依赖、深度和重复路径；模型不能返回 TypeScript 或绑定函数。
5. 可运行路径被物化为 Graphs + Loop，在 validation split 上评分。
6. 分数、失败数、token 与耗时回传给该叶子及全部祖先。
7. 达到轮数或收敛条件后，冻结最佳 `leafId + Node path + Graph specs + Loop policy`。
8. 单独运行 `test` 命令，才打开 test split；测试阶段不会再创建优化器或修改路径。

## 数据集

| 数据集 | 本地 AFlow split | 指标 | 特殊边界 |
|---|---:|---|---|
| DROP | 200 validate / 800 test | max token F1 | 支持 `\|` 分隔的多个可接受答案 |
| HumanEval | 33 / 131 | pass@1 | 生成代码只在隔离 Docker 中运行 |
| MBPP | 86 / 341 | pass@1 | 生成代码只在隔离 Docker 中运行 |
| GSM8K | 264 / 1055 | 最后一个数字准确率 | 容差 `1e-6` |
| MATH | 119 / 486 | AFlow symbolic + balanced normalized | 这是 AFlow 的 Level-5 精选 split，不是完整 MATH |

原始数据不在仓库内。预期文件与隐私边界见 [`data/README.md`](data/README.md)。题面会进入 `BenchmarkTask`，标准答案、参考代码和隐藏测试只保留在 adapter 的私有闭包中。

## 安装与配置

要求 Node.js 24+、npm 11+。MATH 的 AFlow 等价评分器还需要 Python、`regex`、SymPy 与 ANTLR runtime；HumanEval/MBPP 另要求已启动 Docker daemon，并提前拉取 Python 镜像。

```bash
npm ci
cp .env.example .env
```

在本地 `.env` 填写凭据；`.env`、数据集和运行产物都已忽略：

```dotenv
CODE_SOUL_BASE_URL=https://api.deepseek.com
CODE_SOUL_MODEL=deepseek-flash
CODE_SOUL_API_KEY=replace-locally
CODE_SOUL_CONCURRENCY=3
CODE_SOUL_TIMEOUT_MS=600000
AFLOW_SCORER_PYTHON=python
```

所有优化调用、样本并发、多个 solver 和 `TRAJECTORY` 内部调用共用同一个 3 路 semaphore，不会各自放大为 3 路。

## 离线验证

```bash
npm run check
```

默认 CI 不注入模型密钥，也不运行真实 benchmark。测试使用假 Provider，覆盖一点一 Node、Graph 编译、Loop 的顺序/重复/切换、评分器和私有 judge 隔离。

## 运行实验

正式 MATH 搜索默认使用 AFlow 对齐配置：119 道 validation、初始工作流加最多 20 个候选、每个工作流验证 5 次、Top-4 混合采样，以及 Top-3 均值连续 5 轮不变时早停：

```bash
npm run build
node --env-file=.env dist/cli.js search \
  --dataset math \
  --data-dir data/datasets \
  --search-limit 0 \
  --rounds 20 \
  --repeats 5 \
  --evaluation-concurrency 3 \
  --top-k 4 \
  --patience 5 \
  --seed 42
```

将 `--dataset` 替换为 `drop`、`humaneval`、`mbpp`、`gsm8k` 或 `math`。`--search-limit 0` 表示完整 validation split。

冻结后再运行 held-out test：

```bash
node --env-file=.env dist/cli.js test \
  --dataset math \
  --data-dir data/datasets \
  --run-dir runs/math/<run-id> \
  --test-limit 0 \
  --test-repeats 3
```

代码数据集需要先准备容器；judge 使用 `--pull=never`，不会在评分途中隐式下载：

```bash
docker pull python:3.13-slim
node --env-file=.env dist/cli.js search \
  --dataset humaneval \
  --docker-image python:3.13-slim
```

建议正式复现实验改用镜像 digest。judge 采用无网络、只读根文件系统、非 root、移除 capabilities、`no-new-privileges`、CPU/内存/PID/输出限制和硬超时；Docker 不可用时明确失败，绝不回退到宿主机 `exec`。

## 运行产物

```text
runs/<dataset>/<run-id>/
├── manifest.json
├── search-events.jsonl
├── search-tree.jsonl          # 每行一个搜索顶点、恰好一个 Node
├── search-tree-final.json
├── experiences.jsonl
├── evaluations/<leaf-id>/
│   ├── summary.json
│   └── samples.jsonl
├── best/
│   ├── plan.json
│   ├── node-path.json
│   ├── graphs.json
│   ├── loop.json
│   ├── validation-summary.json
│   └── search-summary.json
└── test/
    ├── summary.json
    └── samples.jsonl
```

manifest 记录 Ditto 版本、模型名、非敏感 endpoint、数据文件哈希、固定样本 ID、搜索设置和评分版本，不记录 API Key 或授权头。`runs/` 默认不进入 Git。

为贴合 AFlow/OpenAI SDK 行为，瞬时 Provider 故障最多发起 3 次 HTTP 尝试，完整工作流对任意异常最多执行 5 次、间隔 1 秒；最终仍失败时，汇总通过 `timeoutRuns` 与 `wrongRuns` 区分基础设施超时和正常完成但答错。

## 当前限制

- MATH 首先调用冻结的 AFlow Python/SymPy scorer；若其判 0，再以平衡 `boxed` 提取和保守的格式归一化复核。产物同时记录旧分数、是否回退及等价类型，减少嵌套分数、矩阵、单位和角度符号造成的误判，而不覆盖真正的数学错误。
- OpenAI Python SDK 会把部分缺失的可选字段实体化为 `null`；传入 Ditto 前会恢复为省略字段的 wire shape，避免把 `tool_calls: null` 误判为非法模型输出。
- 首版固定 `prepare / solve / refine` Graph 边界，执行器已经支持 `next / repeat / switch`；后续可在受控 allowlist 中开放更多 Loop policy 搜索。
- Ditto npm 包的 Contract 目前主要是 TypeScript 编译期类型，没有运行时可枚举 JSON Schema；本仓库因此维护最小可信 Node proposal 校验层，没有修改上游包。
- 仓库暂未声明开源许可证；公开可见不等于自动授予复用许可，许可证应由项目负责人决定。
