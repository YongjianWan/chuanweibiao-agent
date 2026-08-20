# 前端静态原型

本目录是工程建设类技术标辅助评审系统的前端 Demo / 静态原型。

## 打开方式

建议用本地 HTTP 服务打开，避免 Chrome 对 `file://` 本地文件路由的安全限制影响 Hash 跳转：

```powershell
python -m http.server 8000 --directory prototype
```

然后访问：

```text
http://localhost:8000/
```

也可以直接用现代浏览器打开，但部分 Chrome 版本可能在控制台提示 `file://` 安全限制：

```text
prototype/index.html
```

不需要 Node、npm、构建工具或后端服务。

## 路由

使用单个 `index.html` 和 Hash 路由：

- `#/create`
- `#/confirm`（需先在页面①点击“下一步：解析”，计时从该按钮起算）
- `#/running`（页面①解析后即可查看，包含 S1/S2/S3/S4 事件流）
- `#/results`（逐项评审产生结果后可查看）
- `#/detail?bidder=...&item=T-02`（对应单元格评审完成后可查看）

`#/confirm?binding=issue` 是开发演示绑定异常的旧入口；当前正式原型 `DEMO_MODE = false`，默认不暴露该入口。

## 数据说明

Mock 数据统一放在 `prototype/js/mock-data.js`，通过全局对象 `window.PROTOTYPE_DATA` 提供；证据种子由 `prototype/js/located-seed.js` 提供。

数据字段尽量贴近 README §4 的数据契约，保留了 `item_guid`、`section_id`、`page`、`match_score`、`hit`、`tier`、`aspects` 等后续对接字段；界面默认不向用户暴露这些内部技术字段。

`prototype/js/located-seed.js` 与 `data/interim/mock/review_results.json` 由 `scripts/build-prototype-mock.js` 生成。脚本优先读取 `data/projects/jiyang-epc/evidence/<bidder>/located.json` 与 `data/projects/jiyang-epc/sections/<bidder>/sections.json`，拿真实 S2 证据包里的 `bidder` / `item_id` / `item_guid` / PDF 页码作为种子；这些产物不存在时，才回退到早期 `data/interim/located.json`、`data/interim/sections.json` 样例。

低置信度阈值统一为 `confidence < 0.85`。Mock 评分结果只用于前端演示：`tier` 与 `score` 均模拟模型输出，`score` 保持在档位区间内；`confidence` 从 1.0 起按降级、截断、重试三个因素相乘，不再使用随机低基线，也不再展示要素加权定分。

`sectionBlocks` 提供章节块层级数据。真实 PDF 链路产出 `picked[].page` 后会透传展示；回退到早期样例时，没有页码的证据会显示“页码未采集”。`section_id` 按 README §4 使用 `文件序号#块顺序号`，`#` 后保持纯整数。

当前仓库已有 `config/projects/济阳区实验高级中学.yaml`；静态原型仍使用 `mock-data.js` 内置评分表作为可离线演示数据，评分项、分值、三档区间、`criteria` 与 `aspects` 已按该项目 YAML 同步。页面②的档位说明 `desc` 是评审专家补充说明，默认空，不是招标文件原文；后续接入真实链路时，应改为从项目 YAML 生成或注入评分表，而不是手工维护 Mock。

页面④的“导出报告”会在浏览器本地生成静态 HTML，内容包含系统判分 / 专家判分并列表、未评定单列、建议人工复核清单、无区分度审计、专家复核记录、性能数据和 `compute_notes`。评审未完成时页面④仅作为运行快照查看，导出按钮禁用，避免生成半成品报告。

所有分数、耗时、token、显存相关内容均为 Mock / 占位示例，不代表真实评审结果或真实硬件配置；12 家字数合计按 README §1 的实测口径校准为 1047.0 万字。
