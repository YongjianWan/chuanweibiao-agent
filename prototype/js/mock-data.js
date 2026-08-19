(function () {
  const bidders = [
    { id: "zhongye", name: "中冶建工集团有限公司8010856", short: "中冶建工", pdfCount: 20, chars: 567000 },
    { id: "zhongjian1", name: "中国建筑一局（集团）有限公司8004216", short: "中建一局", pdfCount: 20, chars: 781000 },
    { id: "jinan1", name: "济南一建集团有限公司8008754", short: "济南一建", pdfCount: 20, chars: 429000 },
    { id: "zhongjian2", name: "中国建筑第二工程局有限公司8001968", short: "中建二局", pdfCount: 20, chars: 906000 },
    { id: "zhongjian5", name: "中国建筑第五工程局有限公司8002423", short: "中建五局", pdfCount: 20, chars: 632000 },
    { id: "zhongtie", name: "中铁建工集团有限公司8010219", short: "中铁建工", pdfCount: 20, chars: 1126000 },
    { id: "shandong3", name: "山东三箭建设工程股份有限公司8003180", short: "山东三箭", pdfCount: 20, chars: 728000 },
    { id: "qingjian", name: "青建集团股份公司8006620", short: "青建集团", pdfCount: 20, chars: 854000 },
    { id: "tianqi", name: "天齐置业集团股份有限公司8007234", short: "天齐集团", pdfCount: 20, chars: 295000 },
    { id: "zhongqing", name: "中青建安建设集团有限公司8005591", short: "中青建安", pdfCount: 20, chars: 1004000 },
    { id: "dezhou", name: "德州建设集团有限公司8007782", short: "德州建设", pdfCount: 20, chars: 1580000 },
    { id: "shandongluqiao", name: "山东路桥集团有限公司8009083", short: "山东路桥", pdfCount: 20, chars: 2260000 }
  ];

  const guids = [
    "75bd5598-9f76-4e3b-8a0a-d494380d4d9d",
    "108d538f-85b8-4c7d-b32c-f6acdaa187b9",
    "7c2f86a9-21bb-4ea2-a55c-6c1f2b407b1d",
    "123a9226-d66e-4ace-8dc4-65a76a8282fa",
    "9d7303c2-f91b-4078-a3aa-61c29d72d6e1",
    "4a348c28-6f7d-49d6-88f9-1af12ef35f71",
    "842f52f7-1a6e-4f53-85ef-cad97ad7b520",
    "5167466c-9ddf-4b1b-a589-f71e6e73b492",
    "7f60614c-74a3-43a1-97c4-18837b1a89cb",
    "969a7dd0-f36e-4907-a6e2-26c59cf02810",
    "f4a0fc84-b5c0-4761-b2b7-f5d12999646b",
    "a6ba629d-30e4-4334-bafd-eec7a962c01a",
    "e36891df-6503-4b22-9cf5-7a6ac64c5aa0",
    "617ee02f-8512-4e1c-87d6-6752e95cb853",
    "1d9a7d7f-195d-4e31-94ff-a346320f7211",
    "885bbcd1-922d-44e2-b9ab-c93f9b595f4f",
    "23d9ccf8-8db4-427f-946a-c2b75d8c7bde",
    "afc25aa4-38b8-4384-8e35-f81e63e69590",
    "d9947cd4-a5cb-42f2-80ea-b2dd798d90da"
  ];

  const itemDefs = [
    ["T-01", "设计任务书优化", 20],
    ["T-02", "进度管理方案", 4],
    ["T-03", "费用及资金管理方案", 3],
    ["T-04", "施工方案及技术措施", 8],
    ["T-05", "服务采购管理方案", 3],
    ["T-06", "质量管理体系与措施", 6],
    ["T-07", "安全管理体系与措施", 6],
    ["T-08", "文明施工及环境保护措施", 5],
    ["T-09", "施工总进度计划及保证措施", 5],
    ["T-10", "资源配备计划", 5],
    ["T-11", "劳动力安排计划", 4],
    ["T-12", "材料设备采购计划", 4],
    ["T-13", "BIM 技术应用方案", 4],
    ["T-14", "EPC 总承包管理方案", 4],
    ["T-15", "各专业施工图设计安排协调时间保证措施", 4],
    ["T-16", "工程重点难点分析", 4],
    ["T-17", "应急处置预案", 4],
    ["T-18", "成品保护及移交方案", 3],
    ["T-19", "绿色建造与扬尘治理措施", 4]
  ];

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  const LOW_CONFIDENCE_THRESHOLD = 0.85;

  function normalizeFactors(factors) {
    const total = factors.reduce((sum, factor) => sum + factor.weight, 0);
    let used = 0;
    return factors.map((factor, index) => {
      const isLast = index === factors.length - 1;
      const weight = isLast ? round2(1 - used) : round2(factor.weight / total);
      used += weight;
      return { ...factor, weight };
    });
  }

  function makeTiers(maxScore) {
    return [
      {
        tier: "优",
        min: round1(maxScore * 0.75),
        max: maxScore,
        desc: "内容完整，措施明确，针对本项目特点提出可执行安排。"
      },
      {
        tier: "良",
        min: round1(maxScore * 0.5),
        max: round1(maxScore * 0.75),
        desc: "主要内容完整，关键措施基本可行，针对性仍有不足。"
      },
      {
        tier: "一般",
        min: round1(maxScore * 0.25),
        max: round1(maxScore * 0.5),
        desc: "覆盖基本要求，但内容较概括，细化程度不足。"
      }
    ];
  }

  function makeFactors(name, idx) {
    if (name === "进度管理方案") {
      return normalizeFactors([
        {
          name: "施工进度计划编制与关键路径分析",
          weight: 0.35,
          sub: [
            { name: "总体进度计划合理性", weight: 0.4, desc: "计划是否覆盖设计、采购、施工关键节点。" },
            { name: "关键路径与里程碑节点控制", weight: 0.35, desc: "是否识别制约工期的关键线路。" },
            { name: "工序衔接与流水施工组织", weight: 0.25, desc: "工序穿插和流水节拍是否清楚。" }
          ]
        },
        {
          name: "设计进度管理与协同机制",
          weight: 0.25,
          sub: [
            { name: "设计出图计划", weight: 0.5, desc: "设计成果提交与审查节点是否明确。" },
            { name: "设计施工协同", weight: 0.5, desc: "是否说明 EPC 模式下协同机制。" }
          ]
        },
        {
          name: "进度保障措施与资源配置",
          weight: 0.25,
          sub: [
            { name: "劳动力保障", weight: 0.34, desc: "劳动力配置是否匹配工期。" },
            { name: "材料设备保障", weight: 0.33, desc: "材料设备供应是否有保障。" },
            { name: "赶工措施", weight: 0.33, desc: "风险情况下是否有赶工预案。" }
          ]
        },
        {
          name: "进度监测、预警与纠偏机制",
          weight: 0.15,
          sub: [
            { name: "动态监测", weight: 0.5, desc: "是否建立进度跟踪机制。" },
            { name: "预警纠偏", weight: 0.5, desc: "是否说明偏差处理办法。" }
          ]
        }
      ]);
    }

    const factors = [
      {
        name: name + "完整性",
        weight: 0.34,
        sub: [
          { name: "内容覆盖", weight: 0.5, desc: "是否覆盖招标文件要求的主要内容。" },
          { name: "章节组织", weight: 0.5, desc: "结构是否完整清楚。" }
        ]
      },
      {
        name: name + "针对性",
        weight: 0.33,
        sub: [
          { name: "项目特征响应", weight: 0.5, desc: "是否结合本项目工程特点。" },
          { name: "关键风险识别", weight: 0.5, desc: "是否识别关键难点。" }
        ]
      },
      {
        name: name + "可执行性",
        weight: 0.33,
        sub: [
          { name: "责任与节点", weight: 0.5, desc: "责任分工和时间节点是否明确。" },
          { name: "保障措施", weight: 0.5, desc: "措施是否具备落地条件。" }
        ]
      }
    ].map((factor, factorIndex) => ({
      ...factor,
      weight: idx % 4 === factorIndex ? round1(factor.weight + 0.02) : factor.weight
    }));
    return normalizeFactors(factors);
  }

  const items = itemDefs.map(([id, name, maxScore], index) => ({
    id,
    guid: guids[index],
    name,
    max_score: maxScore,
    source: "招标文件.pdf 第 33~37 页",
    bound_count: 12,
    expected_bidders: 12,
    tiers: makeTiers(maxScore),
    factors: makeFactors(name, index),
    synonyms: name === "进度管理方案" ? ["香蕉曲线", "S 曲线", "关键线路"] : []
  }));

  const scoringTable = {
    project: "济阳区实验高级中学项目工程总承包（EPC）",
    source: "招标文件.pdf 第 33~37 页",
    prepared: true,
    prepared_label: "评分规则已准备",
    rules: ["内容不全酌情扣分", "若此条缺项不得分"],
    items
  };

  const projectSummary = "本项目为济阳区实验高级中学工程总承包（EPC）静态原型示例，建设内容包含设计、施工及相关总承包管理工作。评审重点关注投标文件是否围绕房建工程特点、工期组织、质量安全、资源保障、专业协同与可追溯证据展开。该摘要为 Mock 占位文本，用于展示页面结构，不代表实际 S0 抽取结果。";

  function mockModelTier(item, bidderIndex, itemIndex) {
    if (itemIndex === 18) return null;
    const bucket = (bidderIndex * 7 + itemIndex * 5) % 10;
    const tierName = bucket >= 7 ? "优" : bucket >= 3 ? "良" : "一般";
    return item.tiers.find((tier) => tier.tier === tierName);
  }

  function mockCompletionRate(bidderIndex, itemIndex) {
    return round2(0.46 + ((bidderIndex * 11 + itemIndex * 7) % 35) / 100);
  }

  function factorScores(item, bidderIndex, itemIndex, targetRate) {
    if (item.id === "T-05" || item.id === "T-18") return null;
    return item.factors.map((factor, factorIndex) => ({
      name: factor.name,
      weight: factor.weight,
      value: round2(Math.min(0.95, Math.max(0.05, targetRate + ((((bidderIndex + itemIndex + factorIndex) % 3) - 1) * 0.04))))
    }));
  }

  function weightedRate(factors, fallbackRate) {
    if (!factors || !factors.length) return fallbackRate;
    return round2(factors.reduce((sum, factor) => sum + factor.weight * factor.value, 0));
  }

  function scoreInTier(tier, rate) {
    if (!tier) return 0;
    const score = round1(tier.min + rate * (tier.max - tier.min));
    if (tier.tier !== "优" && score >= tier.max) {
      return round1(tier.max - 0.1);
    }
    return score;
  }

  const sectionBlocks = [];

  function makeEvidencePackage(bidder, item, bidderIndex, itemIndex, resultStatus, score) {
    const fileStem = item.name.length > 14 ? item.name.slice(0, 14) : item.name;
    const file = fileStem + item.guid.toUpperCase() + ".pdf";
    const noEvidence = score === 0;
    const picked = noEvidence ? [] : [
      {
        section_id: (itemIndex + 1) + "#2.1",
        file,
        item_id: item.id,
        item_guid: item.guid,
        bidder: bidder.name,
        bidder_id: bidder.id,
        page: 12 + ((bidderIndex + itemIndex) % 16),
        level: 3,
        path: ["第二章 施工组织", "2.1 总体部署", "2.1.4 施工段划分"],
        unit: ["第二章 施工组织", "2.1 总体部署"],
        match_score: round1(17.8 + ((bidderIndex + itemIndex) % 9)),
        hit: ["t:总体部署", "b:关键节点", "b:本项目"],
        chars: 860,
        truncated: false,
        text: "本工程按教学区、配套用房及室外工程分区组织施工，结合现场移交条件设置流水作业段，并对关键节点、材料进场和专业穿插进行动态控制。"
      },
      {
        section_id: (itemIndex + 1) + "#2.2",
        file,
        item_id: item.id,
        item_guid: item.guid,
        bidder: bidder.name,
        bidder_id: bidder.id,
        page: 14 + ((bidderIndex + itemIndex) % 18),
        level: 2,
        path: ["第二章 施工组织", "2.2 阶段目标"],
        unit: ["第二章 施工组织", "2.2 阶段目标"],
        match_score: round1(14.1 + ((bidderIndex * 2 + itemIndex) % 7)),
        hit: ["b:里程碑", "b:EPC 协同"],
        chars: 740,
        truncated: item.id === "T-09",
        parse_hint: item.id === "T-09" ? "解析提示：该证据来自进度表格附近文本，建议人工复核。" : "",
        text: "设计、采购、施工各阶段设置里程碑节点，项目部按周检查完成情况。对可能影响工期的审批、材料供应和专业交叉问题建立预警纠偏机制。"
      }
    ];

    picked.forEach((row) => {
      sectionBlocks.push({
        id: row.section_id,
        bidder: row.bidder,
        bidder_id: row.bidder_id,
        item_id: row.item_id,
        item_guid: row.item_guid,
        file: row.file,
        page: row.page,
        level: row.level,
        path: row.path,
        text: row.text,
        chars: row.chars
      });
    });

    return {
      item_id: item.id,
      item_guid: item.guid,
      bidder: bidder.name,
      bidder_id: bidder.id,
      name: item.name,
      candidates: noEvidence ? 0 : 18 + ((bidderIndex + itemIndex) % 15),
      units: noEvidence ? 0 : picked.length,
      fallback: item.id === "T-02" && bidder.id === "jinan1",
      evidence_chars: noEvidence ? 0 : picked.reduce((sum, row) => sum + row.chars, 0),
      budget: 3000,
      picked
    };
  }

  const evidencePackages = {};
  const reviewResults = [];

  bidders.forEach((bidder, bidderIndex) => {
    items.forEach((item, itemIndex) => {
      const key = bidder.id + "__" + item.id;
      let status = "rated";
      let tier = mockModelTier(item, bidderIndex, itemIndex);
      let rate = mockCompletionRate(bidderIndex, itemIndex);
      let factors = tier ? factorScores(item, bidderIndex, itemIndex, rate) : null;
      let score = scoreInTier(tier, weightedRate(factors, rate));
      let attempts = 1;
      let confidence = round2(0.78 + ((bidderIndex + itemIndex) % 5) * 0.04);
      let last_error = "";

      if (bidder.id === "zhongjian1" && item.id === "T-05") {
        status = "unrated";
        tier = null;
        factors = null;
        score = null;
        attempts = 3;
        confidence = 0;
        last_error = "JSON 解析失败";
      }

      if (bidder.id === "jinan1" && item.id === "T-02") {
        tier = item.tiers.find((row) => row.tier === "良");
        factors = factorScores(item, bidderIndex, itemIndex, 0.1);
        score = scoreInTier(tier, weightedRate(factors, 0.1));
        confidence = 0.63;
        attempts = 2;
      }

      if (bidder.id === "zhongjian2" && item.id === "T-06") {
        attempts = 2;
        confidence = 0.81;
      }

      if (item.id === "T-19") {
        confidence = 0.91;
      }

      const result = {
        item_id: item.id,
        item_guid: item.guid,
        bidder: bidder.name,
        bidder_id: bidder.id,
        status,
        tier: tier ? tier.tier : null,
        score,
        cite: score === 0 ? [] : [0, 1],
        reason: score === 0
          ? "证据定位未检索到与该评分项直接相关的合格章节，按招标文件规则“若此条缺项不得分”处理为 0 分。"
          : "投标文件覆盖了主要评审要求，能够说明组织安排、节点控制和保障措施；部分内容仍偏概括，与本项目 EPC 协同和现场条件结合不够充分。",
        confidence,
        attempts,
        last_error,
        perf: {
          in_tokens: status === "unrated" ? 3560 : 2600 + ((bidderIndex + 1) * 137 + itemIndex * 43),
          out_tokens: status === "unrated" ? 0 : 138 + ((bidderIndex + itemIndex) % 60),
          latency_ms: status === "unrated" ? 23600 : 6200 + ((bidderIndex * 421 + itemIndex * 317) % 6800)
        }
      };

      if (status === "rated" && score !== 0 && factors) {
        result.factor_scores = factors;
      }

      reviewResults.push(result);
      evidencePackages[key] = makeEvidencePackage(bidder, item, bidderIndex, itemIndex, status, score);
    });
  });

  function resultFor(bidderId, itemId) {
    return reviewResults.find((row) => row.bidder_id === bidderId && row.item_id === itemId);
  }

  const matrix = items.map((item) => {
    const scores = {};
    bidders.forEach((bidder) => {
      scores[bidder.name] = resultFor(bidder.id, item.id).score;
    });
    return {
      item_id: item.id,
      name: item.name,
      max_score: item.max_score,
      scores
    };
  });

  const totals = {};
  bidders.forEach((bidder) => {
    const rows = reviewResults.filter((row) => row.bidder_id === bidder.id);
    totals[bidder.name] = {
      score: round1(rows.reduce((sum, row) => sum + (typeof row.score === "number" ? row.score : 0), 0)),
      unrated: rows.filter((row) => row.status === "unrated").length
    };
  });

  const reportData = {
    project: scoringTable.project,
    generated_at: "2026-08-21T14:03:11+08:00",
    bidders: bidders.map((bidder) => bidder.name),
    matrix,
    totals,
    details: reviewResults,
    unrated: reviewResults
      .filter((row) => row.status === "unrated")
      .map((row) => ({
        bidder: row.bidder,
        item_id: row.item_id,
        attempts: row.attempts,
        last_error: row.last_error
      })),
    review_flags: reviewResults
      .filter((row) => row.status === "rated" && row.score !== 0 && row.confidence < LOW_CONFIDENCE_THRESHOLD)
      .map((row) => ({
        bidder: row.bidder,
        item_id: row.item_id,
        confidence: row.confidence,
        why: row.attempts > 1 ? "fallback 证据或重试后成功" : "证据置信度偏低"
      })),
    perf: {
      wall_clock_sec: 582,
      concurrency: 8,
      calls: 228,
      retries: reviewResults.reduce((sum, row) => sum + Math.max(row.attempts - 1, 0), 0),
      in_tokens: reviewResults.reduce((sum, row) => sum + row.perf.in_tokens, 0),
      out_tokens: reviewResults.reduce((sum, row) => sum + row.perf.out_tokens, 0),
      gpu: "未采集",
      vram_peak_gb: null,
      gpu_note: "模型为远程托管端点时，我方进程内无法采集显存；此处为 Mock 占位展示。"
    }
  };

  const runEvents = [
    { type: "stage", stage: "PDF 入库", status: "running", message: "开始读取 12 家投标技术标 PDF" },
    { type: "stage", stage: "PDF 入库", status: "done", message: "完成 240 个技术标 PDF 入库，封面文件不参与评分" },
    { type: "stage", stage: "证据定位", status: "running", message: "按评分项绑定关系进入单 PDF 内部定位证据" },
    { type: "stage", stage: "证据定位", status: "done", message: "证据包已生成，逐项评审开始" },
    { type: "retry", bidder_id: "zhongjian2", item_id: "T-06", attempt: 1, max_attempts: 3, message: "模型返回格式不完整，准备重试" },
    { type: "retry", bidder_id: "jinan1", item_id: "T-02", attempt: 1, max_attempts: 3, message: "引用编号校验失败，准备重试" }
  ];

  reviewResults.forEach((result) => {
    runEvents.push({
      type: "review",
      bidder_id: result.bidder_id,
      item_id: result.item_id,
      status: result.status,
      score: result.score,
      tier: result.tier,
      confidence: result.confidence,
      attempts: result.attempts,
      in_tokens: result.perf.in_tokens,
      out_tokens: result.perf.out_tokens,
      latency_ms: result.perf.latency_ms
    });
  });

  runEvents.push({ type: "stage", stage: "结果汇总", status: "running", message: "生成并排结果矩阵和未评定清单" });
  runEvents.push({ type: "stage", stage: "结果汇总", status: "done", message: "报告数据已汇总完成" });

  window.PROTOTYPE_DATA = {
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    scoringTable,
    projectSummary,
    bidders,
    sectionBlocks,
    evidencePackages,
    reviewResults,
    reportData,
    runEvents
  };
})();
