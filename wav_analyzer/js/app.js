/**
 * WAV Studio Web — Main Application
 * Handles UI, file input, worker communication, and dashboard rendering.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── State ────────────────────────────────────────────────────────────────────

let worker = null;
let currentAnalysis = null;
let prevAnalysis = null;
let compareMode = false;
let compareV2File = null;

// ── Worker setup ─────────────────────────────────────────────────────────────

function createWorker() {
  if (worker) worker.terminate();
  worker = new Worker("js/worker.js");

  worker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "status":
        setStatus(msg.text);
        break;
      case "line":
        appendLog(msg.text);
        break;
      case "analysis":
        currentAnalysis = msg.data;
        break;
      case "done":
        onAnalysisDone();
        break;
      case "error":
        onAnalysisError(msg.text);
        break;
    }
  };

  worker.onerror = (err) => {
    onAnalysisError(err.message || "Worker error");
  };
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(text) {
  $("#status").textContent = text;
}

function appendLog(text) {
  const log = $("#log");
  log.textContent += text + "\n";
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  $("#log").textContent = "";
}

function setRunning(running) {
  const btns = $$(".toolbar button");
  btns.forEach(b => b.disabled = running);
  if (running) {
    $("#drop-zone").classList.add("disabled");
  } else {
    $("#drop-zone").classList.remove("disabled");
  }
}

function showView(id) {
  $$(".view").forEach(v => v.classList.remove("active"));
  $(`#${id}`).classList.add("active");

  $$(".tab-btn").forEach(t => t.classList.remove("active"));
  const tab = $(`.tab-btn[data-view="${id}"]`);
  if (tab) tab.classList.add("active");
}

// ── File handling ────────────────────────────────────────────────────────────

function handleFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".wav")) {
    setStatus("Please select a .wav file");
    return;
  }

  prevAnalysis = null;
  compareMode = false;
  compareV2File = null;
  runAnalysis(file);
}

function handleCompareFiles(file1, file2) {
  if (!file1 || !file2) return;
  compareMode = true;
  compareV2File = file2;
  prevAnalysis = null;
  setStatus("Analyzing V1...");
  runAnalysis(file1);
}

function runAnalysis(file) {
  clearLog();
  setRunning(true);
  showView("log-view");
  setStatus(`Analyzing ${file.name}...`);

  createWorker();

  const reader = new FileReader();
  reader.onload = () => {
    worker.postMessage({
      type: "analyze",
      buffer: reader.result,
      fileName: file.name,
      fileSize: file.size,
    }, [reader.result]);
  };
  reader.onerror = () => {
    onAnalysisError("Failed to read file");
  };
  reader.readAsArrayBuffer(file);
}

function onAnalysisDone() {
  if (compareMode && !prevAnalysis) {
    // Phase 1 done — store V1, analyze V2
    prevAnalysis = currentAnalysis;
    currentAnalysis = null;
    appendLog("\n--- Now analyzing V2... ---\n");
    setStatus(`Analyzing V2: ${compareV2File.name}...`);
    runAnalysis(compareV2File);
    compareMode = false; // prevent re-triggering
    return;
  }

  setRunning(false);
  setStatus(`Done — ${currentAnalysis.file}`);
  $("#btn-dashboard").disabled = false;
  $("#btn-export").disabled = false;
  $("#btn-ai").disabled = false;

  // Auto-show dashboard
  renderDashboard();
  showView("dashboard-view");
}

function onAnalysisError(text) {
  setRunning(false);
  setStatus("Error: " + text);
  appendLog("\n!! ERROR: " + text);
}

// ── Drag & drop ──────────────────────────────────────────────────────────────

function initDragDrop() {
  const zone = $("#drop-zone");

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => {
    zone.classList.remove("drag-over");
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith(".wav"));
    if (files.length >= 2) {
      handleCompareFiles(files[0], files[1]);
    } else if (files.length === 1) {
      handleFile(files[0]);
    }
  });

  // Click to open file picker
  zone.addEventListener("click", () => {
    if (zone.classList.contains("disabled")) return;
    $("#file-input").click();
  });

  $("#file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
    e.target.value = ""; // reset so same file can be picked again
  });
}

// ── Toolbar buttons ──────────────────────────────────────────────────────────

function initToolbar() {
  $("#btn-open").addEventListener("click", () => {
    $("#file-input").click();
  });

  $("#btn-compare").addEventListener("click", () => {
    $("#compare-input").click();
  });

  $("#compare-input").addEventListener("change", (e) => {
    const files = [...e.target.files];
    if (files.length >= 2) {
      handleCompareFiles(files[0], files[1]);
    } else if (files.length === 1) {
      setStatus("Select 2 files to compare (hold Ctrl/Cmd)");
    }
    e.target.value = "";
  });

  $("#btn-dashboard").addEventListener("click", () => {
    if (!currentAnalysis) return;
    renderDashboard();
    showView("dashboard-view");
  });

  $("#btn-export").addEventListener("click", () => {
    if (!currentAnalysis) return;
    exportText();
  });

  $("#btn-ai").addEventListener("click", () => {
    if (!currentAnalysis) return;
    copyAiPrompt();
  });

  // Tabs
  $$(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      showView(btn.dataset.view);
    });
  });
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportText() {
  if (!currentAnalysis) return;
  const blob = new Blob([currentAnalysis.text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = currentAnalysis.file.replace(/\.wav$/i, "_analysis.txt");
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Exported analysis text");
}

// ── AI prompt ────────────────────────────────────────────────────────────────

function buildAiPrompt() {
  const a = currentAnalysis;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const hasK = isFinite(a.lufs_k);

  const lufsNote = hasK
    ? "  - LUFS values are K-weighted per ITU-R BS.1770-4.\n  - Frequency band analysis uses cascaded 2nd-order Butterworth filters."
    : "  - LUFS values are computed WITHOUT K-weighting.\n    K-weighted LUFS will typically read ~2-3 dB higher.";

  return `================================================================
  AUDIO RENDER ANALYSIS REPORT
  Auto-generated by WAV Studio Web
  File    : ${a.file}
  Analyzed: ${now}
================================================================

CONTEXT FOR AI REVIEW
---------------------
You are an expert audio engineer reviewing a WAV render.
This report contains objective measurements computed directly
from the raw PCM data of the file listed above.

Read the metrics below and provide a professional assessment:
  - Identify any technical issues (clipping, DC offset, phase)
  - Evaluate loudness against streaming platform targets
  - Comment on dynamic range (crest factor, LRA)
  - Comment on stereo width and mono-compatibility
  - Comment on spectral balance across frequency bands
  - Note any segments where stereo correlation shifts significantly
  - Give a clear verdict: what is good, what needs fixing, and why

Measurement notes:
${lufsNote}
  - True peak uses 4x polyphase FIR oversampling.
  - LRA uses EBU R128 gating (absolute -70 LUFS, relative -20 LU,
    10th-95th percentile).

================================================================
  MEASUREMENTS
================================================================

${a.text}`;
}

function copyAiPrompt() {
  if (!currentAnalysis) return;
  const prompt = buildAiPrompt();
  navigator.clipboard.writeText(prompt).then(() => {
    setStatus("AI prompt copied to clipboard — paste into any AI chat");
    // Brief visual feedback on the button
    const btn = $("#btn-ai");
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 2000);
  }).catch(() => {
    // Fallback for older browsers / non-HTTPS
    const ta = document.createElement("textarea");
    ta.value = prompt;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    setStatus("AI prompt copied to clipboard — paste into any AI chat");
  });
}

// ── Dashboard rendering ──────────────────────────────────────────────────────

function fmtDb(v, prec = 1) {
  if (!isFinite(v)) return "-inf";
  return (v >= 0 ? "+" : "") + v.toFixed(prec);
}

function dbVal(x) {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

function badge(text, color) {
  const colors = {
    green:  { bg: "#2a6e3f", fg: "#7ddf96" },
    red:    { bg: "#8b2d2d", fg: "#f5a0a0" },
    orange: { bg: "#7a5c1f", fg: "#f0d080" },
    gray:   { bg: "#444",    fg: "#ccc" },
    blue:   { bg: "#2a5080", fg: "#8ac4ff" },
  };
  const c = colors[color] || colors.gray;
  return `<span class="badge" style="background:${c.bg};color:${c.fg}">${escHtml(text)}</span>`;
}

function escHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function deltaText(newV, oldV, unit = "", lowerIsBetter = true, prec = 1) {
  if (!isFinite(newV) || !isFinite(oldV)) return "";
  const d = newV - oldV;
  if (Math.abs(d) < 0.05) return '<span class="delta neutral">~ unchanged</span>';
  const arrow = d < 0 ? "&#9660;" : "&#9650;";
  const better = (d < 0) === lowerIsBetter;
  const cls = better ? "good" : "bad";
  return `<span class="delta ${cls}">${arrow} from ${fmtDb(oldV, prec)}${unit}</span>`;
}

function renderDashboard() {
  const v2 = currentAnalysis;
  const v1 = prevAnalysis;
  const compare = v1 !== null;
  const container = $("#dashboard-content");
  const track = v2.file.replace(/\.wav$/i, "");

  // LUFS display
  const hasK = isFinite(v2.lufs_k);
  const lufsDisplay = hasK ? v2.lufs_k : (isFinite(v2.lufs_i) ? v2.lufs_i + 2.5 : v2.lufs_i);
  const lufsLabel = hasK ? "Integrated LUFS (K-weighted)" : "Integrated LUFS (est. K-wtd)";

  let lufsDisplay1;
  if (compare) {
    const hasK1 = isFinite(v1.lufs_k);
    lufsDisplay1 = hasK1 ? v1.lufs_k : (isFinite(v1.lufs_i) ? v1.lufs_i + 2.5 : v1.lufs_i);
  }

  // Card builder
  function card(label, value, unit, delta = "") {
    return `<div class="card">
      <div class="card-label">${label}</div>
      <div class="card-value">${value}<span class="card-unit">${unit}</span></div>
      ${delta ? `<div class="card-delta">${delta}</div>` : ""}
    </div>`;
  }

  // LUFS card
  let dLufs = "";
  if (compare && isFinite(lufsDisplay1)) {
    const diff = lufsDisplay - lufsDisplay1;
    if (Math.abs(diff) < 0.3) {
      dLufs = '<span class="delta neutral">~ unchanged</span>';
    } else {
      const target = -14;
      const better = Math.abs(lufsDisplay - target) < Math.abs(lufsDisplay1 - target);
      const cls = better ? "good" : "bad";
      const lbl = better && Math.abs(diff) > 3 ? "much better" : (better ? "better" : "louder");
      dLufs = `<span class="delta ${cls}">from ${fmtDb(lufsDisplay1)} - ${lbl}</span>`;
    }
  }

  const rmsDb = dbVal(v2.rms_avg);
  const dRms = compare ? deltaText(rmsDb, dbVal(v1.rms_avg), " dBFS") : "";
  const tpDb = dbVal(v2.tp);
  let dTp = "";
  if (compare) {
    const tp1 = dbVal(v1.tp);
    if (isFinite(tp1)) {
      const safeNow = tpDb < -1, safeOld = tp1 < -1;
      if (safeNow && !safeOld) dTp = `<span class="delta good">from ${fmtDb(tp1)} dBTP - fixed</span>`;
      else dTp = deltaText(tpDb, tp1, " dBTP");
    }
  }

  let dLra = "";
  if (compare) {
    if (Math.abs(v2.lra - v1.lra) < 0.3) dLra = '<span class="delta neutral">~ unchanged</span>';
    else dLra = deltaText(v2.lra, v1.lra, " LU", false);
  }

  const cardsHtml = `<div class="cards">
    ${card(lufsLabel, fmtDb(lufsDisplay), "", dLufs)}
    ${card("RMS average", fmtDb(rmsDb), " dBFS", dRms)}
    ${card("True peak (max)", fmtDb(tpDb), " dBTP", dTp)}
    ${card("LRA", v2.lra.toFixed(1), " LU", dLra)}
  </div>`;

  // Status checks
  const clipBadge = v2.clips === 0 ? badge("Clean", "green") : badge(`${v2.clips} clips`, "red");
  const tpVal = dbVal(v2.tp);
  const tpBadge = tpVal < -1 ? badge(`${fmtDb(tpVal)} dBTP`, "green") :
                  tpVal < 0  ? badge(`${fmtDb(tpVal)} dBTP`, "orange") :
                               badge(`${fmtDb(tpVal)} dBTP !!`, "red");
  const dcMax = Math.max(Math.abs(v2.dc_l), Math.abs(v2.dc_r || 0));
  const dcDbV = dbVal(dcMax);
  const dcBadge = dcMax < 0.0005 ? badge("OK", "green") :
                  dcMax < 0.005  ? badge(`Present (~${fmtDb(dcDbV, 0)} dBFS)`, "orange") :
                                   badge(`!! ${fmtDb(dcDbV, 0)} dBFS`, "red");

  let corrBadge, widthBadge;
  if (v2.corr !== null) {
    corrBadge = badge(`${v2.corr >= 0 ? "+" : ""}${v2.corr.toFixed(2)}`, v2.corr > 0.4 ? "blue" : "orange");
    let w;
    if (v2.corr > 0.95) w = "Near-mono";
    else if (v2.corr > 0.7) w = "Narrow";
    else if (v2.corr > 0.4) w = "Moderate";
    else if (v2.corr > 0.0) w = "Wide";
    else w = "Out-of-phase";
    const wc = (w === "Narrow" || w === "Near-mono") ? "orange" :
               (w === "Moderate" || w === "Wide") ? "green" : "red";
    widthBadge = badge(w, wc);
  } else {
    corrBadge = badge("N/A (mono)", "gray");
    widthBadge = badge("Mono", "gray");
  }

  // Streaming targets
  const lufsRef = lufsDisplay;
  function streamBadge(target) {
    if (!isFinite(lufsRef)) return badge("N/A", "gray");
    const diff = lufsRef - target;
    if (diff < -1) return badge(`~${Math.abs(diff).toFixed(1)} LU quiet`, "orange");
    if (diff > 1) return badge(`~${diff.toFixed(1)} LU hot`, "red");
    return badge("~On target", "green");
  }

  const lufsType = hasK ? "K-weighted" : "est. K-weighted";

  // Band analysis
  const bd = v2.band_data || {};
  let bandSection = "";
  const bandNames = ["Sub", "Bass", "Low-mid", "Mid", "Hi-mid", "Air"];
  if (Object.keys(bd).length > 0) {
    let bandRows = "";
    for (const name of bandNames) {
      if (!bd[name]) continue;
      const b = bd[name];
      bandRows += `<tr><td>${name}</td><td class="r">${fmtDb(dbVal(b.rms_avg), 0)} dBFS</td><td class="r">${b.crest.toFixed(0)} dB</td></tr>`;
    }
    bandSection = `<div class="panel">
      <div class="panel-header">FREQUENCY BANDS</div>
      <table class="checks">
        <tr><td><b>Band</b></td><td class="r"><b>RMS</b></td><td class="r"><b>Crest</b></td></tr>
        ${bandRows}
      </table>
    </div>`;
  }

  // RMS timeline
  const tl2 = v2.rms_timeline;
  const tl1 = compare ? v1.rms_timeline : [];
  const allDbVals = tl2.map(r => r[2]).filter(v => isFinite(v));
  if (compare) allDbVals.push(...tl1.map(r => r[2]).filter(v => isFinite(v)));
  if (allDbVals.length === 0) allDbVals.push(-40, 0);

  let dbLo = Math.min(...allDbVals) - 2;
  let dbHi = Math.max(...allDbVals) + 2;
  if (dbHi - dbLo < 4) { const m = (dbHi + dbLo) / 2; dbLo = m - 2; dbHi = m + 2; }
  const rng = dbHi - dbLo;

  function barPct(v) { return isFinite(v) ? Math.max(1, Math.min(100, (v - dbLo) / rng * 100)) : 1; }
  function barColor(v, isOld = false) {
    if (isOld) return !isFinite(v) ? "#333" : "#7a3535";
    if (isFinite(v) && allDbVals.length && v < (allDbVals.reduce((a, b) => a + b) / allDbVals.length) - 8) return "#c89030";
    return "#4a90d9";
  }

  let barRows = "";
  const maxLen = Math.max(tl2.length, tl1.length);
  for (let idx = 0; idx < maxLen; idx++) {
    const t0 = idx < tl2.length ? tl2[idx][0] : tl1[idx][0];
    const t1 = idx < tl2.length ? tl2[idx][1] : tl1[idx][1];
    const label = `${Math.floor(t0)}-${Math.floor(t1)}s`;

    const v2db = idx < tl2.length ? tl2[idx][2] : -Infinity;
    const v1db = idx < tl1.length ? tl1[idx][2] : null;

    const v2bar = `<div class="bar" style="width:${barPct(v2db).toFixed(1)}%;background:${barColor(v2db)}"></div>`;
    const v1bar = compare && v1db !== null ?
      `<div class="bar bar-old" style="width:${barPct(v1db).toFixed(1)}%;background:${barColor(v1db, true)}"></div>` : "";

    barRows += `<div class="tl-row">
      <div class="tl-label">${label}</div>
      <div class="tl-bars">${v2bar}${v1bar}</div>
      <div class="tl-db">${isFinite(v2db) ? fmtDb(v2db) : "-inf"}</div>
    </div>`;
  }

  let legend = "";
  if (compare) {
    legend = `<div class="legend">
      <span class="leg-item"><span class="leg-box" style="background:#4a90d9"></span> V2 (current)</span>
      <span class="leg-item"><span class="leg-box" style="background:#7a3535"></span> V1 (previous)</span>
    </div>`;
  }

  const title = compare ? `V1 vs V2 - ${track}` : track;
  let topBadges = "";
  if (compare) {
    const sameDur = Math.abs(v2.duration - v1.duration) < 0.5;
    const sameFmt = v2.bits === v1.bits && v2.sr === v1.sr && v2.channels === v1.channels;
    const parts = [];
    if (sameDur) parts.push("Same duration");
    if (sameFmt) parts.push("Same format");
    if (parts.length) topBadges = badge(parts.join(" / "), "green");
  }

  const m = Math.floor(v2.duration / 60);
  const s = v2.duration % 60;
  const info = `${v2.bits}-bit / ${v2.sr} Hz / ${v2.stereo ? "Stereo" : "Mono"} / ${m}m ${s.toFixed(1)}s / ${v2.size_mb.toFixed(1)} MB`;

  const panelsCols = Object.keys(bd).length > 0 ? "1fr 1fr 1fr" : "1fr 1fr";

  container.innerHTML = `
    <div class="dash-header">
      <h2>${escHtml(title)}</h2> ${topBadges}
      <div class="file-info">${info}</div>
    </div>

    ${cardsHtml}

    <div class="panels" style="grid-template-columns:${panelsCols}">
      <div class="panel">
        <div class="panel-header">STATUS CHECKS</div>
        <table class="checks">
          <tr><td>Clipping</td><td class="r">${clipBadge}</td></tr>
          <tr><td>True peak</td><td class="r">${tpBadge}</td></tr>
          <tr><td>DC offset</td><td class="r">${dcBadge}</td></tr>
          <tr><td>L/R correlation</td><td class="r">${corrBadge}</td></tr>
          <tr><td>Stereo width</td><td class="r">${widthBadge}</td></tr>
        </table>
      </div>
      <div class="panel">
        <div class="panel-header">STREAMING TARGETS (${lufsType.toUpperCase()})</div>
        <p class="muted">Your ${lufsType} LUFS: ${fmtDb(lufsRef)}</p>
        <table class="checks">
          <tr><td>Spotify / YouTube (-14)</td><td class="r">${streamBadge(-14)}</td></tr>
          <tr><td>Apple Music (-16)</td><td class="r">${streamBadge(-16)}</td></tr>
        </table>
      </div>
      ${bandSection}
    </div>

    <div class="timeline">
      <div class="tl-title">RMS OVER TIME${compare ? " - V1 VS V2" : ""}</div>
      ${legend}
      ${barRows}
    </div>

    <div class="footer">Generated by WAV Studio Web</div>
  `;
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initDragDrop();
  initToolbar();
});
