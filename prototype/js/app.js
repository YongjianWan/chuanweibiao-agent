(function () {
  const DATA = window.PROTOTYPE_DATA;
  const DEMO_MODE = false;
  const app = document.getElementById("app");
  const TOTAL_REVIEWS = DATA.bidders.length * DATA.scoringTable.items.length;
  const LOW_CONFIDENCE_THRESHOLD = DATA.lowConfidenceThreshold || 0.85;
  const stageNames = ["PDF 入库", "证据定位", "逐项评审", "结果汇总"];
  const STORAGE_KEY = "technical-review-state-v4";
  const LOG_BOTTOM_GAP = 16;
  const BIDDER_RECOGNITION_MS = 420;
  const REVIEW_EVENT_KEYS = DATA.runEvents
    .filter((event) => event.type === "review")
    .map((event) => reviewKeyFor(event.bidder_id, event.item_id));

  const state = loadAppState();

  function createRunState() {
    return {
      eventIndex: 0,
      logs: [],
      started: false,
      reviewStarted: false,
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
      pausedAt: null,
      pausedTotalMs: 0,
      lastEventAt: null,
      waitUntil: null,
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

  function createUploadState() {
    return {
      selected: false,
      parsed: false,
      recognizedCount: 0,
      totalFiles: 0,
      sourceLabel: "",
      startedAt: null,
      finishedAt: null,
      timer: null
    };
  }

  function totalBidderPdfCount() {
    return DATA.bidders.reduce((sum, bidder) => sum + bidder.pdfCount, 0);
  }

  function clearRunTimer() {
    if (state.run.timer) {
      clearInterval(state.run.timer);
      state.run.timer = null;
    }
  }

  function clearUploadRecognitionTimer() {
    if (state.upload && state.upload.timer) {
      clearInterval(state.upload.timer);
      state.upload.timer = null;
    }
  }

  function resetWorkflowState() {
    clearRunTimer();
    clearUploadRecognitionTimer();
    state.run = createRunState();
    state.upload = createUploadState();
    state.reviewOverrides = {};
    state.expertReviews = [];
    state.activeSectionId = "";
    state.showScoringReference = false;
    saveState();
  }

  function loadAppState() {
    const initial = {
      run: createRunState(),
      upload: createUploadState(),
      reviewOverrides: {},
      expertReviews: [],
      activeSectionId: "",
      showScoringReference: false
    };

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return initial;
      const saved = JSON.parse(raw);
      const run = hydrateRunState(saved.run);
      return {
        run,
        upload: hydrateUploadState(saved.upload, run),
        reviewOverrides: saved.reviewOverrides && typeof saved.reviewOverrides === "object" ? saved.reviewOverrides : {},
        expertReviews: Array.isArray(saved.expertReviews) ? saved.expertReviews : [],
        activeSectionId: "",
        showScoringReference: false
      };
    } catch (error) {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch (storageError) {
        // 存储不可用时降级为内存状态，保证页面仍可运行。
      }
      return initial;
    }
  }

  function finiteNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function hydrateRunState(saved) {
    const run = createRunState();
    if (!saved || typeof saved !== "object") return run;

    run.eventIndex = Math.min(Math.max(0, Math.floor(finiteNumber(saved.eventIndex, 0))), DATA.runEvents.length);
    run.logs = Array.isArray(saved.logs) ? saved.logs.slice(-DATA.runEvents.length - 20) : [];
    run.started = Boolean(saved.started);
    run.reviewStarted = Boolean(saved.reviewStarted);
    run.paused = Boolean(saved.paused);
    run.finished = Boolean(saved.finished);
    run.completedReviews = Math.max(0, Math.floor(finiteNumber(saved.completedReviews, 0)));
    run.retries = Math.max(0, Math.floor(finiteNumber(saved.retries, 0)));
    run.unrated = Math.max(0, Math.floor(finiteNumber(saved.unrated, 0)));
    run.inTokens = Math.max(0, Math.floor(finiteNumber(saved.inTokens, 0)));
    run.outTokens = Math.max(0, Math.floor(finiteNumber(saved.outTokens, 0)));
    run.latencyTotal = Math.max(0, finiteNumber(saved.latencyTotal, 0));
    run.startedAt = finiteNumber(saved.startedAt, 0) || null;
    run.finishedAt = finiteNumber(saved.finishedAt, 0) || null;
    run.pausedAt = finiteNumber(saved.pausedAt, 0) || null;
    run.pausedTotalMs = Math.max(0, finiteNumber(saved.pausedTotalMs, 0));
    run.lastEventAt = finiteNumber(saved.lastEventAt, 0) || null;
    run.waitUntil = finiteNumber(saved.waitUntil, 0) || null;
    run.currentLabel = typeof saved.currentLabel === "string" ? saved.currentLabel : run.currentLabel;
    run.stages = { ...run.stages, ...(saved.stages && typeof saved.stages === "object" ? saved.stages : {}) };
    run.timer = null;

    if (run.finished) {
      run.paused = false;
      run.pausedAt = null;
      run.waitUntil = null;
    } else if (run.paused && !run.pausedAt) {
      run.pausedAt = Date.now();
    }
    return run;
  }

  function hydrateUploadState(saved, run) {
    const upload = createUploadState();
    if (saved && typeof saved === "object") {
      upload.selected = Boolean(saved.selected);
      upload.parsed = Boolean(saved.parsed);
      upload.recognizedCount = Math.min(
        DATA.bidders.length,
        Math.max(0, Math.floor(finiteNumber(saved.recognizedCount, 0)))
      );
      upload.totalFiles = Math.max(0, Math.floor(finiteNumber(saved.totalFiles, 0)));
      upload.sourceLabel = typeof saved.sourceLabel === "string" ? saved.sourceLabel : "";
      upload.startedAt = finiteNumber(saved.startedAt, 0) || null;
      upload.finishedAt = finiteNumber(saved.finishedAt, 0) || null;
    } else if (run && (run.started || run.reviewStarted || run.finished || run.completedReviews)) {
      upload.selected = true;
      upload.parsed = true;
      upload.recognizedCount = DATA.bidders.length;
      upload.totalFiles = totalBidderPdfCount();
      upload.sourceLabel = "已选择投标文件";
      upload.startedAt = run.startedAt;
      upload.finishedAt = run.startedAt;
    }
    if (upload.parsed) {
      upload.selected = true;
      upload.recognizedCount = DATA.bidders.length;
      upload.totalFiles = upload.totalFiles || totalBidderPdfCount();
      upload.sourceLabel = upload.sourceLabel || "已选择投标文件";
    }
    if (upload.recognizedCount >= DATA.bidders.length) {
      upload.parsed = true;
      upload.finishedAt = upload.finishedAt || Date.now();
    }
    upload.timer = null;
    return upload;
  }

  function saveState() {
    const run = { ...state.run, timer: null };
    const upload = { ...state.upload, timer: null };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        run,
        upload,
        reviewOverrides: state.reviewOverrides,
        expertReviews: state.expertReviews
      }));
    } catch (error) {
      // 存储不可用时降级为内存状态，保证页面仍可运行。
    }
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

  function scoringItems() {
    return DATA.scoringTable.items;
  }

  function scoringRules() {
    return DATA.scoringTable.rules;
  }

  function itemById(id) {
    return scoringItems().find((item) => item.id === id);
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

  function citedEvidenceEntries(result, evidence) {
    if (!result || result.status === "unrated" || !evidence || !Array.isArray(evidence.picked)) {
      return [];
    }
    const cite = Array.isArray(result.cite) ? result.cite : [];
    return cite
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < evidence.picked.length)
      .map((index) => ({ index, row: evidence.picked[index] }));
  }

  function pageLabel(row) {
    return row.page ? "第 " + row.page + " 页" : "页码未采集";
  }

  function shortBidder(id) {
    const bidder = bidderById(id);
    return bidder ? bidder.short : id;
  }

  function routeForDetail(bidderId, itemId) {
    return "#/detail?bidder=" + encodeURIComponent(bidderId) + "&item=" + encodeURIComponent(itemId);
  }

  function modeText(regularText, demoText) {
    return DEMO_MODE ? demoText : regularText;
  }

  function isUploadParsed() {
    return Boolean(state.upload && state.upload.parsed);
  }

  function isRunAccessible() {
    return Boolean(state.run.started || state.run.reviewStarted || state.run.finished);
  }

  function isResultsAccessible() {
    return Boolean(state.run.completedReviews || state.run.finished);
  }

  function completedReviewKeySet() {
    const count = state.run.finished
      ? REVIEW_EVENT_KEYS.length
      : Math.min(state.run.completedReviews, REVIEW_EVENT_KEYS.length);
    return new Set(REVIEW_EVENT_KEYS.slice(0, count));
  }

  function isReviewCompleted(bidderId, itemId, completedKeys = completedReviewKeySet()) {
    return completedKeys.has(reviewKeyFor(bidderId, itemId));
  }

  function completedReviewResults() {
    const completedKeys = completedReviewKeySet();
    return DATA.reviewResults.filter((row) => completedKeys.has(reviewKeyFor(row.bidder_id, row.item_id)));
  }

  function fallbackRouteHash() {
    if (!isUploadParsed()) return "#/create";
    if (!isRunAccessible()) return "#/create";
    return "#/running";
  }

  function blockedRouteHash(route) {
    if (route.path === "/create") return "";
    if (route.path === "/confirm") return isUploadParsed() && isRunAccessible() ? "" : "#/create";
    if (route.path === "/running") return isRunAccessible() ? "" : fallbackRouteHash();
    if (route.path === "/results") return isResultsAccessible() ? "" : fallbackRouteHash();
    if (route.path === "/detail") {
      if (!isResultsAccessible()) return fallbackRouteHash();
      const bidderId = route.query.get("bidder") || DATA.bidders[0].id;
      const itemId = route.query.get("item") || "T-02";
      return isReviewCompleted(bidderId, itemId) ? "" : "#/results";
    }
    return "#/create";
  }

  function shell(activePath, body) {
    const links = [
      { path: "/create", label: "新建评审", enabled: true },
      { path: "/confirm", label: "确认招标信息", enabled: isUploadParsed() && isRunAccessible() },
      { path: "/running", label: "运行监视", enabled: isRunAccessible() },
      { path: "/results", label: "结果并排", enabled: isResultsAccessible() }
    ];

    return `
      <header class="topbar">
        <div class="brand">
          <h1 class="brand-title">工程建设类技术标辅助评审系统</h1>
          <div class="brand-subtitle">${html(modeText("技术标辅助评审流程", "静态 Demo 原型 · Mock 数据 · 不连接后端"))}</div>
        </div>
        <nav class="nav" aria-label="页面导航">
          ${links.map((link) => link.enabled ? `
            <a class="${activePath === link.path ? "active" : ""}" href="#${link.path}">${link.label}</a>
          ` : `
            <span class="nav-disabled" aria-disabled="true" title="请先完成前置步骤">${link.label}</span>
          `).join("")}
        </nav>
      </header>
      ${body}
    `;
  }

  function render() {
    const route = getRoute();
    const blockedHash = blockedRouteHash(route);
    if (blockedHash) {
      setRoute(blockedHash);
      return;
    }
    if (route.path === "/create" && state.run.finished) {
      resetWorkflowState();
    }
    if (route.path === "/create") {
      app.innerHTML = shell(route.path, renderCreate());
      return;
    }
    if (route.path === "/confirm") {
      app.innerHTML = shell(route.path, renderConfirm());
      return;
    }
    if (route.path === "/running") {
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
    const upload = state.upload;
    const items = scoringItems();
    const recognizedBidders = DATA.bidders.slice(0, upload.recognizedCount);
    const recognizedChars = recognizedBidders.reduce((sum, bidder) => sum + bidder.chars, 0);
    const expectedFiles = totalBidderPdfCount();
    const shownFiles = upload.selected ? (upload.totalFiles || expectedFiles) : 0;
    const uploadStatus = !upload.selected ? "等待选择" : upload.parsed ? "识别完成" : "识别中";
    const uploadBadge = !upload.selected ? "neutral" : upload.parsed ? "success" : "primary";
    const nextClass = upload.parsed ? "btn primary" : "btn primary disabled";
    const nextAttrs = upload.parsed ? `href="#/confirm"` : `href="#/create" aria-disabled="true"`;
    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">新建评审任务</h2>
            <p class="page-desc">选择招标文件与各投标人的技术标 PDF。文件清单识别完成后，点击下一步启动现场解析与计时。</p>
          </div>
          <div class="toolbar">
            <label class="btn primary" for="bidFileInput">选择投标文件</label>
            <input id="bidFileInput" class="file-input" type="file" accept="application/pdf,.pdf" multiple data-file-input>
            <a class="${nextClass}" ${nextAttrs} data-start-parse>下一步：解析</a>
          </div>
        </section>

        <section class="summary-strip" aria-label="任务概览">
          ${metric("评分规则", "已加载", items.length + " 个评分项 / 总分 " + totalScore().toFixed(1) + " 分")}
          ${metric("投标人", recognizedBidders.length + " / " + DATA.bidders.length + " 家", uploadStatus)}
          ${metric("逐项评审", TOTAL_REVIEWS + " 项", "12 家投标人 × 19 个评分项")}
          ${metric("语料体量", recognizedBidders.length ? chars(recognizedChars) : "待解析", shownFiles ? shownFiles + " 个 PDF" : "等待文件选择")}
        </section>

        <section class="layout-grid" style="margin-top: 18px;">
          <div class="panel">
            <div class="panel-header">
              <h3 class="panel-title">基础信息</h3>
              <span class="badge ${uploadBadge}">${uploadStatus}</span>
            </div>
            <div class="panel-body">
              <div class="field-grid">
                <div class="field">
                  <label for="projectName">项目名称</label>
                  <input id="projectName" class="input" value="${html(DATA.scoringTable.project)}">
                </div>
                <div class="field">
                  <label>招标文件</label>
                  <div class="select-like">招标文件.pdf · 已加载</div>
                </div>
                <div class="field">
                  <label>评分规则状态</label>
                  <div class="select-like">已加载 · ${items.length} 个评分项 · 总分 ${totalScore().toFixed(1)} 分</div>
                </div>
                <div class="field">
                  <label>投标文件</label>
                  <div class="select-like">${upload.selected ? html(upload.sourceLabel || "已选择投标文件") : "未选择"}</div>
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
            <span class="badge ${uploadBadge}">${recognizedBidders.length}/${DATA.bidders.length} 已识别</span>
          </div>
          <div class="panel-body">
            <p class="panel-note">文件选择后只做投标人和 PDF 清单识别；点击“下一步：解析”后才开始 S1 入库和现场计时。</p>
            ${recognizedBidders.length ? `
              <div class="bidder-compact-list">
                ${recognizedBidders.map((bidder) => `
                  <div class="bidder-compact-item">
                    <div>
                      <div class="bidder-name" title="${html(bidder.name)}">${html(bidder.name)}</div>
                      <div class="bidder-meta">${bidder.pdfCount} 个 PDF / ${chars(bidder.chars)}</div>
                    </div>
                    <span class="status-dot" title="已识别" aria-label="识别状态：已识别"></span>
                  </div>
                `).join("")}
              </div>
            ` : `
              <div class="empty">请选择投标文件，解析结果会逐家进入列表。</div>
            `}
          </div>
        </section>
      </main>
    `;
  }

  function renderConfirm() {
    const route = getRoute();
    const bindingIssueDemo = DEMO_MODE && route.query.get("binding") === "issue";
    const confirmItems = scoringItems().map((item) => (
      bindingIssueDemo && item.id === "T-15"
        ? { ...item, bound_count: item.expected_bidders - 1 }
        : item
    ));
    const mismatchItem = confirmItems.find((item) => item.bound_count < item.expected_bidders);
    const mismatch = Boolean(mismatchItem);
    const elapsed = runElapsedMs();
    const scoringTotal = totalScore();
    const scoringTotalNote = scoringTotal === 100 ? "来自招标文件" : modeText("待评分规则确认", "Mock 尚未完整替换");
    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">确认招标信息</h2>
            <p class="page-desc">评分表已从招标文件第 33~37 页离线抽出并人工确认。本页用于核对评分项、分值、档位区间和投标文件绑定状态。</p>
          </div>
          <div class="toolbar">
            <a class="btn" href="#/create">上一步</a>
            <button class="btn" data-toggle-reference>${state.showScoringReference ? "收起对照" : "打开对照"}</button>
            ${state.run.started ? `<a class="btn" href="#/running">查看运行监视</a>` : ""}
            ${DEMO_MODE ? `<a class="btn" href="${bindingIssueDemo ? "#/confirm" : "#/confirm?binding=issue"}">${bindingIssueDemo ? "恢复正常绑定" : "演示绑定异常"}</a>` : ""}
            <button class="btn primary" data-start-run ${mismatch ? "disabled" : ""}>确认并开始评审</button>
          </div>
        </section>

        <section class="summary-strip">
          ${metric("评分项", confirmItems.length + " 项", "技术标评分项")}
          ${metric("总分", scoringTotal.toFixed(1) + " 分", scoringTotalNote)}
          ${metric("投标文件绑定", mismatch ? "存在异常" : "全部匹配", mismatch ? mismatchItem.id + " 为 " + mismatchItem.bound_count + "/" + mismatchItem.expected_bidders : "19 项均为 12/12")}
          ${metric("现场计时", `<span data-run-elapsed>${state.run.startedAt ? formatDuration(elapsed) : "未开始"}</span>`, "页面①下一步：解析起算")}
          ${metric("人工介入", "本页一次", "确认后进入现场评审")}
        </section>

        ${state.showScoringReference ? renderScoringReference(confirmItems) : ""}

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
                    ${confirmItems.map((item, index) => `
                      <tr>
                        <td>${index + 1}</td>
                        <td>
                          <strong>${html(item.name)}</strong>
                        </td>
                        <td>
                          ${item.max_score.toFixed(1)}
                        </td>
                        <td>${html(tierSummary(item))}</td>
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
              <ul class="rule-list readonly-rules">
                ${scoringRules().map((rule) => `
                  <li>
                    <span class="check-dot">✓</span>
                    <span>${html(rule)}</span>
                  </li>
                `).join("")}
              </ul>
              <div class="field" style="margin-top: 18px;">
                <label for="projectSummaryReadonly">项目特征摘要</label>
                <textarea id="projectSummaryReadonly" class="textarea readonly-textarea" readonly>${html(DATA.projectSummary)}</textarea>
              </div>
            </div>
          </aside>
        </section>
      </main>
    `;
  }

  function renderScoringReference(items) {
    return `
      <section class="panel reference-panel" aria-label="招标文件评标办法对照">
        <div class="panel-header">
          <h3 class="panel-title">招标文件评标办法对照</h3>
          <span class="badge primary">第 33~37 页</span>
        </div>
        <div class="panel-body reference-grid">
          <aside class="reference-page">
            <div class="reference-page-title">技术标评审办法摘录</div>
            <p>评委根据投标文件对各评分项的响应情况，在一般、良、优三个区间内酌情定分；内容不全酌情扣分，若对应评分项缺项不得分。</p>
            <p>本页用于人工核对评分项名称、满分、三档区间与投标文件绑定状态，确认后才进入逐项评审。</p>
          </aside>
          <div class="table-wrap">
            <table class="table-compact">
              <thead>
                <tr>
                  <th>评分项</th>
                  <th>满分</th>
                  <th>招标文件评审标准原文</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((item) => `
                  <tr>
                    <td><strong>${html(item.name)}</strong></td>
                    <td>${item.max_score.toFixed(1)}</td>
                    <td>${item.criteria ? html(item.criteria) : `<span class="muted">评审标准原文缺失，需回招标文件补</span>`}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    `;
  }

  function renderRunning() {
    const run = state.run;
    const elapsed = runElapsedMs();
    const percent = Math.min(100, (run.completedReviews / TOTAL_REVIEWS) * 100);
    const avgLatency = run.completedReviews ? Math.round(run.latencyTotal / run.completedReviews) : 0;
    const remainingReviews = Math.max(0, TOTAL_REVIEWS - run.completedReviews);
    const estimatedMs = run.completedReviews ? remainingReviews * Math.max(avgLatency, 2400) / DATA.reportData.perf.concurrency : 0;
    const waitingMs = run.lastEventAt ? runTimestampNow(run) - run.lastEventAt : 0;
    const resultButton = isResultsAccessible()
      ? `<a class="btn primary" href="#/results">查看已完成结果</a>`
      : `<span class="btn primary disabled" aria-disabled="true" title="逐项评审开始后才会产生结果">查看已完成结果</span>`;

    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">${run.finished ? "评审完成" : "评审进行中"}</h2>
            <p class="page-desc">逐项评审进度单独统计，分母为 228 = 12 家投标人 × 19 个评分项；S1-S4 用步骤条展示。</p>
          </div>
          <div class="toolbar">
            <button class="btn" data-toggle-run>${run.paused ? "继续" : "暂停"}</button>
            ${resultButton}
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h3 class="panel-title">阶段状态</h3>
            <span class="badge ${run.finished ? "success" : "primary"}">${run.finished ? "报告数据已生成" : "现场运行中"}</span>
          </div>
          <div class="panel-body">
            <div class="stage-stepper" aria-label="S1-S4 运行阶段">
              ${stageNames.map(renderStageStep).join(`<span class="stage-arrow" aria-hidden="true">→</span>`)}
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
                ${metric("已用时间", formatDuration(elapsed), "预计剩余 " + formatDuration(estimatedMs) + " · 按当前吞吐估算")}
                ${metric("当前处理状态", html(run.currentLabel), "已等待 " + formatDuration(waitingMs))}
                ${metric("当前并发", DATA.reportData.perf.concurrency + " 路", "逐项评审并发")}
                ${metric("GPU / 显存", "未采集", "不伪造硬件数据")}
                ${metric("累计输入", number(run.inTokens) + " tokens", "实时累加")}
                ${metric("累计输出", number(run.outTokens) + " tokens", "实时累加")}
                ${metric("重试", run.retries + " 次", "失败先重试")}
                ${metric("未评定", run.unrated + " 项", "不计入合计")}
              </div>
            </div>
          </div>

          <aside class="panel">
            <div class="panel-header">
              <h3 class="panel-title">运行说明</h3>
              <span class="badge neutral">流程约束</span>
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
              <div class="secondary-actions">
                <button class="btn ghost" data-reset-run>${html(modeText("重置流程", "重置演示"))}</button>
              </div>
            </div>
          </aside>
        </section>

        <section class="panel" style="margin-top: 18px;">
          <div class="panel-header">
            <h3 class="panel-title">运行记录</h3>
            <span class="badge neutral">最新在下</span>
          </div>
          <div class="panel-body">
            <div class="run-log">
              <div class="log-head">
                <div>时间</div>
                <div>对象</div>
                <div>事件</div>
                <div class="log-result">结果</div>
              </div>
              ${run.logs.length ? run.logs.map(renderLogRow).join("") : `<div class="empty">等待评审事件进入滚动区</div>`}
            </div>
          </div>
        </section>
      </main>
    `;
  }

  function renderResults() {
    const elapsed = reportElapsedMs();
    const completedKeys = completedReviewKeySet();
    const completedCount = Math.min(state.run.finished ? TOTAL_REVIEWS : state.run.completedReviews, TOTAL_REVIEWS);
    const pendingCount = Math.max(0, TOTAL_REVIEWS - completedCount);
    const canExportReport = Boolean(state.run.finished);
    const visibleReviewFlags = completedReviewResults()
      .filter((row) => row.status === "rated" && row.score !== 0 && row.confidence < LOW_CONFIDENCE_THRESHOLD);
    const visibleAuditFlags = (DATA.reportData.audit || [])
      .filter((row) => scoringItems().some((item) => item.id === row.item_id))
      .filter((row) => DATA.bidders.every((bidder) => isReviewCompleted(bidder.id, row.item_id, completedKeys)));
    const rows = scoringItems().map((item) => {
      const allCompletedForItem = DATA.bidders.every((bidder) => isReviewCompleted(bidder.id, item.id, completedKeys));
      const audit = allCompletedForItem ? auditByItem(item.id) : null;
      return `
        <tr class="${audit ? "row-warning" : ""}">
          <td class="sticky-item" data-score-col="0">
            <strong>${html(item.name)}</strong>
            ${audit ? `<div class="small muted">无区分度，建议复核 · ${html(audit.detail)}</div>` : ""}
          </td>
          <td class="sticky-max" data-score-col="1">${item.max_score.toFixed(1)}</td>
          ${DATA.bidders.map((bidder, index) => renderScoreCell(bidder, item, index, completedKeys)).join("")}
        </tr>
      `;
    }).join("");

    return `
      <main class="page page-wide">
        <section class="page-header">
          <div>
            <h2 class="page-title">评审结果并排</h2>
            <p class="page-desc">并排展示 12 家投标人的逐项结果，供专家查看和比较；系统不输出跨家优劣判断。</p>
          </div>
          <div class="toolbar">
            <a class="btn" href="#/running">返回运行监视</a>
            <button class="btn primary" data-export-report ${canExportReport ? "" : "disabled"} title="${canExportReport ? "导出完整静态 HTML 报告" : "评审完成后才能导出正式报告"}">导出报告</button>
          </div>
        </section>

        <section class="summary-strip">
          ${metric("投标人", DATA.bidders.length + " 家", "横向滚动展示")}
          ${metric("已完成", completedCount + " / " + TOTAL_REVIEWS, pendingCount ? pendingCount + " 项评审中" : "全部完成")}
          ${metric("用时", formatDuration(elapsed), state.run.startedAt ? "从页面①下一步：解析起算" : "尚未开始")}
          ${metric("建议复核", (visibleReviewFlags.length + visibleAuditFlags.length) + " 项", "低置信 " + visibleReviewFlags.length + " / 无区分度 " + visibleAuditFlags.length)}
        </section>

        ${pendingCount ? `
          <section class="panel status-panel" style="margin-top: 18px;">
            <div class="panel-body">
              <div class="info-box">
                <strong>当前为运行快照</strong>
                <span class="muted">还有 ${pendingCount} 项未完成，当前合计不含评审中项；正式报告需等全部评审完成后导出。</span>
              </div>
            </div>
          </section>
        ` : ""}

        <section class="panel" style="margin-top: 18px;">
          <div class="panel-header">
            <h3 class="panel-title">并排矩阵</h3>
            <span class="badge neutral">评分项列固定 · 12 家横向滚动</span>
          </div>
          <div class="panel-body">
            <div class="table-wrap matrix-wrap">
              <table class="score-matrix">
                <thead>
                  <tr>
                    <th class="sticky-item" data-score-col="0">评分项</th>
                    <th class="sticky-max" data-score-col="1">满分</th>
                    ${DATA.bidders.map((bidder, index) => `<th data-score-col="${index + 2}">${html(bidder.short)}</th>`).join("")}
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                  <tr class="matrix-total-row">
                    <td class="sticky-item" data-score-col="0"><strong>合计（19 项）</strong></td>
                    <td class="sticky-max" data-score-col="1"><strong>${totalScore().toFixed(1)}</strong></td>
                    ${DATA.bidders.map((bidder, index) => {
                      const systemTotal = systemTotalForBidder(bidder, completedKeys);
                      const expertTotal = expertTotalForBidder(bidder, completedKeys);
                      return `
                        <td data-score-col="${index + 2}" title="系统合计不含评审中项；专家口径只在存在改判时显示">
                          <strong>${systemTotal.score.toFixed(1)}${systemTotal.unrated ? "*" : ""}</strong>
                          ${expertTotal.overrides ? `<div class="manual-score">专家 ${expertTotal.score.toFixed(1)}</div>` : ""}
                        </td>
                      `;
                    }).join("")}
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="legend">
              <span>0 = 未命中，投标文件未写此项</span>
              <span>— = 未评定，系统未能给出判断，不计入合计</span>
              <span>评审中 = 结果尚未到达，暂不计入当前合计</span>
              <span>复核 = confidence &lt; ${LOW_CONFIDENCE_THRESHOLD}，建议人工复核</span>
              <span>无区分度 = 12 家落在同一档，建议复核</span>
              <span>人工 = 专家改判值，与系统判分并存</span>
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
    const item = itemById(itemId) || scoringItems()[1];
    const result = resultBy(bidder.id, item.id);
    const evidence = evidenceBy(bidder.id, item.id);

    if (!result || !evidence) {
      return `
        <main class="page">
          <div class="panel"><div class="empty">未找到对应详情</div></div>
        </main>
      `;
    }

    const reviewKey = reviewKeyFor(bidder.id, item.id);
    const review = normalizeExpertReview(reviewKey, state.reviewOverrides[reviewKey]);
    const overrideScore = numericOverrideScore(review);
    const citedEntries = citedEvidenceEntries(result, evidence);
    const activeSection = state.activeSectionId || (citedEntries[0] ? citedEntries[0].row.section_id : "");
    state.activeSectionId = activeSection;
    const titleStatus = result.status === "unrated"
      ? "未评定"
      : result.score === 0
        ? "未命中"
        : "判分 " + result.tier;
    const scoreText = scoreLabel(result.score);
    const overrideScoreText = scoreLabel(overrideScore);

    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">${html(bidder.short)} · ${html(item.name)}</h2>
            <p class="page-desc">${titleStatus} · 系统 ${scoreText} / ${item.max_score.toFixed(1)} 分${overrideScore !== null ? "；人工改判 " + overrideScoreText + " 分" : ""}</p>
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
                  ${metric("系统判分", scoreText, result.status === "unrated" ? "score 保持为 null" : "不因下方操作改变")}
                  ${metric("专家判分", overrideScore !== null ? overrideScoreText : "—", overrideScore !== null ? "仅进入专家口径合计" : "未改判")}
                  ${metric("当前档位", result.tier || "无", result.status === "unrated" ? "重试耗尽未进入判分" : result.score === 0 ? "按缺项不得分处理" : "来自评分区间")}
                  ${metric("置信度", result.confidence.toFixed(2), result.status === "unrated" ? "未产生有效判分" : isLowConfidence(result) ? "建议人工复核" : "可追溯")}
                  ${metric("调用次数", result.attempts + " 次", result.attempts > 1 ? "曾重试" : "一次成功")}
                </div>
              </div>
            </section>

            <section class="panel" style="margin-top: 18px;">
              <div class="panel-header">
                <h3 class="panel-title">评分档位</h3>
                <span class="badge neutral">区间来自招标文件</span>
              </div>
              <div class="panel-body">
                <div class="tier-list">
                  ${item.tiers.map((tier) => `
                    <div class="tier ${tier.tier === result.tier ? "active" : ""}">
                      <div class="tier-name">${tier.tier}</div>
                      <div>${tier.min.toFixed(1)}-${tier.max.toFixed(1)} 分</div>
                      <div class="small muted">${tier.desc ? html(tier.desc) : "专家补充说明未填写"}</div>
                    </div>
                  `).join("")}
                </div>
                ${item.criteria ? `
                  <blockquote class="tier-quote">
                    <div class="tier-quote-label">招标文件第 33~37 页评审标准原文</div>
                    ${html(item.criteria)}
                  </blockquote>
                ` : `<p class="small muted">评审标准原文缺失，本项判档位缺少依据，需回招标文件补。</p>`}
              </div>
            </section>

            ${result.status === "unrated" ? renderUnratedPanel(result) : `
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
                  <span class="badge neutral">${citationBadge(result, citedEntries)}</span>
                </div>
                <div class="panel-body">
                  ${renderCitationBody(result, citedEntries, activeSection)}
                </div>
              </section>
            `}

            ${renderRetrievalPanel(result, evidence)}

            <section class="panel" style="margin-top: 18px;">
              <div class="panel-header">
                <h3 class="panel-title">专家复核</h3>
                <span class="badge neutral">${html(modeText("本地复核记录", "原型本地状态"))}</span>
              </div>
              <div class="panel-body">
                <div class="review-form">
                  <button class="btn" data-review-approve data-bidder="${html(bidder.id)}" data-item="${html(item.id)}">认可</button>
                  <input id="overrideScore" class="input" placeholder="改判分数" value="${overrideScore !== null ? html(overrideScore) : ""}">
                  <input id="overrideNote" class="input" placeholder="备注" value="${review && review.note ? html(review.note) : ""}">
                  <button class="btn primary" data-review-save data-bidder="${html(bidder.id)}" data-item="${html(item.id)}">保存改判</button>
                </div>
                <div class="small muted" style="margin-top: 10px;">系统判分 ${scoreText} 分不因认可或改判改变；未评定项被改判后，页面④系统格仍显示 “—”。</div>
                ${review ? `<div class="review-note">已记录：${html(review.action)}${overrideScore !== null ? "，人工 " + html(overrideScore) + " 分" : ""}${review.note ? "，备注：" + html(review.note) : ""}</div>` : ""}
              </div>
            </section>
          </div>

          ${result.status === "unrated" ? renderUnratedAside(result) : `
            <aside class="panel source-viewer">
              <div class="panel-header">
                <h3 class="panel-title">原文定位</h3>
                <span class="badge primary">PDF 页定位模拟</span>
              </div>
              <div class="panel-body">
                ${renderSourceViewer(citedEntries, activeSection)}
              </div>
            </aside>
          `}
        </section>
      </main>
    `;
  }

  function unratedReason(result) {
    return "模型调用 " + result.attempts + " 次后仍未返回有效判分结果；最后错误：" + (result.last_error || "无") + "。该项按未评定处理，score 保持为 null，不参与合计。";
  }

  function renderUnratedPanel(result) {
    return `
      <section class="panel" style="margin-top: 18px;">
        <div class="panel-header">
          <h3 class="panel-title">未评定失败信息</h3>
          <span class="badge danger">无有效判分</span>
        </div>
        <div class="panel-body">
          <div class="info-box">
            <strong>调用 ${result.attempts} 次 · 最后错误：${html(result.last_error || "无")}</strong>
            <span class="muted">${html(unratedReason(result))}</span>
          </div>
        </div>
      </section>
    `;
  }

  function renderUnratedAside(result) {
    return `
      <aside class="panel source-viewer">
        <div class="panel-header">
          <h3 class="panel-title">调用状态</h3>
          <span class="badge danger">未进入判分</span>
        </div>
        <div class="panel-body">
          <div class="source-page">
            <div class="empty">调用 ${result.attempts} 次后仍未产生有效判分，最后错误：${html(result.last_error || "无")}。</div>
          </div>
        </div>
      </aside>
    `;
  }

  function citationBadge(result, citedEntries) {
    if (result.status === "unrated") return "无有效引用";
    const cite = Array.isArray(result.cite) ? result.cite : [];
    if (!cite.length) return "引用编号 无";
    if (!citedEntries.length) return "引用编号越界";
    return "引用编号 " + citedEntries.map((entry) => entry.index).join("、");
  }

  function renderCitationBody(result, citedEntries, activeSection) {
    if (result.status === "unrated") {
      return `<div class="empty">该项未产生有效判分结果，暂无可展示的引用证据。</div>`;
    }
    if (!citedEntries.length) {
      return result.score === 0
        ? `<div class="empty">未检索到合格证据。按招标文件规则“若此条缺项不得分”处理。</div>`
        : `<div class="empty">未找到合法引用编号，真实调用中应触发重试。</div>`;
    }
    return `
                  <div class="evidence-list">
                    ${citedEntries.map((entry) => renderEvidence(entry.row, entry.index, activeSection)).join("")}
                  </div>
    `;
  }

  function renderRetrievalPanel(result, evidence) {
    const picked = Array.isArray(evidence.picked) ? evidence.picked : [];
    const truncated = picked.some((row) => row.truncated);
    const retryCount = Math.max(0, result.attempts - 1);
    return `
      <section class="panel" style="margin-top: 18px;">
        <div class="panel-header">
          <h3 class="panel-title">检索与置信度</h3>
          <span class="badge neutral">按分值分配证据上限</span>
        </div>
        <div class="panel-body">
          <div class="info-box">
            <strong>证据 ${number(evidence.units)} 段 / ${number(evidence.evidence_chars)} 字（上限 ${number(evidence.budget)} 字）</strong>
            <span class="muted">降级检索 ${evidence.fallback ? "是" : "否"} · 截断 ${truncated ? "是" : "否"} · 重试 ${retryCount} 次 · confidence ${result.confidence.toFixed(2)}</span>
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
            <div class="evidence-path">${html(row.path.join(" › "))} · ${pageLabel(row)}</div>
          </div>
          <button class="btn link" data-locate-section="${html(row.section_id)}">在原文中定位</button>
        </div>
        <div class="quote">“${html(row.text)}”</div>
        ${row.parse_hint ? `<span class="badge warning">${html(row.parse_hint)}</span>` : ""}
        ${row.truncated ? `<span class="badge warning">建议人工复核</span>` : ""}
      </article>
    `;
  }

  function renderSourceViewer(citedEntries, activeSection) {
    if (!citedEntries.length) {
      return `<div class="source-page"><div class="empty">没有可定位的原文片段</div></div>`;
    }
    return `
      <div class="source-page">
        ${citedEntries.map(({ row, index }) => `
          <section id="${sourceDomId(row.section_id)}" class="source-block ${row.section_id === activeSection ? "active" : ""}">
            <h4>[${index}] ${pageLabel(row)} · ${html(row.path[row.path.length - 1])}</h4>
            <p>${html(row.text)}</p>
          </section>
        `).join("")}
      </div>
    `;
  }

  function renderScoreCell(bidder, item, bidderIndex, completedKeys = completedReviewKeySet()) {
    if (!isReviewCompleted(bidder.id, item.id, completedKeys)) {
      return `
        <td data-score-col="${bidderIndex + 2}">
          <span class="score-cell pending" title="该评分项仍在评审中">评审中</span>
        </td>
      `;
    }

    const result = resultBy(bidder.id, item.id);
    if (!result) {
      return `
        <td data-score-col="${bidderIndex + 2}">
          <span class="score-cell pending" title="等待结果写入">评审中</span>
        </td>
      `;
    }
    const href = routeForDetail(bidder.id, item.id);
    const review = overrideBy(bidder.id, item.id);
    const overrideScore = numericOverrideScore(review);
    const approved = reviewAction(review) === "认可";
    const low = isLowConfidence(result);
    let cls = "score-cell";
    let label = "";
    let title = "点击查看判分依据";

    if (result.status === "unrated") {
      cls += " unrated";
      label = "—";
      title = "未评定，点击查看失败信息";
    } else if (result.score === 0) {
      cls += " zero";
      label = "0";
      title = "未命中，点击查看依据";
    } else {
      label = result.score.toFixed(1) + (low ? " 复核" : "");
      if (low) cls += " review";
    }

    if (overrideScore !== null) {
      title = "已人工改判，点击查看系统判分、人工分和依据";
    } else if (approved) {
      cls += " approved";
      title = "专家已认可，点击查看判分依据";
    }

    return `
      <td data-score-col="${bidderIndex + 2}">
        <a class="${cls}" href="${href}" title="${html(title)}">
          <span class="score-cell-main">${html(label)}</span>
          ${overrideScore !== null ? `<span class="manual-score">人工 ${scoreLabel(overrideScore)}</span>` : ""}
          ${approved ? `<span class="approved-label">认可</span>` : ""}
        </a>
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

  function renderStageStep(name) {
    const status = state.run.stages[name];
    const cls = status === "已完成" ? "done" : status === "进行中" ? "running" : "waiting";
    const mark = status === "已完成" ? "✓" : status === "进行中" ? "●" : "○";
    const label = name === "PDF 入库" ? "PDF入库" : name;

    return `
      <div class="stage-step ${cls}" aria-label="${html(label + "：" + status)}">
        <div class="stage-step-main">
          <span>${html(label)}</span>
          <span class="stage-step-mark" aria-hidden="true">${mark}</span>
        </div>
        <div class="stage-step-state">${html(status)}</div>
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

  function totalScore() {
    return scoringItems().reduce((sum, item) => sum + item.max_score, 0);
  }

  function runElapsedMs() {
    if (!state.run.startedAt) return 0;
    const endAt = state.run.finishedAt || runTimestampNow(state.run);
    return Math.max(0, endAt - state.run.startedAt - state.run.pausedTotalMs);
  }

  function runTimestampNow(run) {
    return run.paused && run.pausedAt ? run.pausedAt : Date.now();
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
      saveState();
    }
    if (!run.timer && !run.finished) {
      run.timer = setInterval(tickRun, 750);
    }
  }

  function startReview() {
    ensureRunStarted("确认完成，进入逐项评审");
    const run = state.run;
    if (run.paused) {
      toggleRunPaused();
    }
    if (!run.reviewStarted) {
      run.reviewStarted = true;
      run.paused = false;
      run.currentLabel = "确认完成，进入逐项评审";
      run.logs.push({
        time: clock(),
        kind: "system",
        message: "人工确认完成，逐项评审事件流已放行",
        result: "开始评审"
      });
      saveState();
    }
  }

  function isReviewPhaseEvent(event) {
    if (!event) return false;
    return event.type === "review" ||
      event.type === "retry" ||
      event.type === "wait" ||
      (event.type === "stage" && (event.stage === "逐项评审" || event.stage === "结果汇总"));
  }

  function canConsumeEvent(event) {
    return !isReviewPhaseEvent(event) || state.run.reviewStarted;
  }

  function markWaitingForReviewGate() {
    const run = state.run;
    if (!run.reviewStarted && run.currentLabel !== "等待人工确认开始逐项评审") {
      run.currentLabel = "等待人工确认开始逐项评审";
      saveState();
    }
  }

  function completeRun() {
    const run = state.run;
    run.finished = true;
    run.finishedAt = Date.now();
    run.paused = false;
    run.pausedAt = null;
    run.waitUntil = null;
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

  function beginUploadRecognition(fileCount) {
    clearRunTimer();
    clearUploadRecognitionTimer();
    state.run = createRunState();
    state.upload = createUploadState();
    state.reviewOverrides = {};
    state.expertReviews = [];
    state.activeSectionId = "";
    state.showScoringReference = false;
    state.upload.selected = true;
    state.upload.totalFiles = fileCount || totalBidderPdfCount();
    state.upload.sourceLabel = state.upload.totalFiles + " 个文件已选择";
    state.upload.startedAt = Date.now();
    startUploadRecognitionTimer();
    saveState();
    render();
  }

  function startUploadRecognitionTimer() {
    clearUploadRecognitionTimer();
    const upload = state.upload;
    if (!upload || !upload.selected || upload.parsed) return;
    upload.timer = setInterval(() => {
      if (!upload.selected || upload.parsed) {
        clearUploadRecognitionTimer();
        return;
      }
      upload.recognizedCount = Math.min(DATA.bidders.length, upload.recognizedCount + 1);
      if (upload.recognizedCount >= DATA.bidders.length) {
        upload.parsed = true;
        upload.finishedAt = Date.now();
        upload.sourceLabel = (upload.totalFiles || totalBidderPdfCount()) + " 个文件已识别";
        clearUploadRecognitionTimer();
      }
      saveState();
      if (getRoute().path === "/create") {
        render();
      }
    }, BIDDER_RECOGNITION_MS);
  }

  function tickRun() {
    const route = getRoute();
    const run = state.run;
    let changed = false;
    if (!run.paused && !run.finished) {
      const now = Date.now();
      if (run.waitUntil && now < run.waitUntil) {
        updateRuntimeFields(route.path);
      } else {
        if (run.waitUntil) {
          run.waitUntil = null;
          changed = true;
        }
        const event = DATA.runEvents[run.eventIndex];
        if (event && canConsumeEvent(event)) {
          processRunEvent(event);
          run.eventIndex += 1;
          changed = true;
        } else if (event) {
          markWaitingForReviewGate();
        }
      }
      if (run.eventIndex >= DATA.runEvents.length) {
        completeRun();
        changed = true;
      }
    }
    if (changed) {
      saveState();
    }

    if (route.path === "/confirm") {
      updateRuntimeFields(route.path);
      return;
    }
    if (route.path === "/running") {
      if (changed || (!run.paused && !run.finished)) {
        renderPreservingRunLog();
      }
      return;
    }
    if (route.path === "/results") {
      if (changed) {
        renderPreservingMatrixScroll();
      }
    }
  }

  function updateRuntimeFields(path) {
    if (path !== "/confirm") return;
    const elapsed = document.querySelector("[data-run-elapsed]");
    if (elapsed) {
      elapsed.textContent = state.run.startedAt ? formatDuration(runElapsedMs()) : "未开始";
    }
  }

  function isRunLogPinned(log) {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= LOG_BOTTOM_GAP;
  }

  function renderPreservingRunLog() {
    const log = document.querySelector(".run-log");
    const shouldPin = log ? isRunLogPinned(log) : true;
    const scrollTop = log ? log.scrollTop : 0;
    render();
    const nextLog = document.querySelector(".run-log");
    if (!nextLog) return;
    if (shouldPin) {
      nextLog.scrollTop = nextLog.scrollHeight;
    } else {
      nextLog.scrollTop = scrollTop;
    }
  }

  function renderPreservingMatrixScroll() {
    const matrix = document.querySelector(".matrix-wrap");
    const scrollLeft = matrix ? matrix.scrollLeft : 0;
    const scrollTop = matrix ? matrix.scrollTop : 0;
    render();
    const nextMatrix = document.querySelector(".matrix-wrap");
    if (nextMatrix) {
      nextMatrix.scrollLeft = scrollLeft;
      nextMatrix.scrollTop = scrollTop;
    }
  }

  function scrollRunLogToBottom() {
    const log = document.querySelector(".run-log");
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }

  function pushRunLog(row) {
    state.run.logs.push(row);
  }

  function processWaitEvent(event, bidder, item) {
    const run = state.run;
    run.waitUntil = Date.now() + Math.max(0, event.duration_ms || 0);
    run.stages["逐项评审"] = "进行中";
    run.currentLabel = (bidder ? bidder.short : event.bidder_id) + " · " + (item ? item.name : event.item_id);
    pushRunLog({
      time: clock(),
      kind: "system",
      bidder: bidder ? bidder.short : event.bidder_id,
      item: item ? item.name : event.item_id,
      result: event.message || "等待模型返回"
    });
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
      pushRunLog({
        time: clock(),
        kind: "system",
        message: event.message,
        result: event.status === "done" ? "已完成" : "进行中"
      });
      return;
    }

    const item = itemById(event.item_id);
    const bidder = bidderById(event.bidder_id);

    if (event.type === "wait") {
      processWaitEvent(event, bidder, item);
      return;
    }

    run.currentLabel = (bidder ? bidder.short : event.bidder_id) + " · " + (item ? item.name : event.item_id);

    if (event.type === "retry") {
      run.retries += 1;
      run.stages["逐项评审"] = "进行中";
      pushRunLog({
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

      pushRunLog({
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

  function reviewKeyFor(bidderId, itemId) {
    return bidderId + "__" + itemId;
  }

  function overrideBy(bidderId, itemId) {
    const key = reviewKeyFor(bidderId, itemId);
    return normalizeExpertReview(key, state.reviewOverrides[key]);
  }

  function reviewAction(review) {
    if (!review) return "";
    if (review.action) return review.action;
    if (review.type === "人工改判") return "改判";
    return review.type || "";
  }

  function numericOverrideScore(review) {
    if (reviewAction(review) !== "改判") return null;
    const score = Number(review.expert_score ?? review.score);
    return Number.isFinite(score) ? score : null;
  }

  function roundScore(value) {
    return Math.round(value * 10) / 10;
  }

  function systemTotalForBidder(bidder, completedKeys = completedReviewKeySet()) {
    const rows = scoringItems()
      .filter((item) => isReviewCompleted(bidder.id, item.id, completedKeys))
      .map((item) => resultBy(bidder.id, item.id));
    const score = rows.reduce((sum, row) => sum + (row && typeof row.score === "number" ? row.score : 0), 0);
    const unrated = rows.filter((row) => row && row.status === "unrated").length;
    return {
      score: roundScore(score),
      unrated
    };
  }

  function expertTotalForBidder(bidder, completedKeys = completedReviewKeySet()) {
    let score = 0;
    let overrides = 0;
    scoringItems()
      .filter((item) => isReviewCompleted(bidder.id, item.id, completedKeys))
      .forEach((item) => {
        const result = resultBy(bidder.id, item.id);
        const overrideScore = numericOverrideScore(overrideBy(bidder.id, item.id));
        if (overrideScore !== null) {
          score += overrideScore;
          overrides += 1;
          return;
        }
        if (result && typeof result.score === "number") {
          score += result.score;
        }
      });
    return {
      score: roundScore(score),
      overrides
    };
  }

  function scoreLabel(value) {
    if (value == null) return "—";
    if (value === 0) return "0";
    return value.toFixed(1);
  }

  function localIsoNow() {
    const date = new Date();
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absolute = Math.abs(offsetMinutes);
    return date.getFullYear() + "-" +
      pad(date.getMonth() + 1) + "-" +
      pad(date.getDate()) + "T" +
      pad(date.getHours()) + ":" +
      pad(date.getMinutes()) + ":" +
      pad(date.getSeconds()) +
      sign + pad(Math.floor(absolute / 60)) + ":" + pad(absolute % 60);
  }

  function normalizeExpertReview(key, review) {
    if (!review || typeof review !== "object") return null;
    const [bidderId = "", itemId = ""] = String(key || "").split("__");
    const result = resultBy(review.bidder_id || bidderId, review.item_id || itemId);
    const bidder = bidderById(review.bidder_id || bidderId);
    const action = reviewAction(review);
    const expertScore = action === "改判"
      ? numericOverrideScore(review)
      : result && typeof result.score === "number" ? result.score : null;
    const systemScore = "system_score" in review ? review.system_score : result ? result.score : null;
    const delta = "delta" in review
      ? review.delta
      : action === "改判" && typeof systemScore === "number" && typeof expertScore === "number"
        ? roundScore(expertScore - systemScore)
        : action === "认可" && typeof systemScore === "number"
          ? 0
          : null;

    return {
      bidder: review.bidder || (bidder ? bidder.name : ""),
      bidder_id: review.bidder_id || bidderId,
      item_id: review.item_id || itemId,
      action,
      system_score: systemScore,
      expert_score: expertScore,
      delta,
      note: review.note || "",
      reviewed_at: review.reviewed_at || ""
    };
  }

  function makeExpertReview(bidderId, itemId, action, expertScore, note) {
    const result = resultBy(bidderId, itemId);
    const bidder = bidderById(bidderId);
    const systemScore = result ? result.score : null;
    const roundedExpert = action === "改判" ? roundScore(expertScore) : systemScore;
    const delta = action === "改判" && typeof systemScore === "number"
      ? roundScore(roundedExpert - systemScore)
      : action === "认可" && typeof systemScore === "number"
        ? 0
        : null;
    return {
      bidder: bidder ? bidder.name : bidderId,
      bidder_id: bidderId,
      item_id: itemId,
      action,
      system_score: systemScore,
      expert_score: roundedExpert,
      delta,
      note: note || "",
      reviewed_at: localIsoNow()
    };
  }

  function recordExpertReview(record) {
    const key = reviewKeyFor(record.bidder_id, record.item_id);
    state.reviewOverrides[key] = record;
    if (!Array.isArray(state.expertReviews)) {
      state.expertReviews = [];
    }
    state.expertReviews.push(record);
  }

  function expertReviewRecords() {
    const records = Array.isArray(state.expertReviews)
      ? state.expertReviews.map((record) => normalizeExpertReview(reviewKeyFor(record.bidder_id, record.item_id), record)).filter(Boolean)
      : [];
    const seen = new Set(records.map((record) => reviewKeyFor(record.bidder_id, record.item_id) + "__" + record.reviewed_at));
    Object.entries(state.reviewOverrides || {}).forEach(([key, review]) => {
      const record = normalizeExpertReview(key, review);
      if (!record) return;
      const marker = key + "__" + record.reviewed_at;
      if (!seen.has(marker)) {
        records.push(record);
        seen.add(marker);
      }
    });
    return records;
  }

  function auditByItem(itemId) {
    return (DATA.reportData.audit || []).find((row) => row.item_id === itemId && row.kind === "no_discrimination");
  }

  function buildReportHtml() {
    const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });
    const perf = DATA.reportData.perf;
    const computeNotes = DATA.reportData.compute_notes || {};
    const completedKeys = completedReviewKeySet();
    const reportReviews = expertReviewRecords().filter((record) => {
      const bidder = bidderById(record.bidder_id);
      return bidder && isReviewCompleted(bidder.id, record.item_id, completedKeys);
    });
    const matrixRows = scoringItems().map((item) => {
      const audit = auditByItem(item.id);
      return `
        <tr class="${audit ? "audit-row" : ""}">
          <td>
            ${html(item.name)}
            ${audit ? `<div class="note">无区分度，建议复核：${html(audit.detail)}</div>` : ""}
          </td>
          <td>${item.max_score.toFixed(1)}</td>
          ${DATA.bidders.map((bidder) => {
            if (!isReviewCompleted(bidder.id, item.id, completedKeys)) {
              return `<td class="pending">评审中</td><td></td>`;
            }
            const result = resultBy(bidder.id, item.id);
            const review = overrideBy(bidder.id, item.id);
            const overrideScore = numericOverrideScore(review);
            const systemLabel = result.status === "unrated"
              ? "—"
              : scoreLabel(result.score) + (isLowConfidence(result) ? " 复核" : "");
            const systemClass = isLowConfidence(result)
              ? "low"
              : result.status === "unrated"
                ? "unrated"
                : result.score === 0
                  ? "zero"
                  : "";
            return `<td class="${systemClass}">${html(systemLabel)}</td><td class="${overrideScore !== null ? "override" : ""}">${overrideScore !== null ? html(scoreLabel(overrideScore)) : ""}</td>`;
          }).join("")}
        </tr>
      `;
    }).join("");
    const totalRow = `
      <tr class="total">
        <td>合计（19 项）</td>
        <td>${totalScore().toFixed(1)}</td>
        ${DATA.bidders.map((bidder) => {
          const systemTotal = systemTotalForBidder(bidder, completedKeys);
          const expertTotal = expertTotalForBidder(bidder, completedKeys);
          return `<td>${systemTotal.score.toFixed(1)}${systemTotal.unrated ? "*" : ""}</td><td>${expertTotal.overrides ? expertTotal.score.toFixed(1) : ""}</td>`;
        }).join("")}
      </tr>
    `;
    const unrated = DATA.reportData.unrated.filter((row) => {
      const bidder = DATA.bidders.find((item) => item.name === row.bidder);
      return bidder && isReviewCompleted(bidder.id, row.item_id, completedKeys);
    });
    const reviewFlags = DATA.reportData.review_flags.filter((row) => {
      const bidder = DATA.bidders.find((item) => item.name === row.bidder);
      return bidder && isReviewCompleted(bidder.id, row.item_id, completedKeys);
    });
    const unratedRows = unrated.length
      ? unrated.map((row) => {
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
    const reviewRows = reviewFlags.length
      ? reviewFlags.map((row) => {
        const item = itemById(row.item_id);
        return `<li>${html(row.bidder)} · ${html(row.item_id)} ${html(item ? item.name : "")} · confidence ${row.confidence.toFixed(2)} · ${html(row.why)}</li>`;
      }).join("")
      : "<li>无低置信度项</li>";
    const auditRows = (DATA.reportData.audit || []).length
      ? DATA.reportData.audit.map((row) => {
        const item = itemById(row.item_id);
        return `<li>${html(row.item_id)} ${html(item ? item.name : "")} · ${html(row.detail)}</li>`;
      }).join("")
      : "<li>无无区分度审计项</li>";
    const expertRows = reportReviews.length
      ? reportReviews.map((record) => {
        const item = itemById(record.item_id);
        return `
          <tr>
            <td>${html(record.bidder)}</td>
            <td>${html(record.item_id)} ${html(item ? item.name : "")}</td>
            <td>${html(record.action)}</td>
            <td>${html(scoreLabel(record.system_score))}</td>
            <td>${html(scoreLabel(record.expert_score))}</td>
            <td>${html(scoreLabel(record.delta))}</td>
            <td>${html(record.note || "")}</td>
            <td>${html(record.reviewed_at || "")}</td>
          </tr>
        `;
      }).join("")
      : `<tr><td colspan="8">暂无专家复核记录</td></tr>`;
    const computeMethod = Array.isArray(computeNotes.method) ? computeNotes.method : [];

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
    table { width: 100%; border-collapse: collapse; min-width: 1640px; }
    th, td { padding: 8px 10px; border: 1px solid #d9e0ea; text-align: left; vertical-align: top; }
    th { background: #f3f6fa; white-space: nowrap; }
    .total td { background: #f8fafc; font-weight: 700; }
    .audit-row td { background: #fffaf0; }
    .low { color: #a45f0a; font-weight: 700; }
    .override { color: #0b6b52; font-weight: 700; }
    .unrated { color: #b42318; font-weight: 700; }
    .zero { color: #667085; }
    .pending { color: #667085; font-weight: 700; }
    .single-column, .perf, .expert-table { min-width: 0; }
    .perf { max-width: 780px; }
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
          ${DATA.bidders.map((bidder) => `<th colspan="2">${html(bidder.short)}</th>`).join("")}
        </tr>
        <tr>
          <th></th>
          <th></th>
          ${DATA.bidders.map(() => `<th>系统</th><th>专家</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${matrixRows}
        ${totalRow}
      </tbody>
    </table>
  </div>
  <p class="note">0 = 未命中；— = 未评定；复核 = confidence &lt; ${LOW_CONFIDENCE_THRESHOLD}；专家列仅列人工改判值；* = 该家存在未评定项。</p>

  <h2>未评定单列</h2>
  <table class="single-column">
    <thead><tr><th>未评定项</th></tr></thead>
    <tbody>${unratedRows}</tbody>
  </table>

  <h2>建议人工复核</h2>
  <ul>${reviewRows}</ul>

  <h2>无区分度审计</h2>
  <ul>${auditRows}</ul>

  <h2>专家复核记录</h2>
  <table class="expert-table">
    <thead>
      <tr><th>投标人</th><th>评分项</th><th>动作</th><th>系统分</th><th>专家分</th><th>差值</th><th>备注</th><th>时间</th></tr>
    </thead>
    <tbody>${expertRows}</tbody>
  </table>

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

  <h2>compute_notes</h2>
  <table class="perf">
    <tbody>
      <tr><th>算力归属</th><td>${html(computeNotes.owner || "未采集")}</td></tr>
      <tr><th>硬件规格</th><td>${html(computeNotes.spec || "未采集")}</td></tr>
      <tr><th>模型版本</th><td>${html(computeNotes.model || "未采集")}</td></tr>
      <tr><th>技术做法</th><td><ul>${computeMethod.map((row) => `<li>${html(row)}</li>`).join("") || "<li>未采集</li>"}</ul></td></tr>
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
      if (!isUploadParsed()) {
        window.alert("请先选择投标文件，并等待识别完成。");
        return;
      }
      if (!state.run.started) {
        ensureRunStarted("页面①点击下一步：解析，开始 PDF 入库和现场计时");
      }
      setRoute("#/confirm");
      return;
    }

    const start = event.target.closest("[data-start-run]");
    if (start) {
      if (!isUploadParsed()) {
        window.alert("请先完成投标文件解析。");
        return;
      }
      startReview();
      setRoute("#/running");
      return;
    }

    const toggleReference = event.target.closest("[data-toggle-reference]");
    if (toggleReference) {
      state.showScoringReference = !state.showScoringReference;
      render();
      return;
    }

    const exportReport = event.target.closest("[data-export-report]");
    if (exportReport) {
      if (!state.run.finished) {
        window.alert("评审完成后才能导出正式报告。当前结果页仅作为运行快照查看。");
        return;
      }
      downloadReport();
      return;
    }

    const toggle = event.target.closest("[data-toggle-run]");
    if (toggle) {
      toggleRunPaused();
      saveState();
      render();
      return;
    }

    const reset = event.target.closest("[data-reset-run]");
    if (reset) {
      if (!window.confirm(modeText("确定重置当前流程、运行进度和计时器吗？此操作会让现场运行状态归零。", "确定重置演示运行进度和计时器吗？此操作会让现场运行状态归零。"))) {
        return;
      }
      resetWorkflowState();
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
      const bidderId = approve.getAttribute("data-bidder");
      const itemId = approve.getAttribute("data-item");
      const note = document.getElementById("overrideNote")?.value.trim() || "";
      recordExpertReview(makeExpertReview(bidderId, itemId, "认可", null, note));
      saveState();
      render();
      return;
    }

    const save = event.target.closest("[data-review-save]");
    if (save) {
      const bidderId = save.getAttribute("data-bidder");
      const itemId = save.getAttribute("data-item");
      const item = itemById(itemId);
      const scoreRaw = document.getElementById("overrideScore")?.value.trim() || "";
      const score = Number(scoreRaw);
      const note = document.getElementById("overrideNote")?.value.trim() || "";
      if (!scoreRaw || !Number.isFinite(score) || score < 0 || (item && score > item.max_score)) {
        window.alert("改判分数必须是 0 到 " + (item ? item.max_score.toFixed(1) : "满分") + " 之间的数字。");
        return;
      }
      recordExpertReview(makeExpertReview(bidderId, itemId, "改判", score, note));
      saveState();
      render();
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target && event.target.closest ? event.target.closest("[data-file-input]") : null;
    if (!input) return;
    if (input.files && input.files.length === 0) return;
    const fileCount = input.files && input.files.length ? input.files.length : totalBidderPdfCount();
    beginUploadRecognition(fileCount);
  });

  function toggleRunPaused() {
    const run = state.run;
    if (run.finished) return;
    if (run.paused) {
      const now = Date.now();
      const pausedMs = run.pausedAt ? Math.max(0, now - run.pausedAt) : 0;
      run.pausedTotalMs += pausedMs;
      if (run.waitUntil) {
        run.waitUntil += pausedMs;
      }
      if (run.lastEventAt) {
        run.lastEventAt += pausedMs;
      }
      run.paused = false;
      run.pausedAt = null;
      return;
    }
    run.paused = true;
    run.pausedAt = Date.now();
  }

  function clearMatrixHover(matrix) {
    matrix.querySelectorAll(".matrix-row-hover").forEach((row) => {
      row.classList.remove("matrix-row-hover");
    });
    matrix.querySelectorAll(".matrix-col-hover").forEach((cell) => {
      cell.classList.remove("matrix-col-hover");
    });
  }

  function setMatrixHover(cell) {
    const matrix = cell.closest(".score-matrix");
    const row = cell.closest("tr");
    if (!matrix || !row) return;

    clearMatrixHover(matrix);
    row.classList.add("matrix-row-hover");
    Array.from(matrix.rows).forEach((matrixRow) => {
      const columnCell = matrixRow.cells[cell.cellIndex];
      if (columnCell) {
        columnCell.classList.add("matrix-col-hover");
      }
    });
  }

  document.addEventListener("pointerover", (event) => {
    if (!event.target || !event.target.closest) return;
    const cell = event.target.closest(".score-matrix th, .score-matrix td");
    if (cell) {
      setMatrixHover(cell);
    }
  });

  document.addEventListener("pointerout", (event) => {
    if (!event.target || !event.target.closest) return;
    const matrix = event.target.closest(".score-matrix");
    const related = event.relatedTarget;
    if (!matrix || (related && related.nodeType && matrix.contains(related))) return;
    clearMatrixHover(matrix);
  });

  window.addEventListener("hashchange", () => {
    state.activeSectionId = "";
    render();
    if (getRoute().path === "/running") {
      setTimeout(scrollRunLogToBottom, 0);
    }
  });

  if (!location.hash) {
    location.hash = "#/create";
  }
  render();
  if (getRoute().path === "/running") {
    setTimeout(scrollRunLogToBottom, 0);
  }
  if (state.upload.selected && !state.upload.parsed) {
    startUploadRecognitionTimer();
  }
  if (state.run.started && !state.run.finished) {
    ensureRunStarted();
  }
})();
