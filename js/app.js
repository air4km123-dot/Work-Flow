/* ==========================================================================
   APPLICATION LOGIC
   Tabs, summary dashboards, scenario cards, presentation-mode slide deck.
   ========================================================================== */

(function () {
  "use strict";

  var fmtClock = GanttEngine.fmtTime;

  // Charts with an overlap band (currently only M4) need a re-measure once
  // they actually become visible (tab switch / presentation slide change),
  // since layout offsets read as 0 while hidden or detached from the DOM.
  var overlapHandles = [];
  function refreshOverlaps() {
    overlapHandles.forEach(function (h) { h.refreshOverlap(); });
  }

  function fmtDuration(seconds) {
    if (seconds === 0) return "0 min";
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    if (s === 0) return m + " min";
    return m + " min " + s + " sec";
  }

  var CARD_PLOT_WIDTH = 900;
  var SLIDE_PLOT_WIDTH = 1560;

  function maxDuration(list) {
    return Math.max.apply(null, list.map(function (s) { return s.totalTime; }));
  }

  var AUTO_MAX = maxDuration(APP_DATA.auto);
  var MANUAL_MAX = maxDuration(APP_DATA.manual);
  var CARD_PX_AUTO = CARD_PLOT_WIDTH / AUTO_MAX;
  var CARD_PX_MANUAL = CARD_PLOT_WIDTH / MANUAL_MAX;
  var SLIDE_PX_AUTO = SLIDE_PLOT_WIDTH / AUTO_MAX;
  var SLIDE_PX_MANUAL = SLIDE_PLOT_WIDTH / MANUAL_MAX;

  // The final scenario in the Manual tab is always "the" current proposed
  // workflow — referenced by position rather than a hardcoded id/index so
  // adding, removing, or reordering manual scenarios can't leave summary
  // numbers elsewhere on the page stale.
  function proposedManualScenario() {
    return APP_DATA.manual[APP_DATA.manual.length - 1];
  }

  // ---- shared building blocks ---------------------------------------------

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // Highlights the words Manual/Auto (filled badge, white text) and
  // Condenser/Evaporator (colored text) wherever they appear in a scenario
  // name — used everywhere a scenario name is rendered as a title.
  function styledScenarioName(text) {
    return text
      .replace(/\bManual\b/g, '<span class="word-badge word-badge-manual">Manual</span>')
      .replace(/\bAuto\b/g, '<span class="word-badge word-badge-auto">Auto</span>')
      .replace(/\bCondenser\b/g, '<span class="word-color word-color-condenser">Condenser</span>')
      .replace(/\bEvaporator\b/g, '<span class="word-color word-color-evaporator">Evaporator</span>');
  }

  function buildLegend() {
    var wrap = el("div", "legend");
    [
      ["Condenser Cleaning", "var(--condenser)"],
      ["General Tasks (Combined)", "var(--general)"],
      ["Evaporator Cleaning", "var(--evaporator)"],
      ["Waiting / Machine-Running", "var(--overlap)"],
    ].forEach(function (item) {
      var li = el("div", "legend-item");
      var sw = el("span", "legend-swatch");
      sw.style.background = item[1];
      li.appendChild(sw);
      li.appendChild(document.createTextNode(item[0]));
      wrap.appendChild(li);
    });
    return wrap;
  }

  function buildStatPills(scenario, opts) {
    opts = opts || {};
    var wrap = el("div", "scenario-stats");
    var stats = [["Total Time", fmtClock(scenario.totalTime)], ["Added Service Time", fmtDuration(scenario.addedServiceTime)]];
    // Time Saved / Reduction are skipped here when the big Before→After
    // banner is shown right below — it already states both, so showing them
    // twice in the same card/slide is redundant.
    if (!opts.hideSavings) {
      if (scenario.timeSaved !== null && scenario.timeSaved !== undefined) stats.push(["Time Saved", fmtDuration(scenario.timeSaved)]);
      if (scenario.percentReduction !== null && scenario.percentReduction !== undefined) stats.push(["Reduction", scenario.percentReduction.toFixed(2) + "%"]);
    }
    stats.forEach(function (s) {
      var pill = el("div", "stat-pill");
      pill.appendChild(el("div", "v", s[1]));
      pill.appendChild(el("div", "l", s[0]));
      wrap.appendChild(pill);
    });
    return wrap;
  }

  function buildBigComparison(beforeSec, afterSec, savedSec, reductionPct, big) {
    var wrap = el("div", "big-comparison" + (big ? " slide-big" : ""));
    function item(label, value) {
      var d = el("div", "item");
      d.appendChild(el("div", "value", value));
      d.appendChild(el("div", "label", label));
      return d;
    }
    wrap.appendChild(item("Before", fmtClock(beforeSec)));
    wrap.appendChild(el("div", "arrow", "→"));
    wrap.appendChild(item("After", fmtClock(afterSec)));
    wrap.appendChild(item("Time Saved", fmtClock(savedSec)));
    wrap.appendChild(item("Reduction", reductionPct.toFixed(2) + "%"));
    return wrap;
  }

  function buildScenarioCard(scenario, pxPerSecond, opts) {
    opts = opts || {};
    var card = el("div", "scenario-card" + (scenario.highlight ? " highlight" : ""));

    var head = el("div", "scenario-head");
    var left = el("div");
    left.appendChild(el("div", "scenario-code", scenario.code));
    left.appendChild(el("div", "scenario-name", styledScenarioName(scenario.name)));
    left.appendChild(el("div", "scenario-desc", scenario.description));
    head.appendChild(left);
    if (opts.presentBtn) {
      var pbtn = el("button", "btn btn-sm", "Present ▸");
      pbtn.addEventListener("click", function () { openPresentation(opts.slideIndex); });
      head.appendChild(pbtn);
    }
    card.appendChild(head);

    card.appendChild(buildLegend());

    var scroll = el("div", "gantt-scroll");
    var chartHost = el("div");
    scroll.appendChild(chartHost);
    card.appendChild(scroll);
    var handle = GanttEngine.renderChart(chartHost, scenario, pxPerSecond);
    if (scenario.overlaps && scenario.overlaps.length) overlapHandles.push(handle);

    card.appendChild(el("div", "expand-hint", "Double-click any section bar to expand its tasks; double-click again to collapse."));
    card.appendChild(buildStatPills(scenario, { hideSavings: scenario.showBigComparison }));

    if (scenario.showBigComparison) {
      card.appendChild(buildBigComparison(3600, scenario.totalTime, scenario.timeSaved, scenario.percentReduction, false));
    }

    card.appendChild(el("div", "conclusion-banner", scenario.conclusion));

    return card;
  }

  // ---- summary dashboards --------------------------------------------------

  function buildAutoSummary() {
    var wrap = el("div", "summary-dashboard");
    function card(value, label, accent) {
      var c = el("div", "summary-card accent-" + accent);
      c.appendChild(el("div", "value", value));
      c.appendChild(el("div", "label", label));
      wrap.appendChild(c);
    }
    card("0 min", "Auto Evaporator within EM — Added", "evaporator");
    card("30 min", "Manual Condenser Only — Added", "condenser");
    card("30 min", "Auto Evaporator + Condenser — Added", "navy");
    return wrap;
  }

  function buildManualSummary() {
    var wrap = el("div", "summary-dashboard");
    function card(value, label, accent) {
      var c = el("div", "summary-card accent-" + accent);
      c.appendChild(el("div", "value", value));
      c.appendChild(el("div", "label", label));
      wrap.appendChild(c);
    }
    card("30 min", "Manual Condenser", "condenser");
    card("30 min", "Manual Evaporator", "evaporator");
    card("60 min", "Current Combined", "navy");
    card(fmtDuration(proposedManualScenario().totalTime), "Proposed Combined", "overlap");
    return wrap;
  }

  // ---- tab rendering --------------------------------------------------------

  function renderAutoTab() {
    var panel = document.getElementById("panel-auto");
    panel.innerHTML = "";
    panel.appendChild(buildAutoSummary());
    var grid = el("div", "scenario-grid");
    APP_DATA.auto.forEach(function (sc, i) {
      grid.appendChild(buildScenarioCard(sc, CARD_PX_AUTO, { presentBtn: true, slideIndex: SLIDE_INDEX[sc.id] }));
    });
    panel.appendChild(grid);
  }

  function renderManualTab() {
    var panel = document.getElementById("panel-manual");
    panel.innerHTML = "";
    panel.appendChild(buildManualSummary());
    var grid = el("div", "scenario-grid");
    APP_DATA.manual.forEach(function (sc) {
      grid.appendChild(buildScenarioCard(sc, CARD_PX_MANUAL, { presentBtn: true, slideIndex: SLIDE_INDEX[sc.id] }));
    });
    panel.appendChild(grid);
  }

  // ---- tabs -------------------------------------------------------------

  function initTabs() {
    var btns = document.querySelectorAll(".tab-btn");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        btns.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
        document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
        refreshOverlaps();
      });
    });
  }

  // ==========================================================================
  // PRESENTATION MODE
  // ==========================================================================

  var SLIDE_INDEX = {}; // scenario id -> slide index, filled once slides build
  var slides = [];
  var currentSlide = 0;

  function slideShell(eyebrow, title, sub) {
    var s = el("div", "slide");
    if (eyebrow) s.appendChild(el("div", "slide-eyebrow", eyebrow));
    if (title) s.appendChild(el("div", "slide-title", title));
    if (sub) s.appendChild(el("div", "slide-sub", sub));
    return s;
  }

  function buildTitleSlide() {
    var s = slideShell("Toyota Service Operations", "Condenser & Evaporator Cleaning Workflow Optimization", "A time-based comparison of current and proposed cleaning workflows across Auto and Manual machine countries.");
    var spacer = el("div");
    spacer.style.flex = "1";
    s.appendChild(spacer);
    var row = el("div", "big-comparison slide-big");
    function item(v, l) {
      var d = el("div", "item");
      d.appendChild(el("div", "value", v));
      d.appendChild(el("div", "label", l));
      return d;
    }
    var proposed = proposedManualScenario();
    row.appendChild(item("0 min", "Auto Evaporator — Added Time"));
    row.appendChild(item(proposed.percentReduction.toFixed(2) + "%", "Manual Workflow Reduction"));
    row.appendChild(item(fmtClock(proposed.timeSaved), "Manual Time Saved"));
    s.appendChild(row);
    return s;
  }

  function buildScenarioSlide(scenario, px, tabLabel) {
    var s = slideShell(tabLabel, scenario.code + " — " + styledScenarioName(scenario.name), scenario.description);
    s.appendChild(buildLegend());
    var chartHost = el("div");
    s.appendChild(chartHost);
    var handle = GanttEngine.renderChart(chartHost, scenario, px);
    if (scenario.overlaps && scenario.overlaps.length) overlapHandles.push(handle);
    s.appendChild(buildStatPills(scenario, { hideSavings: scenario.showBigComparison }));
    if (scenario.showBigComparison) s.appendChild(buildBigComparison(3600, scenario.totalTime, scenario.timeSaved, scenario.percentReduction, true));
    s.appendChild(el("div", "conclusion-banner", scenario.conclusion));
    return s;
  }

  // Fits N mini-charts across a 1920px slide (1780px inner content width,
  // 40px gaps, a 90px narrowed row-label per column, plus safety margin for
  // the .compare-col chart's 1.05 hover-scale) without overflowing/clipping.
  function comparisonColWidth(n) {
    var GAP = 40, LABEL_AND_MARGIN = 110;
    return Math.max(120, (1780 - (n - 1) * GAP) / n - LABEL_AND_MARGIN);
  }

  function buildComparisonSlide(title, sub, scenarioList, sharedMax) {
    var s = slideShell("Comparison", title, sub);
    var cols = el("div", "compare-cols");
    var colWidth = comparisonColWidth(scenarioList.length);
    scenarioList.forEach(function (sc) {
      var px = colWidth / sharedMax;
      var col = el("div", "compare-col");
      col.appendChild(el("h3", null, sc.code + " — " + styledScenarioName(sc.name)));
      var chartHost = el("div");
      col.appendChild(chartHost);
      var handle = GanttEngine.renderChart(chartHost, sc, px);
      if (sc.overlaps && sc.overlaps.length) overlapHandles.push(handle);
      col.appendChild(buildStatPills(sc));
      cols.appendChild(col);
    });
    s.appendChild(cols);
    return s;
  }

  function buildCurrentVsProposedSlide() {
    var m3 = APP_DATA.manual.filter(function (s) { return s.id === "M3"; })[0];
    var proposed = proposedManualScenario();
    var s = slideShell("Manual Workflow", "Current vs Proposed Manual Workflow", "Rearranging manual evaporator and condenser cleaning to overlap with waiting and machine-running periods.");
    var cols = el("div", "compare-cols");
    [m3, proposed].forEach(function (sc) {
      var px = comparisonColWidth(2) / MANUAL_MAX;
      var col = el("div", "compare-col");
      col.appendChild(el("h3", null, sc.code + " — " + styledScenarioName(sc.name)));
      var chartHost = el("div");
      col.appendChild(chartHost);
      var handle = GanttEngine.renderChart(chartHost, sc, px);
      if (sc.overlaps && sc.overlaps.length) overlapHandles.push(handle);
      col.appendChild(buildStatPills(sc));
      cols.appendChild(col);
    });
    s.appendChild(cols);
    s.appendChild(buildBigComparison(m3.totalTime, proposed.totalTime, proposed.timeSaved, proposed.percentReduction, true));
    return s;
  }

  function buildTimeSavingSummarySlide() {
    var proposed = proposedManualScenario();
    var s = slideShell("Executive Summary", "Time-Saving Summary", "Combined impact of proposed workflow changes across Auto and Manual machine countries.");
    s.appendChild(buildBigComparison(3600, proposed.totalTime, proposed.timeSaved, proposed.percentReduction, true));
    var grid = el("div", "summary-dashboard");
    function card(value, label, accent) {
      var c = el("div", "summary-card accent-" + accent);
      c.appendChild(el("div", "value", value));
      c.appendChild(el("div", "label", label));
      grid.appendChild(c);
    }
    card("0 min", "Auto Evaporator within EM — Added", "evaporator");
    card("30 min", "Auto/Manual Condenser Only — Added", "condenser");
    card("60 min", "Manual Current Combined", "navy");
    card(fmtDuration(proposed.totalTime), "Manual Proposed Combined", "overlap");
    s.appendChild(grid);
    s.appendChild(el("div", "conclusion-banner", "Auto evaporator cleaning adds zero service time by running inside the existing EM window. The proposed manual workflow saves " + fmtDuration(proposed.timeSaved) + " (" + proposed.percentReduction.toFixed(2) + "%) by overlapping evaporator preparation with the condenser's waiting and machine-running periods."));
    return s;
  }

  function buildSlides() {
    slides = [];
    slides.push(buildTitleSlide());

    APP_DATA.auto.forEach(function (sc) {
      SLIDE_INDEX[sc.id] = slides.length;
      slides.push(buildScenarioSlide(sc, SLIDE_PX_AUTO, "Auto Machine Countries"));
    });
    slides.push(buildComparisonSlide("Auto Scenario Comparison", "Comparing added service time across auto machine cleaning strategies.", APP_DATA.auto, AUTO_MAX));

    APP_DATA.manual.forEach(function (sc) {
      SLIDE_INDEX[sc.id] = slides.length;
      slides.push(buildScenarioSlide(sc, SLIDE_PX_MANUAL, "Manual Machine Countries"));
    });
    slides.push(buildComparisonSlide("Manual Scenario Comparison", "Comparing total cleaning time across manual machine cleaning strategies.", APP_DATA.manual, MANUAL_MAX));

    slides.push(buildCurrentVsProposedSlide());
    slides.push(buildTimeSavingSummarySlide());
  }

  var overlayEl, viewportEl, wrapperEl, counterEl;

  function fitSlideViewport() {
    var s = Math.min((window.innerWidth - 80) / 1920, (window.innerHeight - 140) / 1080);
    s = Math.max(s, 0.1);
    wrapperEl.style.width = (1920 * s) + "px";
    wrapperEl.style.height = (1080 * s) + "px";
    viewportEl.style.transform = "scale(" + s + ")";
  }

  function showSlide(idx) {
    if (idx < 0) idx = 0;
    if (idx >= slides.length) idx = slides.length - 1;
    currentSlide = idx;
    viewportEl.innerHTML = "";
    viewportEl.appendChild(slides[idx]);
    counterEl.textContent = (idx + 1) + " / " + slides.length;
    refreshOverlaps();
  }

  function openPresentation(startIdx) {
    if (!slides.length) buildSlides();
    overlayEl.classList.add("active");
    fitSlideViewport();
    showSlide(startIdx || 0);
    document.body.style.overflow = "hidden";
  }

  function closePresentation() {
    overlayEl.classList.remove("active");
    document.body.style.overflow = "";
  }

  function initPresentation() {
    overlayEl = document.getElementById("present-overlay");
    wrapperEl = document.getElementById("slide-wrapper");
    viewportEl = document.getElementById("slide-viewport");
    counterEl = document.getElementById("present-counter");

    document.getElementById("btn-present").addEventListener("click", function () { openPresentation(0); });
    document.getElementById("present-exit").addEventListener("click", closePresentation);
    document.getElementById("present-prev").addEventListener("click", function () { showSlide(currentSlide - 1); });
    document.getElementById("present-next").addEventListener("click", function () { showSlide(currentSlide + 1); });

    window.addEventListener("resize", function () { if (overlayEl.classList.contains("active")) fitSlideViewport(); });

    document.addEventListener("keydown", function (e) {
      if (!overlayEl.classList.contains("active")) return;
      if (e.key === "ArrowRight") showSlide(currentSlide + 1);
      else if (e.key === "ArrowLeft") showSlide(currentSlide - 1);
      else if (e.key === "Escape") closePresentation();
    });
  }

  // ---- export toolbar wiring ------------------------------------------------

  function initExportToolbar() {
    var dropdown = document.getElementById("export-dropdown");
    document.getElementById("btn-export").addEventListener("click", function (e) {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
    document.addEventListener("click", function () { dropdown.classList.remove("open"); });

    document.getElementById("export-current").addEventListener("click", function () {
      if (!overlayEl.classList.contains("active")) openPresentation(0);
      ExportEngine.exportSlidePNG(slides[currentSlide], "slide-" + (currentSlide + 1));
    });
    document.getElementById("export-all").addEventListener("click", function () {
      if (!slides.length) buildSlides();
      ExportEngine.exportAllSlidesPNG(slides);
    });
    document.getElementById("export-pdf").addEventListener("click", function () {
      if (!slides.length) buildSlides();
      ExportEngine.exportSlidesPDF(slides);
    });
    document.getElementById("export-print").addEventListener("click", function () {
      if (!overlayEl.classList.contains("active")) openPresentation(0);
      setTimeout(function () { window.print(); }, 150);
    });
  }

  // ---- boot -------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", function () {
    initTabs();
    initPresentation();
    buildSlides();
    renderAutoTab();
    renderManualTab();
    initExportToolbar();
  });
})();
