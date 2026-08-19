(function () {
  const DATA = window.PROTOTYPE_DATA;
  const app = document.getElementById("app");
  const TOTAL_REVIEWS = DATA.bidders.length * DATA.scoringTable.items.length;
  const LOW_CONFIDENCE_THRESHOLD = DATA.lowConfidenceThreshold || 0.85;
  const stageNames = ["PDF 入库", "证据定位", "逐项评审", "结果汇总"];

  const state = {
    run: createRunState(),
    reviewOverrides: {},
    activeSectionId: ""
  };

  function createRunState() {
    return {
      eventIndex: 0,
      logs: [],
      started: false,
      paused: false,
      finished: false,
      completedReviews: 0,
      retries: 0,
      unrated: 0,
      inTokens: 0,
      outTokens: 0,
      latencyTotal: 0,
      startedAt: null,
      finishedAt: null,
      lastEventAt: null,
      currentLabel: "等待开始",
      stages: {
        "PDF 入库": "等待中",
        "证据定位": "等待中",
        "逐项评审": "等待中",
        "结果汇总": "等待中"
      },
      timer: null
    };
  }

  function resetRunState() {
    if (state.run.timer) {
      clearInterval(state.run.timer);
    }
    state.run = createRunState();
  }

  function html(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function number(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }

  function chars(value) {
    return (value / 10000).toFixed(1) + " 万字";
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return pad(minutes) + ":" + pad(seconds);
  }

  function clock() {
    const date = new Date();
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function getRoute() {
    const raw = location.hash || "#/create";
    const clean = raw.startsWith("#") ? raw.slice(1) : raw;
    const [path, queryString = ""] = clean.split("?");
    return {
      path: path || "/create",
      query: new URLSearchParams(queryString)
    };
  }

  function setRoute(hash) {
    location.hash = hash;
  }

  function itemById(id) {
    return DATA.scoringTable.items.find((item) => item.id === id);
  }

  function bidderById(id) {
    return DATA.bidders.find((bidder) => bidder.id === id);
  }

  function resultBy(bidderId, itemId) {
    return DATA.reviewResults.find((row) => row.bidder_id === bidderId && row.item_id === itemId);
  }

  function isLowConfidence(result) {
    return result.status === "rated" && result.score !== 0 && result.confidence < LOW_CONFIDENCE_THRESHOLD;
  }

  function evidenceBy(bidderId, itemId) {
    return DATA.evidencePackages[bidderId + "__" + itemId];
  }

  function shortBidder(id) {
    const bidder = bidderById(id);
    return bidder ? bidder.short : id;
  }

  function routeForDetail(bidderId, itemId) {
    return "#/detail?bidder=" + encodeURIComponent(bidderId) + "&item=" + encodeURIComponent(itemId);
  }

  function shell(activePath, body) {
    const links = [
      ["/create", "新建评审"],
      ["/confirm", "确认招标信息"],
      ["/running", "运行监视"],
      ["/results", "结果并排"]
    ];

    return `
      <header class="topbar">
        <div class="brand">
          <h1 class="brand-title">工程建设类技术标辅助评审系统</h1>
          <div class="brand-subtitle">静态 Demo 原型 · Mock 数据 · 不连接后端</div>
        </div>
        <nav class="nav" aria-label="页面导航">
          ${links.map(([path, label]) => `
            <a class="${activePath === path ? "active" : ""}" href="#${path}">${label}</a>
          `).join("")}
        </nav>
      </header>
      ${body}
    `;
  }

  function render() {
    const route = getRoute();
    if (route.path === "/create") {
      app.innerHTML = shell(route.path, renderCreate());
      return;
    }
    if (route.path === "/confirm") {
      app.innerHTML = shell(route.path, renderConfirm());
      return;
    }
    if (route.path === "/running") {
      ensureRunStarted();
      app.innerHTML = shell(route.path, renderRunning());
      return;
    }
    if (route.path === "/results") {
      app.innerHTML = shell(route.path, renderResults());
      return;
    }
    if (route.path === "/detail") {
      app.innerHTML = shell(route.path, renderDetail(route.query));
      scrollActiveSource();
      return;
    }
    setRoute("#/create");
  }

  function renderCreate() {
    const totalChars = DATA.bidders.reduce((sum, bidder) => sum + bidder.chars, 0);
    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">新建评审任务</h2>
            <p class="page-desc">选择招标文件与各投标人的技术标 PDF。评分规则已完成离线准备，本页只展示业务状态和文件识别结果。</p>
          </div>
          <div class="toolbar">
            <a class="btn primary" href="#/confirm" data-start-parse>下一步：解析</a>
          </div>
        </section>

        <section class="summary-strip" aria-label="任务概览">
          ${metric("评分规则", "已加载", "19 个评分项 / 总分 100 分")}
          ${metric("投标人", DATA.bidders.length + " 家", "每家 20 个技术标 PDF")}
          ${metric("逐项评审", TOTAL_REVIEWS + " 项", "12 家投标人 × 19 个评分项")}
          ${metric("语料体量", chars(totalChars), "Mock 占位统计")}
        </section>

        <section class="layout-grid" style="margin-top: 18px;">
          <div class="panel">
            <div class="panel-header">
              <h3 class="panel-title">基础信息</h3>
              <span class="badge success">评分规则已准备</span>
            </div>
            <div class="panel-body">
              <div class="field-grid">
                <div class="field">
                  <label for="projectName">项目名称</label>
                  <input id="projectName" class="input" value="${html(DATA.scoringTable.project)}">
                </div>
                <div class="field">
                  <label>招标文件</label>
                  <div class="select-like">招标文件.pdf · 已选择</div>
                </div>
                <div class="field">
                  <label>评分规则状态</label>
                  <div class="select-like">已加载 · ${DATA.scoringTable.items.length} 个评分项 · 总分 ${totalScore().toFixed(1)} 分</div>
                </div>
                <div class="field">
                  <label>评审范围</label>
                  <div class="select-like">仅技术部分 · 不包含商务标</div>
                </div>
              </div>
            </div>
          </div>

          <aside class="panel">
            <div class="panel-header">
              <h3 class="panel-title">现场口径</h3>
              <span class="badge primary">S1-S4 现场跑</span>
            </div>
            <div class="panel-body">
              <div class="info-box">
                <strong>合法离线准备</strong>
                <span class="muted">评分表、要素、项目特征摘要只依赖招标文件，可提前准备；投标文件处理和评审结果必须现场运行。</span>
              </div>
            </div>
          </aside>
        </section>

        <section class="panel" style="margin-top: 18px;">
          <div class="panel-header">
            <h3 class="panel-title">投标文件（技术部分）</h3>
            <span class="badge neutral">共 ${DATA.bidders.length} 家</span>
          </div>
          <div class="panel-body">
            <div class="bidder-list">
              ${DATA.bidders.map((bidder) => `
                <div class="bidder-row">
                  <div>
                    <div class="bidder-name">${html(bidder.name)}</div>
                    <div class="bidder-meta">${bidder.pdfCount} 个 PDF / ${chars(bidder.chars)} · 评分项文件按名称前缀自动绑定</div>
                  </div>
                  <span class="badge success">已识别</span>
                </div>
              `).join("")}
            </div>
          </div>
        </section>
      </main>
    `;
  }

  function renderConfirm() {
    const mismatch = DATA.scoringTable.items.some((item) => item.bound_count < item.expected_bidders);
    const elapsed = runElapsedMs();
    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">确认招标信息</h2>
            <p class="page-desc">评分表已从招标文件第 33~37 页离线抽出并人工确认。本页用于核对评分项、分值、档位区间和投标文件绑定状态。</p>
          </div>
          <div class="toolbar">
            <a class="btn" href="#/create">上一步</a>
            <button class="btn primary" data-start-run ${mismatch ? "disabled" : ""}>确认并开始评审</button>
          </div>
        </section>

        <section class="summary-strip">
          ${metric("评分项", DATA.scoringTable.items.length + " 项", "技术标评分项")}
          ${metric("总分", totalScore().toFixed(1) + " 分", "来自招标文件")}
          ${metric("投标文件绑定", mismatch ? "存在异常" : "全部匹配", mismatch ? "需处理后开始" : "19 项均为 12/12")}
          ${metric("现场计时", state.run.startedAt ? formatDuration(elapsed) : "未开始", "页面①下一步起算")}
          ${metric("人工介入", "本页一次", "确认后进入现场评审")}
        </section>

        <section class="layout-grid" style="margin-top: 18px;">
          <div class="panel">
            <div class="panel-header">
              <h3 class="panel-title">解析结果（可核对）</h3>
              <span class="badge ${mismatch ? "danger" : "success"}">${mismatch ? "存在缺项" : "可开始"}</span>
            </div>
            <div class="panel-body">
              <div class="table-wrap">
                <table class="table-compact">
                  <thead>
                    <tr>
                      <th>序</th>
                      <th>评分项</th>
                      <th>分值</th>
                      <th>三档区间</th>
                      <th>绑定的投标文件</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${DATA.scoringTable.items.map((item, index) => `
                      <tr>
                        <td>${index + 1}</td>
                        <td>${html(item.name)}</td>
                        <td>${item.max_score.toFixed(1)}</td>
                        <td>${tierSummary(item)}</td>
                        <td><span class="badge ${item.bound_count === item.expected_bidders ? "success" : "danger"}">${item.bound_count}/${item.expected_bidders} 家已匹配</span></td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <aside class="panel">
            <div class="panel-header">
              <h3 class="panel-title">全局规则与项目摘要</h3>
              <span class="badge primary">注入评审</span>
            </div>
            <div class="panel-body">
              <ul class="rule-list">
                ${DATA.scoringTable.rules.map((rule) => `
                  <li><span class="check-dot">✓</span><span>${html(rule)}</span></li>
                `).join("")}
              </ul>
              <div class="field" style="margin-top: 18px;">
                <label for="projectSummary">项目特征摘要</label>
                <textarea id="projectSummary" class="textarea">${html(DATA.projectSummary)}</textarea>
              </div>
            </div>
          </aside>
        </section>
      </main>
    `;
  }

  function renderRunning() {
    const run = state.run;
    const elapsed = runElapsedMs();
    const percent = Math.min(100, (run.completedReviews / TOTAL_REVIEWS) * 100);
    const avgLatency = run.completedReviews ? Math.round(run.latencyTotal / run.completedReviews) : 0;
    const remainingReviews = Math.max(0, TOTAL_REVIEWS - run.completedReviews);
    const estimatedMs = run.completedReviews ? remainingReviews * Math.max(avgLatency, 2400) / DATA.reportData.perf.concurrency : 0;
    const waitingMs = run.lastEventAt ? Date.now() - run.lastEventAt : 0;

    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">${run.finished ? "评审完成" : "评审进行中"}</h2>
            <p class="page-desc">逐项评审进度单独统计，分母为 228 = 12 家投标人 × 19 个评分项；S1-S4 用阶段状态展示。</p>
          </div>
          <div class="toolbar">
            <button class="btn" data-toggle-run>${run.paused ? "继续" : "暂停"}</button>
            <button class="btn" data-reset-run>重置演示</button>
            <a class="btn primary" href="#/results">查看已完成结果</a>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h3 class="panel-title">阶段状态</h3>
            <span class="badge ${run.finished ? "success" : "primary"}">${run.finished ? "报告数据已生成" : "现场运行中"}</span>
          </div>
          <div class="panel-body">
            <div class="stage-list">
              ${stageNames.map((name) => {
                const status = run.stages[name];
                const cls = status === "已完成" ? "done" : status === "进行中" ? "running" : "waiting";
                return `
                  <div class="stage ${cls}">
                    <div class="stage-name">${name}</div>
                    <div class="stage-state">${status}</div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        </section>

        <section class="layout-grid" style="margin-top: 18px;">
          <div class="panel">
            <div class="panel-header">
              <h3 class="panel-title">逐项评审进度</h3>
              <span class="badge primary">${run.completedReviews} / ${TOTAL_REVIEWS}</span>
            </div>
            <div class="panel-body">
              <div class="progress-box">
                <div>
                  <div class="progress-label">
                    <span>12 家投标人 × 19 个评分项</span>
                    <span>${percent.toFixed(1)}%</span>
                  </div>
                  <div class="progress-track" aria-label="逐项评审进度">
                    <div class="progress-fill" style="width: ${percent}%;"></div>
                  </div>
                </div>
                <div class="progress-number">
                  <strong>${run.completedReviews} / ${TOTAL_REVIEWS}</strong>
                  <span class="muted">${percent.toFixed(1)}%</span>
                </div>
              </div>

              <div class="summary-strip" style="margin-top: 18px;">
                ${metric("已用时间", formatDuration(elapsed), "预计剩余 " + formatDuration(estimatedMs))}
                ${metric("当前处理状态", html(run.currentLabel), "已等待 " + formatDuration(waitingMs))}
                ${metric("当前并发", DATA.reportData.perf.concurrency + " 路", "逐项评审并发")}
                ${metric("GPU / 显存", "未采集", "不伪造硬件数据")}
                ${metric("累计输入", number(run.inTokens) + " tokens", "Mock 实时累加")}
                ${metric("累计输出", number(run.outTokens) + " tokens", "Mock 实时累加")}
                ${metric("重试", run.retries + " 次", "失败先重试")}
                ${metric("未评定", run.unrated + " 项", "不计入合计")}
              </div>
            </div>
          </div>

          <aside class="panel">
            <div class="panel-header">
              <h3 class="panel-title">运行说明</h3>
              <span class="badge neutral">Mock 演示</span>
            </div>
            <div class="panel-body">
              <div class="info-box">
                <strong>实时标准</strong>
                <span class="muted">每完成一个评分项，1 秒内进入滚动区；如果连续等待，当前处理项和等待时长保持可见。</span>
              </div>
              <div class="info-box" style="margin-top: 12px;">
                <strong>未命中与未评定</strong>
                <span class="muted">0 分表示投标文件未写；“—”表示系统重试后仍未能给出判断，两者不会合并。</span>
              </div>
            </div>
          </aside>
        </section>

        <section class="panel" style="margin-top: 18px;">
          <div class="panel-header">
            <h3 class="panel-title">实时滚动</h3>
            <span class="badge neutral">最新在上</span>
          </div>
          <div class="panel-body">
            <div class="run-log">
              ${run.logs.length ? run.logs.slice(0, 80).map(renderLogRow).join("") : `<div class="empty">等待评审事件进入滚动区</div>`}
            </div>
          </div>
        </section>
      </main>
    `;
  }

  function renderResults() {
    const elapsed = reportElapsedMs();
    const rows = DATA.scoringTable.items.map((item) => {
      const allZero = DATA.bidders.every((bidder) => resultBy(bidder.id, item.id).score === 0);
      return `
        <tr class="${allZero ? "row-warning" : ""}">
          <td class="sticky-item">
            <strong>${html(item.name)}</strong>
            ${allZero ? `<div class="small muted">疑似检索配置问题</div>` : ""}
          </td>
          <td class="sticky-max">${item.max_score.toFixed(1)}</td>
          ${DATA.bidders.map((bidder) => renderScoreCell(bidder, item)).join("")}
        </tr>
      `;
    }).join("");

    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">评审结果并排</h2>
            <p class="page-desc">并排展示 12 家投标人的逐项结果，供专家查看和比较；系统不输出跨家优劣判断。</p>
          </div>
          <div class="toolbar">
            <a class="btn" href="#/running">返回运行监视</a>
            <button class="btn primary" data-export-report>导出报告</button>
          </div>
        </section>

        <section class="summary-strip">
          ${metric("投标人", DATA.bidders.length + " 家", "横向滚动展示")}
          ${metric("评分项", DATA.scoringTable.items.length + " 项", "评分项列固定")}
          ${metric("用时", formatDuration(elapsed), state.run.startedAt ? "从页面①下一步起算" : "Mock 占位")}
          ${metric("建议复核", DATA.reportData.review_flags.length + " 项", "confidence < " + LOW_CONFIDENCE_THRESHOLD)}
        </section>

        <section class="panel" style="margin-top: 18px;">
          <div class="panel-header">
            <h3 class="panel-title">并排矩阵</h3>
            <span class="badge neutral">评分项列固定 · 12 家横向滚动</span>
          </div>
          <div class="panel-body">
            <div class="table-wrap">
              <table class="score-matrix">
                <thead>
                  <tr>
                    <th class="sticky-item">评分项</th>
                    <th class="sticky-max">满分</th>
                    ${DATA.bidders.map((bidder) => `<th>${html(bidder.short)}</th>`).join("")}
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                  <tr>
                    <td class="sticky-item"><strong>合计（19 项）</strong></td>
                    <td class="sticky-max"><strong>100.0</strong></td>
                    ${DATA.bidders.map((bidder) => {
                      const total = DATA.reportData.totals[bidder.name];
                      return `<td><strong>${total.score.toFixed(1)}${total.unrated ? "*" : ""}</strong></td>`;
                    }).join("")}
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="legend">
              <span>0 = 未命中，投标文件未写此项</span>
              <span>— = 未评定，系统未能给出判断，不计入合计</span>
              <span>复核 = confidence &lt; ${LOW_CONFIDENCE_THRESHOLD}，建议人工复核</span>
              <span>* = 该家存在未评定项，合计不完整</span>
            </div>
          </div>
        </section>
      </main>
    `;
  }

  function renderDetail(query) {
    const bidderId = query.get("bidder") || DATA.bidders[0].id;
    const itemId = query.get("item") || "T-02";
    const bidder = bidderById(bidderId) || DATA.bidders[0];
    const item = itemById(itemId) || DATA.scoringTable.items[1];
    const result = resultBy(bidder.id, item.id);
    const evidence = evidenceBy(bidder.id, item.id);

    if (!result || !evidence) {
      return `
        <main class="page">
          <div class="panel"><div class="empty">未找到对应详情</div></div>
        </main>
      `;
    }

    const reviewKey = bidder.id + "__" + item.id;
    const override = state.reviewOverrides[reviewKey];
    const activeSection = state.activeSectionId || (evidence.picked[0] ? evidence.picked[0].section_id : "");
    state.activeSectionId = activeSection;
    const titleStatus = result.status === "unrated"
      ? "未评定"
      : result.score === 0
        ? "未命中"
        : "判分 " + result.tier;
    const scoreText = result.score == null ? "—" : result.score.toFixed(1);

    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">${html(bidder.short)} · ${html(item.name)}</h2>
            <p class="page-desc">${titleStatus} · ${scoreText} / ${item.max_score.toFixed(1)} 分</p>
          </div>
          <div class="toolbar">
            <a class="btn" href="#/results">返回结果并排</a>
          </div>
        </section>

        <section class="detail-grid">
          <div class="stack">
            <section class="panel">
              <div class="panel-header">
                <h3 class="panel-title">当前评分</h3>
                ${result.status === "unrated"
                  ? `<span class="badge danger">未评定</span>`
                  : result.score === 0
                    ? `<span class="badge neutral">0 分未命中</span>`
                    : `<span class="badge primary">${html(result.tier)} · ${scoreText} 分</span>`}
              </div>
              <div class="panel-body">
                <div class="summary-strip">
                  ${metric("最终分数", scoreText, "满分 " + item.max_score.toFixed(1))}
                  ${metric("当前档位", result.tier || "无", result.score === 0 ? "按缺项不得分处理" : "来自评分区间")}
                  ${metric("置信度", result.confidence.toFixed(2), isLowConfidence(result) ? "建议人工复核" : "可追溯")}
                  ${metric("调用次数", result.attempts + " 次", result.attempts > 1 ? "曾重试" : "一次成功")}
                </div>
              </div>
            </section>

            <section class="panel" style="margin-top: 18px;">
              <div class="panel-header">
                <h3 class="panel-title">评分档位</h3>
                <span class="badge neutral">招标文件第 33~37 页</span>
              </div>
              <div class="panel-body">
                <div class="tier-list">
                  ${item.tiers.map((tier) => `
                    <div class="tier ${tier.tier === result.tier ? "active" : ""}">
                      <div class="tier-name">${tier.tier}</div>
                      <div>${tier.min.toFixed(1)}-${tier.max.toFixed(1)} 分</div>
                      <div class="small muted">${html(tier.desc)}</div>
                    </div>
                  `).join("")}
                </div>
              </div>
            </section>

            ${result.factor_scores && result.factor_scores.length ? renderFactorPanel(result, item) : ""}

            <section class="panel" style="margin-top: 18px;">
              <div class="panel-header">
                <h3 class="panel-title">判分理由</h3>
                ${isLowConfidence(result) ? `<span class="badge warning">建议人工复核</span>` : `<span class="badge success">证据可追溯</span>`}
              </div>
              <div class="panel-body">
                <p class="reason-text">${html(result.reason)}</p>
              </div>
            </section>

            <section class="panel" style="margin-top: 18px;">
              <div class="panel-header">
                <h3 class="panel-title">引用的证据</h3>
                <span class="badge neutral">引用编号 ${result.cite.length ? result.cite.join("、") : "无"}</span>
              </div>
              <div class="panel-body">
                ${evidence.picked.length ? `
                  <div class="evidence-list">
                    ${evidence.picked.map((row, index) => renderEvidence(row, index, activeSection)).join("")}
                  </div>
                ` : `<div class="empty">未检索到合格证据。按招标文件规则“若此条缺项不得分”处理。</div>`}
              </div>
            </section>

            <section class="panel" style="margin-top: 18px;">
              <div class="panel-header">
                <h3 class="panel-title">专家复核</h3>
                <span class="badge neutral">原型本地状态</span>
              </div>
              <div class="panel-body">
                <div class="review-form">
                  <button class="btn" data-review-approve data-bidder="${html(bidder.id)}" data-item="${html(item.id)}">认可</button>
                  <input id="overrideScore" class="input" placeholder="改判分数" value="${override && override.score ? html(override.score) : ""}">
                  <input id="overrideNote" class="input" placeholder="备注" value="${override && override.note ? html(override.note) : ""}">
                  <button class="btn primary" data-review-save data-bidder="${html(bidder.id)}" data-item="${html(item.id)}">保存改判</button>
                </div>
                ${override ? `<div class="review-note">已记录：${html(override.type)}${override.score ? "，改判 " + html(override.score) + " 分" : ""}${override.note ? "，备注：" + html(override.note) : ""}</div>` : ""}
              </div>
            </section>
          </div>

          <aside class="panel source-viewer">
            <div class="panel-header">
              <h3 class="panel-title">原文定位</h3>
              <span class="badge primary">PDF 页定位模拟</span>
            </div>
            <div class="panel-body">
              ${renderSourceViewer(evidence, activeSection)}
            </div>
          </aside>
        </section>
      </main>
    `;
  }

  function renderFactorPanel(result, item) {
    const value = result.factor_scores.reduce((sum, factor) => sum + factor.weight * factor.value, 0);
    return `
      <section class="panel" style="margin-top: 18px;">
        <div class="panel-header">
          <h3 class="panel-title">区间内定分 / 要素加权</h3>
          <span class="badge neutral">存在 factor_scores 时显示</span>
        </div>
        <div class="panel-body">
          <div class="factor-list">
            ${result.factor_scores.map((factor) => `
              <div class="factor">
                <div class="factor-head">
                  <div class="factor-title">${html(factor.name)}</div>
                  <div class="small muted">${factor.weight.toFixed(2)} × ${factor.value.toFixed(2)} = ${(factor.weight * factor.value).toFixed(3)}</div>
                </div>
                <div class="factor-bar">
                  <div class="factor-fill" style="width: ${factor.value * 100}%;"></div>
                </div>
              </div>
            `).join("")}
          </div>
          <div class="info-box" style="margin-top: 12px;">
            <strong>合计得分率 ${value.toFixed(2)}</strong>
            <span class="muted">映射到当前档位区间，得到 ${result.score == null ? "—" : result.score.toFixed(1)} / ${item.max_score.toFixed(1)} 分。</span>
          </div>
        </div>
      </section>
    `;
  }

  function renderEvidence(row, index, activeSection) {
    return `
      <article class="evidence">
        <div class="evidence-head">
          <div>
            <div class="evidence-title">[${index}] ${html(row.file)}</div>
            <div class="evidence-path">${html(row.path.join(" › "))} · 第 ${row.page} 页</div>
          </div>
          <button class="btn link" data-locate-section="${html(row.section_id)}">在原文中定位</button>
        </div>
        <div class="quote">“${html(row.text)}”</div>
        ${row.parse_hint ? `<span class="badge warning">${html(row.parse_hint)}</span>` : ""}
        ${row.truncated ? `<span class="badge warning">建议人工复核</span>` : ""}
      </article>
    `;
  }

  function renderSourceViewer(evidence, activeSection) {
    if (!evidence.picked.length) {
      return `<div class="source-page"><div class="empty">没有可定位的原文片段</div></div>`;
    }
    return `
      <div class="source-page">
        ${evidence.picked.map((row, index) => `
          <section id="${sourceDomId(row.section_id)}" class="source-block ${row.section_id === activeSection ? "active" : ""}">
            <h4>[${index}] 第 ${row.page} 页 · ${html(row.path[row.path.length - 1])}</h4>
            <p>${html(row.text)}</p>
          </section>
        `).join("")}
      </div>
    `;
  }

  function renderScoreCell(bidder, item) {
    const result = resultBy(bidder.id, item.id);
    const href = routeForDetail(bidder.id, item.id);
    const low = isLowConfidence(result);
    let cls = "score-cell";
    let label = "";
    let title = "点击查看判分依据";

    if (result.status === "unrated") {
      cls += " unrated";
      label = "—";
      title = "未评定，点击查看失败信息和证据";
    } else if (result.score === 0) {
      cls += " zero";
      label = "0";
      title = "未命中，点击查看依据";
    } else {
      label = result.score.toFixed(1) + (low ? " 复核" : "");
      if (low) cls += " review";
    }

    return `
      <td>
        <a class="${cls}" href="${href}" title="${html(title)}">${html(label)}</a>
      </td>
    `;
  }

  function renderLogRow(row) {
    return `
      <div class="log-row ${html(row.kind)}">
        <div class="log-time">${html(row.time)}</div>
        <div>${html(row.bidder || "系统")}</div>
        <div>${html(row.item || row.message)}</div>
        <div class="log-result">${html(row.result || "")}</div>
      </div>
    `;
  }

  function metric(label, value, note) {
    return `
      <div class="metric">
        <div class="metric-label">${html(label)}</div>
        <div class="metric-value">${value}</div>
        <div class="metric-note">${html(note)}</div>
      </div>
    `;
  }

  function tierSummary(item) {
    return item.tiers
      .slice()
      .reverse()
      .map((tier) => `${tier.tier} ${tier.min.toFixed(1)}-${tier.max.toFixed(1)}`)
      .join(" / ");
  }

  function totalScore() {
    return DATA.scoringTable.items.reduce((sum, item) => sum + item.max_score, 0);
  }

  function runElapsedMs() {
    if (!state.run.startedAt) return 0;
    return (state.run.finishedAt || Date.now()) - state.run.startedAt;
  }

  function reportElapsedMs() {
    return state.run.startedAt ? runElapsedMs() : DATA.reportData.perf.wall_clock_sec * 1000;
  }

  function ensureRunStarted(message) {
    const run = state.run;
    if (!run.started) {
      run.started = true;
      run.startedAt = Date.now();
      run.lastEventAt = Date.now();
      run.currentLabel = message || "开始读取 12 家投标技术标 PDF";
      run.stages["PDF 入库"] = "进行中";
    }
    if (!run.timer && !run.finished) {
      run.timer = setInterval(tickRun, 750);
    }
  }

  function tickRun() {
    const route = getRoute();
    const run = state.run;
    if (!run.paused && !run.finished) {
      const event = DATA.runEvents[run.eventIndex];
      if (event) {
        processRunEvent(event);
        run.eventIndex += 1;
      }
      if (run.eventIndex >= DATA.runEvents.length) {
        run.finished = true;
        run.finishedAt = Date.now();
        run.paused = false;
        run.stages["PDF 入库"] = "已完成";
        run.stages["证据定位"] = "已完成";
        run.stages["逐项评审"] = "已完成";
        run.stages["结果汇总"] = "已完成";
        run.currentLabel = "报告数据已生成";
        if (run.timer) {
          clearInterval(run.timer);
          run.timer = null;
        }
      }
    }
    if (route.path === "/confirm" || route.path === "/running" || route.path === "/results") {
      render();
    }
  }

  function processRunEvent(event) {
    const run = state.run;
    run.lastEventAt = Date.now();

    if (event.type === "stage") {
      run.stages[event.stage] = event.status === "done" ? "已完成" : "进行中";
      if (event.stage === "逐项评审" && event.status === "running") {
        run.stages["结果汇总"] = "等待中";
      }
      run.currentLabel = event.message;
      run.logs.unshift({
        time: clock(),
        kind: "system",
        message: event.message,
        result: event.status === "done" ? "已完成" : "进行中"
      });
      return;
    }

    const item = itemById(event.item_id);
    const bidder = bidderById(event.bidder_id);
    run.currentLabel = (bidder ? bidder.short : event.bidder_id) + " · " + (item ? item.name : event.item_id);

    if (event.type === "retry") {
      run.retries += 1;
      run.stages["逐项评审"] = "进行中";
      run.logs.unshift({
        time: clock(),
        kind: "retry",
        bidder: bidder.short,
        item: item.name,
        result: "重试 " + event.attempt + "/" + event.max_attempts
      });
      return;
    }

    if (event.type === "review") {
      run.stages["PDF 入库"] = "已完成";
      run.stages["证据定位"] = "已完成";
      run.stages["逐项评审"] = "进行中";
      run.completedReviews += 1;
      run.inTokens += event.in_tokens || 0;
      run.outTokens += event.out_tokens || 0;
      run.latencyTotal += event.latency_ms || 0;

      let kind = "rated";
      let result = "";
      if (event.status === "unrated") {
        kind = "unrated";
        run.unrated += 1;
        result = "— 未评定";
      } else if (event.score === 0) {
        kind = "miss";
        result = "0 分 未命中";
      } else {
        result = event.tier + " " + event.score.toFixed(1) + " 分";
        if (isLowConfidence(event)) {
          kind = "retry";
          result += " · 建议复核";
        }
      }

      run.logs.unshift({
        time: clock(),
        kind,
        bidder: bidder.short,
        item: item.name,
        result
      });
    }
  }

  function sourceDomId(sectionId) {
    return "source-" + String(sectionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function scrollActiveSource() {
    if (!state.activeSectionId) return;
    setTimeout(() => {
      const target = document.getElementById(sourceDomId(state.activeSectionId));
      if (target) target.scrollIntoView({ block: "nearest" });
    }, 0);
  }

  function scoreLabel(value) {
    if (value == null) return "—";
    if (value === 0) return "0";
    return value.toFixed(1);
  }

  function buildReportHtml() {
    const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });
    const perf = DATA.reportData.perf;
    const matrixRows = DATA.scoringTable.items.map((item) => `
      <tr>
        <td>${html(item.name)}</td>
        <td>${item.max_score.toFixed(1)}</td>
        ${DATA.bidders.map((bidder) => {
          const result = resultBy(bidder.id, item.id);
          const label = scoreLabel(result.score) + (isLowConfidence(result) ? " 复核" : "");
          return `<td class="${isLowConfidence(result) ? "low" : result.status === "unrated" ? "unrated" : result.score === 0 ? "zero" : ""}">${html(label)}</td>`;
        }).join("")}
      </tr>
    `).join("");
    const totalRow = `
      <tr class="total">
        <td>合计（19 项）</td>
        <td>100.0</td>
        ${DATA.bidders.map((bidder) => {
          const total = DATA.reportData.totals[bidder.name];
          return `<td>${total.score.toFixed(1)}${total.unrated ? "*" : ""}</td>`;
        }).join("")}
      </tr>
    `;
    const unratedRows = DATA.reportData.unrated.length
      ? DATA.reportData.unrated.map((row) => {
        const item = itemById(row.item_id);
        return `
          <tr>
            <td>
              <strong>${html(row.bidder)}</strong><br>
              ${html(row.item_id)} ${html(item ? item.name : "")}<br>
              调用 ${row.attempts} 次；最后错误：${html(row.last_error || "无")}
            </td>
          </tr>
        `;
      }).join("")
      : `<tr><td>无未评定项</td></tr>`;
    const reviewRows = DATA.reportData.review_flags.length
      ? DATA.reportData.review_flags.map((row) => {
        const item = itemById(row.item_id);
        return `<li>${html(row.bidder)} · ${html(row.item_id)} ${html(item ? item.name : "")} · confidence ${row.confidence.toFixed(2)} · ${html(row.why)}</li>`;
      }).join("")
      : "<li>无低置信度项</li>";

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${html(DATA.reportData.project)} - 技术标辅助评审报告</title>
  <style>
    body { margin: 32px; color: #1f2937; font: 14px/1.6 "Microsoft YaHei", "PingFang SC", Arial, sans-serif; }
    h1, h2 { margin: 0 0 12px; line-height: 1.25; }
    h1 { font-size: 24px; }
    h2 { margin-top: 28px; font-size: 18px; }
    .meta, .note { color: #667085; }
    .table-wrap { overflow-x: auto; border: 1px solid #d9e0ea; }
    table { width: 100%; border-collapse: collapse; min-width: 1180px; }
    th, td { padding: 8px 10px; border: 1px solid #d9e0ea; text-align: left; vertical-align: top; }
    th { background: #f3f6fa; white-space: nowrap; }
    .total td { background: #f8fafc; font-weight: 700; }
    .low { color: #a45f0a; font-weight: 700; }
    .unrated { color: #b42318; font-weight: 700; }
    .zero { color: #667085; }
    .single-column { min-width: 0; }
    .perf { max-width: 720px; min-width: 0; }
    ul { padding-left: 18px; }
  </style>
</head>
<body>
  <h1>${html(DATA.reportData.project)} - 技术标辅助评审报告</h1>
  <p class="meta">生成时间：${html(generatedAt)}；页面计时：${formatDuration(reportElapsedMs())}；低置信度阈值：confidence &lt; ${LOW_CONFIDENCE_THRESHOLD}</p>

  <h2>并排表</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>评分项</th>
          <th>满分</th>
          ${DATA.bidders.map((bidder) => `<th>${html(bidder.short)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${matrixRows}
        ${totalRow}
      </tbody>
    </table>
  </div>
  <p class="note">0 = 未命中；— = 未评定；复核 = confidence &lt; ${LOW_CONFIDENCE_THRESHOLD}；* = 该家存在未评定项。</p>

  <h2>未评定单列</h2>
  <table class="single-column">
    <thead><tr><th>未评定项</th></tr></thead>
    <tbody>${unratedRows}</tbody>
  </table>

  <h2>建议人工复核</h2>
  <ul>${reviewRows}</ul>

  <h2>性能数据</h2>
  <table class="perf">
    <tbody>
      <tr><th>报告耗时</th><td>${formatDuration(perf.wall_clock_sec * 1000)}</td></tr>
      <tr><th>页面计时</th><td>${formatDuration(reportElapsedMs())}</td></tr>
      <tr><th>并发</th><td>${perf.concurrency} 路</td></tr>
      <tr><th>调用数</th><td>${number(perf.calls)}</td></tr>
      <tr><th>重试数</th><td>${number(perf.retries)}</td></tr>
      <tr><th>输入 tokens</th><td>${number(perf.in_tokens)}</td></tr>
      <tr><th>输出 tokens</th><td>${number(perf.out_tokens)}</td></tr>
      <tr><th>GPU / 显存</th><td>${html(perf.gpu)} / ${perf.vram_peak_gb == null ? "未采集" : perf.vram_peak_gb + " GB"}</td></tr>
      <tr><th>说明</th><td>${html(perf.gpu_note)}</td></tr>
    </tbody>
  </table>
</body>
</html>`;
  }

  function downloadReport() {
    const blob = new Blob([buildReportHtml()], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "技术标辅助评审报告-" + new Date().toISOString().replace(/[:.]/g, "-") + ".html";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  document.addEventListener("click", (event) => {
    const parse = event.target.closest("[data-start-parse]");
    if (parse) {
      event.preventDefault();
      resetRunState();
      ensureRunStarted("投标文件上传完成，开始 PDF 入库和解析计时");
      setRoute("#/confirm");
      return;
    }

    const start = event.target.closest("[data-start-run]");
    if (start) {
      ensureRunStarted("确认完成，进入逐项评审");
      setRoute("#/running");
      return;
    }

    const exportReport = event.target.closest("[data-export-report]");
    if (exportReport) {
      downloadReport();
      return;
    }

    const toggle = event.target.closest("[data-toggle-run]");
    if (toggle) {
      state.run.paused = !state.run.paused;
      render();
      return;
    }

    const reset = event.target.closest("[data-reset-run]");
    if (reset) {
      resetRunState();
      render();
      return;
    }

    const locate = event.target.closest("[data-locate-section]");
    if (locate) {
      state.activeSectionId = locate.getAttribute("data-locate-section");
      render();
      return;
    }

    const approve = event.target.closest("[data-review-approve]");
    if (approve) {
      const key = approve.getAttribute("data-bidder") + "__" + approve.getAttribute("data-item");
      state.reviewOverrides[key] = { type: "认可", score: "", note: "" };
      render();
      return;
    }

    const save = event.target.closest("[data-review-save]");
    if (save) {
      const key = save.getAttribute("data-bidder") + "__" + save.getAttribute("data-item");
      const score = document.getElementById("overrideScore")?.value.trim() || "";
      const note = document.getElementById("overrideNote")?.value.trim() || "";
      state.reviewOverrides[key] = { type: "人工改判", score, note };
      render();
    }
  });

  window.addEventListener("hashchange", () => {
    state.activeSectionId = "";
    render();
  });

  if (!location.hash) {
    location.hash = "#/create";
  } else {
    render();
  }
})();
