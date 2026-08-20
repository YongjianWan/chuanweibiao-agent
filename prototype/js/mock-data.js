(function () {
  const bidders = [
    { id: "zhongye", name: "中冶建工集团有限公司8010856", short: "中冶建工", pdfCount: 20, chars: 535000 },
    { id: "zhongjian1", name: "中国建筑一局（集团）有限公司8004216", short: "中建一局", pdfCount: 20, chars: 742000 },
    { id: "jinan1", name: "济南一建集团有限公司8008754", short: "济南一建", pdfCount: 20, chars: 412000 },
    { id: "zhongjian2", name: "中国建筑第二工程局有限公司8001968", short: "中建二局", pdfCount: 20, chars: 861000 },
    { id: "zhongjian5", name: "中国建筑第五工程局有限公司8002423", short: "中建五局", pdfCount: 20, chars: 602000 },
    { id: "zhongtie", name: "中铁建工集团有限公司8010219", short: "中铁建工", pdfCount: 20, chars: 1072000 },
    { id: "shandong3", name: "山东三箭建设工程股份有限公司8003180", short: "山东三箭", pdfCount: 20, chars: 692000 },
    { id: "qingjian", name: "青建集团股份公司8006620", short: "青建集团", pdfCount: 20, chars: 812000 },
    { id: "tianqi", name: "天齐置业集团股份有限公司8007234", short: "天齐集团", pdfCount: 20, chars: 295000 },
    { id: "zhongqing", name: "中青建安建设集团有限公司8005591", short: "中青建安", pdfCount: 20, chars: 954000 },
    { id: "dezhou", name: "德州建设集团有限公司8007782", short: "德州建设", pdfCount: 20, chars: 1233000 },
    { id: "shandongluqiao", name: "山东路桥集团有限公司8009083", short: "山东路桥", pdfCount: 20, chars: 2260000 }
  ];

  const itemDefs = [
    {
      "id": "T-01",
      "guid": "75bd5598-9f76-4e3b-8a0a-d494380d4d9d",
      "name": "设计任务书优化",
      "max_score": 20.0,
      "tiers": [
        {
          "tier": "优",
          "min": 17.0,
          "max": 20.0
        },
        {
          "tier": "良",
          "min": 14.0,
          "max": 17.0
        },
        {
          "tier": "一般",
          "min": 10.0,
          "max": 14.0
        }
      ],
      "aspects": [
        "设计需求深度解析与目标对齐",
        "优化建议的具体性与可行性",
        "工程设计要求满足度",
        "设计质量保证措施"
      ],
      "criteria": "设计任务书优化：根据招标人提供的设计任务书进行优化，提出优化建议，满足工程设计要求，设计质量保证措施等具体、可行，评委根据投标文件情况分为一般、良、优，分别酌情得10-14 分、14-17 分、17-20分，内容不全酌情扣分，若此条缺项不得分。相关标书内容在设计任务书优化中体现。",
      "synonyms": []
    },
    {
      "id": "T-02",
      "guid": "108d538f-85b8-4c7d-b32c-f6acdaa187b9",
      "name": "进度管理方案",
      "max_score": 4.0,
      "tiers": [
        {
          "tier": "优",
          "min": 3.0,
          "max": 4.0
        },
        {
          "tier": "良",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 2.0
        }
      ],
      "aspects": [
        "施工进度计划编制与关键路径分析",
        "设计进度管理与协同机制",
        "进度保障措施与资源配置",
        "进度监测、预警与纠偏机制"
      ],
      "criteria": "进度管理方案，包括施工进度和设计进度等各方面；评委根据投标文件情况分为一般、良、优，分别酌情得1-2 分、2-3 分、3-4 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在进度管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-03",
      "guid": "9e60551f-c8b5-4b2b-81aa-ceb4b4a86d2d",
      "name": "费用及资金管理方案",
      "max_score": 3.0,
      "tiers": [
        {
          "tier": "优",
          "min": 2.5,
          "max": 3.0
        },
        {
          "tier": "良",
          "min": 1.7,
          "max": 2.5
        },
        {
          "tier": "一般",
          "min": 1.2,
          "max": 1.7
        }
      ],
      "aspects": [
        "费用预算编制与成本控制体系",
        "资金筹措与使用计划",
        "财务风险防控与应急预案",
        "资金监管与审计配合机制"
      ],
      "criteria": "费用及资金管理方案；评委根据投标文件情况分为一般、良、优，分别酌情得1.2-1.7 分、1.7-2.5 分、2.5-3分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在费用及资金管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-04",
      "guid": "255bb711-dc0e-4968-bf39-2a61b0abc8eb",
      "name": "质量管理方案",
      "max_score": 4.0,
      "tiers": [
        {
          "tier": "优",
          "min": 3.0,
          "max": 4.0
        },
        {
          "tier": "良",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 2.0
        }
      ],
      "aspects": [
        "工程整体质量管控体系",
        "进场材料设备质量标准管控",
        "材料设备品牌档次管控措施",
        "规格型号一致性管控"
      ],
      "criteria": "质量管理方案；对工程整体质量及进场的材料设备质量标准、品牌档次、规格型号等的管控措施合理可行。评委根据投标文件情况分为一般、良、优，分别酌情得1-2 分、2-3 分、3-4 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在质量管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-05",
      "guid": "acabee9d-b7e9-4461-9491-1ee7dacefac3",
      "name": "安全、职业健康和环境管理方案",
      "max_score": 4.0,
      "tiers": [
        {
          "tier": "优",
          "min": 3.0,
          "max": 4.0
        },
        {
          "tier": "良",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 2.0
        }
      ],
      "aspects": [
        "安全管理体系与组织架构",
        "安全风险管控与防护措施",
        "职业健康管理方案",
        "环境保护与文明施工措施"
      ],
      "criteria": "安全、职业健康和环境管理方案；评委根据投标文件情况分为一般、良、优，分别酌情得1-2 分、2-3 分、3-4 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在安全、职业健康和环境管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-06",
      "guid": "8dc6e95d-ae6a-4422-8ff7-b7b2939ff724",
      "name": "调试、试运行与移交管理方案",
      "max_score": 4.0,
      "tiers": [
        {
          "tier": "优",
          "min": 3.0,
          "max": 4.0
        },
        {
          "tier": "良",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 2.0
        }
      ],
      "aspects": [
        "调试组织与实施策略",
        "多方协调与配合机制",
        "试运行保障与应急预案",
        "移交管理与资料归档"
      ],
      "criteria": "调试、试运行与移交管理方案；评委根据投标文件中调试、试运行与移交过程中协调、配合招标人移交措施等方案情况分为一般、良、优，分别酌情得1-2 分、2-3 分、3-4 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在调试、试运行与移交管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-07",
      "guid": "51f11a77-e946-4abd-ba0f-b5f47ceb9e04",
      "name": "风险管理方案",
      "max_score": 3.0,
      "tiers": [
        {
          "tier": "优",
          "min": 2.5,
          "max": 3.0
        },
        {
          "tier": "良",
          "min": 1.7,
          "max": 2.5
        },
        {
          "tier": "一般",
          "min": 1.2,
          "max": 1.7
        }
      ],
      "aspects": [
        "风险识别与评估体系",
        "风险应对策略与措施",
        "应急响应与处置机制",
        "风险监控与动态管理"
      ],
      "criteria": "风险管理方案；评委根据投标文件情况分为一般、良、优，分别酌情得1.2-1.7 分、1.7-2.5 分、2.5-3 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在风险管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-08",
      "guid": "83e39679-fabf-4dd1-ba31-224dc2d2d51f",
      "name": "沟通协调方案",
      "max_score": 3.0,
      "tiers": [
        {
          "tier": "优",
          "min": 2.5,
          "max": 3.0
        },
        {
          "tier": "良",
          "min": 2.0,
          "max": 2.5
        },
        {
          "tier": "一般",
          "min": 1.5,
          "max": 2.0
        }
      ],
      "aspects": [
        "行政审批协助与手续办理机制",
        "职能部门沟通策略与承诺办法",
        "外部关系协调与冲突解决机制",
        "信息反馈与闭环管理体系"
      ],
      "criteria": "沟通协调方案；评委根据投标文件中协助招标人办理各种手续、同职能部门的沟通协调承诺办法等情况分为一般、良、优，分别酌情得1.5-2 分、2-2.5 分、2.5-3分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在沟通协调方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-09",
      "guid": "3a101949-3b00-4c83-a62a-fafe13ac376e",
      "name": "合同管理与信息管理方案，有完善的信息管理系统",
      "max_score": 3.0,
      "tiers": [
        {
          "tier": "优",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "良",
          "min": 1.0,
          "max": 2.0
        },
        {
          "tier": "一般",
          "min": 0.5,
          "max": 1.0
        }
      ],
      "aspects": [
        "合同全生命周期管理体系",
        "信息管理系统的功能完备性",
        "信息安全与数据保障机制",
        "系统实施运维与培训服务"
      ],
      "criteria": "合同管理与信息管理方案，有完善的信息管理系统；评委根据投标文件情况分为一般、良、优，分别酌情得0.5-1 分、1-2 分、2-3 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在合同管理与信息管理方案，有完善的信息管理系统中体现。",
      "synonyms": []
    },
    {
      "id": "T-10",
      "guid": "ae93a6c8-1c01-4ab8-a43b-11f4cbc40a3c",
      "name": "各专业施工图设计的安排、协调、时间保证措施",
      "max_score": 2.0,
      "tiers": [
        {
          "tier": "优",
          "min": 1.5,
          "max": 2.0
        },
        {
          "tier": "良",
          "min": 0.7,
          "max": 1.5
        },
        {
          "tier": "一般",
          "min": 0.2,
          "max": 0.7
        }
      ],
      "aspects": [
        "各专业施工图设计进度安排与计划管理",
        "多专业协同设计与接口协调机制",
        "设计进度延误预警与纠偏措施",
        "现场平面管理与设计配合方案"
      ],
      "criteria": "各专业施工图设计的安排、协调、时间保证措施；现场平面管理方案；评委根据投标文件情况分为一般、良、优，分别酌情得0.2-0.7 分、0.7-1.5 分、1.5-2分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在各专业施工图设计的安排、协调、时间保证措施；中体现。",
      "synonyms": []
    },
    {
      "id": "T-11",
      "guid": "123a9226-d66e-4ace-8dc4-65a76a8282fa",
      "name": "施工方案及技术措施",
      "max_score": 8.0,
      "tiers": [
        {
          "tier": "优",
          "min": 6.0,
          "max": 8.0
        },
        {
          "tier": "良",
          "min": 3.0,
          "max": 6.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 3.0
        }
      ],
      "aspects": [
        "总体施工部署与流程规划",
        "核心工程技术方案针对性",
        "质量保证体系与控制措施",
        "安全文明施工与环境保护",
        "资源配备与进度保障机制"
      ],
      "criteria": "施工方案及技术措施；评委根据投标文件情况分为一般、良、优，分别酌情得1-3 分、3-6 分、6-8 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在施工方案及技术措施中体现。",
      "synonyms": []
    },
    {
      "id": "T-12",
      "guid": "c105b81a-3fca-42a1-a0fa-c55332f11e62",
      "name": "安全施工、文明施工和绿色施工措施",
      "max_score": 8.0,
      "tiers": [
        {
          "tier": "优",
          "min": 6.0,
          "max": 8.0
        },
        {
          "tier": "良",
          "min": 3.0,
          "max": 6.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 3.0
        }
      ],
      "aspects": [
        "安全施工管理体系与风险防控",
        "文明施工标准化与现场环境管理",
        "绿色施工技术与资源节约措施"
      ],
      "criteria": "安全施工、文明施工和绿色施工措施；评委根据投标文件情况分为一般、良、优，分别酌情得1-3 分、3-6分、6-8 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在安全施工、文明施工和绿色施工措施中体现。",
      "synonyms": []
    },
    {
      "id": "T-13",
      "guid": "80d2c3d4-2628-4f0c-88ed-77fbc129aa4c",
      "name": "环境保护及防尘施工措施",
      "max_score": 4.0,
      "tiers": [
        {
          "tier": "优",
          "min": 3.0,
          "max": 4.0
        },
        {
          "tier": "良",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 2.0
        }
      ],
      "aspects": [
        "扬尘控制专项方案",
        "噪声与振动污染防治",
        "水污染与固体废弃物管理",
        "管理体系与应急响应"
      ],
      "criteria": "环境保护及防尘施工措施。评委根据投标文件情况分为一般、良、优，分别酌情得1-2 分,2-3 分,3-4 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在环境保护及防尘施工措施中体现。",
      "synonyms": []
    },
    {
      "id": "T-14",
      "guid": "fafc867a-6a90-4765-b0d0-6ebfd818d218",
      "name": "施工总进度计划及保证措施",
      "max_score": 8.0,
      "tiers": [
        {
          "tier": "优",
          "min": 6.0,
          "max": 8.0
        },
        {
          "tier": "良",
          "min": 3.0,
          "max": 6.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 3.0
        }
      ],
      "aspects": [
        "施工进度计划编制科学性",
        "进度保证组织管理体系",
        "技术与资源保障措施",
        "动态监控与纠偏机制"
      ],
      "criteria": "施工总进度计划及保证措施；评委根据投标文件情况分为一般、良、优，分别酌情得1-3 分、3-6 分、6-8分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在施工总进度计划及保证措施中体现。",
      "synonyms": []
    },
    {
      "id": "T-15",
      "guid": "4c62f8e4-d847-4cb9-bca0-9b4f78d9573e",
      "name": "施工现场总平面布置",
      "max_score": 4.0,
      "tiers": [
        {
          "tier": "优",
          "min": 3.0,
          "max": 4.0
        },
        {
          "tier": "良",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 2.0
        }
      ],
      "aspects": [
        "功能分区与空间布局合理性",
        "交通组织与物流动线规划",
        "临时设施配置与标准化建设",
        "水电管网与环保消防设施",
        "动态调整与图示表达质量"
      ],
      "criteria": "施工现场总平面布置；评委根据投标文件情况分为一般、良、优，分别酌情得1-2 分、2-3 分、3-4 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在施工现场总平面布置中体现。",
      "synonyms": []
    },
    {
      "id": "T-16",
      "guid": "ffd783a2-78cf-4fd6-81ef-812298958298",
      "name": "施工质量措施计划",
      "max_score": 8.0,
      "tiers": [
        {
          "tier": "优",
          "min": 6.0,
          "max": 8.0
        },
        {
          "tier": "良",
          "min": 3.0,
          "max": 6.0
        },
        {
          "tier": "一般",
          "min": 1.0,
          "max": 3.0
        }
      ],
      "aspects": [
        "质量管理体系与组织架构",
        "关键工序与质量控制点措施",
        "材料设备进场检验与管理",
        "质量检测与验收管理计划",
        "质量持续改进与应急处理"
      ],
      "criteria": "施工质量措施计划；评委根据投标文件情况分为一般、良、优，分别酌情得1-3 分、3-6 分、6-8 分内容不全酌情扣分，若此条缺项不得分；相关标书内容在施工质量措施计划中体现。",
      "synonyms": []
    },
    {
      "id": "T-17",
      "guid": "c43a82b9-31a1-4f6b-acf5-a9af954b6816",
      "name": "材料采购管理方案",
      "max_score": 4.0,
      "tiers": [
        {
          "tier": "优",
          "min": 2.0,
          "max": 4.0
        },
        {
          "tier": "良",
          "min": 1.0,
          "max": 2.0
        },
        {
          "tier": "一般",
          "min": 0.5,
          "max": 1.0
        }
      ],
      "aspects": [
        "采购组织架构与职责分工",
        "供应商管理与资源保障",
        "采购流程控制与质量保证",
        "成本控制与资金支付管理",
        "仓储物流与现场管理"
      ],
      "criteria": "材料采购管理方案；评委根据投标文件情况分为一般、良、优，分别酌情得0.5-1 分、1-2 分、2-4 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在材料采购管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-18",
      "guid": "6c230e96-2e06-4c28-a648-0181e132707f",
      "name": "货物采购管理方案",
      "max_score": 3.0,
      "tiers": [
        {
          "tier": "优",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "良",
          "min": 1.0,
          "max": 2.0
        },
        {
          "tier": "一般",
          "min": 0.5,
          "max": 1.0
        }
      ],
      "aspects": [
        "采购组织架构与职责分工",
        "采购流程与控制措施",
        "质量控制与验收标准",
        "仓储物流与供应保障",
        "成本控制与档案管理"
      ],
      "criteria": "货物采购管理方案；评委根据投标文件情况分为一般、良、优，分别酌情得0.5-1 分、1-2 分、2-3 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在货物采购管理方案中体现。",
      "synonyms": []
    },
    {
      "id": "T-19",
      "guid": "e1c9c784-0683-45a4-a123-08a7f4084f86",
      "name": "服务采购管理方案",
      "max_score": 3.0,
      "tiers": [
        {
          "tier": "优",
          "min": 2.0,
          "max": 3.0
        },
        {
          "tier": "良",
          "min": 1.0,
          "max": 2.0
        },
        {
          "tier": "一般",
          "min": 0.5,
          "max": 1.0
        }
      ],
      "aspects": [
        "采购策划与需求分析",
        "供应商管理与评价体系",
        "采购过程控制与合规管理",
        "合同管理与后续服务保障"
      ],
      "criteria": "服务采购管理方案；评委根据投标文件情况分为一般、良、优，分别酌情得0.5-1 分、1-2 分、2-3 分，内容不全酌情扣分，若此条缺项不得分；相关标书内容在服务采购管理方案中体现。",
      "synonyms": []
    }
  ];

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function round3(value) {
    return Math.round(value * 1000) / 1000;
  }

  const LOW_CONFIDENCE_THRESHOLD = 0.85;

  // criteria 只能逐字来自招标文件（data-contract.md §3），缺了就是缺了——
  // 早先这里有个 buildCriteria() 会按同样句式合成一段，而页面⑤把它标成
  // 「招标文件第 33~37 页评审标准原文」展示，等于我方杜撰判分依据。已删，别加回来。
  function requireCriteria(def) {
    const criteria = typeof def.criteria === "string" ? def.criteria.trim() : "";
    if (!criteria) {
      console.error("[mock-data] 评分项 " + def.id + " 缺少 criteria；" +
        "请从 config/projects/济阳区实验高级中学.yaml 补齐，不要合成。");
    }
    return criteria;
  }

  const items = itemDefs.map((def) => {
    const tiers = def.tiers.map((tier) => ({ ...tier, desc: "" }));
    return {
      id: def.id,
      guid: def.guid,
      name: def.name,
      max_score: def.max_score,
      source: "招标文件.pdf 第 33~37 页",
      bound_count: 12,
      expected_bidders: 12,
      tiers,
      criteria: requireCriteria(def),
      aspects: def.aspects || [],
      synonyms: def.synonyms || []
    };
  });

  const scoringTable = {
    project: "济阳区实验高级中学项目工程总承包（EPC）",
    source: "招标文件.pdf 第 33~37 页",
    prepared: true,
    prepared_label: "评分规则已准备",
    rules: ["内容不全酌情扣分", "若此条缺项不得分"],
    items
  };

  const BASE_EVIDENCE_BUDGET = 3000;
  const MIN_EVIDENCE_BUDGET = 1500;
  const MAX_EVIDENCE_BUDGET = 6000;
  const TOTAL_SCORE = items.reduce((sum, item) => sum + item.max_score, 0);

  function evidenceBudgetFor(item) {
    const raw = BASE_EVIDENCE_BUDGET * items.length * item.max_score / TOTAL_SCORE;
    return Math.round(Math.min(MAX_EVIDENCE_BUDGET, Math.max(MIN_EVIDENCE_BUDGET, raw)));
  }

  const projectSummary = "本项目为济阳区实验高级中学工程总承包（EPC），建设内容包含设计、施工及相关总承包管理工作。评审重点关注投标文件是否围绕房建工程特点、工期组织、质量安全、资源保障、专业协同与可追溯证据展开。该摘要用于评审上下文展示，接入后由 S0 抽取结果替换。";

  function mockModelTier(item, bidderIndex, itemIndex) {
    if (itemIndex === 18) return null;
    const bucket = (bidderIndex * 7 + itemIndex * 5) % 10;
    const tierName = bucket >= 7 ? "优" : bucket >= 3 ? "良" : "一般";
    return item.tiers.find((tier) => tier.tier === tierName);
  }

  function mockCompletionRate(bidderIndex, itemIndex, tierName) {
    const variance = ((bidderIndex * 11 + itemIndex * 7) % 18) / 100;
    if (tierName === "优") return round2(0.72 + variance);
    if (tierName === "良") return round2(0.44 + variance);
    if (tierName === "一般") return round2(0.18 + variance);
    return 0;
  }

  function scoreInTier(tier, rate) {
    if (!tier) return 0;
    const score = round1(tier.min + rate * (tier.max - tier.min));
    if (tier.tier !== "优" && score >= tier.max) {
      return round1(tier.max - 0.1);
    }
    return score;
  }

  function confidenceFromFactors({ fallback, truncated, retried }) {
    let confidence = 1;
    const factors = [];
    if (fallback) {
      confidence *= 0.7;
      factors.push("降级");
    }
    if (truncated) {
      confidence *= 0.9;
      factors.push("截断");
    }
    if (retried) {
      confidence *= 0.9;
      factors.push("重试");
    }
    return {
      confidence: round3(confidence),
      factors
    };
  }

  function confidenceWhy(factors) {
    return factors && factors.length ? "置信度减分：" + factors.join(" + ") : "无减分因素";
  }

  const sectionBlocks = [];
  const LOCATED_SEED = Array.isArray(window.LOCATED_SEED) ? window.LOCATED_SEED : [];

  function mockSectionId(bidderIndex, itemIndex, offset) {
    const fileOrdinal = itemIndex + 1;
    const blockOrdinal = bidderIndex * 100 + itemIndex * 2 + offset + 47;
    return fileOrdinal + "#" + blockOrdinal;
  }

  function seedForItem(bidder, item, itemIndex) {
    if (!LOCATED_SEED.length) return null;
    const sameBidderAndItem = LOCATED_SEED.find((row) =>
      row && row.item_id === item.id && (row.bidder === bidder.name || row.bidder_id === bidder.id)
    );
    if (sameBidderAndItem) return sameBidderAndItem;
    const sameItem = LOCATED_SEED.find((row) => row && row.item_id === item.id);
    if (sameItem) return sameItem;
    return LOCATED_SEED[itemIndex % LOCATED_SEED.length];
  }

  function fallbackPickedRows(bidder, item, bidderIndex, itemIndex) {
    const fileStem = item.name.length > 14 ? item.name.slice(0, 14) : item.name;
    const file = fileStem + item.guid.toUpperCase() + ".pdf";
    return [
      {
        section_id: mockSectionId(bidderIndex, itemIndex, 0),
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
        section_id: mockSectionId(bidderIndex, itemIndex, 1),
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
  }

  function seedPickedRows(seed, bidder, item) {
    if (!seed || !Array.isArray(seed.picked) || !seed.picked.length) return null;
    return seed.picked.slice(0, 4).map((row) => ({
      section_id: row.section_id,
      file: row.file,
      item_id: row.item_id || item.id,
      item_guid: row.item_guid || item.guid,
      bidder: row.bidder === bidder.name ? row.bidder : bidder.name,
      bidder_id: bidder.id,
      page: row.page || null,
      level: row.level || (Array.isArray(row.path) ? row.path.length : 1),
      path: Array.isArray(row.path) && row.path.length ? row.path : ["未命名章节"],
      unit: Array.isArray(row.unit) && row.unit.length
        ? row.unit
        : Array.isArray(row.path) && row.path.length ? row.path : ["未命名章节"],
      match_score: typeof row.match_score === "number" ? row.match_score : 0,
      hit: Array.isArray(row.hit) ? row.hit : [],
      chars: typeof row.chars === "number" ? row.chars : String(row.text || "").length,
      truncated: Boolean(row.truncated),
      parse_hint: row.truncated ? "解析提示：该证据来自 located.json 截断片段，建议人工复核。" : "",
      text: row.text || "原始章节文本未在 sections.json 中找到。"
    }));
  }

  function fitPickedRowsToBudget(rows, budget) {
    const fitted = [];
    let remaining = budget;
    rows.forEach((row) => {
      if (remaining <= 0) return;
      const chars = typeof row.chars === "number" ? row.chars : String(row.text || "").length;
      if (chars <= remaining) {
        fitted.push(row);
        remaining -= chars;
        return;
      }
      fitted.push({
        ...row,
        chars: remaining,
        truncated: true,
        parse_hint: "解析提示：该证据因本评分项 budget 用尽被截断，建议人工复核。",
        text: String(row.text || "").slice(0, Math.max(0, remaining)) + "..."
      });
      remaining = 0;
    });
    return fitted;
  }

  function makeEvidencePackage(bidder, item, bidderIndex, itemIndex, resultStatus, score) {
    const noEvidence = resultStatus === "unrated" || score === 0;
    const seed = seedForItem(bidder, item, itemIndex);
    const budget = evidenceBudgetFor(item);
    const rawPicked = noEvidence ? [] : (seedPickedRows(seed, bidder, item) || fallbackPickedRows(bidder, item, bidderIndex, itemIndex));
    const picked = fitPickedRowsToBudget(rawPicked, budget);

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
      source_item_id: seed ? seed.item_id || null : null,
      source_bidder: seed ? seed.bidder || null : null,
      source_name: seed ? seed.name : null,
      candidates: noEvidence ? 0 : seed && typeof seed.candidates === "number" ? seed.candidates : 18 + ((bidderIndex + itemIndex) % 15),
      units: noEvidence ? 0 : picked.length,
      fallback: (item.id === "T-02" && bidder.id === "jinan1") || Boolean(seed && seed.fallback),
      evidence_chars: noEvidence ? 0 : picked.reduce((sum, row) => sum + row.chars, 0),
      budget,
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
      let rate = mockCompletionRate(bidderIndex, itemIndex, tier ? tier.tier : null);
      let attempts = 1;
      let last_error = "";

      if (bidder.id === "zhongjian1" && item.id === "T-05") {
        status = "unrated";
        tier = null;
        attempts = 3;
        last_error = "JSON 解析失败";
      }

      if (status === "rated" && bidder.id === "jinan1" && item.id === "T-02") {
        tier = item.tiers.find((row) => row.tier === "良");
        rate = 0.1;
        attempts = 2;
      }

      if (status === "rated" && bidder.id === "dezhou" && item.id === "T-16") {
        tier = item.tiers.find((row) => row.tier === "优");
        rate = 0.18;
      }

      if (status === "rated" && bidder.id === "zhongjian2" && item.id === "T-06") {
        attempts = 2;
      }

      if (status === "rated" && item.id === "T-17") {
        tier = item.tiers.find((row) => row.tier === "良");
        rate = mockCompletionRate(bidderIndex, itemIndex, "良");
      }

      const score = status === "unrated" ? null : scoreInTier(tier, rate);
      const evidencePackage = makeEvidencePackage(bidder, item, bidderIndex, itemIndex, status, score);
      const confidenceState = status === "unrated"
        ? { confidence: 0, factors: ["未评定"] }
        : confidenceFromFactors({
          fallback: evidencePackage.fallback,
          truncated: evidencePackage.picked.some((row) => row.truncated),
          retried: attempts > 1
        });

      const result = {
        item_id: item.id,
        item_guid: item.guid,
        bidder: bidder.name,
        bidder_id: bidder.id,
        status,
        tier: tier ? tier.tier : null,
        score,
        cite: status === "unrated" || score === 0 ? [] : evidencePackage.picked.slice(0, 2).map((_, index) => index),
        reason: status === "unrated"
          ? "模型连续返回无效结果，系统按未评定处理。"
          : score === 0
          ? "证据定位未检索到与该评分项直接相关的合格章节，按招标文件规则“若此条缺项不得分”处理为 0 分。"
          : "投标文件覆盖了主要评审要求，能够说明组织安排、节点控制和保障措施；部分内容仍偏概括，与本项目 EPC 协同和现场条件结合不够充分。",
        confidence: confidenceState.confidence,
        confidence_factors: confidenceState.factors,
        attempts,
        last_error,
        perf: {
          in_tokens: status === "unrated" ? 3560 : 2600 + ((bidderIndex + 1) * 137 + itemIndex * 43),
          out_tokens: status === "unrated" ? 0 : 138 + ((bidderIndex + itemIndex) % 60),
          latency_ms: status === "unrated" ? 23600 : 6200 + ((bidderIndex * 421 + itemIndex * 317) % 6800)
        }
      };

      reviewResults.push(result);
      evidencePackages[key] = evidencePackage;
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
    const score = round1(rows.reduce((sum, row) => sum + (typeof row.score === "number" ? row.score : 0), 0));
    totals[bidder.name] = {
      score,
      unrated: rows.filter((row) => row.status === "unrated").length,
      expert_score: score,
      expert_overrides: 0
    };
  });

  function buildAuditRows() {
    return items.flatMap((item) => {
      const rows = bidders.map((bidder) => resultFor(bidder.id, item.id));
      if (rows.some((row) => !row || row.status === "unrated")) return [];

      const buckets = rows.map((row) => row.score === 0 ? "0分" : row.tier);
      const firstBucket = buckets[0];
      if (!firstBucket || !buckets.every((bucket) => bucket === firstBucket)) return [];

      const tierDist = item.tiers.reduce((dist, tier) => {
        dist[tier.tier] = buckets.filter((bucket) => bucket === tier.tier).length;
        return dist;
      }, {});
      tierDist["0分"] = buckets.filter((bucket) => bucket === "0分").length;

      return [{
        item_id: item.id,
        kind: "no_discrimination",
        detail: bidders.length + " 家全部判「" + firstBucket + "」档",
        tier_dist: tierDist
      }];
    });
  }

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
        why: confidenceWhy(row.confidence_factors)
      })),
    audit: buildAuditRows(),
    expert_reviews: [],
    perf: {
      wall_clock_sec: 582,
      concurrency: 8,
      calls: 228,
      retries: reviewResults.reduce((sum, row) => sum + Math.max(row.attempts - 1, 0), 0),
      in_tokens: reviewResults.reduce((sum, row) => sum + row.perf.in_tokens, 0),
      out_tokens: reviewResults.reduce((sum, row) => sum + row.perf.out_tokens, 0),
      gpu: "未采集",
      vram_peak_gb: null,
      gpu_note: "模型为远程托管端点时，我方进程内无法采集显存；此处显示为未采集。"
    },
    compute_notes: {
      owner: "我方自有算力",
      spec: "未采集",
      model: "远程托管模型端点，版本未采集",
      method: [
        "证据定位：IDF 加权 + 单锚点闸门，不依赖向量库",
        "防幻觉：模型只选择证据编号，引用原文由系统从证据包截取",
        "计时口径：页面①点击下一步后覆盖 S1-S4 全流程"
      ]
    }
  };

  const runEvents = [
    { type: "stage", stage: "PDF 入库", status: "running", message: "开始读取 12 家投标技术标 PDF" },
    { type: "stage", stage: "PDF 入库", status: "done", message: "完成 240 个技术标 PDF 入库，封面文件不参与评分" },
    { type: "stage", stage: "证据定位", status: "running", message: "按评分项绑定关系进入单 PDF 内部定位证据" },
    { type: "stage", stage: "证据定位", status: "done", message: "证据包已生成，等待人工确认开始逐项评审" },
    { type: "stage", stage: "逐项评审", status: "running", message: "确认完成，逐项评审开始" }
  ];

  function retryMessage(result) {
    if (result.bidder_id === "jinan1" && result.item_id === "T-02") {
      return "引用编号校验失败，准备重试";
    }
    if (result.bidder_id === "zhongjian2" && result.item_id === "T-06") {
      return "模型返回格式不完整，准备重试";
    }
    return "模型返回格式不完整，准备重试";
  }

  reviewResults.forEach((result) => {
    if (result.bidder_id === "zhongye" && result.item_id === "T-06") {
      runEvents.push({
        type: "wait",
        bidder_id: result.bidder_id,
        item_id: result.item_id,
        duration_ms: 40000,
        message: "等待模型端点返回，保留当前处理项"
      });
    }
    for (let attempt = 1; attempt < result.attempts; attempt += 1) {
      runEvents.push({
        type: "retry",
        bidder_id: result.bidder_id,
        item_id: result.item_id,
        attempt,
        max_attempts: result.attempts,
        message: retryMessage(result)
      });
    }
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
