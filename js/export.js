/* ==========================================================================
   EXPORT ENGINE
   Renders slides at their true 1920x1080 size (never the scaled-down
   presentation viewport) via an offscreen clone, then captures with
   html2canvas. PDF export stitches one page per slide with jsPDF.

   html2canvas / jsPDF are loaded lazily from CDN on first export use (not
   at page load) so the app itself never depends on network access.
   ========================================================================== */

(function (global) {
  "use strict";

  var HTML2CANVAS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
  var JSPDF_SRC = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
  var LOAD_TIMEOUT_MS = 15000;

  var libPromises = {};

  function loadScript(src) {
    if (libPromises[src]) return libPromises[src];
    libPromises[src] = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = src;
      var timer = setTimeout(function () {
        reject(new Error("Timed out loading " + src + " — check your internet connection."));
      }, LOAD_TIMEOUT_MS);
      script.onload = function () { clearTimeout(timer); resolve(); };
      script.onerror = function () { clearTimeout(timer); reject(new Error("Failed to load " + src + " — check your internet connection.")); };
      document.head.appendChild(script);
    });
    return libPromises[src];
  }

  function ensureHtml2Canvas() {
    if (global.html2canvas) return Promise.resolve();
    return loadScript(HTML2CANVAS_SRC);
  }

  function ensureJsPDF() {
    if (global.jspdf && global.jspdf.jsPDF) return Promise.resolve();
    return loadScript(JSPDF_SRC);
  }

  function getStage() {
    var stage = document.getElementById("export-stage");
    if (!stage) {
      stage = document.createElement("div");
      stage.id = "export-stage";
      document.body.appendChild(stage);
    }
    return stage;
  }

  function captureSlide(slideEl) {
    return ensureHtml2Canvas().then(function () {
      var stage = getStage();
      stage.innerHTML = "";
      var clone = slideEl.cloneNode(true);
      clone.style.transform = "none";
      clone.style.width = "1920px";
      clone.style.height = "1080px";
      stage.appendChild(clone);

      return global.html2canvas(clone, {
        width: 1920,
        height: 1080,
        windowWidth: 1920,
        windowHeight: 1080,
        scale: 1,
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
      }).then(function (canvas) {
        stage.innerHTML = "";
        return canvas;
      });
    });
  }

  function downloadCanvas(canvas, filename) {
    var link = document.createElement("a");
    link.download = filename + ".png";
    link.href = canvas.toDataURL("image/png", 1.0);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function reportError(err) {
    console.error(err);
    alert(err && err.message ? err.message : "Export failed. Check your internet connection and try again.");
  }

  function exportSlidePNG(slideEl, filename) {
    return captureSlide(slideEl).then(function (canvas) {
      downloadCanvas(canvas, filename || "slide");
    }).catch(reportError);
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function exportAllSlidesPNG(slides) {
    var chain = Promise.resolve();
    slides.forEach(function (slide, i) {
      chain = chain.then(function () {
        return captureSlide(slide).then(function (canvas) {
          downloadCanvas(canvas, "slide-" + String(i + 1).padStart(2, "0"));
          return delay(350);
        });
      });
    });
    return chain.catch(reportError);
  }

  function exportSlidesPDF(slides) {
    return ensureJsPDF().then(function () {
      var jsPDFCtor = global.jspdf.jsPDF;
      var doc = new jsPDFCtor({ orientation: "landscape", unit: "px", format: [1920, 1080], compress: true });

      var chain = Promise.resolve();
      slides.forEach(function (slide, i) {
        chain = chain.then(function () {
          return captureSlide(slide).then(function (canvas) {
            var img = canvas.toDataURL("image/jpeg", 0.95);
            if (i > 0) doc.addPage([1920, 1080], "landscape");
            doc.addImage(img, "JPEG", 0, 0, 1920, 1080);
          });
        });
      });
      return chain.then(function () {
        doc.save("workflow-presentation.pdf");
      });
    }).catch(reportError);
  }

  global.ExportEngine = {
    exportSlidePNG: exportSlidePNG,
    exportAllSlidesPNG: exportAllSlidesPNG,
    exportSlidesPDF: exportSlidesPDF,
  };
})(window);
