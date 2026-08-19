# data/ 目录说明

`原始资料/` 是甲方与公司提供的原件，受 `.gitignore` 保护，**不进 git、不修改**。
本目录只存放从原始资料生成的、可复现的、体积可控的中间产物与最终报告。

## 目录结构

```
data/
├── README.md
├── projects/                         # 按项目组织
│   ├── _sample-docx/                # 软件类样例数据。下划线前缀 = 非真实项目。
│   │                                 # 进 git，是 tests/test_s2_regression.py 的输入
│   └── jiyang-epc/                   # 真实项目 slug，见 manifest.json。
│                                     # sections/ 与 sections_all.json **不进 git**
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
  data/projects/_sample-docx/sections/sample-docx/sections.json

# 2. 合并所有 bidder 的 sections.json -> sections_all.json
python scripts/merge_sections.py data/projects/_sample-docx

# 3. S2：在单个 bidder 的章节块内定位证据
python src/s2_locate.py \
  data/projects/_sample-docx/sections/sample-docx/sections.json \
  config/review_points.yaml \
  data/projects/_sample-docx/evidence/sample-docx/located.json

# 4. S3/S4：逐条评审并生成报告 -> data/out/
# （待实现）
```

真实工程标书为 PDF，S1 的 PDF 路径见 `docs/issues.md` P0；在 PDF 路径实现前，
样例 docx 数据用于守住 S2 检索算法的回归测试。


## 哪些进 git，哪些不进

| 路径 | 进 git | 理由 |
|---|---|---|
| `projects/*/manifest.json` | ✅ | 几百字节，是目录的说明书 |
| `projects/_sample-docx/**` | ✅ | 软件类样例，合计 5 MB，`tests/test_s2_regression.py` 的输入 |
| `projects/jiyang-epc/sections/` | ❌ | 12 家技术标全文，约 33 MB |
| `projects/jiyang-epc/sections_all.json` | ❌ | 同上内容再存一遍，约 33 MB |
| `projects/jiyang-epc/evidence/` | ❌ | 投标文件原文片段 |

不进 git 有两个理由，缺一条也仍然成立：体积（合计约 66 MB，每重跑一次 git 就长一次），
以及内容——那是 12 家投标人的技术标全文，开标评标期间不宜进仓库（哪怕是私有仓）。
`原始资料/` 被 ignore 的意义会被这个衍生物抵消。

**不进 git 的怎么重建**（换机器、新克隆都跑这两条，约 40 秒）：

```bash
python src/s1_ingest.py --project "原始资料/实际测试工程文件/济阳区实验高级中学项目工程总承包（EPC） 2" data/projects/jiyang-epc
python scripts/merge_sections.py data/projects/jiyang-epc
```

前置：`原始资料/` 下要有真实标书，该目录同样不进 git。
