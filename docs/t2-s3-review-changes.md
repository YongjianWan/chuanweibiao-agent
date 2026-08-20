# T2 / S3 评审引擎改动清单

> 来源：Issue #8 及其补充评论  
> 适用范围：`feat/t2-s3-review` 分支  
> 目标：按已定案的架构决策拆除「要素加权定分」，使 S3 与真实评分表、数据契约对齐。

---

## 1. 背景与决策前提

主分支 `168d1bc` 已将评分表结构从 `factors + sub` 改为 `aspects`，并定案：

- **不做要素加权定分**。加权只影响档内小数点位置，配置成本（≈230 条）与收益不成比例。
- `tier`：由模型对照招标文件档位描述原文判定。
- `score`：由模型直接在档区间内给出，系统只校验是否落在区间内；越界走现有重试路径。
- `aspects`：只作为 S2 检索词来源，不带权重、不参与判分。

因此 S3 需要同步清理所有「要素加权」残留代码与校验。

---

## 2. 改动范围

改动集中在 `src/s3_review.py`、`tests/test_s3_review.py` 与相关文档；模型客户端骨架（`OpenAICompatibleClient`）与调用流程保持不变。

---

## 3. `src/s3_review.py`

### 3.1 `_validate_scoring_item()`

当前问题：函数仍硬要求 `factors` 字段并校验权重和为 1.0，与 `168d1bc` 后的 `aspects` 评分表冲突，导致真实 yaml 19/19 报 `"评分项缺少字段：factors"`。

| 动作 | 内容 |
|---|---|
| 删除 | `required` 元组中的 `"factors"` |
| 删除 | `factors` 非空校验 |
| 删除 | factor 名称非空/唯一校验 |
| 删除 | 权重和必须为 1.0 的整段校验（`:405-417`） |
| 保留 | `tiers` 必须含 `tier/min/max/desc` 的校验 |
| 保留 | tiers 按分值降序排列、区间有效的校验 |

### 3.2 `_validate_model_output()`

| 动作 | 内容 |
|---|---|
| 删除 | `factor_scores` 字段存在性与数组类型校验 |
| 删除 | `factor_scores` 与配置集合完全相等的校验（含中文要素名逐字回显） |
| 新增 | `score` 字段必须存在且为数字 |
| 新增 | `score` 区间校验：落在 `tier` 对应区间内；边界按 `data-contract.md` 约定 |
| 建议 | 允许 `cite` 为空数组（配合非空 `reason`），避免正常低分/未命中情形被重试耗尽成 `unrated` |

**score 边界归属（必须写死）：**

- 最高档：闭区间 `[min, max]`
- 其他档：左闭右开 `[min, max)`

> 例：T-02「良 2.0-3.0」应接受 `score: 3.0`，拒绝 `score: 2.0` 时按左边界规则仍属合法；重点是避免 `3.0` 被误判为越界。

### 3.3 `_score_and_confidence()`

| 动作 | 内容 |
|---|---|
| 删除 | `score = tier.min + Σ(weight × value) × (tier.max - tier.min)` 整段计算 |
| 改为 | 从模型输出读取 `score`，程序只做校验（校验逻辑上移到 `_validate_model_output()`） |
| 删除 | 四因素中的「打架」因素 |
| 保留 | 三因素：`降级 ×0.7`、`截断 ×0.9`、`重试 ×0.9` |

**confidence 阈值表回退到三因素：**

| confidence | 组合 | 是否标 ⚠ |
|---|---|---|
| 0.900 | 仅截断；仅重试 | 否 |
| 0.810 | 截断 + 重试 | 是 |
| 0.700 | 仅降级 | 是 |
| 0.630 | 降级 + 截断；降级 + 重试 | 是 |
| 0.567 | 降级 + 截断 + 重试 | 是 |

阈值保持 `0.85`，等效规则：除「仅被截断」和「仅重试过」外一律标 ⚠。

### 3.4 `build_messages()`

| 动作 | 内容 |
|---|---|
| 删除 | prompt 中传递 `factors` |
| 改为 | 把 `tiers[].desc` 作为模型判档位的主依据讲清楚 |
| 更新 | system prompt：不再要求 `factor_scores`，改为要求 `tier/score/cite/reason` |

### 3.5 `MockModelClient`

| 动作 | 内容 |
|---|---|
| 删除 | 生成 `factor_scores` |
| 改为 | 直接生成落在中间档区间内的 `score` |
| 改为 | `cite` 允许为空数组（当 `picked` 为空时） |

### 3.6 输出结构

| 字段 | 处理 |
|---|---|
| `factor_scores` | 删除 |
| `confidence_factors` | 删除（或按团队约定决定是否保留内部调试） |
| `last_error` | 保留，并补进 `data-contract.md` |

### 3.7 `review_all()` 的 `perf.calls` 口径

当前 `calls = sum(attempts)`，未命中项 `attempts=0` 不计入，与文档示例 `calls: 228`（评审项数）口径不一致。

建议：改为 `calls = len(results)`（即评审项数，含未命中项），`retries` 仍按 `sum(max(attempts - 1, 0))` 计算。

---

## 4. `tests/test_s3_review.py`

### 4.1 同步现有断言

- 去掉 `factor_scores` 相关断言。
- `score` 断言改为模型直接给出的值（不再是 2.6 等加权计算值）。
- `confidence` 断言改为三因素组合（如 `0.9`、`0.81`、`0.7` 等）。
- 去掉「打架」因素相关测试用例与断言。

### 4.2 新增真实评分表校验测试

必须新增一条测试，读取 `config/projects/济阳区实验高级中学.yaml`，对全部 19 项调用 `_validate_scoring_item()`，断言 19/19 通过。

```python
def test_real_scoring_table_passes_validation():
    import yaml
    path = Path("config/projects/济阳区实验高级中学.yaml")
    table = yaml.safe_load(path.read_text(encoding="utf-8"))
    ok = 0
    for item in table["items"]:
        _validate_scoring_item(item)
        ok += 1
    assert ok == len(table["items"]) == 19
```

> 这是本轮完成判定的硬门槛，否则测试全绿仍会漏掉「代码与真实配置脱节」的问题。

### 4.3 测试 import 风格

改为与 `tests/test_s2_regression.py` 一致：

```python
import sys
sys.path.insert(0, "src")
from s3_review import ...
```

使 `pytest tests/` 能直接跑，而不必 `python -m pytest`。

---

## 5. 文档同步

### 5.1 `README.md`

| 位置 | 内容 |
|---|---|
| §3.1 差异表 | 更新 T2 当前实现与目标状态的差异 |
| §4 评审结果结构 | 删除 `factor_scores` 字段；更新 `score` 来源说明；confidence 改为三因素 |
| §4 阈值表 | 用三因素 7 组合替换四因素 15 组合表 |
| §4「档位与分数各由什么决定」 | 改为：tier 和 score 都由模型判定，程序只校验 |
| §5.3 页面⑤ | 删除或标注「区间内定分」块为可选/已砍 |
| §7 T2 状态 | 更新为「进行中」，说明已去掉要素加权 |
| §10 目录结构 | `src/s3_review.py` 已存在，更新状态 |

### 5.2 `docs/data-contract.md`

- 同步 `aspects` 不是 `factors`。
- 同步 `score` 由模型给出、系统校验区间。
- 补 `last_error` 字段说明。
- 同步 confidence 三因素与阈值表。

### 5.3 `requirements-dev.txt` 安装说明

如 README §10 或相关段落有安装命令，同步说明：

```bash
pip install -r requirements.txt
pip install -r requirements-dev.txt
python -m pytest tests/ -q
```

---

## 6. Git 操作

- `git fetch origin`
- `git merge origin/main`（当前落后 15 个 commit）
- 处理可能的冲突，重点检查 `config/projects/济阳区实验高级中学.yaml` 的 `aspects` 结构

---

## 7. 阻塞项与依赖（非 T2 负责，但影响验收）

| 阻塞 | 责任方 | 影响 |
|---|---|---|
| `tiers[].desc` 未补全 | YongjianWan | 真实 yaml 即使 `_validate_scoring_item()` 通过，后续 S3 prompt 也缺判档依据 |
| S2 未适配评分表 + 多投标人（T8） | 后端 | 产不出带 `bidder/item_id/aspects` 的真实证据包，**真正端到端要等 T8** |
| 模型端点 B2 | Aiden | 真实模型调用测不了，只能用 mock |

> 本轮 T2 完成判定的上限是：**代码改对 + 测试全绿 + 用构造证据包把单项跑通**。不要承诺「真实端到端跑一次」，S2 还没ready。

---

## 8. 完成判定（验收标准）

全部满足才算 T2 本轮完成：

1. `src/s3_review.py` 中无 `factor_scores`/`factors` 加权残留。
2. `_validate_scoring_item()` 通过 `config/projects/济阳区实验高级中学.yaml` 全部 19 项校验。
3. `_validate_model_output()` 对 `score` 做正确区间校验（边界归属写死）。
4. `confidence` 只保留三因素，阈值表与 `0.85` 对齐。
5. `MockModelClient` 与 `tests/test_s3_review.py` 断言同步。
6. 新增真实 yaml 校验测试，且 19/19 通过。
7. `python -m pytest tests/ -q` 全绿（或 `pytest tests/ -q` 在 import 风格改后也能绿）。
8. `git merge origin/main` 无冲突，合并后测试仍全绿。
9. README / data-contract.md 中相关字段、阈值表、T2 状态已同步。

---

## 9. 改动文件清单

```
src/s3_review.py                  # 主要改动
tests/test_s3_review.py           # 断言同步 + 新增真实 yaml 测试
README.md                         # 数据契约、阈值表、T2 状态同步
docs/data-contract.md             # 同步 score、confidence、last_error
docs/t2-s3-review-changes.md      # 本文件
```

可能涉及：

```
prototype/js/mock-data.js         # 若原型仍展示 factor_scores，需同步删除
scripts/build-prototype-mock.js   # 同步生成逻辑
```
