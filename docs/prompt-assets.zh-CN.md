# 可复用提示词资产

[English](prompt-assets.md)

四集配置与通用构造模板在prompts/initialization。loadPromptAssets()重建选定完整工作流并核hash，运行引导与研究元数据分开。HumanEval/DROP保留首次原题重复，MBPP/Automation不重复；设置幂等，不在history累加原题。推荐方向是待验证假设，不是所有后端上的实测收益。

文本提案含parentHash、rationale、edits:[{path,value}]。宿主检查精确文本路径、完整schema、不变字段、重复策略与题号规则，再序列化重建图；任意Patch和非法JSON拒绝。textEditInput接收调用方模型配置，只有显式optimizer运行时可透传结构化响应选项；执行profile保持原wire，具体格式支持须在实际服务核实。

实际复用方式见[默认Search、新Test及冻结导出命令](recommended-search-and-test.zh-CN.md)。没有匹配tokenizer或受控用量测量时，首次重复的精确增量tokens未知；离线原题次数和UTF-8字节可观察，不能当作计费单位。
