# Search与Test默认使用选用工作流

[English](recommended-search-and-test.md)

HumanEval、MBPP、DROP、AutomationBench的新运行按dataset自动使用选定完整工作流、提示词与首次呈现方式；Search还把数据集引导放入优化器user。其他数据集保持原初始化。模型仍使用团队已有CODE_SOUL_*配置，数据集策略不选择后端。历史Search观察不能证明迁移到另一后端后的效果。

环境要求：Node 24+、npm 11+、requirements-provider.txt固定的Python依赖，代码评分需要Docker。设置DITTO_PROVIDER_PYTHON后，执行npm.cmd ci与npm.cmd run build。

## 新Search

~~~powershell
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js search --dataset drop --data-dir data/datasets --output-dir runs/drop-search --request-timeout-ms 180000 --workflow-timeout-ms 300000 --offline-only true
~~~

实际评价范围与预算确定后才去掉--offline-only true。Search保留当前main的原生Worker方向保护、独立方向预算、完整definition/Graph变异协议、五遍分配和选择方法；manifest身份与优化器请求同时保留探索政策和数据集初始化。默认初始化接入不是新Graph比较，也不是小文本编辑协议。需要历史baseline对照时，在新Search显式加--initialization baseline；仅该历史模式允许有意覆盖user提示词，不悄悄替换选定种子。

## 不先Search，直接新Test

~~~powershell
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js test --dataset drop --data-dir data/datasets --output-dir runs/drop-test --request-timeout-ms 180000 --workflow-timeout-ms 300000 --offline-only true
~~~

无--run-dir时先把选定完整图写入新冻结目录，再读取Test数据，不调用优化器或运行Search。预检核数据与身份但不创建provider；正式holdout获准后才去掉--offline-only true，Test三遍。输出目录必须全新；不填--output-dir时在runs/selected-test/<dataset>下自动建立时间戳目录。

## 旧冻结与通用完整图导出

~~~powershell
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js test --dataset drop --run-dir runs/existing-search --data-dir data/datasets
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js freeze --dataset drop --workflow-file selected-workflow.json --output-dir runs/exported --request-timeout-ms 180000 --workflow-timeout-ms 300000
~~~

显式--run-dir只读原冻结图。Search --resume true --run-dir使用保存的初始化及身份，不受新默认替换；旧schema-v1仍保留原完整运行时校验，可能需要原checkout。选定图导出不伪造新的Search完成记录。

通用文件仅含dataset、id、definition、source；source含protocol、candidateId、revision、recordHash、definitionHash，选定ID和完整图hash须匹配。只含可分享选择来源，不带本地账户信息。冻结产物另记实际配置的执行模型/endpoint/生成参数，不把策略来源当作当前模型的实测效果。

新冻结分别保留完整源码与执行兼容hash。具名frozen-initialization-assets-v1政策仅排除已封入完整图及资产hash的四卡JSON和strategy-template.json；其他执行源码、编译逻辑、prompt、原生模板、环境、模型、数据评分及资源合同继续检查。Test不重新加载最新初始化JSON。缺/多字段、未知政策和身份漂移均在派发前拒绝。

正式Automation另冻结官方revision/lock/clean、评分Python包/模块指纹、bridge及scorer合同，Test在读数据或创建provider前核验。DITTO_AUTOMATION_ROOT和DITTO_AUTOMATION_PYTHON须指向已核实官方安装；freeze不启动world、不读holdout。

工程模式--engineering-fixture只接最多八条显式合成题和127.0.0.1的dummy HTTP服务，走真实CLI/SDK而不用正式数据或真实模型。fixture结果不是Test结论，其合成评分身份不能冒充formal合同。
