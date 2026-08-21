(function () {
  const SCORING_REFERENCE = window.SCORING_REFERENCE || null;
  const PROJECT_CONFIG = window.PROJECT_CONFIG || null;
  const TOKEN_NOTE = "端点 usage 恒为 null，token 由中文约 1.5 字/token 本地估算。";
  const DATA = applyProjectConfig(
    applyRealResults(window.PROTOTYPE_DATA, window.REAL_RESULTS),
    PROJECT_CONFIG,
    SCORING_REFERENCE
  );
  const DEMO_MODE = false;
  const app = document.getElementById("app");
  const TOTAL_REVIEWS = DATA.bidders.length * DATA.scoringTable.items.length;
  const LOW_CONFIDENCE_THRESHOLD = DATA.lowConfidenceThreshold || 0.85;
  const stageNames = ["PDF 入库", "证据定位", "逐项评审", "结果汇总"];
  const STORAGE_KEY = "technical-review-state-v7";
  const RECOVERY_STORAGE_KEY = "technical-review-recovery-v1";
  const LOG_BOTTOM_GAP = 16;
  const LOG_RENDER_LIMIT = 160;
  const BIDDER_RECOGNITION_MS = 420;
  const REVIEW_EVENT_KEYS = DATA.runEvents
    .filter((event) => event.type === "review")
    .map((event) => reviewKeyFor(event.bidder_id, event.item_id));

  const state = loadAppState();

  function applyRealResults(baseData, realData) {
    if (!baseData || !realData || !Array.isArray(realData.reviewResults) || !realData.reviewResults.length) {
      return baseData;
    }

    const baseBidders = Array.isArray(baseData.bidders) ? baseData.bidders : [];
    const bidderByName = new Map(baseBidders.map((bidder) => [bidder.name, bidder]));
    const realBidderNames = new Set(realData.reviewResults.map((row) => row.bidder).filter(Boolean));
    const bidders = baseBidders
      .filter((bidder) => realBidderNames.has(bidder.name))
      .concat([...realBidderNames]
        .filter((name) => !bidderByName.has(name))
        .sort()
        .map((name) => ({
          id: name,
          name,
          short: name.replace(/\d+$/, "").slice(0, 8),
          pdfCount: 20,
          chars: 0
        })));
    const bidderByRealName = new Map(bidders.map((bidder) => [bidder.name, bidder]));
    const reviewResults = realData.reviewResults.map((row) => {
      const bidder = bidderByRealName.get(row.bidder);
      return {
        ...row,
        bidder_id: row.bidder_id || (bidder ? bidder.id : row.bidder)
      };
    });

    return {
      ...baseData,
      dataSource: {
        kind: "real",
        source: realData.source_report_json || realData.source_reviews_json || "",
        reviews_source: realData.source_reviews_json || "",
        report_source: realData.source_report_json || "",
        generated_at: realData.generated_at || ""
      },
      bidders: bidders.length ? bidders : baseBidders,
      reviewResults,
      reportData: realData.reportData || baseData.reportData,
      reportDataSource: realData.source_report_json ? "s4_report_json" : "derived_from_reviews",
      runEvents: Array.isArray(realData.runEvents) && realData.runEvents.length ? realData.runEvents : baseData.runEvents
    };
  }

  function applyProjectConfig(data, projectConfig, scoringReference) {
    if (!data || !projectConfig) return data;

    const scoringTable = buildProjectScoringTable(data.scoringTable, projectConfig, scoringReference);
    const perfOverride = projectConfig.perf_override && typeof projectConfig.perf_override === "object"
      ? projectConfig.perf_override
      : {};
    const baseReportData = data.reportData || {};
    const basePerf = baseReportData.perf || {};
    const reportUsesOfficialS4 = data.reportDataSource === "s4_report_json";
    const reportData = reportUsesOfficialS4
      ? baseReportData
      : {
        ...baseReportData,
        project: projectConfig.project || baseReportData.project || scoringTable.project,
        perf: {
          ...basePerf,
          ...perfOverride,
          token_note: perfOverride.token_note || basePerf.token_note || TOKEN_NOTE
        }
      };

    return {
      ...data,
      configSource: {
        scoring: projectConfig.source_config || "",
        summary: projectConfig.source_summary || "",
        generated_from: scoringReference && Array.isArray(scoringReference.items)
          ? "prototype/js/scoring-reference.js"
          : ""
      },
      scoringTable,
      projectSummary: projectConfig.project_summary || data.projectSummary,
      reportData
    };
  }

  function buildProjectScoringTable(baseTable, projectConfig, scoringReference) {
    const base = baseTable || { items: [], rules: [] };
    const fallbackById = new Map((base.items || []).map((item) => [item.id, item]));
    const referenceItems = scoringReference && Array.isArray(scoringReference.items)
      ? scoringReference.items
      : [];
    const items = referenceItems.length
      ? referenceItems.map((row) => {
        const id = row.item_id || row.id;
        const fallback = fallbackById.get(id) || {};
        const tiers = Array.isArray(row.system_tiers) && row.system_tiers.length
          ? row.system_tiers.map((tier) => ({ ...tier, desc: "" }))
          : (fallback.tiers || []).map((tier) => ({ ...tier }));
        return {
          ...fallback,
          id,
          guid: row.guid || fallback.guid || "",
          name: row.name || fallback.name || id,
          max_score: typeof row.max_score === "number" ? row.max_score : fallback.max_score,
          source: row.source_page || projectConfig.scoring_source || base.source,
          expected_bidders: fallback.expected_bidders || 0,
          bound_count: fallback.bound_count || 0,
          tiers,
          criteria: row.pdf_criteria || fallback.criteria || "",
          aspects: fallback.aspects || [],
          synonyms: fallback.synonyms || []
        };
      })
      : (base.items || []).map((item) => ({ ...item }));

    return {
      ...base,
      project: projectConfig.project || base.project,
      source: projectConfig.source_config || base.source,
      prepared: true,
      prepared_label: projectConfig.prepared_label || base.prepared_label || "评分规则已加载",
      rules: Array.isArray(projectConfig.scoring_rules) && projectConfig.scoring_rules.length
        ? projectConfig.scoring_rules
        : base.rules,
      items
    };
  }

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
      recognitionComplete: false,
      recognizedCount: 0,
      totalFiles: 0,
      pdfFiles: 0,
      totalBytes: 0,
      sourceLabel: "",
      recognizedBidders: [],
      unmatchedFiles: [],
      ignoredFiles: [],
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
    state.activeCriteriaId = "";
    state.showScoringReference = false;
    saveState();
  }

  function hasWorkflowData(snapshot = state) {
    const run = snapshot && snapshot.run ? snapshot.run : {};
    const upload = snapshot && snapshot.upload ? snapshot.upload : {};
    return Boolean(
      upload.selected ||
      upload.parsed ||
      run.started ||
      run.reviewStarted ||
      run.finished ||
      run.completedReviews ||
      (Array.isArray(run.logs) && run.logs.length) ||
      (snapshot && snapshot.reviewOverrides && Object.keys(snapshot.reviewOverrides).length) ||
      (Array.isArray(snapshot && snapshot.expertReviews) && snapshot.expertReviews.length)
    );
  }

  function loadAppState() {
    const initial = {
      run: createRunState(),
      upload: createUploadState(),
      reviewOverrides: {},
      expertReviews: [],
      activeSectionId: "",
      activeCriteriaId: "",
      showScoringReference: false
    };

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return loadRecoverySnapshot() || initial;
      const saved = JSON.parse(raw);
      const run = hydrateRunState(saved.run);
      return {
        run,
        upload: hydrateUploadState(saved.upload, run),
        reviewOverrides: saved.reviewOverrides && typeof saved.reviewOverrides === "object" ? saved.reviewOverrides : {},
        expertReviews: Array.isArray(saved.expertReviews) ? saved.expertReviews : [],
        activeSectionId: "",
        activeCriteriaId: "",
        showScoringReference: false
      };
    } catch (error) {
      const recovered = loadRecoverySnapshot();
      if (recovered) return recovered;
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
    run.logs = Array.isArray(saved.logs) ? saved.logs.slice(-LOG_RENDER_LIMIT) : [];
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

    if (!run.reviewStarted && !run.completedReviews && !run.finished) {
      run.startedAt = null;
      run.lastEventAt = null;
      run.paused = false;
      run.pausedAt = null;
      run.pausedTotalMs = 0;
    }

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
      upload.recognitionComplete = Boolean(saved.recognitionComplete || saved.parsed);
      upload.recognizedCount = Math.min(
        DATA.bidders.length,
        Math.max(0, Math.floor(finiteNumber(saved.recognizedCount, 0)))
      );
      upload.totalFiles = Math.max(0, Math.floor(finiteNumber(saved.totalFiles, 0)));
      upload.pdfFiles = Math.max(0, Math.floor(finiteNumber(saved.pdfFiles, saved.totalFiles || 0)));
      upload.totalBytes = Math.max(0, Math.floor(finiteNumber(saved.totalBytes, 0)));
      upload.sourceLabel = typeof saved.sourceLabel === "string" ? saved.sourceLabel : "";
      upload.recognizedBidders = Array.isArray(saved.recognizedBidders) ? saved.recognizedBidders : [];
      upload.unmatchedFiles = Array.isArray(saved.unmatchedFiles) ? saved.unmatchedFiles : [];
      upload.ignoredFiles = Array.isArray(saved.ignoredFiles) ? saved.ignoredFiles : [];
      upload.startedAt = finiteNumber(saved.startedAt, 0) || null;
      upload.finishedAt = finiteNumber(saved.finishedAt, 0) || null;
    } else if (run && (run.started || run.reviewStarted || run.finished || run.completedReviews)) {
      upload.selected = true;
      upload.parsed = true;
      upload.recognitionComplete = true;
      upload.recognizedCount = DATA.bidders.length;
      upload.totalFiles = totalBidderPdfCount();
      upload.pdfFiles = upload.totalFiles;
      upload.sourceLabel = "文件名预检通过";
      upload.startedAt = run.startedAt;
      upload.finishedAt = run.startedAt;
    }
    if (upload.parsed) {
      upload.selected = true;
      upload.recognitionComplete = true;
      upload.recognizedCount = upload.recognizedBidders.length || DATA.bidders.length;
      upload.totalFiles = upload.totalFiles || upload.pdfFiles || totalBidderPdfCount();
      upload.pdfFiles = upload.pdfFiles || upload.totalFiles;
      upload.sourceLabel = upload.sourceLabel || "文件名预检通过";
    }
    if (upload.recognizedCount >= DATA.bidders.length && upload.recognitionComplete) {
      upload.parsed = true;
      upload.finishedAt = upload.finishedAt || Date.now();
    }
    upload.timer = null;
    return upload;
  }

  function saveState() {
    const run = { ...state.run, timer: null };
    if (Array.isArray(run.logs)) {
      run.logs = run.logs.slice(-LOG_RENDER_LIMIT);
    }
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

  function serializeWorkflowState(reason) {
    return {
      version: 1,
      reason: reason || "auto",
      savedAt: Date.now(),
      run: { ...state.run, timer: null },
      upload: { ...state.upload, timer: null },
      reviewOverrides: state.reviewOverrides,
      expertReviews: state.expertReviews
    };
  }

  function hydrateWorkflowSnapshot(saved) {
    if (!saved || typeof saved !== "object") return null;
    const run = hydrateRunState(saved.run);
    const snapshot = {
      run,
      upload: hydrateUploadState(saved.upload, run),
      reviewOverrides: saved.reviewOverrides && typeof saved.reviewOverrides === "object" ? saved.reviewOverrides : {},
      expertReviews: Array.isArray(saved.expertReviews) ? saved.expertReviews : [],
      activeSectionId: "",
      activeCriteriaId: "",
      showScoringReference: false
    };
    return hasWorkflowData(snapshot) ? snapshot : null;
  }

  function saveRecoverySnapshot(reason) {
    if (!hasWorkflowData()) return false;
    try {
      window.localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(serializeWorkflowState(reason)));
      return true;
    } catch (error) {
      return false;
    }
  }

  function loadRecoverySnapshot() {
    try {
      const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY);
      if (!raw) return null;
      return hydrateWorkflowSnapshot(JSON.parse(raw));
    } catch (error) {
      return null;
    }
  }

  function recoverySnapshotMeta() {
    try {
      const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      const snapshot = hydrateWorkflowSnapshot(saved);
      if (!snapshot) return null;
      return {
        savedAt: finiteNumber(saved.savedAt, 0) || null,
        run: snapshot.run,
        upload: snapshot.upload
      };
    } catch (error) {
      return null;
    }
  }

  function restoreRecoverySnapshot() {
    const recovered = loadRecoverySnapshot();
    if (!recovered) return false;
    clearRunTimer();
    clearUploadRecognitionTimer();
    Object.assign(state, recovered);
    saveState();
    if (state.upload.selected && !state.upload.parsed) {
      startUploadRecognitionTimer();
    }
    if (state.run.startedAt && !state.run.finished) {
      ensureRunStarted();
    }
    return true;
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

  function bytes(value) {
    const size = Math.max(0, Number(value) || 0);
    if (size >= 1024 * 1024 * 1024) return (size / 1024 / 1024 / 1024).toFixed(2) + " GB";
    if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
    if (size >= 1024) return (size / 1024).toFixed(1) + " KB";
    return size + " B";
  }

  function normalizeForMatch(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function compactGuid(value) {
    return normalizeForMatch(value).replace(/[^a-z0-9]/g, "");
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

  function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return [
      date.getFullYear(),
      "-",
      pad(date.getMonth() + 1),
      "-",
      pad(date.getDate()),
      " ",
      pad(date.getHours()),
      ":",
      pad(date.getMinutes())
    ].join("");
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

  function tierSummary(item) {
    if (!item || !Array.isArray(item.tiers) || !item.tiers.length) return "未配置";
    return item.tiers
      .map((tier) => {
        const min = Number.isFinite(Number(tier.min)) ? Number(tier.min).toFixed(1) : "-";
        const max = Number.isFinite(Number(tier.max)) ? Number(tier.max).toFixed(1) : "-";
        return (tier.tier || "档位") + " " + min + "-" + max + " 分";
      })
      .join(" / ");
  }

  function rangeSummary(tiers) {
    if (!Array.isArray(tiers) || !tiers.length) return "未配置";
    return tiers
      .map((tier) => {
        const min = Number.isFinite(Number(tier.min)) ? Number(tier.min).toFixed(1) : "-";
        const max = Number.isFinite(Number(tier.max)) ? Number(tier.max).toFixed(1) : "-";
        return min + "-" + max + " 分";
      })
      .join(" / ");
  }

  function compactScore(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return "-";
    return score.toFixed(1).replace(/\.0$/, "");
  }

  function compactTierSummary(item) {
    if (!item || !Array.isArray(item.tiers) || !item.tiers.length) return "未配置";
    return item.tiers
      .slice()
      .sort((a, b) => Number(a.min) - Number(b.min))
      .map((tier) => {
        return (tier.tier || "档位") + " " + compactScore(tier.min) + "–" + compactScore(tier.max);
      })
      .join("｜");
  }

  function renderReadonlyValue(value) {
    return `<div class="readonly-value">${html(value)}</div>`;
  }

  function renderProjectSummaryMarkdown(markdown) {
    const lines = String(markdown || "")
      .split(/\r?\n/)
      .map((line) => line.trim());
    const blocks = [];
    let paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${paragraph.map(html).join("<br>")}</p>`);
      paragraph = [];
    };

    lines.forEach((line) => {
      if (!line) {
        flushParagraph();
        return;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        const level = Math.min(heading[1].length + 3, 6);
        blocks.push(`<h${level}>${html(heading[2])}</h${level}>`);
        return;
      }
      paragraph.push(line);
    });
    flushParagraph();
    return blocks.join("");
  }

  function referenceByItemId(itemId) {
    const rows = SCORING_REFERENCE && Array.isArray(SCORING_REFERENCE.items) ? SCORING_REFERENCE.items : [];
    return rows.find((row) => row.item_id === itemId) || null;
  }

  function itemById(id) {
    return scoringItems().find((item) => item.id === id);
  }

  function bidderById(id) {
    return DATA.bidders.find((bidder) => bidder.id === id);
  }

  function bidderByName(name) {
    return DATA.bidders.find((bidder) => bidder.name === name);
  }

  function uploadFilePath(file) {
    return file.webkitRelativePath || file.name || "";
  }

  function uploadFileRow(file) {
    const path = uploadFilePath(file);
    return {
      name: file.name || path,
      path,
      size: file.size || 0
    };
  }

  function isPdfFile(file) {
    return /\.pdf$/i.test(file.name || uploadFilePath(file));
  }

  function hasTechnicalBidFolder(filePath) {
    return String(filePath || "")
      .split(/[\\/]+/)
      .some((part) => normalizeForMatch(part).includes("技术标"));
  }

  function isTechnicalBidPdf(file) {
    if (!isPdfFile(file)) return false;
    const relativePath = file.webkitRelativePath || "";
    return !relativePath || hasTechnicalBidFolder(relativePath);
  }

  function matchBidderForPath(filePath) {
    const normalizedPath = normalizeForMatch(filePath);
    return DATA.bidders.find((bidder) => {
      const names = [bidder.name, bidder.short, bidder.id].filter(Boolean);
      return names.some((name) => {
        const normalizedName = normalizeForMatch(name);
        return normalizedName && normalizedPath.includes(normalizedName);
      });
    }) || null;
  }

  function matchItemForPath(filePath) {
    const normalizedPath = normalizeForMatch(filePath);
    const guidPath = compactGuid(filePath);
    return scoringItems().find((item) => {
      const guid = compactGuid(item.guid);
      const name = normalizeForMatch(item.name);
      const id = normalizeForMatch(item.id);
      return (guid && guidPath.includes(guid)) ||
        (name && normalizedPath.includes(name)) ||
        (id && normalizedPath.includes(id));
    }) || null;
  }

  function analyzeSelectedFiles(fileList) {
    const files = Array.from(fileList || []);
    const pdfFiles = files.filter(isPdfFile);
    const technicalPdfFiles = pdfFiles.filter(isTechnicalBidPdf);
    const technicalPdfSet = new Set(technicalPdfFiles);
    const ignoredFiles = files
      .filter((file) => !technicalPdfSet.has(file))
      .map(uploadFileRow);
    const groups = new Map(DATA.bidders.map((bidder) => [bidder.id, {
      bidder_id: bidder.id,
      bidder: bidder.name,
      short: bidder.short,
      pdfCount: 0,
      sizeBytes: 0,
      matchedItemIds: new Set(),
      samples: []
    }]));
    const unmatchedFiles = [];

    technicalPdfFiles.forEach((file) => {
      const path = uploadFilePath(file);
      const bidder = matchBidderForPath(path);
      const item = matchItemForPath(path);
      const row = uploadFileRow(file);
      if (!bidder) {
        unmatchedFiles.push(row);
        return;
      }
      const group = groups.get(bidder.id);
      group.pdfCount += 1;
      group.sizeBytes += file.size || 0;
      if (item) group.matchedItemIds.add(item.id);
      if (group.samples.length < 3) group.samples.push(path);
    });

    const recognizedBidders = DATA.bidders
      .map((bidder) => groups.get(bidder.id))
      .filter((group) => group && group.pdfCount > 0)
      .map((group) => ({
        ...group,
        matchedItemIds: [...group.matchedItemIds].sort()
      }));
    const totalBytes = technicalPdfFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    return {
      totalFiles: technicalPdfFiles.length,
      pdfFiles: technicalPdfFiles.length,
      totalBytes,
      recognizedBidders,
      unmatchedFiles,
      ignoredFiles,
      sourceLabel: "已选择 " + technicalPdfFiles.length + " 个技术标 PDF，" + bytes(totalBytes) +
        (ignoredFiles.length ? " · 已过滤 " + ignoredFiles.length + " 个非技术标/非 PDF 文件" : "")
    };
  }

  function uploadRecognizedBidders() {
    const rows = Array.isArray(state.upload.recognizedBidders) ? state.upload.recognizedBidders : [];
    const rowById = new Map(rows.map((row) => [row.bidder_id, row]));
    return DATA.bidders
      .filter((bidder) => rowById.has(bidder.id))
      .map((bidder) => {
        const row = rowById.get(bidder.id);
        return {
          ...bidder,
          pdfCount: row.pdfCount,
          chars: null,
          sizeBytes: row.sizeBytes || 0,
          matchedItemIds: Array.isArray(row.matchedItemIds) ? row.matchedItemIds : [],
          samples: Array.isArray(row.samples) ? row.samples : []
        };
      });
  }

  function bindingItemsForUpload() {
    const recognized = uploadRecognizedBidders();
    const expected = DATA.bidders.length;
    return scoringItems().map((item) => {
      const bound = recognized.filter((bidder) => bidder.matchedItemIds.includes(item.id)).length;
      const status = bound >= expected
        ? "matched"
        : bound > 0
          ? "partial"
          : "unverified";
      const note = status === "matched"
        ? "文件名 GUID/评分项名称已匹配"
        : status === "partial"
          ? "仅部分投标人文件名匹配，需补齐或等待后续定位确认"
          : "文件名未匹配到 GUID/评分项名称，需等待后续定位确认";
      return {
        ...item,
        expected_bidders: expected,
        bound_count: bound,
        binding_status: status,
        binding_note: note
      };
    });
  }

  function normalizeReviewResult(result) {
    if (!result || typeof result !== "object") return null;
    const rawStatus = result.status;
    const score = typeof result.score === "number" ? result.score : null;
    const isRated = rawStatus === "rated" && score !== null;
    const status = isRated ? "rated" : "unrated";
    const attempts = Number.isFinite(Number(result.attempts)) ? Number(result.attempts) : 0;
    const lastError = result.last_error || result.error || (rawStatus && rawStatus !== status ? "未知评审状态：" + rawStatus : "");

    return {
      ...result,
      status,
      score: isRated ? score : null,
      cite: Array.isArray(result.cite) ? result.cite : [],
      reason: result.reason || (status === "unrated" ? "评审结果异常，前端按未评定处理。" : ""),
      confidence: typeof result.confidence === "number" ? result.confidence : 0,
      attempts,
      last_error: lastError,
      miss_reason: result.miss_reason || null,
      perf: result.perf && typeof result.perf === "object" ? result.perf : { in_tokens: 0, out_tokens: 0, latency_ms: 0 }
    };
  }

  function resultBy(bidderId, itemId) {
    const bidder = bidderById(bidderId);
    return normalizeReviewResult(DATA.reviewResults.find((row) =>
      row.item_id === itemId && (
        row.bidder_id === bidderId ||
        (bidder && row.bidder === bidder.name)
      )
    ));
  }

  function reportBidderKey(bidder) {
    const report = DATA.reportData || {};
    const bidders = Array.isArray(report.bidders) ? report.bidders : [];
    if (bidders.includes(bidder.name)) return bidder.name;
    if (bidders.includes(bidder.id)) return bidder.id;
    return bidder.name;
  }

  function reportMatrixRow(itemId) {
    const rows = DATA.reportData && Array.isArray(DATA.reportData.matrix) ? DATA.reportData.matrix : [];
    return rows.find((row) => row.item_id === itemId) || null;
  }

  function reportScoreFor(bidder, item) {
    const row = reportMatrixRow(item.id);
    if (!row || !row.scores || typeof row.scores !== "object") return undefined;
    const key = reportBidderKey(bidder);
    return Object.prototype.hasOwnProperty.call(row.scores, key) ? row.scores[key] : undefined;
  }

  function resultForDisplay(bidder, item, completedKeys = completedReviewKeySet()) {
    if (!isReviewCompleted(bidder.id, item.id, completedKeys)) return null;
    // 取原始评审结果；这里曾误写成调用自身，导致 Maximum call stack size exceeded，
    // 页面⑤（单项详情）因此完全打不开。修于 2026-08-21。
    const result = resultBy(bidder.id, item.id);
    const reportScore = state.run.finished ? reportScoreFor(bidder, item) : undefined;
    if (reportScore === undefined) return result;
    if (reportScore === null) {
      return {
        ...(result || {}),
        item_id: item.id,
        bidder_id: bidder.id,
        bidder: bidder.name,
        status: "unrated",
        score: null
      };
    }
    return {
      ...(result || {}),
      item_id: item.id,
      bidder_id: bidder.id,
      bidder: bidder.name,
      status: result && result.status ? result.status : "rated",
      score: Number(reportScore)
    };
  }

  function reportTotalForBidder(bidder) {
    const totals = DATA.reportData && DATA.reportData.totals && typeof DATA.reportData.totals === "object"
      ? DATA.reportData.totals
      : {};
    return totals[reportBidderKey(bidder)] || totals[bidder.name] || totals[bidder.id] || null;
  }

  function isLowConfidence(result) {
    if (!result || result.status !== "rated" || typeof result.confidence !== "number") return false;
    if (result.score === 0 && result.miss_reason === "no_file") return false;
    return result.confidence < LOW_CONFIDENCE_THRESHOLD;
  }

  function zeroMissLabel(result) {
    if (result && result.miss_reason === "no_file") return "缺文件";
    if (result && result.miss_reason === "not_found") return "检索未命中";
    return "未命中";
  }

  function zeroMissDetail(result) {
    if (result && result.miss_reason === "no_file") return "该投标人未提交对应文件，按缺项不得分处理";
    if (result && result.miss_reason === "not_found") return "文件存在但证据定位未命中，建议人工复核";
    return "按缺项不得分处理";
  }

  function reviewFlagWhy(result) {
    if (result && result.miss_reason === "not_found") return "证据定位未命中，检索未命中不等于投标人未写";
    if (result && result.reason) return result.reason;
    return "confidence 低于阈值";
  }

  function reviewFlagRows(completedKeys = completedReviewKeySet()) {
    return completedReviewResults(completedKeys)
      .filter(isLowConfidence)
      .map((row) => {
        const bidder = bidderById(row.bidder_id);
        return {
          bidder: row.bidder || (bidder ? bidder.name : row.bidder_id),
          item_id: row.item_id,
          confidence: row.confidence,
          why: reviewFlagWhy(row)
        };
      });
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

  function completedReviewResults(completedKeys = completedReviewKeySet()) {
    return DATA.reviewResults
      .filter((row) => completedKeys.has(reviewKeyFor(row.bidder_id, row.item_id)))
      .map(normalizeReviewResult)
      .filter(Boolean);
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
      { path: "/confirm", label: "确认标准与文件", enabled: isUploadParsed() && isRunAccessible() },
      { path: "/running", label: "运行监视", enabled: isRunAccessible() },
      { path: "/results", label: "评审结果", enabled: isResultsAccessible() }
    ];

    return `
      <header class="topbar">
        <div class="brand">
          <h1 class="brand-title">工程建设类技术标辅助评审系统</h1>
          <div class="brand-subtitle">${html(modeText("技术标辅助评审流程", "静态 Demo 原型 · Mock 数据 · 不连接后端"))}</div>
        </div>
        <nav class="nav" aria-label="页面导航">
          ${links.map((link) => link.enabled ? `
            <a class="${activePath === link.path ? "active" : ""}" href="#${link.path}"${link.path === "/create" && activePath !== "/create" && state.run.finished ? " data-new-review" : ""}>${link.label}</a>
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
    const uploadedBidders = uploadRecognizedBidders();
    const recognizedBidders = uploadedBidders.slice(0, upload.recognizedCount);
    const expectedFiles = totalBidderPdfCount();
    const shownFiles = upload.selected ? (upload.pdfFiles || upload.totalFiles || expectedFiles) : 0;
    const uploadStatus = !upload.selected
      ? "等待选择"
      : upload.parsed
        ? "识别完成"
        : upload.recognitionComplete
          ? "缺少投标人"
          : "识别中";
    const bidderMetricValue = upload.selected ? recognizedBidders.length + " / " + DATA.bidders.length + " 家" : "待选择";
    const bidderMetricNote = upload.selected ? uploadStatus : "选择投标文件后预检";
    const reviewMetricValue = upload.parsed ? TOTAL_REVIEWS + " 项" : "待生成";
    const reviewMetricNote = upload.parsed
      ? DATA.bidders.length + " 家投标人 × " + items.length + " 个评分项"
      : "文件名预检通过后生成";
    const mainUploadLabel = upload.selected ? "重新选择投标文件" : "选择投标文件";
    const uploadBadge = !upload.selected ? "neutral" : upload.parsed ? "success" : upload.recognitionComplete ? "danger" : "primary";
    const nextClass = upload.parsed ? "btn primary" : "btn primary disabled";
    const nextAttrs = upload.parsed ? `href="#/confirm"` : `href="#/create" aria-disabled="true"`;
    // 评审进行中禁止重新选择文件：beginUploadRecognition 会重置前端状态，
    // 但服务端的旧运行还在跑，再选一次就会起第二条流水线，两条并发打向端点——
    // 实测端点 12 路就崩（README §6 阶段二）。等本轮跑完（finished）才解锁。
    const uploadLocked = state.run.reviewStarted && !state.run.finished;
    const uploadLockTitle = "评审进行中，等本轮跑完再选择新文件";
    const recoveryMeta = !hasWorkflowData() ? recoverySnapshotMeta() : null;
    const recoveryBanner = recoveryMeta ? `
        <section class="recovery-banner" aria-label="可恢复评审">
          <div>
            <strong>检测到上一轮评审快照</strong>
            <span>可恢复 ${recoveryMeta.run.finished ? "已完成" : "未完成"} 的评审状态${recoveryMeta.savedAt ? "，保存于 " + html(formatDateTime(recoveryMeta.savedAt)) : ""}。</span>
          </div>
          <button class="btn" type="button" data-restore-recovery>恢复上一轮</button>
        </section>
    ` : "";
    return `
      <main class="page">
        ${recoveryBanner}
        <section class="page-header">
          <div>
            <h2 class="page-title">新建评审任务</h2>
            <p class="page-desc">选择本次要评审的投标文件。招标文件及评分标准已加载，本次仅评审所选投标文件。</p>
          </div>
          <div class="toolbar upload-actions">
            ${uploadLocked ? `
            <span class="btn primary disabled" aria-disabled="true" title="${uploadLockTitle}">${mainUploadLabel}</span>
            <span class="btn disabled" aria-disabled="true" title="${uploadLockTitle}">补充选择 PDF</span>
            ` : `
            <label class="btn primary" for="bidDirInput">${mainUploadLabel}</label>
            <input id="bidDirInput" class="file-input" type="file" accept="application/pdf,.pdf" webkitdirectory directory multiple data-file-input>
            <label class="btn" for="bidFileInput">补充选择 PDF</label>
            <input id="bidFileInput" class="file-input" type="file" accept="application/pdf,.pdf" multiple data-file-input>
            `}
            <a class="${nextClass}" ${nextAttrs} data-start-parse>下一步：解析</a>
          </div>
        </section>

        <section class="summary-strip" aria-label="任务概览">
          ${metric("评分规则", "已加载", items.length + " 个评分项 / 总分 " + totalScore().toFixed(1) + " 分")}
          ${metric("投标人", bidderMetricValue, bidderMetricNote)}
          ${metric("逐项评审", reviewMetricValue, reviewMetricNote)}
          ${metric("文件体量", upload.selected ? bytes(upload.totalBytes) : "待选择", shownFiles ? shownFiles + " 个技术标 PDF" : "等待文件选择")}
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
                  <label>项目名称</label>
                  ${renderReadonlyValue(DATA.scoringTable.project)}
                </div>
                <div class="field">
                  <label>招标文件</label>
                  ${renderReadonlyValue("招标文件.pdf · 已加载")}
                </div>
                <div class="field">
                  <label>评分规则状态</label>
                  ${renderReadonlyValue((DATA.scoringTable.prepared_label || "已加载") + " · " + items.length + " 个评分项 · 总分 " + totalScore().toFixed(1) + " 分")}
                </div>
                <div class="field">
                  <label>投标文件</label>
                  ${renderReadonlyValue(upload.selected ? upload.sourceLabel || "已选择投标文件" : "未选择")}
                </div>
              </div>
            </div>
          </div>

          <aside class="panel">
            <div class="panel-header">
              <h3 class="panel-title">本次评审说明</h3>
              <span class="badge primary">已加载</span>
            </div>
            <div class="panel-body">
              <div class="info-box">
                <strong>评分依据</strong>
                <span class="muted">招标文件及评分标准已加载，本次仅评审所选投标文件。</span>
              </div>
            </div>
          </aside>
        </section>

        <section class="panel" style="margin-top: 18px;">
          <div class="panel-header">
            <h3 class="panel-title">投标文件（技术部分）</h3>
            <span class="badge ${uploadBadge}">${upload.selected ? recognizedBidders.length + "/" + DATA.bidders.length + " 已识别" : "待选择"}</span>
          </div>
          <div class="panel-body">
            <p class="panel-note">识别依据为本次选择文件的目录名、文件名、GUID 和评分项名称；${liveActive() || LIVE.available
              ? "正文抽取在点击「下一步：解析」后由服务层真实执行。"
              : "正文抽取需要服务层（python src/server.py），未连接时页面仅作回放演示。"}</p>
            ${renderUploadFilterNote()}
            ${recognizedBidders.length ? `
              <div class="bidder-compact-list">
                ${recognizedBidders.map((bidder) => `
                  <div class="bidder-compact-item">
                    <div>
                      <div class="bidder-name" title="${html(bidder.name)}">${html(bidder.name)}</div>
                      <div class="bidder-meta">${bidder.pdfCount} 个技术标 PDF / ${bytes(bidder.sizeBytes)} / ${bidder.matchedItemIds.length}/${items.length} 项文件名匹配</div>
                    </div>
                    <span class="status-dot" title="已识别" aria-label="识别状态：已识别"></span>
                  </div>
                `).join("")}
              </div>
            ` : `
              <div class="empty">请选择投标文件，解析结果会逐家进入列表。</div>
            `}
            ${renderUploadWarnings()}
          </div>
        </section>
      </main>
    `;
  }

  function renderUploadFilterNote() {
    const upload = state.upload;
    if (!upload.selected || !Array.isArray(upload.ignoredFiles) || !upload.ignoredFiles.length) return "";
    const samples = upload.ignoredFiles
      .slice(0, 4)
      .map((file) => html(file.path || file.name))
      .join("；");
    return `
      <div class="upload-filter-note">
        已按“技术标”目录筛选，忽略 ${upload.ignoredFiles.length} 个非技术标/非 PDF 文件${samples ? "，例如：" + samples : ""}${upload.ignoredFiles.length > 4 ? "；..." : ""}
      </div>
    `;
  }

  function renderUploadWarnings() {
    const upload = state.upload;
    if (!upload.selected) return "";
    const recognizedIds = new Set(uploadRecognizedBidders().map((bidder) => bidder.id));
    const missing = DATA.bidders.filter((bidder) => !recognizedIds.has(bidder.id));
    const unmatched = Array.isArray(upload.unmatchedFiles) ? upload.unmatchedFiles : [];
    if (!missing.length && !unmatched.length) return "";
    return `
      <div class="upload-warning">
        ${missing.length ? `
          <div>
            <strong>未识别投标人 ${missing.length} 家</strong>
            <div class="small muted">${missing.map((bidder) => html(bidder.name)).join("、")}</div>
          </div>
        ` : ""}
        ${unmatched.length ? `
          <div>
            <strong>未归属技术标 PDF ${unmatched.length} 个</strong>
            <div class="small muted">${unmatched.slice(0, 6).map((file) => html(file.path || file.name)).join("；")}${unmatched.length > 6 ? "；..." : ""}</div>
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderConfirm() {
    const route = getRoute();
    const bindingIssueDemo = DEMO_MODE && route.query.get("binding") === "issue";
    const confirmItems = bindingItemsForUpload().map((item) => (
      bindingIssueDemo && item.id === "T-15"
        ? { ...item, bound_count: item.expected_bidders - 1 }
        : item
    ));
    const mismatchItem = confirmItems.find((item) => item.binding_status !== "matched");
    const mismatch = Boolean(mismatchItem);
    const elapsed = runElapsedMs();
    const scoringTotal = totalScore();
    const scoringTotalNote = scoringTotal === 100 ? "来自招标文件" : modeText("待评分规则确认", "Mock 尚未完整替换");
    const bindingStatusText = mismatch ? "待确认" : "文件名预检通过";
    const bindingNote = mismatch
      ? mismatchItem.id + " " + mismatchItem.bound_count + "/" + mismatchItem.expected_bidders + " · " + mismatchItem.binding_note
      : confirmItems.length + " 项均为 " + DATA.bidders.length + "/" + DATA.bidders.length;
    const confirmStatusText = state.run.reviewStarted ? "评审进行中" : mismatch ? "待确认" : "校验通过";
    const confirmStatusClass = state.run.reviewStarted ? "running" : mismatch ? "pending" : "success";
    const timingText = state.run.reviewStarted
      ? `评审用时 <span data-run-elapsed>${html(formatDuration(elapsed))}</span>`
      : "评审计时 未开始";
    return `
      <main class="page page-confirm">
        <section class="page-header">
          <div>
            <h2 class="page-title">确认评分标准与投标文件</h2>
            <p class="page-desc">请核对评分项、分值、评分区间、招标文件原文，以及本次上传投标文件的文件名预检结果。</p>
          </div>
          <div class="toolbar">
            <a class="btn" href="#/create">上一步</a>
            <button class="btn" data-toggle-reference>${state.showScoringReference ? "收起校验详情" : "校验详情"}</button>
            ${DEMO_MODE ? `<a class="btn" href="${bindingIssueDemo ? "#/confirm" : "#/confirm?binding=issue"}">${bindingIssueDemo ? "恢复正常绑定" : "演示绑定异常"}</a>` : ""}
            <button class="btn primary" data-start-run ${mismatch ? "disabled" : ""}>开始评审</button>
          </div>
        </section>

        <section class="summary-strip">
          ${metric("评分项", confirmItems.length + " 项", "技术标评分项")}
          ${metric("总分", scoringTotal.toFixed(1) + " 分", scoringTotalNote)}
          ${metric("文件绑定", bindingStatusText, bindingNote)}
          ${metric("当前状态", `<span class="status-value ${confirmStatusClass}"><span aria-hidden="true">${confirmStatusClass === "success" ? "✓" : ""}</span>${html(confirmStatusText)}</span><span class="metric-inline-time">${timingText}</span>`, "")}
        </section>

        ${state.showScoringReference ? renderScoringReference(confirmItems) : ""}

        <section class="layout-grid" style="margin-top: 18px;">
          <div class="panel">
            <div class="panel-header">
              <h3 class="panel-title">文件绑定预检（可核对）</h3>
              <span class="badge ${mismatch ? "danger" : "success"}">${mismatch ? "存在缺项" : "可开始"}</span>
            </div>
            <div class="panel-body">
              <div class="table-wrap confirm-table-wrap">
                <table class="table-compact confirm-table">
                  <thead>
                    <tr>
                      <th>序</th>
                      <th class="confirm-score-name">评分项</th>
                      <th>分值</th>
                      <th>三档区间</th>
                      <th>招标原文</th>
                      <th>绑定的投标文件</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${confirmItems.map((item, index) => {
                      const reference = referenceByItemId(item.id);
                      const criteriaText = reference ? reference.pdf_criteria : item.criteria || "";
                      const sourcePage = reference ? reference.source_page : item.source || DATA.scoringTable.source || "招标文件第 33~37 页";
                      const rangeText = reference ? rangeSummary(reference.pdf_tiers) : tierSummary(item);
                      return `
                        <tr>
                          <td>${index + 1}</td>
                          <td class="confirm-score-name">
                            <strong>${html(item.name)}</strong>
                          </td>
                          <td>
                            ${item.max_score.toFixed(1)}
                          </td>
                          <td class="tier-range-compact" title="${html(tierSummary(item))}">${html(compactTierSummary(item))}</td>
                          <td>
                            <details class="criteria-details" ${state.activeCriteriaId === item.id ? "open" : ""}>
                              <summary data-criteria-toggle="${html(item.id)}">查看招标原文</summary>
                              <div class="criteria-card">
                                <div class="criteria-label">招标文件原文</div>
                                <p>${criteriaText ? html(criteriaText) : "评审标准原文缺失，需回招标文件补充。"}</p>
                                <dl>
                                  <div>
                                    <dt>原文页码</dt>
                                    <dd>${html(sourcePage)}</dd>
                                  </div>
                                  <div>
                                    <dt>满分与评分区间</dt>
                                    <dd>${item.max_score.toFixed(1)} 分；${html(rangeText)}</dd>
                                  </div>
                                </dl>
                              </div>
                            </details>
                          </td>
                          <td>
                            <span class="badge ${item.binding_status === "matched" ? "success" : item.binding_status === "partial" ? "warning" : "danger"}">${item.bound_count}/${item.expected_bidders} 家已匹配</span>
                            <div class="small muted">${html(item.binding_note)}</div>
                          </td>
                        </tr>
                      `;
                    }).join("")}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <aside class="panel">
            <div class="panel-header">
              <h3 class="panel-title">全局规则与项目摘要</h3>
              <span class="badge primary">已加载</span>
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
              <div class="readonly-card project-summary-card" style="margin-top: 18px;">
                ${renderProjectSummaryMarkdown(DATA.projectSummary)}
              </div>
            </div>
          </aside>
        </section>
      </main>
    `;
  }

  function renderScoringReference(items) {
    const hasReference = SCORING_REFERENCE && Array.isArray(SCORING_REFERENCE.items);
    const sourcePdf = hasReference ? SCORING_REFERENCE.source_pdf : "招标文件.pdf";
    const sourceXlsx = hasReference ? SCORING_REFERENCE.source_xlsx : "拆分评审项.xlsx";
    const pages = hasReference ? SCORING_REFERENCE.pages : "33-37";
    const matched = hasReference && SCORING_REFERENCE.summary
      ? SCORING_REFERENCE.summary.pdf_vs_xlsx_tiers_match + " / " + SCORING_REFERENCE.summary.items
      : "未加载";
    return `
      <section class="panel reference-panel diagnostic-panel" aria-label="校验详情：评分表来源对照">
        <div class="panel-header">
          <h3 class="panel-title">校验详情：评分表来源对照</h3>
          <span class="badge neutral">辅助核验</span>
        </div>
        <div class="panel-body reference-grid">
          <aside class="reference-page">
            <div class="reference-page-title">诊断来源</div>
            <p>PDF：${html(sourcePdf)}</p>
            <p>XLSX：${html(sourceXlsx)}</p>
            <p>招标文件页码：第 ${html(pages)} 页</p>
            <p>PDF/XLSX 档位匹配：${html(matched)}</p>
          </aside>
          <div class="table-wrap">
            <table class="table-compact">
              <thead>
                <tr>
                  <th>评分项</th>
                  <th>满分</th>
                  <th>PDF 原文</th>
                  <th>XLSX 对照</th>
                  <th>系统档位</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((item) => {
                  const reference = referenceByItemId(item.id);
                  return `
                    <tr>
                      <td><strong>${html(item.name)}</strong></td>
                      <td>${item.max_score.toFixed(1)}</td>
                      <td>
                        ${html(reference ? reference.pdf_criteria : item.criteria || "")}
                        <div class="small muted">${html(reference ? rangeSummary(reference.pdf_tiers) : tierSummary(item))}</div>
                      </td>
                      <td>
                        ${reference && reference.xlsx_desc ? html(reference.xlsx_desc) : `<span class="muted">未加载 XLSX 对照</span>`}
                        <div class="small muted">${html(reference ? rangeSummary(reference.xlsx_tiers) : "未加载")}</div>
                      </td>
                      <td>
                        ${html(reference ? rangeSummary(reference.system_tiers) : tierSummary(item))}
                        <div class="small muted">${reference && reference.checks && reference.checks.pdf_vs_xlsx_tiers_match ? "PDF/XLSX 档位一致" : "需人工核对"}</div>
                      </td>
                    </tr>
                  `;
                }).join("")}
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
    const concurrency = numericConcurrency();
    const estimatedMs = run.completedReviews && concurrency ? remainingReviews * Math.max(avgLatency, 2400) / concurrency : 0;
    const waitingMs = run.lastEventAt ? runTimestampNow(run) - run.lastEventAt : 0;
    const resultButton = isResultsAccessible()
      ? `<a class="btn primary" href="#/results">查看已完成结果</a>`
      : `<span class="btn primary disabled" aria-disabled="true" title="逐项评审开始后才会产生结果">查看已完成结果</span>`;
    const runSourceText = DATA.dataSource && DATA.dataSource.kind === "real"
      ? "真实评审记录"
      : "样例评审记录";

    return `
      <main class="page">
        <section class="page-header">
          <div>
            <h2 class="page-title">${run.finished ? "评审完成" : "评审进行中"}</h2>
            <p class="page-desc">本页展示逐项评审进度、当前处理状态、重试和未评定项；分母为 ${TOTAL_REVIEWS} = ${DATA.bidders.length} 家投标人 × ${DATA.scoringTable.items.length} 个评分项。</p>
          </div>
          <div class="toolbar">
            <button class="btn" data-toggle-run title="${liveActive()
              ? "仅暂停页面滚动；服务层的模型调用不会停，计时也照走"
              : "暂停回放"}">${liveActive()
              ? (run.paused ? "继续滚动" : "暂停滚动（后台继续）")
              : (run.paused ? "继续" : "暂停")}</button>
            ${resultButton}
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h3 class="panel-title">阶段状态</h3>
            <span class="badge ${run.finished ? "success" : "primary"}">${run.finished ? "报告数据已生成" : runSourceText}</span>
          </div>
          <div class="panel-body">
            <div class="stage-stepper" aria-label="运行阶段">
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
                ${metric("已用时间", `<span data-run-elapsed>${html(formatDuration(elapsed))}</span>`, `<span data-run-estimated>预计剩余 ${html(formatDuration(estimatedMs))} · 按当前吞吐估算</span>`, "", true)}
                ${metric("当前处理状态", `<span class="metric-value-clamp" title="${html(run.currentLabel)}">${html(run.currentLabel)}</span>`, `<span data-run-waiting>已等待 ${html(formatDuration(waitingMs))}</span>`, "metric-dynamic", true)}
                ${metric("当前并发", concurrencyLabel(), "逐项评审并发")}
                ${metric("GPU / 显存", "未采集", "不伪造硬件数据")}
                ${metric("累计输入", number(run.inTokens) + " tokens", "本地估算")}
                ${metric("累计输出", number(run.outTokens) + " tokens", "本地估算")}
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
                <strong>数据说明</strong>
                <span class="muted">${liveActive()
                  ? "本次运行：页面①点击后由服务层实时执行 S1→S4，下方逐项记录为本次产生（run " + html(LIVE.runId) + "）。"
                  : "未连接服务层，当前展示最近一次真实全量评审的过程记录（回放）。启动 python src/server.py 后刷新即为实时运行。"}</span>
              </div>
              <div class="info-box" style="margin-top: 12px;">
                <strong>token 口径</strong>
                <span class="muted">${html((DATA.reportData.perf && DATA.reportData.perf.token_note) || TOKEN_NOTE)}</span>
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
              ${renderRunLogs(run.logs)}
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
    const resultsTitle = pendingCount ? "评审结果（运行中）" : "评审结果汇总";
    const resultsDesc = "集中展示 " + DATA.bidders.length + " 家投标人的独立评分结果；各投标文件分别评审，互不影响。";
    const visibleReviewFlags = reviewFlagRows(completedKeys);
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
            <h2 class="page-title">${resultsTitle}</h2>
            <p class="page-desc">${html(resultsDesc)}</p>
          </div>
          <div class="toolbar">
            <a class="btn" href="#/running">返回运行监视</a>
            <button class="btn primary" data-export-report ${canExportReport ? "" : "disabled"} title="${canExportReport ? "导出静态 HTML 报告" : "评审完成后才能导出报告"}">导出报告</button>
            ${liveActive() ? `<button class="btn" data-export-xlsx ${canExportReport ? "" : "disabled"} title="${canExportReport ? "导出 Excel（评分汇总 / 逐项明细 / 未评定 / 建议复核 / 性能）" : "评审完成后才能导出"}">导出 Excel</button>` : ""}
          </div>
        </section>

        <section class="summary-strip">
          ${metric("投标人", DATA.bidders.length + " 家", "独立评分结果")}
          ${metric("已完成", completedCount + " / " + TOTAL_REVIEWS, pendingCount ? pendingCount + " 项评审中" : "全部完成")}
          ${metric("用时", formatDuration(elapsed), state.run.startedAt ? "从开始评审起算" : "尚未开始")}
          ${metric("建议复核", (visibleReviewFlags.length + visibleAuditFlags.length) + " 项", "低置信 " + visibleReviewFlags.length + " / 无区分度 " + visibleAuditFlags.length)}
        </section>

        ${pendingCount ? `
          <section class="panel status-panel" style="margin-top: 18px;">
            <div class="panel-body">
              <div class="info-box">
                <strong>当前为阶段性结果</strong>
                <span class="muted">${pendingCount} 项尚未完成；总分暂不生成，正式汇总需等全部评审完成后导出。</span>
              </div>
            </div>
          </section>
        ` : ""}

        <section class="panel" style="margin-top: 18px;">
          <div class="panel-header">
            <h3 class="panel-title">逐项评分矩阵</h3>
            <span class="badge neutral">评分项列固定 · 各家独立评审</span>
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
                    <td class="sticky-item" data-score-col="0"><strong>${pendingCount ? "总分（未完成）" : "合计（19 项）"}</strong></td>
                    <td class="sticky-max" data-score-col="1"><strong>${pendingCount ? "满分 " + totalScore().toFixed(1) : totalScore().toFixed(1)}</strong></td>
                    ${DATA.bidders.map((bidder, index) => {
                      const systemTotal = systemTotalForBidder(bidder, completedKeys);
                      const expertTotal = expertTotalForBidder(bidder, completedKeys);
                      return `
                        <td data-score-col="${index + 2}" title="${pendingCount ? "运行完成前不生成总分" : "专家口径只在存在改判时显示"}">
                          ${pendingCount ? `<strong>未完成</strong>` : `<strong>${systemTotal.score.toFixed(1)}${systemTotal.unrated ? "*" : ""}</strong>`}
                          ${!pendingCount && expertTotal.overrides ? `<div class="manual-score">专家 ${expertTotal.score.toFixed(1)}</div>` : ""}
                        </td>
                      `;
                    }).join("")}
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="legend">
              <span>0 = 缺文件或未命中；0 复核 = 文件存在但证据定位未命中</span>
              <span>— = 未评定，系统未能给出判断，不计入合计</span>
              <span>评审中 = 结果尚未到达，运行完成前不生成总分</span>
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
    // completedKeys 此前未定义就被使用，抛 ReferenceError 导致本页不渲染。修于 2026-08-21。
    const completedKeys = completedReviewKeySet();
    const result = resultForDisplay(bidder, item, completedKeys);
    const evidence = evidenceBy(bidder.id, item.id) || {};

    if (!result) {
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
        ? zeroMissLabel(result)
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
            <a class="btn" href="#/results">返回评审结果</a>
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
                    ? `<span class="badge ${isLowConfidence(result) ? "warning" : "neutral"}">0 分${html(zeroMissLabel(result))}</span>`
                    : `<span class="badge primary">${html(result.tier)} · ${scoreText} 分</span>`}
                </div>
                <div class="panel-body">
                  <div class="summary-strip">
                  ${metric("系统判分", scoreText, result.status === "unrated" ? "score 保持为 null" : "不因下方操作改变")}
                  ${metric("专家判分", overrideScore !== null ? overrideScoreText : "—", overrideScore !== null ? "仅进入专家口径合计" : "未改判")}
                  ${metric("当前档位", result.tier || "无", result.status === "unrated" ? "重试耗尽未进入判分" : result.score === 0 ? zeroMissDetail(result) : "来自评分区间")}
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
                <span class="badge primary">证据页码</span>
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
        ? `<div class="empty">${html(zeroMissDetail(result))}。</div>`
        : `<div class="empty">未找到合法引用编号，真实调用中应触发重试。</div>`;
    }
    return `
                  <div class="evidence-list">
                    ${citedEntries.map((entry) => renderEvidence(entry.row, entry.index, activeSection)).join("")}
                  </div>
    `;
  }

  function renderRetrievalPanel(result, evidence) {
    const safeEvidence = evidence && typeof evidence === "object" ? evidence : {};
    const picked = Array.isArray(safeEvidence.picked) ? safeEvidence.picked : [];
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
            <strong>证据 ${number(safeEvidence.units)} 段 / ${number(safeEvidence.evidence_chars)} 字（上限 ${number(safeEvidence.budget)} 字）</strong>
            <span class="muted">降级检索 ${safeEvidence.fallback ? "是" : "否"} · 截断 ${truncated ? "是" : "否"} · 重试 ${retryCount} 次 · confidence ${result.confidence.toFixed(2)}</span>
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
          <button class="btn link" data-locate-section="${html(row.section_id)}">定位摘录</button>
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
      label = "0" + (low ? " 复核" : "");
      title = zeroMissDetail(result) + "，点击查看依据";
      if (low) cls += " review";
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

  function metric(label, value, note, className, noteIsHtml) {
    return `
      <div class="metric ${className || ""}">
        <div class="metric-label">${html(label)}</div>
        <div class="metric-value">${value}</div>
        ${note ? `<div class="metric-note">${noteIsHtml ? note : html(note)}</div>` : ""}
      </div>
    `;
  }

  function renderRunLogs(logs) {
    if (!logs.length) return `<div class="empty">等待评审事件进入滚动区</div>`;
    const hiddenCount = Math.max(0, logs.length - LOG_RENDER_LIMIT);
    const visibleLogs = logs.slice(-LOG_RENDER_LIMIT);
    return `
      ${hiddenCount ? `<div class="log-trimmed">已折叠较早 ${hiddenCount} 条记录，仅显示最近 ${LOG_RENDER_LIMIT} 条</div>` : ""}
      ${visibleLogs.map(renderLogRow).join("")}
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
    const wallClock = DATA.reportData && DATA.reportData.perf ? DATA.reportData.perf.wall_clock_sec : null;
    return state.run.startedAt ? runElapsedMs() : typeof wallClock === "number" ? wallClock * 1000 : 0;
  }

  function startReviewClock(run, message) {
    if (!run.startedAt) {
      run.startedAt = Date.now();
      run.lastEventAt = run.startedAt;
      run.currentLabel = message || run.currentLabel;
      run.pausedTotalMs = 0;
      run.pausedAt = null;
    }
  }

  function numericConcurrency() {
    const value = DATA.reportData && DATA.reportData.perf ? Number(DATA.reportData.perf.concurrency) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function concurrencyLabel() {
    const value = numericConcurrency();
    return value ? value + " 路" : html((DATA.reportData.perf && DATA.reportData.perf.concurrency) || "未采集");
  }

  // ================= T10/T11：实时运行（README §3.8）=================
  // 服务层（src/server.py）可达时接管数据源：POST /api/run 起一次真实运行，
  // 轮询把服务端事件追加进 DATA.runEvents。**页面③的消费路径一行都不改**——
  // 回放与实时走同一个 tickRun，区别只是事件从哪来。
  const LIVE = {
    available: false,
    runId: null,
    cursor: 0,
    polling: false,
    serverDone: false,
    failed: false,
    error: "",
    reportLoaded: false,
    announced: false
  };

  function liveActive() {
    return LIVE.available && !!LIVE.runId && LIVE.runId !== "pending";
  }

  // 服务端还在跑，或事件还没消费完 —— 此时不许 completeRun
  function liveStillRunning() {
    return liveActive() && !LIVE.serverDone;
  }

  function liveProbe() {
    if (typeof fetch !== "function") return Promise.resolve();
    return fetch("/api/health", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { LIVE.available = !!(data && data.ok); })
      .catch(() => { LIVE.available = false; });
  }

  function liveStart() {
    if (!LIVE.available || LIVE.runId) return;
    LIVE.runId = "pending";
    fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    })
      .then((res) => res.json())
      .then((data) => {
        if (data && data.run_id) {
          LIVE.runId = data.run_id;
          LIVE.cursor = 0;
          // 实时接管后，回放事件必须清空，否则真假两份事件会串在一起。
          DATA.runEvents.length = 0;
          state.run.eventIndex = 0;
          pushRunLog({
            time: clock(),
            kind: "system",
            message: "服务层已连接，本次为实时运行（run " + data.run_id + "，并发 "
              + data.concurrency + " 路" + (data.mock ? "，Mock 模型" : "") + "）",
            result: "实时"
          });
        } else if (data && data.active_run_id) {
          // 服务端防重入（见 server.py）：已有一条在跑，多半是重复点击。
          // 挂到那条运行上继续轮询，而不是退回回放——回放会冒充实时，那更糟。
          LIVE.runId = data.active_run_id;
          LIVE.cursor = 0;
          DATA.runEvents.length = 0;
          state.run.eventIndex = 0;
          pushRunLog({
            time: clock(),
            kind: "system",
            message: "已有运行进行中，页面③接续显示该次运行（run " + data.active_run_id + "）",
            result: "实时"
          });
        } else {
          LIVE.runId = null;
          LIVE.failed = true;
          LIVE.error = (data && data.error) || "服务层拒绝启动";
          pushRunLog({ time: clock(), kind: "unrated",
            message: "服务层启动失败：" + LIVE.error + "（页面③退回回放）", result: "失败" });
        }
      })
      .catch((err) => {
        LIVE.runId = null;
        LIVE.available = false;
        LIVE.failed = true;
        LIVE.error = String(err);
      });
  }

  function livePoll() {
    if (!liveActive() || LIVE.polling || LIVE.serverDone) return;
    LIVE.polling = true;
    fetch("/api/progress?run_id=" + LIVE.runId + "&cursor=" + LIVE.cursor, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        LIVE.polling = false;
        if (!data || data.error) return;
        (data.events || []).forEach((event) => { DATA.runEvents.push(liveEvent(event)); });
        LIVE.cursor = data.cursor;
        LIVE.serverDone = !!data.done;
        LIVE.failed = !!data.failed;
        LIVE.error = data.error || "";
        if (LIVE.failed && LIVE.error && !LIVE.announced) {
          LIVE.announced = true;
          pushRunLog({ time: clock(), kind: "unrated",
            message: "运行失败：" + LIVE.error, result: "失败" });
        }
        if (LIVE.serverDone && !LIVE.reportLoaded) liveLoadReport();
      })
      .catch(() => { LIVE.polling = false; });
  }

  // 服务端给的是投标人**全名**（目录名），前端事件用短 id。
  // 短 id 的生成规则只在前端有一份，所以映射放在这里做，不让服务端猜。
  function liveEvent(event) {
    if (!event || event.type === "stage") return event;
    const bidder = bidderByName(event.bidder);
    const mapped = Object.assign({}, event);
    mapped.bidder_id = bidder ? bidder.id : event.bidder;
    return mapped;
  }

  // 页面②的人工确认放行服务端的 S3。不确认，服务端就停在 S2 之后等着——
  // 这条是为了让页面③滚动的起点确实晚于人工确认，而不是后台早已评完的回放。
  function liveConfirm() {
    if (!liveActive()) return;
    fetch("/api/confirm?run_id=" + LIVE.runId, { method: "POST" }).catch(() => {});
  }

  function liveLoadReport() {
    LIVE.reportLoaded = true;
    fetch("/api/report?run_id=" + LIVE.runId, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        // 后端 report.json 的 matrix / totals 就是以投标人全名为 key，
        // 与前端 reportBidderKey() 的取键规则一致，可直接覆盖。
        if (data && Array.isArray(data.matrix)) {
          DATA.reportData = Object.assign({}, DATA.reportData, data);
        }
      })
      .catch(() => {});
  }
  // ================= 实时运行到此为止 =================

  function ensureRunStarted(message) {
    const run = state.run;
    if (!run.started) {
      run.started = true;
      run.currentLabel = message || "开始读取 12 家投标技术标 PDF";
      run.stages["PDF 入库"] = "进行中";
      saveState();
      liveStart();
    }
    if (!run.timer && !run.finished) {
      run.timer = setInterval(tickRun, 750);
    }
  }

  function prepareRunForConfirm() {
    const run = state.run;
    if (!run.started) {
      run.started = true;
      run.currentLabel = "等待人工确认开始逐项评审";
      run.stages["PDF 入库"] = "已完成";
      run.stages["证据定位"] = "已完成";
      saveState();
    }
    // 挪到条件外：刷新页面后 run.started 已是 true，若启动时的重连失败，
    // 这里再不补一次 liveStart，服务端运行就成孤儿、页面悄悄退回回放。
    // liveStart 幂等（runId 已在则早退），重复调无代价。
    liveStart();
  }

  function startReview() {
    prepareRunForConfirm();
    const run = state.run;
    startReviewClock(run, "确认完成，开始逐项评审");
    ensureRunStarted();
    if (run.paused) {
      toggleRunPaused();
    }
    liveConfirm();
    if (!run.reviewStarted) {
      run.reviewStarted = true;
      run.paused = false;
      run.currentLabel = "确认完成，开始逐项评审";
      run.logs.push({
        time: clock(),
        kind: "system",
        message: "评分标准与投标文件确认完成，逐项评审开始",
        result: "已开始"
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
    saveRecoverySnapshot("run-finished");
  }

  function beginUploadRecognition(fileList) {
    const analysis = analyzeSelectedFiles(fileList);
    clearRunTimer();
    clearUploadRecognitionTimer();
    state.run = createRunState();
    // LIVE 必须跟着重置：否则第二轮 liveStart() 因 runId 仍挂着旧值而早退，
    // 服务层不会收到新的 POST /api/run，页面③会把上一轮的事件当成新运行回放——
    // 那正是 §1 P0 要防的「预跑好当场播放」。F5 刷新能绕过（LIVE 是内存态），
    // 但演示现场不该依赖人记得刷新。
    LIVE.runId = null;
    LIVE.cursor = 0;
    LIVE.serverDone = false;
    LIVE.failed = false;
    LIVE.error = "";
    LIVE.reportLoaded = false;
    LIVE.announced = false;
    state.upload = createUploadState();
    state.reviewOverrides = {};
    state.expertReviews = [];
    state.activeSectionId = "";
    state.showScoringReference = false;
    state.upload.selected = true;
    state.upload.totalFiles = analysis.totalFiles;
    state.upload.pdfFiles = analysis.pdfFiles;
    state.upload.totalBytes = analysis.totalBytes;
    state.upload.sourceLabel = analysis.sourceLabel;
    state.upload.recognizedBidders = analysis.recognizedBidders;
    state.upload.unmatchedFiles = analysis.unmatchedFiles;
    state.upload.ignoredFiles = analysis.ignoredFiles;
    state.upload.startedAt = Date.now();
    if (!analysis.recognizedBidders.length) {
      state.upload.recognitionComplete = true;
      state.upload.parsed = false;
      state.upload.finishedAt = Date.now();
    } else {
      startUploadRecognitionTimer();
    }
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
      const target = Array.isArray(upload.recognizedBidders) ? upload.recognizedBidders.length : 0;
      upload.recognizedCount = Math.min(target, upload.recognizedCount + 1);
      if (upload.recognizedCount >= target) {
        upload.recognitionComplete = true;
        upload.parsed = target >= DATA.bidders.length;
        upload.finishedAt = Date.now();
        upload.sourceLabel = upload.parsed ? "文件名预检通过" : "文件名预检未通过：缺少投标人";
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
    livePoll();
    if (!run.paused && !run.finished) {
      const now = Date.now();
      if (run.waitUntil && now < run.waitUntil) {
        updateRuntimeFields(route.path);
      } else {
        if (run.waitUntil) {
          run.waitUntil = null;
          changed = true;
        }
        // 回放每 tick 消费一条（节奏好看）；实时模式一次追多条，
        // 否则 750ms/条 会追不上并发 12 路的真实产出速度，页面③反而显得慢。
        let budget = liveActive() ? 60 : 1;
        while (budget > 0) {
          budget -= 1;
          const event = DATA.runEvents[run.eventIndex];
          if (event && canConsumeEvent(event)) {
            processRunEvent(event);
            run.eventIndex += 1;
            changed = true;
            if (run.waitUntil) break;
          } else {
            if (event) markWaitingForReviewGate();
            break;
          }
        }
      }
      if (run.eventIndex >= DATA.runEvents.length && !liveStillRunning()) {
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
      if (changed) {
        renderPreservingRunLog();
      } else {
        updateRuntimeFields(route.path);
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
    if (path !== "/confirm" && path !== "/running") return;
    const elapsedText = state.run.startedAt ? formatDuration(runElapsedMs()) : "未开始";
    document.querySelectorAll("[data-run-elapsed]").forEach((elapsed) => {
      elapsed.textContent = elapsedText;
    });

    if (path === "/running") {
      const run = state.run;
      const elapsed = runElapsedMs();
      const estimatedMs = run.completedReviews
        ? (elapsed / Math.max(1, run.completedReviews)) * Math.max(0, TOTAL_REVIEWS - run.completedReviews)
        : 0;
      const waitingMs = run.lastEventAt ? runTimestampNow(run) - run.lastEventAt : 0;
      const estimated = document.querySelector("[data-run-estimated]");
      if (estimated) {
        estimated.textContent = "预计剩余 " + formatDuration(estimatedMs) + " · 按当前吞吐估算";
      }
      const waiting = document.querySelector("[data-run-waiting]");
      if (waiting) {
        waiting.textContent = "已等待 " + formatDuration(waitingMs);
      }
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
    if (state.run.logs.length > LOG_RENDER_LIMIT) {
      state.run.logs = state.run.logs.slice(-LOG_RENDER_LIMIT);
    }
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
        bidder: bidder ? bidder.short : event.bidder_id,
        item: item ? item.name : event.item_id,
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

      const review = normalizeReviewResult(event);
      let kind = "rated";
      let result = "";
      if (!review || review.status === "unrated") {
        kind = "unrated";
        run.unrated += 1;
        result = "— 未评定";
        if (review && review.last_error) {
          result += " · " + review.last_error;
        }
      } else if (review.score === 0) {
        kind = isLowConfidence(review) ? "retry" : "miss";
        result = "0 分 " + zeroMissLabel(review);
        if (isLowConfidence(review)) {
          result += " · 建议复核";
        }
      } else {
        result = review.tier + " " + review.score.toFixed(1) + " 分";
        if (isLowConfidence(review)) {
          kind = "retry";
          result += " · 建议复核";
        }
      }

      pushRunLog({
        time: clock(),
        kind,
        bidder: bidder ? bidder.short : event.bidder_id,
        item: item ? item.name : event.item_id,
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
    if (state.run.finished) {
      const total = reportTotalForBidder(bidder);
      if (total) {
        return {
          score: roundScore(total.score),
          unrated: Math.max(0, Number(total.unrated) || 0)
        };
      }
    }
    const rows = scoringItems()
      .filter((item) => isReviewCompleted(bidder.id, item.id, completedKeys))
      .map((item) => resultForDisplay(bidder, item, completedKeys));
    const score = rows.reduce((sum, row) => sum + (row && typeof row.score === "number" ? row.score : 0), 0);
    const unrated = rows.filter((row) => row && row.status === "unrated").length;
    return {
      score: roundScore(score),
      unrated
    };
  }

  function expertTotalForBidder(bidder, completedKeys = completedReviewKeySet()) {
    if (state.run.finished) {
      const total = reportTotalForBidder(bidder);
      if (total) {
        return {
          score: roundScore(total.expert_score ?? total.score),
          overrides: Math.max(0, Number(total.expert_overrides) || 0)
        };
      }
    }
    let score = 0;
    let overrides = 0;
    scoringItems()
      .filter((item) => isReviewCompleted(bidder.id, item.id, completedKeys))
      .forEach((item) => {
        const result = resultForDisplay(bidder, item, completedKeys);
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
    const dataSource = DATA.dataSource || {};
    const configSource = DATA.configSource || {};
    const reportSourceText = dataSource.kind === "real"
      ? (dataSource.report_source
        ? "正式 S4 报告：" + dataSource.report_source
        : "真实评审结果：" + (dataSource.source || "已加载 real-results.js"))
      : "样例数据";
    const configSourceText = configSource.scoring
      ? "评分配置：" + configSource.scoring + "；项目摘要：" + (configSource.summary || "未标注")
      : "评分配置来源未标注";
    const tokenNote = perf.token_note || TOKEN_NOTE;
    const reportWallClock = typeof perf.wall_clock_sec === "number"
      ? formatDuration(perf.wall_clock_sec * 1000)
      : "未采集";
    const concurrencyText = typeof perf.concurrency === "number"
      ? perf.concurrency + " 路"
      : html(perf.concurrency || "未采集");
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
            const result = resultForDisplay(bidder, item, completedKeys);
            if (!result) {
              return `<td class="pending">评审中</td><td></td>`;
            }
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
    const unrated = completedReviewResults(completedKeys)
      .filter((row) => row.status === "unrated")
      .map((row) => {
        const bidder = bidderById(row.bidder_id);
        return {
          bidder: row.bidder || (bidder ? bidder.name : row.bidder_id),
          item_id: row.item_id,
          attempts: row.attempts,
          last_error: row.last_error
        };
      });
    const reviewFlags = reviewFlagRows(completedKeys);
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
  <p class="meta">数据源：${html(reportSourceText)}；${html(configSourceText)}。本文件为当前页面导出的评审报告，含当前专家复核记录。</p>

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
  <p class="note">0 = 缺文件或未命中；0 复核 = 文件存在但证据定位未命中；— = 未评定；复核 = confidence &lt; ${LOW_CONFIDENCE_THRESHOLD}；专家列仅列人工改判值；* = 该家存在未评定项。</p>

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
      <tr><th>报告耗时</th><td>${reportWallClock}</td></tr>
      <tr><th>页面计时</th><td>${formatDuration(reportElapsedMs())}</td></tr>
      <tr><th>并发</th><td>${concurrencyText}</td></tr>
      <tr><th>调用数</th><td>${number(perf.calls)}</td></tr>
      <tr><th>重试数</th><td>${number(perf.retries)}</td></tr>
      <tr><th>输入 tokens（本地估算）</th><td>${number(perf.in_tokens)}</td></tr>
      <tr><th>输出 tokens（本地估算）</th><td>${number(perf.out_tokens)}</td></tr>
      <tr><th>token 说明</th><td>${html(tokenNote)}</td></tr>
      <tr><th>GPU / 显存</th><td>${html(perf.gpu)} / ${perf.vram_peak_gb == null ? "未采集" : perf.vram_peak_gb + " GB"}</td></tr>
      <tr><th>说明</th><td>${html(perf.gpu_note)}</td></tr>
      <tr><th>耗时说明</th><td>${html(perf.wall_clock_note || "未采集")}</td></tr>
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
    const newReview = event.target.closest("[data-new-review]");
    if (newReview) {
      event.preventDefault();
      if (!window.confirm("当前评审已完成。确定要新建评审吗？系统会先保存上一轮恢复快照，取消则继续保留当前结果。")) {
        return;
      }
      saveRecoverySnapshot("new-review");
      resetWorkflowState();
      setRoute("#/create");
      render();
      return;
    }

    const restoreRecovery = event.target.closest("[data-restore-recovery]");
    if (restoreRecovery) {
      if (!restoreRecoverySnapshot()) {
        window.alert("未找到可恢复的上一轮评审快照。");
        return;
      }
      setRoute(state.run.finished ? "#/results" : "#/running");
      render();
      return;
    }

    const parse = event.target.closest("[data-start-parse]");
    if (parse) {
      event.preventDefault();
      if (!isUploadParsed()) {
        window.alert("请先选择投标文件，并确认已识别到全部投标人。");
        return;
      }
      prepareRunForConfirm();
      setRoute("#/confirm");
      return;
    }

    const start = event.target.closest("[data-start-run]");
    if (start) {
      if (!isUploadParsed()) {
        window.alert("请先完成投标文件识别和绑定预检。");
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

    const criteriaToggle = event.target.closest("[data-criteria-toggle]");
    if (criteriaToggle) {
      event.preventDefault();
      const itemId = criteriaToggle.getAttribute("data-criteria-toggle") || "";
      state.activeCriteriaId = state.activeCriteriaId === itemId ? "" : itemId;
      render();
      return;
    }

    const exportXlsx = event.target.closest("[data-export-xlsx]");
    if (exportXlsx) {
      if (!state.run.finished) {
        window.alert("评审完成后才能导出报告。");
        return;
      }
      // 调用后端 /api/export 生成评审结果_正式.xlsx，前端用 fetch 接收 blob 后触发下载
      fetch("/api/export?run_id=" + LIVE.runId)
        .then((res) => {
          if (!res.ok) {
            return res.text().then((text) => { throw new Error(text || "导出失败"); });
          }
          return res.blob();
        })
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "评审结果_正式.xlsx";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        })
        .catch((err) => {
          window.alert("导出失败：" + err.message);
        });
      return;
    }

    const exportReport = event.target.closest("[data-export-report]");
    if (exportReport) {
      if (!state.run.finished) {
        window.alert("评审完成后才能导出报告。当前结果页仅作为运行过程查看。");
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
      saveRecoverySnapshot("manual-reset");
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
    if (state.run.reviewStarted && !state.run.finished) {
      // 兜底：正常 UI 已锁（见 renderCreatePage 的 uploadLocked），
      // 这里防的是手改 DOM 之类绕过界面的情况。重新选择会重置前端状态，
      // 但服务端旧运行还在跑，再放行就会两条流水线同时打端点。
      window.alert("评审进行中，等本轮跑完再选择新文件。");
      input.value = "";
      return;
    }
    if (hasWorkflowData()) {
      if (!window.confirm("重新选择投标文件会开始一轮新评审。系统会先保存当前恢复快照，确定继续吗？")) {
        input.value = "";
        return;
      }
      saveRecoverySnapshot("file-reselect");
    }
    beginUploadRecognition(input.files);
  });

  function toggleRunPaused() {
    const run = state.run;
    if (run.finished) return;
    if (run.paused) {
      const now = Date.now();
      const pausedMs = run.pausedAt ? Math.max(0, now - run.pausedAt) : 0;
      // 实时模式下暂停的只是页面滚动，服务层照跑、墙钟照走，**不能把这段时间从耗时里扣掉**——
      // 耗时是 §1 的 P0 考核项，少报比难看严重。回放模式下扣除是对的，那本来就没有真实运行。
      if (!liveActive()) {
        run.pausedTotalMs += pausedMs;
      }
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
    state.activeCriteriaId = "";
    render();
    if (getRoute().path === "/running") {
      setTimeout(scrollRunLogToBottom, 0);
    }
  });

  liveProbe().then(() => {
    // 刷新页面后重连服务端运行：LIVE 是内存态，刷新即丢。
    // liveStart 幂等——LIVE.runId 已在或服务不可用就早退；服务端防重入
    // 会返回 active_run_id 挂回正在跑的那条（见 liveStart 与 server.py）。
    // 不重连的话，刷新后页面只能冻结或退回回放——回放冒充实时是 §1 的 P0。
    // 服务不可用（LIVE.available=false）时不调 liveStart，走既有回放兜底。
    if (state.run.started && !state.run.finished && LIVE.available) {
      liveStart();
    }
    if (state.run.started && !state.run.finished) {
      ensureRunStarted();
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
})();
