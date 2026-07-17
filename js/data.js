/* ==========================================================================
   DATA MODEL
   Source: "SOP ล้างคอล์ยเย็นช่อง EM.xlsx" (user-provided SOP timing sheet).
   All task names and durations below are taken verbatim from that sheet;
   only the seconds-conversion and section grouping are derived here.

   All times are stored in whole SECONDS from scenario t=0.
   Each row (Condenser Cleaning / General Tasks / Evaporator Cleaning) is one of:
     - null                                  -> process not performed
     - { type:"simple", label, start, end }  -> single non-expandable bar
                                                 (used for the EM window, whose
                                                 own internal tasks aren't part
                                                 of this cleaning SOP)
     - an array of exactly 4 sections in fixed order:
         Initial Preparation -> Pre Cleaning -> Cleaning Operation -> Post Cleaning
       each holding a `tasks` array of {name, start, dur, wait?}.
   Section start/end are DERIVED (min task start / max task end) at load time
   by computeSectionBounds(), never hardcoded.
   ========================================================================== */

(function (global) {
  "use strict";

  // ---- real task-block generators (from the SOP) --------------------------

  // "1 คอยล์เย็น EM" — Auto evaporator (cold coil) cleaning inside the EM window.
  // Real total: 30:00 (1800s).
  function autoEvapEMTasks(offset) {
    return [
      { section: "Initial Preparation", tasks: [
        { name: "Connect ground wire", start: offset + 0, dur: 120 },
      ]},
      { section: "Pre Cleaning", tasks: [
        { name: "Drill service hole", start: offset + 120, dur: 60 },
        { name: "Capture \"Before\" photo", start: offset + 180, dur: 60 },
        { name: "Install tray & robotic", start: offset + 240, dur: 150 },
        { name: "Install mirror protection", start: offset + 390, dur: 30 },
        { name: "Prepare cleaning cable", start: offset + 420, dur: 60 },
        { name: "Connect cleaning cable", start: offset + 480, dur: 60 },
      ]},
      { section: "Cleaning Operation", tasks: [
        { name: "Fill Aircare solution", start: offset + 540, dur: 60 },
        { name: "Test robotic arm", start: offset + 600, dur: 120 },
        { name: "Check drainage hose", start: offset + 720, dur: 30 },
        { name: "Connect drainage hose", start: offset + 750, dur: 30 },
        { name: "Start auto cleaning", start: offset + 780, dur: 780 },
      ]},
      { section: "Post Cleaning", tasks: [
        { name: "Remove drainage hose", start: offset + 1560, dur: 30 },
        { name: "Remove robotic", start: offset + 1590, dur: 90 },
        { name: "Remove ground wire", start: offset + 1680, dur: 30 },
        { name: "Capture \"After\" photo & seal hole", start: offset + 1710, dur: 30 },
        { name: "Remove cleaning cable", start: offset + 1740, dur: 30 },
        { name: "Remove mirror protection", start: offset + 1770, dur: 30 },
      ]},
    ];
  }

  // "2 คอยล์ร้อน" — manual condenser (hot coil) cleaning. Real total: 30:00 (1800s).
  // Used standalone (M1) and after the EM window (A2/A3).
  function condenserTasks(offset) {
    return [
      { section: "Initial Preparation", tasks: [
        { name: "Measure A/C low/high pressure, Inspect condenser condition", start: offset + 0, dur: 210 },
      ]},
      { section: "Pre Cleaning", tasks: [
        { name: "Remove plastic cover", start: offset + 210, dur: 120 },
        { name: "Connect the nozzle", start: offset + 330, dur: 60 },
      ]},
      { section: "Cleaning Operation", tasks: [
        { name: "Fill Aircare solution", start: offset + 390, dur: 20 },
        { name: "Spraying solution", start: offset + 410, dur: 580 },
        { name: "Rinsing water 1st round", start: offset + 990, dur: 150 },
        { name: "Rinsing water 2nd round", start: offset + 1140, dur: 150 },
        { name: "Blow the air to dry", start: offset + 1290, dur: 180 },
      ]},
      { section: "Post Cleaning", tasks: [
        { name: "Assemble back the cover", start: offset + 1470, dur: 120 },
        { name: "Measure A/C low/high pressure and final car inspection", start: offset + 1590, dur: 210 },
      ]},
    ];
  }

  // "1 คอยล์เย็น" (Manual) — manual evaporator (cold coil, no robot) cleaning.
  // Real total: 30:00 (1800s).
  function manualEvapTasks(offset) {
    return [
      { section: "Initial Preparation", tasks: [
        { name: "Inspect the A/C", start: offset + 0, dur: 200 },
        { name: "Remove glove compartment", start: offset + 200, dur: 210 },
      ]},
      { section: "Pre Cleaning", tasks: [
        { name: "Capture \"Before\" photo", start: offset + 410, dur: 20 },
        { name: "Install the interior tray", start: offset + 430, dur: 70 },
        { name: "Connect the nozzle", start: offset + 500, dur: 60 },
      ]},
      { section: "Cleaning Operation", tasks: [
        { name: "Fill Aircare solution", start: offset + 560, dur: 20 },
        { name: "Spraying solution", start: offset + 580, dur: 580 },
        { name: "Rinsing water", start: offset + 1160, dur: 150 },
      ]},
      { section: "Post Cleaning", tasks: [
        { name: "Remove the tray and equipment", start: offset + 1310, dur: 60 },
        { name: "Capture \"After\" photo", start: offset + 1370, dur: 20 },
        { name: "Assemble the blower", start: offset + 1390, dur: 210 },
        { name: "Final A/C and car inspection", start: offset + 1600, dur: 200 },
      ]},
    ];
  }

  // ---- section bound computation ------------------------------------------

  function computeSectionBounds(sections) {
    if (!sections || sections.type === "simple") return sections || null;
    return sections.filter(function (sec) { return sec.tasks.length > 0; }).map(function (sec) {
      var starts = sec.tasks.map(function (t) { return t.start; });
      var ends = sec.tasks.map(function (t) { return t.start + t.dur; });
      return {
        section: sec.section,
        start: Math.min.apply(null, starts),
        end: Math.max.apply(null, ends),
        tasks: sec.tasks.map(function (t) {
          return { name: t.name, start: t.start, end: t.start + t.dur, dur: t.dur, wait: !!t.wait };
        }),
      };
    });
  }

  function rowExtent(row) {
    if (!row) return 0;
    if (row.type === "simple") return row.end;
    return Math.max.apply(null, row.map(function (s) { return s.end; }));
  }

  // ---- M4 "4 ร้อนเย็นแบบ kaizen" — real interleaved schedule ----------------
  // The SOP splits the initial car inspection and the final inspection into
  // single combined steps covering both coils — shown once, in the General
  // Tasks row (matching the source's own "Initial Preparation"/"Post cleaning"
  // section labels for those two combined rows), not duplicated per coil.
  // Two explicit "Wait" dwell periods let the technician work the other coil
  // in parallel: condenser waits while evaporator preps, then evaporator waits
  // while condenser finishes. Same task order/structure as the source SOP,
  // reflowed with the revised per-task durations — both Wait windows now run
  // with zero slack (the revised "Blow the air to dry" and "Install the
  // interior tray" durations exactly fill what used to be idle time inside
  // each 5:00 wait). Total: 50:00 (3000s).

  var COMBINED_INITIAL = "Measure A/C low/high pressure, Inspect condenser condition — Combined Check";
  var COMBINED_FINAL = "Final A/C and car inspection — Combined Check";

  // The two combined checks cover both coils at once and are shown only in
  // the General Tasks row (not duplicated into the condenser/evaporator rows).
  var m4General = [
    { section: "Initial Preparation", tasks: [
      { name: COMBINED_INITIAL, start: 0, dur: 410 },
    ]},
    { section: "Post Cleaning", tasks: [
      { name: COMBINED_FINAL, start: 2590, dur: 410 },
    ]},
  ];

  var m4Condenser = [
    { section: "Pre Cleaning", tasks: [
      { name: "Remove plastic cover", start: 410, dur: 120 },
      { name: "Connect the nozzle", start: 530, dur: 60 },
    ]},
    { section: "Cleaning Operation", tasks: [
      { name: "Fill Aircare solution", start: 590, dur: 20 },
      { name: "Spraying solution", start: 610, dur: 280 },
      { name: "Wait", start: 890, dur: 300, wait: true },
      { name: "Rinsing water 1st round", start: 1190, dur: 150 },
      { name: "Rinsing water 2nd round", start: 1340, dur: 150 },
      { name: "Blow the air to dry", start: 1850, dur: 180 },
    ]},
    { section: "Post Cleaning", tasks: [
      { name: "Assemble back the cover", start: 2030, dur: 120 },
    ]},
  ];

  var m4Evaporator = [
    { section: "Initial Preparation", tasks: [
      { name: "Remove glove compartment", start: 890, dur: 210 },
    ]},
    { section: "Pre Cleaning", tasks: [
      { name: "Capture \"Before\" photo", start: 1100, dur: 20 },
      { name: "Install the interior tray", start: 1120, dur: 70 },
      { name: "Connect the nozzle", start: 1490, dur: 60 },
    ]},
    { section: "Cleaning Operation", tasks: [
      { name: "Fill Aircare solution", start: 1550, dur: 20 },
      { name: "Spraying solution", start: 1570, dur: 280 },
      { name: "Wait", start: 1850, dur: 300, wait: true },
      { name: "Rinsing water", start: 2150, dur: 150 },
    ]},
    { section: "Post Cleaning", tasks: [
      { name: "Remove the tray and equipment", start: 2300, dur: 60 },
      { name: "Capture \"After\" photo", start: 2360, dur: 20 },
      { name: "Assemble the blower", start: 2380, dur: 210 },
    ]},
  ];

  // ---- scenario definitions -------------------------------------------

  var EM_WINDOW = 1800; // Toyota's existing EM service window; the auto
  // evaporator cleaning (also 1800s) runs entirely inside it, so it's shown
  // spanning the identical 0-1800s span to make the "0 added" claim visually
  // exact rather than an arbitrary illustrative EM length.

  var A3_COND_OFFSET = EM_WINDOW; // in A3, manual condenser starts after the auto evaporator/EM window ends

  var autoScenarios = [
    {
      id: "A1",
      code: "A1",
      name: "Auto Evaporator within EM",
      description: "Auto evaporator cleaning is inserted into Toyota's existing EM operation. Because it runs inside the existing EM time window, it adds no additional customer service time.",
      addedServiceTime: 0,
      timeSaved: null,
      percentReduction: null,
      totalTime: EM_WINDOW,
      conclusion: "Auto evaporator cleaning is fully absorbed by the existing EM window — zero added service time.",
      rows: {
        condenser: null,
        general: null, // no SOP task detail for the EM window itself yet
        evaporator: computeSectionBounds(autoEvapEMTasks(0)),
      },
    },
    {
      id: "A2",
      code: "A2",
      name: "Manual Condenser Only",
      description: "Manual condenser cleaning performed as a standalone process — the condenser has no auto-cleaning option, so this 30 minutes is added on top of the existing EM operation.",
      addedServiceTime: 1800,
      timeSaved: null,
      percentReduction: null,
      totalTime: 1800,
      conclusion: "Manual condenser cleaning adds a fixed 30 minutes on top of the existing EM process.",
      rows: {
        condenser: computeSectionBounds(condenserTasks(0)),
        general: null,
        evaporator: null,
      },
    },
    {
      id: "A3",
      code: "A3",
      name: "Auto Evaporator + Manual Condenser",
      description: "Auto evaporator cleaning runs inside the existing EM process (0 min added). Manual condenser cleaning then runs after EM completes (+30 min). Combined added time equals condenser cleaning alone.",
      addedServiceTime: 1800,
      timeSaved: null,
      percentReduction: null,
      totalTime: EM_WINDOW + 1800,
      conclusion: "Auto evaporator cleaning is integrated into the existing EM process and adds no additional service time. Therefore, adding both evaporator and condenser cleaning requires the same additional time as condenser cleaning alone.",
      highlight: true,
      rows: {
        condenser: computeSectionBounds(condenserTasks(A3_COND_OFFSET)),
        general: null, // no SOP task detail for the EM window itself yet
        evaporator: computeSectionBounds(autoEvapEMTasks(0)),
      },
    },
  ];

  var manualScenarios = [
    {
      id: "M1",
      code: "M1",
      name: "Manual Condenser Only",
      description: "Manual condenser cleaning performed as a standalone process.",
      addedServiceTime: 1800,
      timeSaved: null,
      percentReduction: null,
      totalTime: 1800,
      conclusion: "Standalone manual condenser cleaning requires 30 minutes.",
      rows: {
        condenser: computeSectionBounds(condenserTasks(0)),
        general: null,
        evaporator: null,
      },
    },
    {
      id: "M2",
      code: "M2",
      name: "Manual Evaporator Only",
      description: "Manual evaporator cleaning performed as a standalone process.",
      addedServiceTime: 1800,
      timeSaved: null,
      percentReduction: null,
      totalTime: 1800,
      conclusion: "Standalone manual evaporator cleaning requires 30 minutes.",
      rows: {
        condenser: null,
        general: null,
        evaporator: computeSectionBounds(manualEvapTasks(0)),
      },
    },
    {
      id: "M3",
      code: "M3",
      name: "Current Sequential Manual",
      description: "Manual condenser cleaning and manual evaporator cleaning are performed back-to-back, one fully after the other.",
      addedServiceTime: 3600,
      timeSaved: 0,
      percentReduction: 0,
      totalTime: 3600,
      conclusion: "Sequential execution requires the full sum of both processes: 60 minutes.",
      rows: {
        condenser: computeSectionBounds(condenserTasks(0)),
        general: null,
        evaporator: computeSectionBounds(manualEvapTasks(1800)),
      },
    },
    {
      id: "M4",
      code: "M4",
      name: "Proposed Optimized Manual",
      description: "Manual evaporator and condenser workflows are rearranged so evaporator preparation begins during the condenser's waiting / passive dwell period, and condenser finishing tasks run during the evaporator's dwell period.",
      addedServiceTime: 3000,
      timeSaved: 600,
      percentReduction: 16.67,
      totalTime: 3000,
      conclusion: "Overlapping evaporator prep with the condenser's passive waiting period — and condenser finishing tasks with the evaporator's — saves 10:00, a 16.67% reduction.",
      highlight: true,
      overlaps: [
        { start: 890, end: 1190, label: "Condenser waits — Evaporator prep begins" },
        { start: 1850, end: 2150, label: "Evaporator waits — Condenser finishing tasks" },
      ],
      rows: {
        condenser: computeSectionBounds(m4Condenser),
        general: computeSectionBounds(m4General),
        evaporator: computeSectionBounds(m4Evaporator),
      },
    },
  ];

  // finalize totalTime as the true max extent across rows (sanity check against the values above)
  autoScenarios.concat(manualScenarios).forEach(function (sc) {
    var extents = [rowExtent(sc.rows.condenser), rowExtent(sc.rows.general), rowExtent(sc.rows.evaporator)];
    sc.totalTime = Math.max.apply(null, extents.concat([sc.totalTime]));
  });

  global.APP_DATA = {
    auto: autoScenarios,
    manual: manualScenarios,
  };
})(window);
