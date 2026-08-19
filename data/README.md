# data/ 目录说明

`原始资料/` 是甲方与公司提供的原件，受 `.gitignore` 保护，**不进 git、不修改**。
本目录只存放从原始资料生成的、可复现的、体积可控的中间产物与最终报告。

## 目录结构

```
data/
├── README.md
├── projects/                         # 按项目组织
│   └── jiyang-epc/                   # 项目 slug，见 manifest.json
│       ├── manifest.json             # 项目元数据 + 投标人清单
│       ├── sections_all.json         # 全部投标人的章节块合并索引
│       ├── sections/                 # S1 产出：按投标人存放章节块
│       │   └── sample-docx/
│       │       └── sections.json
│       └── evidence/                 # S2 产出：按投标人存放证据包
│           └── sample-docx/
│               └── located.json
└── out/                              # S4 产出：最终评审报告
```

## 命名约定

- 项目目录 = `projects/<project_slug>/`
- 投标人目录名 = `manifest.json` 里的 `bidders[].id`，**原样照抄投标文件所在一级目录名**
  （真实场景形如 `中冶建工集团有限公司8010856`）
- `sections_all.json` 是只读索引：每个章节块额外注入 `bidder` 字段，便于跨投标人引用

## 生成流程

```bash
# 1. S1：把某家投标人的 doc/docx 切成章节块
python src/s1_ingest.py "原始资料/公司的临时样例文件仅作参考/ss投标/技术部分" \
  data/projects/jiyang-epc/sections/sample-docx/sections.json

# 2. 合并所有 bidder 的 sections.json -> sections_all.json
python scripts/merge_sections.py data/projects/jiyang-epc

# 3. S2：在单个 bidder 的章节块内定位证据
python src/s2_locate.py \
  data/projects/jiyang-epc/sections/sample-docx/sections.json \
  config/review_points.yaml \
  data/projects/jiyang-epc/evidence/sample-docx/located.json

# 4. S3/S4：逐条评审并生成报告 -> data/out/
# （待实现）
```

真实工程标书为 PDF，S1 的 PDF 路径见 `docs/issues.md` P0；在 PDF 路径实现前，
样例 docx 数据用于守住 S2 检索算法的回归测试。
