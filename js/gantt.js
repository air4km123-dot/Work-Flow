/* ==========================================================================
   GANTT RENDERING ENGINE
   Pure time-accurate Gantt bars: left = start*pxPerSecond, width = dur*pxPerSecond.
   Handles: axis ticks, N/A rows, expand/collapse of the 4 fixed sections,
   narrow-bar abbreviation + external leader-line labels, tooltips, and the
   M4 concurrent/overlap band.
   ========================================================================== */

(function (global) {
  "use strict";

  var SECTION_ABBR = {
    "Initial Preparation": "IP",
    "Pre Cleaning": "PR",
    "Cleaning Operation": "CO",
    "Post Cleaning": "PO",
  };

  var ROW_META = {
    condenser: { label: "Condenser Cleaning", cls: "row-condenser" },
    general: { label: "General Tasks", cls: "row-general" },
    evaporator: { label: "Evaporator Cleaning", cls: "row-evaporator" },
  };

  var BAR_HEIGHT = 30;
  var TRACK_PAD = 10;
  var LANE_HEIGHT = 18;
  var LANE_GAP = 10;
  var BAR_FONT = "600 11px 'Segoe UI', Arial, sans-serif";
  var EXT_FONT = "500 10.5px 'Segoe UI', Arial, sans-serif";

  // ---- text measuring (cached canvas) -------------------------------------
  var _measureCanvas = document.createElement("canvas");
  var _measureCtx = _measureCanvas.getContext("2d");
  function measureTextWidth(text, font) {
    _measureCtx.font = font;
    return _measureCtx.measureText(text).width;
  }

  function fmtTime(totalSeconds) {
    var s = Math.round(totalSeconds);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function niceTickInterval(pxPerSecond, minSpacingPx) {
    var options = [5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1200, 1800];
    for (var i = 0; i < options.length; i++) {
      if (options[i] * pxPerSecond >= minSpacingPx) return options[i];
    }
    return options[options.length - 1];
  }

  // Merge a section's tasks into contiguous coverage runs (touching/overlapping
  // tasks join one run; a real gap — idle time with no task — starts a new one).
  // Used so a collapsed section bar shows empty space where nothing is actually
  // happening, instead of one solid bar spanning from first task to last.
  function computeCoverageSegments(tasks) {
    var sorted = tasks.slice().sort(function (a, b) { return a.start - b.start; });
    var segments = [];
    sorted.forEach(function (t) {
      var last = segments[segments.length - 1];
      if (last && t.start <= last.end) {
        last.end = Math.max(last.end, t.end);
      } else {
        segments.push({ start: t.start, end: t.end });
      }
    });
    return segments;
  }

  // assign a stable global index to every task in a row (used for abbreviation numbers)
  function assignTaskIndices(sections) {
    if (!sections || sections.type === "simple") return;
    var idx = 1;
    sections.forEach(function (sec) {
      sec.tasks.forEach(function (t) { t._idx = idx++; });
    });
  }

  // ---- tooltip (single shared instance) -----------------------------------
  var tooltipEl = null;
  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "gantt-tooltip";
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }
  function showTooltip(evt, html) {
    var el = ensureTooltip();
    el.innerHTML = html;
    el.style.display = "block";
    positionTooltip(evt);
  }
  function positionTooltip(evt) {
    if (!tooltipEl || tooltipEl.style.display === "none") return;
    var x = evt.clientX + 14;
    var y = evt.clientY + 14;
    var rect = tooltipEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = evt.clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight) y = evt.clientY - rect.height - 14;
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
  }
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  // ---- label-lane collision avoidance -------------------------------------
  // items: [{x, width, ...}] -> assigns .lane (0 = closest to track).
  // Lanes are assigned monotonically in left-to-right order: once an item
  // is pushed to a deeper lane, later items never jump back to an earlier
  // (shallower) lane. This keeps the stacked labels reading in a single
  // top-to-bottom sequence matching task order, instead of alternating
  // between lanes as position allows (which read as overlapping/zigzagging).
  function assignLanes(items, gap) {
    var sorted = items.slice().sort(function (a, b) { return a.x - b.x; });
    var lane = 0;
    var lastRight = -Infinity;
    sorted.forEach(function (item, i) {
      var left = item.x - item.width / 2;
      if (i > 0 && left <= lastRight + gap) lane += 1;
      item.lane = lane;
      lastRight = item.x + item.width / 2;
    });
    return sorted.length ? lane + 1 : 0;
  }

  /**
   * Render one scenario's full 3-row Gantt chart into `container`.
   * `container` is emptied first. Returns a handle exposing refresh().
   */
  function renderChart(container, scenario, pxPerSecond, opts) {
    opts = opts || {};
    container.innerHTML = "";
    container.classList.add("gantt-chart");

    var expandState = { condenser: {}, general: {}, evaporator: {} };
    // General Tasks row only appears when a scenario actually has data for it
    // (e.g. M4's combined before/after checks) — otherwise it's skipped so
    // scenarios without SOP detail for it (EM window, etc.) stay 2-row.
    var rowOrder = ["condenser", "general", "evaporator"].filter(function (k) {
      return k !== "general" || !!scenario.rows.general;
    });

    rowOrder.forEach(function (k) {
      if (scenario.rows[k]) assignTaskIndices(scenario.rows[k]);
    });

    var chartDuration = scenario.totalTime;
    var trackWidth = Math.max(chartDuration * pxPerSecond, 40);

    // ---- axis -----
    var axis = document.createElement("div");
    axis.className = "gantt-axis";
    axis.style.width = trackWidth + "px";
    var tickInterval = niceTickInterval(pxPerSecond, 56);
    for (var t = 0; t <= chartDuration + 0.001; t += tickInterval) {
      var tick = document.createElement("div");
      tick.className = "gantt-tick";
      tick.style.left = (t * pxPerSecond) + "px";
      var line = document.createElement("div");
      line.className = "gantt-tick-line";
      var lbl = document.createElement("div");
      lbl.className = "gantt-tick-label";
      lbl.textContent = fmtTime(t);
      tick.appendChild(line);
      tick.appendChild(lbl);
      axis.appendChild(tick);
    }
    var axisWrap = document.createElement("div");
    axisWrap.className = "gantt-axis-wrap";
    var axisSpacer = document.createElement("div");
    axisSpacer.className = "gantt-row-label-spacer";
    axisWrap.appendChild(axisSpacer);
    axisWrap.appendChild(axis);
    container.appendChild(axisWrap);

    var rowEls = {};

    rowOrder.forEach(function (rowKey) {
      var meta = ROW_META[rowKey];
      var rowWrap = document.createElement("div");
      rowWrap.className = "gantt-row-wrap " + meta.cls;

      var rowLabel = document.createElement("div");
      rowLabel.className = "gantt-row-label";
      rowLabel.textContent = meta.label;
      rowWrap.appendChild(rowLabel);

      var rowBody = document.createElement("div");
      rowBody.className = "gantt-row-body";
      rowBody.style.width = trackWidth + "px";

      var labelLane = document.createElement("div");
      labelLane.className = "gantt-label-lane";

      var track = document.createElement("div");
      track.className = "gantt-track";
      track.style.width = trackWidth + "px";
      track.style.height = BAR_HEIGHT + TRACK_PAD + "px";

      rowBody.appendChild(labelLane);
      rowBody.appendChild(track);
      rowWrap.appendChild(rowBody);
      container.appendChild(rowWrap);

      rowEls[rowKey] = { rowWrap: rowWrap, track: track, labelLane: labelLane };

      renderRowTrack(rowKey, scenario.rows[rowKey], track, labelLane, pxPerSecond, expandState[rowKey], trackWidth);
    });

    // overlap bands (M4-style concurrent/waiting windows, 0-N of them)
    // getBoundingClientRect() below forces synchronous layout, so no rAF/timing
    // dependency is needed (and rAF does not reliably fire in headless contexts).
    function redrawOverlaps() {
      drawOverlapBands(container, rowEls, scenario.overlaps, pxPerSecond);
    }
    if (scenario.overlaps && scenario.overlaps.length) {
      redrawOverlaps();
      container.addEventListener("gantt-row-changed", redrawOverlaps);
    }

    function refreshRow(rowKey) {
      var refs = rowEls[rowKey];
      renderRowTrack(rowKey, scenario.rows[rowKey], refs.track, refs.labelLane, pxPerSecond, expandState[rowKey], trackWidth);
      redrawOverlaps();
    }

    // Re-measure and redraw the overlap bands. Needed because offsetTop/
    // offsetWidth are all zero while the chart lives in a display:none
    // panel or a detached (not-yet-inserted) slide — call this once the
    // chart is actually visible in the document (e.g. on tab switch or
    // presentation slide change).
    function refreshOverlap() {
      if (scenario.overlaps && scenario.overlaps.length) redrawOverlaps();
    }

    return { refreshRow: refreshRow, refreshOverlap: refreshOverlap, container: container };
  }

  // Cumulative offsetTop/offsetLeft relative to `ancestor`, walking the
  // offsetParent chain. Unlike getBoundingClientRect(), this is unaffected
  // by CSS transforms on ancestors (e.g. the presentation slide's fit-to-
  // screen scale), so it stays accurate wherever the chart is rendered.
  function offsetRelativeTo(elStart, ancestor, axis) {
    var total = 0;
    var node = elStart;
    var guard = 0;
    while (node && node !== ancestor && guard < 50) {
      total += axis === "left" ? node.offsetLeft : node.offsetTop;
      node = node.offsetParent;
      guard++;
    }
    return total;
  }

  function drawOverlapBands(container, rowEls, overlaps, pxPerSecond) {
    container.querySelectorAll(".overlap-band").forEach(function (el) { el.remove(); });
    var condRefs = rowEls.condenser;
    var evapRefs = rowEls.evaporator;
    if (!condRefs || !evapRefs || !overlaps) return;

    var top = offsetRelativeTo(condRefs.track, container, "top");
    var bottom = offsetRelativeTo(evapRefs.track, container, "top") + evapRefs.track.offsetHeight;
    var labelSpacerWidth = condRefs.rowWrap.querySelector(".gantt-row-label").offsetWidth;

    overlaps.forEach(function (overlap) {
      var left = labelSpacerWidth + overlap.start * pxPerSecond;
      var width = (overlap.end - overlap.start) * pxPerSecond;

      var band = document.createElement("div");
      band.className = "overlap-band";
      band.style.left = left + "px";
      band.style.top = top + "px";
      band.style.width = Math.max(width, 2) + "px";
      band.style.height = Math.max(bottom - top, 2) + "px";

      // Tag sits below the evaporator row (bottom of the band), not above the
      // condenser row — the space above can collide with the axis ticks or
      // that row's own external section/task labels; below the last row is
      // always clear.
      var tag = document.createElement("div");
      tag.className = "overlap-band-tag overlap-band-tag-below";
      tag.textContent = overlap.label || "Concurrent — Waiting / Machine-Running (Time Saved)";
      band.appendChild(tag);

      container.appendChild(band);
    });
  }

  function renderRowTrack(rowKey, sections, trackEl, labelLaneEl, pxPerSecond, expandState, trackWidth) {
    trackEl.innerHTML = "";
    labelLaneEl.innerHTML = "";

    if (!sections) {
      trackEl.classList.add("track-na");
      var na = document.createElement("div");
      na.className = "bar bar-na";
      na.style.left = "0px";
      na.style.width = trackWidth + "px";
      na.textContent = "Not Performed in This Scenario";
      trackEl.appendChild(na);
      labelLaneEl.style.height = "4px";
      return;
    }
    trackEl.classList.remove("track-na");

    if (sections.type === "simple") {
      var simpleLeft = sections.start * pxPerSecond;
      var simpleWidth = Math.max((sections.end - sections.start) * pxPerSecond, 1);
      var simpleBar = document.createElement("div");
      simpleBar.className = "bar bar-simple";
      simpleBar.style.left = simpleLeft + "px";
      simpleBar.style.width = simpleWidth + "px";
      simpleBar.style.height = BAR_HEIGHT + "px";
      var simpleFullW = measureTextWidth(sections.label, BAR_FONT) + 14;
      var simpleShowFull = simpleWidth >= simpleFullW;
      var simpleText = document.createElement("span");
      simpleText.className = "bar-text";
      simpleText.textContent = simpleShowFull ? sections.label : "EM";
      simpleBar.appendChild(simpleText);
      var simpleTooltip = sections.label + "<br>" + fmtTime(sections.start) + " – " + fmtTime(sections.end) +
        " (" + fmtTime(sections.end - sections.start) + ")";
      simpleBar.addEventListener("mouseenter", function (e) { showTooltip(e, simpleTooltip); });
      simpleBar.addEventListener("mousemove", positionTooltip);
      simpleBar.addEventListener("mouseleave", hideTooltip);
      trackEl.appendChild(simpleBar);
      if (!simpleShowFull) {
        var svg2 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg2.setAttribute("class", "leader-svg");
        var extW2 = measureTextWidth(sections.label, EXT_FONT) + 10;
        svg2.setAttribute("width", trackWidth);
        svg2.setAttribute("height", LANE_HEIGHT + 6);
        labelLaneEl.appendChild(svg2);
        var labelLeft2 = Math.min(Math.max(simpleLeft + simpleWidth / 2 - extW2 / 2, 0), trackWidth - extW2);
        var div2 = document.createElement("div");
        div2.className = "ext-label";
        div2.style.left = labelLeft2 + "px";
        div2.style.top = "0px";
        div2.style.width = extW2 + "px";
        div2.textContent = sections.label;
        labelLaneEl.appendChild(div2);
        var lineEl2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
        lineEl2.setAttribute("x1", labelLeft2 + extW2 / 2);
        lineEl2.setAttribute("y1", LANE_HEIGHT - 3);
        lineEl2.setAttribute("x2", simpleLeft + simpleWidth / 2);
        lineEl2.setAttribute("y2", LANE_HEIGHT + 6);
        lineEl2.setAttribute("class", "leader-line");
        svg2.appendChild(lineEl2);
        labelLaneEl.style.height = (LANE_HEIGHT + 6) + "px";
      } else {
        labelLaneEl.style.height = "4px";
      }
      labelLaneEl.style.width = trackWidth + "px";
      return;
    }

    var externalItems = []; // {x, width, text, barCenterX, key}

    sections.forEach(function (sec) {
      var expanded = !!expandState[sec.section];
      if (!expanded) {
        var segments = computeCoverageSegments(sec.tasks);
        segments.forEach(function (seg, segIdx) {
          var partSuffix = segments.length > 1 ? " (Part " + (segIdx + 1) + "/" + segments.length + ")" : "";
          addBar({
            left: seg.start * pxPerSecond,
            width: Math.max((seg.end - seg.start) * pxPerSecond, 1),
            fullText: sec.section + partSuffix,
            abbr: SECTION_ABBR[sec.section] || sec.section.slice(0, 2).toUpperCase(),
            tooltip: sec.section + partSuffix + "<br>" + fmtTime(seg.start) + " – " + fmtTime(seg.end) +
              " (" + fmtTime(seg.end - seg.start) + ")",
            isSection: true,
            sectionName: sec.section,
          });
        });
      } else {
        sec.tasks.forEach(function (task) {
          addBar({
            left: task.start * pxPerSecond,
            width: Math.max((task.end - task.start) * pxPerSecond, 1),
            fullText: task.name,
            abbr: task.wait ? "W" : String(task._idx),
            tooltip: task.name + "<br>" + fmtTime(task.start) + " – " + fmtTime(task.end) +
              " (" + fmtTime(task.end - task.start) + ")",
            isSection: false,
            sectionName: sec.section,
            wait: task.wait,
          });
        });
      }
    });

    function addBar(spec) {
      var bar = document.createElement("div");
      bar.className = "bar " + (spec.isSection ? "bar-section" : "bar-task") + (spec.wait ? " bar-wait" : "");
      bar.style.left = spec.left + "px";
      bar.style.width = spec.width + "px";
      bar.style.height = BAR_HEIGHT + "px";

      var fullTextW = measureTextWidth(spec.fullText, BAR_FONT) + 14;
      var showFull = spec.width >= fullTextW;

      var textSpan = document.createElement("span");
      textSpan.className = "bar-text";
      textSpan.textContent = showFull ? spec.fullText : spec.abbr;
      bar.appendChild(textSpan);

      if (spec.isSection) {
        bar.title = "";
        bar.addEventListener("dblclick", function () {
          expandState[spec.sectionName] = !expandState[spec.sectionName];
          renderRowTrack(rowKey, sections, trackEl, labelLaneEl, pxPerSecond, expandState, trackWidth);
          if (trackEl.closest(".gantt-chart")) {
            var evt = new CustomEvent("gantt-row-changed", { bubbles: true });
            trackEl.dispatchEvent(evt);
          }
        });
      } else {
        bar.addEventListener("dblclick", function () {
          expandState[spec.sectionName] = false;
          renderRowTrack(rowKey, sections, trackEl, labelLaneEl, pxPerSecond, expandState, trackWidth);
          var evt = new CustomEvent("gantt-row-changed", { bubbles: true });
          trackEl.dispatchEvent(evt);
        });
      }

      bar.addEventListener("mouseenter", function (e) { showTooltip(e, spec.tooltip); });
      bar.addEventListener("mousemove", positionTooltip);
      bar.addEventListener("mouseleave", hideTooltip);

      trackEl.appendChild(bar);

      if (!showFull) {
        var extW = measureTextWidth(spec.fullText, EXT_FONT) + 10;
        externalItems.push({
          x: spec.left + spec.width / 2,
          width: extW,
          text: spec.fullText,
          barCenterX: spec.left + spec.width / 2,
        });
      }
    }

    var laneCount = assignLanes(externalItems, LANE_GAP);
    var laneAreaHeight = Math.max(laneCount, 0) * LANE_HEIGHT + (laneCount > 0 ? 6 : 0);
    labelLaneEl.style.height = Math.max(laneAreaHeight, 4) + "px";
    labelLaneEl.style.width = trackWidth + "px";

    if (externalItems.length) {
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "leader-svg");
      svg.setAttribute("width", trackWidth);
      svg.setAttribute("height", laneAreaHeight);
      labelLaneEl.appendChild(svg);

      externalItems.forEach(function (item) {
        // lane 0 (earliest/leftmost item) sits at the top; later items step
        // downward toward the track, so reading top-to-bottom follows the
        // same left-to-right chronological order as the tasks themselves.
        var labelTop = item.lane * LANE_HEIGHT;
        var labelLeft = Math.min(Math.max(item.x - item.width / 2, 0), trackWidth - item.width);

        var div = document.createElement("div");
        div.className = "ext-label";
        div.style.left = labelLeft + "px";
        div.style.top = labelTop + "px";
        div.style.width = item.width + "px";
        div.textContent = item.text;
        labelLaneEl.appendChild(div);

        var lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
        lineEl.setAttribute("x1", labelLeft + item.width / 2);
        lineEl.setAttribute("y1", labelTop + LANE_HEIGHT - 3);
        lineEl.setAttribute("x2", item.barCenterX);
        lineEl.setAttribute("y2", laneAreaHeight);
        lineEl.setAttribute("class", "leader-line");
        svg.appendChild(lineEl);
      });
    }
  }

  global.GanttEngine = {
    renderChart: renderChart,
    fmtTime: fmtTime,
  };
})(window);
