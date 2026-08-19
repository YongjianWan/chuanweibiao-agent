# 前端静态原型

本目录是工程建设类技术标辅助评审系统的前端 Demo / 静态原型。

## 打开方式

直接用现代浏览器打开：

```text
prototype/index.html
```

不需要 Node、npm、构建工具或后端服务。

## 路由

使用单个 `index.html` 和 Hash 路由：

- `#/create`
- `#/confirm`
- `#/confirm?binding=issue`（演示投标文件绑定异常，开始按钮会禁用）
- `#/running`
- `#/results`
- `#/detail?bidder=...&item=T-02`

## 数据说明

Mock 数据统一放在 `prototype/js/mock-data.js`，通过全局对象 `window.PROTOTYPE_DATA` 提供。

数据字段尽量贴近 README §4 的数据契约，保留了 `item_guid`、`section_id`、`page`、`match_score`、`hit`、`tier`、`factor_scores` 等后续对接字段；界面默认不向用户暴露这些内部技术字段。

当前原型按既定实施约束不修改 `data/`，因此 S3 Mock 结果没有另写到 `data/interim/mock/review_results.json`。若后续确认以 `docs/分工与排期.md` 为准，再把同一份 Mock 结构落盘到该位置。

低置信度阈值统一为 `confidence < 0.85`。Mock 评分逻辑按 README §4：先由模型侧判定 `tier`，再用 `score = tier.min + 得分率 × (tier.max - tier.min)` 生成档内连续分；`confidence` 从 1.0 起按降级、截断、重试、打架四个因素相乘，不再使用随机低基线。

`sectionBlocks` 提供章节块层级 Mock 数据，每个章节块都带 `page`，页面⑤的证据定位从证据包 `picked[].page` 透传展示。`section_id` 按 README §4 使用 `文件序号#块顺序号`，`#` 后保持纯整数。

当前仓库尚无 `config/projects/济阳区实验高级中学.yaml`，因此评分表仍是原型用 Mock 数据；已按 `docs/findings-招标文件核对.md` 修正确定有误的 T-15 名称、满分和三档区间。等 T1 产出项目 YAML 后，应整体替换 `mock-data.js` 内的评分表定义。

页面④的“导出报告”会在浏览器本地生成静态 HTML，内容包含并排表、未评定单列、建议人工复核清单和性能数据。

所有分数、耗时、token、显存相关内容均为 Mock / 占位示例，不代表真实评审结果或真实硬件配置；12 家字数合计按 README §1 的实测口径校准为 1047.0 万字。
