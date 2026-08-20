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
- `#/running`（页面①解析后即可查看逐项评审进度）
- `#/results`（逐项评审产生结果后可查看）
- `#/detail?bidder=...&item=T-02`（对应单元格评审完成后可查看）

`#/confirm?binding=issue` 是开发演示绑定异常的旧入口；当前正式原型 `DEMO_MODE = false`，默认不暴露该入口。

## 数据说明

`prototype/js/mock-data.js` 只作为离线兜底数据，通过全局对象 `window.PROTOTYPE_DATA` 提供；证据种子由 `prototype/js/located-seed.js` 提供。真实评审分数由 `prototype/js/real-results.js` 提供，页面启动时检测到 `window.REAL_RESULTS` 就优先使用真实结果，缺失时自动回退到 Mock。

项目级前端配置由 `prototype/js/project-config.js` 注入，来源标注为 `config/projects/济阳区实验高级中学.yaml` 与 `config/projects/项目特征摘要.md`。它覆盖项目摘要、评分规则来源、最终性能口径和 token 说明；评分项展示优先使用 `prototype/js/scoring-reference.js` 的招标文件核对结果生成，不再把 `mock-data.js` 的评分表当正式入口。

数据字段尽量贴近 README §4 的数据契约，保留了 `item_guid`、`section_id`、`page`、`match_score`、`hit`、`tier`、`aspects` 等后续对接字段；界面默认不向用户暴露这些内部技术字段。

`prototype/js/located-seed.js` 与 `prototype/js/real-results.js` 由 `scripts/build-prototype-mock.js` 生成。脚本优先读取 `data/projects/jiyang-epc/evidence/<bidder>/located.json` 与 `data/projects/jiyang-epc/sections/<bidder>/sections.json`，拿真实 S2 证据包里的 `bidder` / `item_id` / `item_guid` / PDF 页码作为种子；这些产物不存在时，才回退到早期 `data/interim/located.json`、`data/interim/sections.json` 样例。若存在 `data/out/report/report.json`，页面④与导出报告直接使用该 S4 正式报告；`data/projects/jiyang-epc/reviews/reviews.json` 只用于补充运行进度事件和逐项详情。

低置信度阈值统一为 `confidence < 0.85`。真实结果直接使用 S3 输出的 `tier` / `score` / `confidence` / `reason` / `cite`；Mock 评分结果只用于前端演示：`tier` 与 `score` 均模拟模型输出，`score` 保持在档位区间内；`confidence` 从 1.0 起按降级、截断、重试三个因素相乘，不再使用随机低基线，也不再展示要素加权定分。

`sectionBlocks` 提供章节块层级数据。真实 PDF 链路产出 `picked[].page` 后会透传展示；回退到早期样例时，没有页码的证据会显示“页码未采集”。`section_id` 按 README §4 使用 `文件序号#块顺序号`，`#` 后保持纯整数。

页面①的文件识别基于本次选择的 `File.name` / `File.webkitRelativePath` / `File.size`，按投标人目录、评分项 GUID 和评分项名称做前端预检；正文抽取将在接入现场运行接口后执行。页面②的绑定状态来自本次上传文件名/GUID 预检，匹配不到会显示“待后续定位确认”，不会固定显示 `12/12`。

页面③展示最近一次真实全量评审的逐项进度、当前处理状态、重试和未评定项；后续接入现场运行接口后，可切换为本次上传实时运行。页面④的“导出报告”会在浏览器本地生成静态 HTML，内容包含系统判分 / 专家判分并列表、未评定单列、建议人工复核清单、无区分度审计、专家复核记录、性能数据和 `compute_notes`。评审未完成时页面④仅作为运行过程查看，导出按钮禁用，避免生成半成品报告。

当前 `real-results.js` 内嵌的 `reportData` 与 `data/out/report/report.json` 保持一致，228 条逐项明细来自该报告的 `details`。token 必须标注“本地估算”：智能体工厂端点 `usage` 恒为 `null`，现按中文约 1.5 字/token 估算。GPU / 显存采集不到时显示“未采集”，不填估算值。
