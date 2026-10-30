# 固定流程工程评价

[English](fixed-engineering-evaluation.md)

`dist/unified/fixed-engineering.js` 用四份固定 Search 划分评价工程正确性，不调用优化器或 Test，也不修改统一 Search 的默认重复次数。HumanEval、MBPP、DROP 使用 main 基础流程；AutomationBench 使用声明式“决策 → ACT.TOOL → OBSERVE”循环，每次尝试创建独立官方世界。

先构建，再提供符合 `src/unified/fixed-engineering.ts` 中 `FixedEngineeringProtocol` 的已批准非秘密 JSON：

```powershell
npm run build
node --experimental-vm-modules dist/unified/fixed-engineering.js <protocol.json> <new-output-directory> probe --offline-only
node --experimental-vm-modules dist/unified/fixed-engineering.js <protocol.json> <output-directory> probe --resume
node --experimental-vm-modules dist/unified/fixed-engineering.js <protocol.json> <another-new-directory> full
```

协议要求获授权的 Ark Agent Plan 端点/模型、三个不同账号别名、明确授权及超额关闭确认。推理 Key 只从 `ARK_PLAN_KEY_<ALIAS>` 读取；只读额度查询使用 `ARK_AUDIT_ACCESS_KEY_ID_<ALIAS>` 和 `ARK_AUDIT_SECRET_ACCESS_KEY_<ALIAS>`。入口不会切换至普通 Ark 或 DeepSeek API。

当前协议为8题独立探测，随后519题各一遍：HumanEval33、MBPP86、DROP200、AutomationBench200。请求期限180秒，普通workflow300秒；Automation600秒、最多60次实际准入的logical模型调用，内部推理及格式修复也计数，重试共用累计时间和调用预算。每次logical调用至多3次SDK HTTP尝试；每题每次重复至多5次workflow尝试。预算在派发前持久化；中断后只有写前记录、没有结果证据时，不能静默重新派发。

四数据集并行共享模型池，合计至多18、每账号6个模型调用。两种代码题各使用6个题级槽控制Docker负载。服务端 `AccountQuotaExceeded` 会停用耗尽账号并禁止SDK重试；`AccountRateLimitExceeded` 保留暂时退避。实际额度和结构化拒绝同时留档，不修改账号设置。输出目录内的 `STOP` 文件阻止新派发，已接受工作随后排空。

Automation工具只在声明的Graph/Loop内执行，公开schema和观察进入下一次推理，私有世界、contract及评分留在评估端。评分使用真实最终世界，partialCredit只作诊断。模型格式错误和声明预算耗尽计有效0；provider、bridge、judge故障仍为工程无效。judge-only恢复必须使用原world/prediction，不重新生成答案。取消活动官方操作会丢弃bridge，并把世界结果记为未知；这不提供回滚保证。

Automation决策缺少必填字段时，仅在使用宿主明确的响应指令及公开工具schema的情况下判模型格式错误。通用JSON路径错误仍是绑定失败；`coalesce`保留可选默认值，包括`api_search.top_k = 5`。

Python响应含多个代码块时，抽取器保留首个入口函数实现块及辅助声明块。只有签名、没有函数体的说明块在后面有实现时跳过；真正有语法错误的实现仍保留，不换成后面的另一解法。抽取器通过只检查语法的Python AST解析排除单独的REPL记录、说明、测试与用法片段，不执行模型代码，也不按私有测试结果选块。解析使用`DITTO_PROVIDER_PYTHON`（默认`python`），保留import、常量与helper定义。

代码判题先要求 `docker-ready` 成功及本地已有不可变镜像。生成程序的容器内期限为12秒，宿主60秒监督属于基础设施边界。打印固定标记或提前退出不能满足随机完成标记；该检查不证明可以防御任意恶意程序对测试环境的探查。

每次运行固定源码、编译产物、提示词、定义、数据成员/顺序、provider及官方环境身份。证据包含不带认证头的HTTP payload、原始响应、实际节点输入输出、送判程序/真实世界，以及已知和未知用量。包含私有测试/世界的结果保留在公开仓库外。身份变化后拒绝按旧run恢复。

`repair --repair-from <original-full-run>` 专门执行本轮另获批准的27个工程无效项，各增加至多1次尝试。入口校验语义身份未变，记录父源码/runtime；原492个有效结果保留来源。它只使用第一个仍有额度的获授权账号。这属于新的有界修复验证，不延长原来已用尽的预算，也不是通用重跑或优化入口。

常用检查：

```powershell
npm run check
npm run audit:prompts
python scripts/provider_bridge_test.py
# 配置固定的官方解释器、源码与数据后，执行真实环境检查：
node --experimental-vm-modules --test dist/benchmark/automation.test.js
node scripts/verify_automation_worlds.mjs <automation-search-data> <new-output-directory>
# 先让docker-ready成功，再选择CODE_JUDGE_IMAGE：
node scripts/verify_code_judge.mjs
node scripts/verify_code_judge_active.mjs
```
