/**
 * HTML dashboard generator.
 * Produces a single self-contained HTML string with inline CSS/JS + Plotly charts.
 */

const C = {
  bg:       '#1a1a2e', card:    '#16213e', text:    '#e0e0e0',
  muted:    '#8892a0', accent:  '#e67e22', accent2: '#f39c12',
  accent3:  '#d35400', border:  '#2a3a5e', green:   '#27ae60',
  red:      '#e74c3c', blue:    '#3498db', purple:  '#9b59b6',
  cyan:     '#00cec9', pink:    '#fd79a8',
};

const CHART_COLORS = [
  '#e67e22','#3498db','#27ae60','#e74c3c','#9b59b6',
  '#f39c12','#1abc9c','#fd79a8','#00cec9','#d35400',
  '#2ecc71','#e84393','#0984e3','#6c5ce7','#fdcb6e',
];

const PLOT_BASE = {
  paper_bgcolor: C.card, plot_bgcolor: C.card,
  font: { color: C.text, family: "'Inter','Segoe UI',sans-serif" },
  xaxis: { gridcolor: C.border, zerolinecolor: C.border },
  yaxis: { gridcolor: C.border, zerolinecolor: C.border },
  margin: { l: 50, r: 30, t: 40, b: 40 },
};

let _cc = 0;

// ── Primitives ──────────────────────────────────────────────────────────────

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function attrJson(obj) {
  return esc(JSON.stringify(obj));
}

export function plotlyChart(id, traces, layout = {}, height = 350) {
  _cc++;
  const uid = `ch-${id}-${_cc}`;
  const merged = { ...PLOT_BASE, height };
  Object.assign(merged, layout);
  if (layout.xaxis) merged.xaxis = { ...PLOT_BASE.xaxis, ...layout.xaxis };
  if (layout.yaxis) merged.yaxis = { ...PLOT_BASE.yaxis, ...layout.yaxis };
  return `<div id="${uid}" class="chart-container deferred-chart" data-traces="${attrJson(traces)}" data-layout="${attrJson(merged)}"></div>`;
}

export function statCard(label, value, subtitle = '', color = C.accent) {
  const sub = subtitle ? `<div class="stat-sub" title="${esc(subtitle)}">${esc(subtitle)}</div>` : '';
  return `<div class="stat-card">
  <div class="stat-value" style="color:${color}">${esc(value)}</div>
  <div class="stat-label">${esc(label)}</div>${sub}
</div>`;
}

export function section(title, content, id = '', collapsed = false) {
  const sid = id ? ` id="${id}"` : '';
  const cls = collapsed ? ' collapsed' : '';
  return `<div class="section${cls}"${sid}>
  <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
    <h2>${esc(title)}</h2><span class="toggle-icon">▼</span>
  </div>
  <div class="section-body">${content}</div>
</div>`;
}

// ── Per-project sections ─────────────────────────────────────────────────────

export function renderOverview(s) {
  const cards = [
    statCard('Project',       s.projectName),
    statCard('Reaper Version',s.reaperVersion, s.platform),
    statCard('Last Saved',    s.lastSaved),
    statCard('Tempo',         `${s.tempo} BPM`, s.timeSignature),
    statCard('Sample Rate',   `${s.sampleRate.toLocaleString()} Hz`),
    statCard('Duration',      s.durationFormatted, `${s.estimatedDuration.toFixed(1)}s`),
    statCard('Rendered',      s.wasRendered ? 'Yes' : 'No', '', s.wasRendered ? C.green : C.red),
    statCard('Master Volume', `${s.masterVolumeDb.toFixed(1)} dB`),
  ];
  if (s.markerCount > 0)
    cards.push(statCard('Markers', String(s.markerCount), s.markers.map(m=>m.name).join(', ')));
  return section('Overview', `<div class="stat-grid">${cards.join('')}</div>`, 'overview');
}

export function renderTracks(s) {
  const mutedSub = s.mutedTrackNames.join(', ');
  const cards = [
    statCard('Total Tracks',    String(s.totalTracks)),
    statCard('Folder/Bus',      String(s.folderTracks)),
    statCard('Leaf Tracks',     String(s.leafTracks)),
    statCard('Muted Tracks',    String(s.mutedTracks),    mutedSub, s.mutedTracks ? C.red : C.accent),
    statCard('Max Depth',       String(s.maxNestingDepth)),
    statCard('Avg FX / Track',  s.avgFxPerTrack.toFixed(1)),
  ];
  return section('Track Statistics', `<div class="stat-grid">${cards.join('')}</div>`, 'tracks');
}

export function renderPlugins(s) {
  const cards = [
    statCard('Total Instances', String(s.totalPluginInstances)),
    statCard('Unique Plugins',  String(s.uniquePlugins)),
    statCard('Bypassed FX',     String(s.bypassedFxCount), '', s.bypassedFxCount ? C.red : C.accent),
    statCard('Diversity Score', s.pluginDiversity.toFixed(2), 'unique / total'),
  ];
  let html = `<div class="stat-grid">${cards.join('')}</div>`;
  if (!s.totalPluginInstances) {
    html += `<p class="empty-message">No plugins found.</p>`;
    return section('FX / Plugin Analysis', html, 'plugins');
  }

  // Top plugins bar
  const topN = Object.entries(s.pluginCounts).slice(0, 15);
  if (topN.length) {
    const shortName = n => {
      let d = n.replace(/^(VST3i|VSTi|VST3|VST|JS):\s*/i, '');
      if (d.length > 32) d = d.slice(0, 29) + '…';
      return d;
    };
    const names  = topN.map(([n]) => shortName(n)).reverse();
    const counts = topN.map(([,v]) => v).reverse();
    html += plotlyChart('plugins', [{
      type: 'bar', x: counts, y: names, orientation: 'h',
      marker: { color: C.accent },
    }], { title: 'Top Plugins by Usage', xaxis: { title: 'Instances' },
          margin: { l: 200, r: 30, t: 40, b: 40 } },
    Math.max(250, names.length * 28 + 80));
  }

  // Vendor + type pies
  let row = '<div class="chart-row">';
  if (Object.keys(s.vendorCounts).length) {
    const vendors = Object.keys(s.vendorCounts).slice(0, 10);
    row += plotlyChart('vendors', [{ type: 'pie', labels: vendors,
      values: vendors.map(v => s.vendorCounts[v]),
      marker: { colors: CHART_COLORS }, hole: 0.4, textfont: { color: '#fff' },
    }], { title: 'Plugin Vendors' }, 320);
  }
  if (Object.keys(s.typeCounts).length) {
    const types = Object.keys(s.typeCounts);
    row += plotlyChart('fxtypes', [{ type: 'pie', labels: types,
      values: types.map(t => s.typeCounts[t]),
      marker: { colors: [C.accent, C.blue, C.green] }, hole: 0.4, textfont: { color: '#fff' },
    }], { title: 'Plugin Types' }, 320);
  }
  row += '</div>';
  html += row;

  if (s.pluginList.length) {
    const rows = s.pluginList.map(p => `<li>${esc(p)}</li>`).join('');
    html += `<details class="detail-block"><summary>Full Plugin List (${s.uniquePlugins})</summary>
      <ul>${rows}</ul></details>`;
  }
  return section('FX / Plugin Analysis', html, 'plugins');
}

export function renderItems(s) {
  const cards = [
    statCard('Total Items',   String(s.totalItems)),
    statCard('MIDI Items',    String(s.midiItems),    '', C.cyan),
    statCard('Audio Items',   String(s.audioItems),   '', C.blue),
    statCard('Muted Items',   String(s.mutedItems),   '', s.mutedItems ? C.red : C.accent),
    statCard('Avg Length',    `${s.avgItemLength.toFixed(1)}s`),
    statCard('Longest',       `${s.longestItem.toFixed(1)}s`,  s.longestItemName),
    statCard('Shortest',      `${s.shortestItem.toFixed(1)}s`, s.shortestItemName),
  ];
  let html = `<div class="stat-grid">${cards.join('')}</div>`;
  if (!s.totalItems) {
    html += `<p class="empty-message">No items found.</p>`;
    return section('Arrangement / Items', html, 'items');
  }

  let row = '<div class="chart-row">';
  const labels = [], values = [], colors = [];
  if (s.midiItems)  { labels.push('MIDI');  values.push(s.midiItems);  colors.push(C.cyan); }
  if (s.audioItems) { labels.push('Audio'); values.push(s.audioItems); colors.push(C.blue); }
  const other = s.totalItems - s.midiItems - s.audioItems;
  if (other > 0)    { labels.push('Other'); values.push(other);        colors.push(C.muted); }
  if (labels.length)
    row += plotlyChart('item-types', [{ type: 'pie', labels, values,
      marker: { colors }, hole: 0.4, textfont: { color: '#fff' },
    }], { title: 'Item Types' }, 300);
  row += '</div>';
  html += row;

  if (s.arrangementDensity.length) {
    const bins = s.arrangementDensity.map((_, i) => String(i + 1));
    html += plotlyChart('density', [{
      type: 'bar', x: bins, y: s.arrangementDensity,
      marker: { color: s.arrangementDensity,
        colorscale: [[0,'#16213e'],[0.5,C.accent],[1,C.accent2]], showscale: false },
    }], { title: 'Arrangement Density', xaxis: { title: 'Time Bin', dtick: 4 },
          yaxis: { title: 'Overlapping Items' } }, 250);
  }
  return section('Arrangement / Items', html, 'items');
}

export function renderMidi(s) {
  if (!s.totalMidiNotes && !s.midiItems) return '';
  const cards = [
    statCard('Total MIDI Notes', s.totalMidiNotes.toLocaleString()),
    statCard('Note Density',     `${s.midiNoteDensity.toFixed(0)} notes/min`),
    statCard('MIDI Duration',    `${s.totalMidiDuration.toFixed(1)}s`),
    statCard('Channels Used',    s.midiChannelsUsed.length
      ? s.midiChannelsUsed.map(c => c+1).join(', ') : 'None'),
  ];
  return section('MIDI Analysis', `<div class="stat-grid">${cards.join('')}</div>`, 'midi');
}

export function renderRouting(s) {
  let html = `<div class="stat-grid">${statCard('Total Sends', String(s.totalSends))}</div>`;
  if (s.tracksWithSends.length)
    html += `<details class="detail-block"><summary>Tracks with sends (${s.tracksWithSends.length})</summary>
      <ul>${s.tracksWithSends.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></details>`;
  return section('Routing & Sends', html, 'routing', true);
}

export function renderAutomation(s) {
  const cards = [
    statCard('Envelopes',    String(s.totalEnvelopes)),
    statCard('Auto Points',  s.totalAutomationPoints.toLocaleString()),
    statCard('Intensity',    `${s.automationIntensity.toFixed(2)} pts/s`),
  ];
  let html = `<div class="stat-grid">${cards.join('')}</div>`;
  if (s.automatedParams.length)
    html += `<details class="detail-block"><summary>Automated Params (${s.automatedParams.length})</summary>
      <ul>${s.automatedParams.sort().map(p=>`<li>${esc(p)}</li>`).join('')}</ul></details>`;
  return section('Automation', html, 'automation', true);
}

export function renderTempo(s) {
  if (!s.tempoChanges) return '';
  let html = statCard('Tempo Changes', String(s.tempoChanges));
  if (s.tempoCurve.length > 1) {
    html += plotlyChart('tempo', [{
      type: 'scatter', mode: 'lines+markers',
      x: s.tempoCurve.map(p=>p.time), y: s.tempoCurve.map(p=>p.bpm),
      line: { color: C.accent, width: 2, shape: 'hv' }, marker: { size: 6 },
    }], { title: 'Tempo Map', xaxis: { title: 'Time (s)' }, yaxis: { title: 'BPM' } }, 280);
  }
  return section('Tempo Map', html, 'tempo', true);
}

export function renderProject(s) {
  return [renderOverview, renderTracks, renderPlugins, renderItems,
          renderMidi, renderRouting, renderAutomation, renderTempo]
    .map(fn => fn(s)).filter(Boolean).join('\n');
}

// ── Comparison view ──────────────────────────────────────────────────────────

export function renderComparison(allStats, batch) {
  const parts = [];
  const { names } = batch;

  // Summary table
  const rows = batch.projects.map(p => `<tr>
    <td>${esc(p.name)}</td><td>${p.tracks}</td><td>${p.plugins}</td>
    <td>${p.items}</td><td>${p.durationFmt}</td><td>${p.tempo}</td>
    <td>${esc(p.reaperVersion)}</td><td>${esc(p.lastSaved)}</td></tr>`).join('');
  parts.push(section('Project Comparison Table',
    `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Project</th><th>Tracks</th><th>Plugins</th><th>Items</th>
        <th>Duration</th><th>BPM</th><th>Version</th><th>Last Saved</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`, 'cmp-table'));

  // Track / plugin bar charts
  parts.push(section('Track Count', plotlyChart('cmp-tracks', [{
    type: 'bar', x: names, y: batch.trackCounts, marker: { color: C.accent },
  }], { title: 'Tracks per Project' }), 'cmp-tracks'));

  parts.push(section('Plugin Count', plotlyChart('cmp-plugins', [{
    type: 'bar', x: names, y: batch.pluginCounts, marker: { color: C.blue },
  }], { title: 'Total Plugins per Project' }), 'cmp-plugins'));

  // Scatter: duration vs tracks
  parts.push(section('Complexity', plotlyChart('cmp-scatter', [{
    type: 'scatter', mode: 'markers+text',
    x: batch.durations, y: batch.trackCounts,
    text: names, textposition: 'top center',
    textfont: { size: 10, color: C.muted },
    marker: { size: 12, color: C.accent },
  }], { title: 'Duration vs Track Count',
        xaxis: { title: 'Duration (s)' }, yaxis: { title: 'Tracks' } }), 'cmp-scatter'));

  // MIDI vs Audio stacked bar
  parts.push(section('MIDI vs Audio', plotlyChart('cmp-midi-audio', [
    { type: 'bar', x: names, y: batch.midiCounts,  name: 'MIDI',  marker: { color: C.cyan } },
    { type: 'bar', x: names, y: batch.audioCounts, name: 'Audio', marker: { color: C.blue } },
  ], { title: 'MIDI vs Audio Items', barmode: 'stack' }), 'cmp-midi-audio'));

  // Global plugin leaderboard
  const gp = batch.globalPluginCounts;
  if (Object.keys(gp).length) {
    const gpNames  = Object.keys(gp);
    const gpCounts = Object.values(gp);
    const shortN   = gpNames.map(n => n.replace(/^(VST3i|VSTi|VST3|VST|JS):\s*/i,'').slice(0,35));
    parts.push(section('Global Plugin Leaderboard', plotlyChart('cmp-gp', [{
      type: 'bar', x: gpCounts.slice().reverse(), y: shortN.slice().reverse(),
      orientation: 'h', marker: { color: C.accent2 },
    }], { title: 'Top Plugins Across All Projects', margin: { l: 230, r: 30, t: 40, b: 40 } },
    Math.max(300, gpNames.length * 24 + 80)), 'cmp-gp'));
  }

  // Vendor pie
  const gv = batch.globalVendorCounts;
  if (Object.keys(gv).length)
    parts.push(section('Global Vendor Leaderboard', plotlyChart('cmp-gv', [{
      type: 'pie', labels: Object.keys(gv), values: Object.values(gv),
      marker: { colors: CHART_COLORS }, hole: 0.35, textfont: { color: '#fff' },
    }], { title: 'Top Vendors Across All Projects' }, 380), 'cmp-gv'));

  // Tempo histogram
  if (batch.tempos.length)
    parts.push(section('Tempo Distribution', plotlyChart('cmp-tempo', [{
      type: 'histogram', x: batch.tempos, marker: { color: C.accent }, nbinsx: 20,
    }], { title: 'Tempo Distribution', xaxis: { title: 'BPM' }, yaxis: { title: 'Count' } }), 'cmp-tempo'));

  // Timeline
  const sorted  = [...batch.projects].sort((a,b) => a.lastSavedRaw.localeCompare(b.lastSavedRaw));
  const tlNames = sorted.map(p => p.name);
  const tlDates = sorted.map(p => p.lastSaved);
  parts.push(section('Production Timeline', plotlyChart('cmp-timeline', [{
    type: 'scatter', mode: 'markers+text',
    x: tlDates, y: tlNames,
    text: tlNames, textposition: 'middle right',
    textfont: { size: 10, color: C.text },
    marker: { size: 12, color: C.accent, symbol: 'diamond' },
  }], { title: 'Projects by Last Save Date', showlegend: false,
        yaxis: { visible: false }, margin: { l: 30, r: 200, t: 40, b: 40 } },
  Math.max(250, sorted.length * 38)), 'cmp-timeline'));

  // Fingerprint radar
  if (batch.fingerprints.length) {
    const cats = ['Tracks','FX Count','MIDI Ratio','Automation','Density','Diversity'];
    const traces = batch.fingerprints.map((fp, i) => {
      const vals = [fp.tracks, fp.fxCount, fp.midiRatio, fp.automation, fp.density, fp.diversity];
      vals.push(vals[0]);
      return { type: 'scatterpolar', r: vals, theta: [...cats, cats[0]],
        fill: 'toself', name: fp.name, opacity: 0.6,
        line: { color: CHART_COLORS[i % CHART_COLORS.length] } };
    });
    parts.push(section('Production Fingerprints', plotlyChart('cmp-radar', traces, {
      title: 'Production Style Fingerprint',
      polar: { bgcolor: C.card,
        radialaxis: { visible: true, range: [0, 1.05], gridcolor: C.border, color: C.muted },
        angularaxis: { gridcolor: C.border, color: C.text } },
      showlegend: true, legend: { font: { size: 10 } },
    }, 500), 'cmp-radar'));
  }

  return parts.join('\n');
}

// ── Filter panel ─────────────────────────────────────────────────────────────

export function buildMetrics(allStats) {
  return allStats.map(s => ({
    name:              s.projectName,
    tracks:            s.totalTracks,
    plugins:           s.totalPluginInstances,
    items:             s.totalItems,
    duration:          Math.round(s.estimatedDuration * 10) / 10,
    tempo:             s.tempo,
    envelopes:         s.totalEnvelopes,
    automationPts:     s.totalAutomationPoints,
    sends:             s.totalSends,
    midiNotes:         s.totalMidiNotes,
    midiItems:         s.midiItems,
    audioItems:        s.audioItems,
    maxDepth:          s.maxNestingDepth,
    avgFxPerTrack:     Math.round(s.avgFxPerTrack * 100) / 100,
    mutedTracks:       s.mutedTracks,
    rendered:          s.wasRendered,
    sampleRate:        s.sampleRate,
    version:           s.reaperVersion,
    tempoChanges:      s.tempoChanges,
  }));
}

export function renderFilterPanel(allStats) {
  const metrics = buildMetrics(allStats);
  const mm = key => {
    const vals = metrics.map(m => m[key]);
    return [Math.min(...vals), Math.max(...vals)];
  };

  const rangeInput = (label, key, step = '1') => {
    const [lo, hi] = mm(key);
    return `<div class="filter-range">
  <label>${label} <span class="range-info">(${lo}–${hi})</span></label>
  <div class="range-row">
    <input type="number" data-filter="${key}" data-bound="min" value="${lo}" min="${lo}" max="${hi}" step="${step}">
    <span class="range-sep">to</span>
    <input type="number" data-filter="${key}" data-bound="max" value="${hi}" min="${lo}" max="${hi}" step="${step}">
  </div></div>`;
  };

  const srOpts  = ['<option value="">Any</option>',
    ...[...new Set(allStats.map(s=>s.sampleRate))].sort()
       .map(r=>`<option value="${r}">${r.toLocaleString()} Hz</option>`)].join('');
  const verOpts = ['<option value="">Any</option>',
    ...[...new Set(allStats.map(s=>s.reaperVersion))].sort()
       .map(v=>`<option value="${esc(v)}">${esc(v)}</option>`)].join('');

  const excludeItems = allStats.map(s =>
    `<label><input type="checkbox" class="exclude-cb" data-project="${esc(s.projectName)}" checked> ${esc(s.projectName)}</label>`
  ).join('');

  return `
<button class="filter-toggle" id="filter-toggle" onclick="toggleFilterPanel()">
  ⚙ Filters <span class="badge" id="filter-badge">0</span>
</button>
<aside class="filter-panel" id="filter-panel">
  <div class="filter-header">
    <h2>⚙ Filters</h2>
    <button class="filter-close" onclick="toggleFilterPanel()">✕</button>
  </div>
  <div class="filter-actions">
    <button class="filter-btn primary" onclick="applyFilters()">Apply</button>
    <button class="filter-btn" onclick="resetFilters()">Reset All</button>
  </div>
  <div class="filter-body">
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">Tracks <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">
        ${rangeInput('Track Count','tracks')}
        ${rangeInput('Max Nesting Depth','maxDepth')}
        ${rangeInput('Muted Tracks','mutedTracks')}
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">Plugins / FX <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">
        ${rangeInput('Total Plugins','plugins')}
        ${rangeInput('Avg FX per Track','avgFxPerTrack','0.1')}
        ${rangeInput('MIDI Items','midiItems')}
        ${rangeInput('Audio Items','audioItems')}
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">Arrangement <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">
        ${rangeInput('Total Items','items')}
        ${rangeInput('Duration (seconds)','duration')}
        ${rangeInput('Tempo (BPM)','tempo','0.1')}
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">Automation <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">
        ${rangeInput('Envelopes','envelopes')}
        ${rangeInput('Automation Points','automationPts')}
        ${rangeInput('Sends / Receives','sends')}
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">MIDI <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">${rangeInput('MIDI Notes','midiNotes')}</div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">Boolean Filters <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">
        <label class="filter-checkbox"><input type="checkbox" id="flt-has-auto"> Has Automation</label>
        <label class="filter-checkbox"><input type="checkbox" id="flt-has-midi"> Has MIDI</label>
        <label class="filter-checkbox"><input type="checkbox" id="flt-rendered"> Was Rendered</label>
        <label class="filter-checkbox"><input type="checkbox" id="flt-has-sends"> Has Sends</label>
        <label class="filter-checkbox"><input type="checkbox" id="flt-tempo-changes"> Has Tempo Changes</label>
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">Project Info <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">
        <label style="font-size:.8rem;color:${C.muted}">Sample Rate</label>
        <select class="filter-select" id="flt-sr">${srOpts}</select>
        <label style="font-size:.8rem;color:${C.muted}">Reaper Version</label>
        <select class="filter-select" id="flt-ver">${verOpts}</select>
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title" onclick="this.parentElement.classList.toggle('fg-collapsed')">Exclude Projects <span class="fg-arrow">▼</span></div>
      <div class="filter-group-body">
        <input type="text" class="exclude-search" id="exclude-search"
               placeholder="Filter list…" oninput="filterExcludeList(this.value)">
        <div style="margin-bottom:6px;font-size:.72rem">
          <a href="#" style="color:${C.accent}" onclick="toggleAllExcludes(true);return false">Select All</a>
          &nbsp;|&nbsp;
          <a href="#" style="color:${C.accent}" onclick="toggleAllExcludes(false);return false">Deselect All</a>
        </div>
        <div class="exclude-list" id="exclude-list">${excludeItems}</div>
      </div>
    </div>
  </div>
  <div class="filter-result-count" id="filter-result-count">
    Showing <strong>${allStats.length}</strong> / ${allStats.length} projects
  </div>
</aside>`;
}

// ── Master HTML generator ────────────────────────────────────────────────────

export function generateHtml(allStats, batch = null, extraHead = '') {
  _cc = 0;
  const isMulti = allStats.length > 1;
  const title = isMulti
    ? `Reaper Project Analysis — ${allStats.length} Projects`
    : (allStats[0]?.projectName ? `Reaper Project Analysis — ${allStats[0].projectName}` : 'Reaper Project Analysis');

  let bodyHtml = '';

  if (isMulti) {
    // Sidebar
    const sideItems = [
      `<div class="sidebar-item comparison active" data-name="__comparison__" onclick="switchTab('__comparison__')">📊 All Projects</div>`,
      ...allStats.map(s => {
        const safe = esc(s.projectName);
        return `<div class="sidebar-item" data-name="${safe}" onclick="switchTab('${safe}')">${safe}</div>`;
      }),
    ].join('');

    bodyHtml += `<nav class="sidebar">
  <div class="sidebar-header">
    <h1>🎛 ${esc(title)}</h1>
    <input type="text" id="sidebar-search" class="sidebar-search" placeholder="Search projects…" autocomplete="off">
    <div id="sidebar-count" class="sidebar-count">${allStats.length} projects</div>
  </div>
  <div class="sidebar-list">${sideItems}</div>
</nav>`;

    bodyHtml += renderFilterPanel(allStats);

    const metricsJson = JSON.stringify(buildMetrics(allStats));

    const cmpHtml = batch ? renderComparison(allStats, batch) : '';
    const panels = [
      `<div class="project-panel active" id="panel-__comparison__">${cmpHtml}</div>`,
      ...allStats.map(s =>
        `<div class="project-panel" id="panel-${esc(s.projectName)}">${renderProject(s)}</div>`),
    ].join('\n');

    bodyHtml += `<div class="main-content" id="main-content">
${panels}
</div>
<script>var PROJECT_METRICS = ${metricsJson};</script>`;
  } else {
    bodyHtml = `<div class="dashboard"><header>
  <h1>🎛 ${esc(title)}</h1>
  <div class="subtitle">Reaper RPP Analyzer</div>
</header>${renderProject(allStats[0])}</div>
<script>var PROJECT_METRICS = [];</script>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${extraHead}
<style>${dashboardCss()}</style>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>
</head>
<body>
${bodyHtml}
<script>${dashboardJs()}</script>
</body>
</html>`;
}

// ── CSS ──────────────────────────────────────────────────────────────────────

export function dashboardCss() {
  return `
*{margin:0;padding:0;box-sizing:border-box}
body{background:${C.bg};color:${C.text};font-family:'Inter','Segoe UI',-apple-system,sans-serif;line-height:1.6}
.dashboard{max-width:1400px;margin:0 auto;padding:24px}
header{text-align:center;padding:32px 0 24px;border-bottom:2px solid ${C.accent};margin-bottom:32px}
header h1{font-size:2rem;font-weight:700;color:${C.accent};letter-spacing:-.5px}
header .subtitle{color:${C.muted};font-size:.95rem;margin-top:6px}

/* sidebar */
.sidebar{position:fixed;top:0;left:0;width:260px;height:100vh;background:${C.card};border-right:1px solid ${C.border};display:flex;flex-direction:column;z-index:200}
.sidebar-header{padding:16px 14px 10px;border-bottom:1px solid ${C.border};flex-shrink:0}
.sidebar-header h1{font-size:1rem;font-weight:700;color:${C.accent};margin-bottom:10px}
.sidebar-search{width:100%;padding:7px 10px;background:${C.bg};border:1px solid ${C.border};border-radius:6px;color:${C.text};font-size:.82rem;outline:none}
.sidebar-search:focus{border-color:${C.accent}}
.sidebar-search::placeholder{color:${C.muted}}
.sidebar-count{font-size:.72rem;color:${C.muted};margin-top:6px}
.sidebar-list{flex:1;overflow-y:auto;padding:6px 0}
.sidebar-item{padding:6px 14px;cursor:pointer;font-size:.82rem;color:${C.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .15s,color .15s;border-left:3px solid transparent}
.sidebar-item:hover{background:${C.bg};color:${C.text}}
.sidebar-item.active{background:${C.accent}18;color:${C.accent};border-left-color:${C.accent};font-weight:600}
.sidebar-item.comparison{color:${C.accent2};font-weight:600;border-bottom:1px solid ${C.border};padding-top:8px;padding-bottom:8px;margin-bottom:2px}
.sidebar-item.comparison.active{background:${C.accent2}18;border-left-color:${C.accent2}}
.sidebar-item.hidden,.sidebar-item.filter-hidden{display:none}
.sidebar-list::-webkit-scrollbar{width:6px}
.sidebar-list::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}

/* main content */
.main-content{margin-left:260px;padding:24px 32px;max-width:calc(100% - 260px)}
.project-panel{display:none}.project-panel.active{display:block}

/* sections */
.section{margin-bottom:28px}
.section-header{display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:12px 16px;background:${C.card};border-radius:10px 10px 0 0;border:1px solid ${C.border};border-bottom:none;user-select:none}
.section-header h2{font-size:1.15rem;font-weight:600;color:${C.accent}}
.toggle-icon{color:${C.muted};transition:transform .2s;font-size:.8rem}
.section.collapsed .toggle-icon{transform:rotate(-90deg)}
.section-body{padding:20px;background:${C.card};border-radius:0 0 10px 10px;border:1px solid ${C.border};border-top:none;overflow:hidden;transition:max-height .3s ease}
.section.collapsed .section-body{max-height:0;padding:0 20px;overflow:hidden}

/* stat cards */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin-bottom:20px}
.stat-card{background:${C.bg};border:1px solid ${C.border};border-radius:10px;padding:16px;text-align:center;transition:border-color .2s}
.stat-card:hover{border-color:${C.accent}44}
.stat-value{font-size:1.5rem;font-weight:700;word-break:break-word}
.stat-label{font-size:.8rem;color:${C.muted};margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
.stat-sub{font-size:.75rem;color:${C.muted};margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* charts */
.chart-container{margin:16px 0;border-radius:8px;overflow:hidden}
.chart-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}

/* tables */
.table-wrap{overflow-x:auto}
.data-table{width:100%;border-collapse:collapse;font-size:.85rem}
.data-table th,.data-table td{padding:8px 12px;text-align:left;border-bottom:1px solid ${C.border}}
.data-table th{color:${C.accent};font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.5px}
.data-table tr:hover td{background:${C.bg}88}

/* collapsible details */
.detail-block{margin-top:14px}
.detail-block summary{cursor:pointer;color:${C.accent};font-size:.9rem;padding:8px 0}
.detail-block summary:hover{text-decoration:underline}
.detail-block ul{list-style:none;padding:8px 0;columns:2}
.detail-block li{padding:3px 0;font-size:.85rem;color:${C.muted}}
.empty-message{color:${C.muted};font-style:italic;padding:12px 0}

/* filter panel */
.filter-toggle{position:fixed;top:10px;right:10px;z-index:210;background:${C.card};border:1px solid ${C.border};color:${C.accent};padding:8px 14px;border-radius:8px;cursor:pointer;font-size:.85rem;font-weight:600;transition:background .2s}
.filter-toggle:hover{background:${C.bg}}
.filter-toggle .badge{background:${C.accent};color:${C.bg};padding:1px 7px;border-radius:10px;font-size:.75rem;margin-left:6px;display:none}
.filter-toggle .badge.visible{display:inline}
.filter-panel{position:fixed;top:0;right:-300px;width:300px;height:100vh;background:${C.card};border-left:1px solid ${C.border};display:flex;flex-direction:column;z-index:200;transition:right .25s ease;box-shadow:-4px 0 20px rgba(0,0,0,.3)}
.filter-panel.open{right:0}
.filter-header{padding:16px 14px 10px;border-bottom:1px solid ${C.border};flex-shrink:0;display:flex;align-items:center;justify-content:space-between}
.filter-header h2{font-size:1rem;font-weight:700;color:${C.accent}}
.filter-close{background:none;border:none;color:${C.muted};font-size:1.2rem;cursor:pointer;padding:4px 8px}
.filter-close:hover{color:${C.text}}
.filter-actions{padding:10px 14px;border-bottom:1px solid ${C.border};display:flex;gap:8px;flex-shrink:0}
.filter-btn{flex:1;padding:6px 10px;border:1px solid ${C.border};border-radius:6px;background:${C.bg};color:${C.text};font-size:.78rem;cursor:pointer;transition:border-color .2s}
.filter-btn:hover{border-color:${C.accent}}
.filter-btn.primary{background:${C.accent};color:${C.bg};border-color:${C.accent};font-weight:600}
.filter-body{flex:1;overflow-y:auto;padding:10px 14px}
.filter-body::-webkit-scrollbar{width:6px}
.filter-body::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
.filter-group{margin-bottom:16px}
.filter-group-title{font-size:.78rem;font-weight:600;color:${C.accent};text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;cursor:pointer;display:flex;align-items:center;justify-content:space-between}
.fg-arrow{transition:transform .2s;font-size:.65rem;color:${C.muted}}
.filter-group.fg-collapsed .fg-arrow{transform:rotate(-90deg)}
.filter-group.fg-collapsed .filter-group-body{display:none}
.filter-range{margin-bottom:10px}
.filter-range label{display:block;font-size:.8rem;color:${C.muted};margin-bottom:4px}
.filter-range .range-row{display:flex;align-items:center;gap:8px}
.filter-range .range-info{font-size:.7rem;color:${C.muted}44}
.filter-range input[type="number"]{width:70px;padding:4px 6px;background:${C.bg};border:1px solid ${C.border};border-radius:4px;color:${C.text};font-size:.8rem;text-align:center}
.filter-range input[type="number"]:focus{border-color:${C.accent};outline:none}
.range-sep{color:${C.muted};font-size:.75rem}
.filter-checkbox{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:.82rem;color:${C.text}}
.filter-checkbox input{accent-color:${C.accent}}
.filter-select{width:100%;padding:5px 8px;background:${C.bg};border:1px solid ${C.border};border-radius:4px;color:${C.text};font-size:.8rem;margin-bottom:6px}
.filter-select:focus{border-color:${C.accent};outline:none}
.filter-result-count{padding:10px 14px;border-top:1px solid ${C.border};font-size:.82rem;color:${C.muted};text-align:center;flex-shrink:0}
.filter-result-count strong{color:${C.accent}}
.exclude-list{max-height:200px;overflow-y:auto;margin-top:4px}
.exclude-list label{display:block;padding:2px 0;font-size:.78rem;color:${C.muted};cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.exclude-list label:hover{color:${C.text}}
.exclude-list input{accent-color:${C.accent};margin-right:6px}
.exclude-search{width:100%;padding:4px 8px;background:${C.bg};border:1px solid ${C.border};border-radius:4px;color:${C.text};font-size:.78rem;margin-bottom:4px}
.exclude-search:focus{border-color:${C.accent};outline:none}

@media(max-width:900px){
  .chart-row{grid-template-columns:1fr}
  .main-content{margin-left:0;padding:16px}
  .sidebar{display:none}
  .filter-panel{display:none}
}
@media print{
  body{background:#fff;color:#222}
  .sidebar,.filter-panel,.filter-toggle{display:none}
  .main-content{margin-left:0}
  .section-header{background:#f0f0f0}
  .section-body{background:#fff;border-color:#ddd}
  .stat-card{background:#f8f8f8;border-color:#ddd}
  .section.collapsed .section-body{max-height:none;padding:20px}
}`;
}

// ── Browser JS (runs in the generated HTML) ──────────────────────────────────

export function dashboardJs() {
  return `
(function(){
function renderChartsIn(el){
  el.querySelectorAll('.deferred-chart:not([data-rendered])').forEach(function(c){
    try{
      Plotly.newPlot(c.id,JSON.parse(c.dataset.traces),JSON.parse(c.dataset.layout),
        {responsive:true,displayModeBar:false});
      c.dataset.rendered='1';
    }catch(e){console.warn('Chart error',c.id,e);}
  });
}
window.switchTab=function(name){
  document.querySelectorAll('.sidebar-item').forEach(function(e){e.classList.remove('active');});
  var si=document.querySelector('.sidebar-item[data-name="'+CSS.escape(name)+'"]');
  if(si)si.classList.add('active');
  document.querySelectorAll('.project-panel').forEach(function(p){p.classList.remove('active');});
  var panel=document.getElementById('panel-'+name);
  if(panel){panel.classList.add('active');renderChartsIn(panel);window.scrollTo(0,0);setTimeout(function(){window.dispatchEvent(new Event('resize'));},50);}
};
window.toggleFilterPanel=function(){
  var p=document.getElementById('filter-panel');if(p)p.classList.toggle('open');
};
window.filterExcludeList=function(q){
  q=q.toLowerCase();
  document.querySelectorAll('#exclude-list label').forEach(function(l){
    l.style.display=(!q||l.textContent.toLowerCase().indexOf(q)!==-1)?'':'none';
  });
};
window.toggleAllExcludes=function(state){
  document.querySelectorAll('.exclude-cb').forEach(function(cb){cb.checked=state;});
};
function getRangeVal(key,bound){
  var el=document.querySelector('input[data-filter="'+key+'"][data-bound="'+bound+'"]');
  return el?parseFloat(el.value):null;
}
window.applyFilters=function(){
  if(!window.PROJECT_METRICS||!PROJECT_METRICS.length)return;
  var rangeKeys=['tracks','plugins','items','duration','tempo','envelopes',
    'automationPts','sends','midiNotes','midiItems','audioItems','maxDepth',
    'avgFxPerTrack','mutedTracks'];
  var ranges={};var activeCount=0;
  rangeKeys.forEach(function(k){
    var el=document.querySelector('input[data-filter="'+k+'"][data-bound="min"]');
    var lo=getRangeVal(k,'min'),hi=getRangeVal(k,'max');
    var origLo=el?parseFloat(el.min):lo,origHi=el?parseFloat(el.max):hi;
    ranges[k]={lo:lo,hi:hi};
    if(lo!==origLo||hi!==origHi)activeCount++;
  });
  function chk(id){var e=document.getElementById(id);return e&&e.checked;}
  var bools={hasAuto:chk('flt-has-auto'),hasMidi:chk('flt-has-midi'),rendered:chk('flt-rendered'),
    hasSends:chk('flt-has-sends'),tempoChanges:chk('flt-tempo-changes')};
  Object.values(bools).forEach(function(v){if(v)activeCount++;});
  var srF=document.getElementById('flt-sr')?.value||'';
  var verF=document.getElementById('flt-ver')?.value||'';
  if(srF)activeCount++;if(verF)activeCount++;
  var excluded=new Set();
  document.querySelectorAll('.exclude-cb').forEach(function(cb){
    if(!cb.checked){excluded.add(cb.dataset.project);activeCount++;}
  });
  var visible=new Set();
  PROJECT_METRICS.forEach(function(m){
    var pass=true;
    if(excluded.has(m.name))pass=false;
    if(pass)rangeKeys.forEach(function(k){
      var r=ranges[k];
      if(r.lo!==null&&m[k]<r.lo)pass=false;
      if(r.hi!==null&&m[k]>r.hi)pass=false;
    });
    if(pass&&bools.hasAuto&&m.envelopes===0)pass=false;
    if(pass&&bools.hasMidi&&m.midiNotes===0)pass=false;
    if(pass&&bools.rendered&&!m.rendered)pass=false;
    if(pass&&bools.hasSends&&m.sends===0)pass=false;
    if(pass&&bools.tempoChanges&&m.tempoChanges===0)pass=false;
    if(pass&&srF&&m.sampleRate!==parseInt(srF))pass=false;
    if(pass&&verF&&m.version!==verF)pass=false;
    if(pass)visible.add(m.name);
  });
  document.querySelectorAll('.sidebar-item:not(.comparison)').forEach(function(el){
    var n=el.dataset.name||'';
    if(visible.has(n)){el.classList.remove('filter-hidden','hidden');}
    else{el.classList.add('filter-hidden','hidden');}
  });
  var ctr=document.getElementById('sidebar-count');
  if(ctr)ctr.textContent=visible.size+' / '+PROJECT_METRICS.length+' projects';
  var rc=document.getElementById('filter-result-count');
  if(rc)rc.innerHTML='Showing <strong>'+visible.size+'</strong> / '+PROJECT_METRICS.length+' projects';
  var badge=document.getElementById('filter-badge');
  if(badge){badge.textContent=activeCount;badge.classList.toggle('visible',activeCount>0);}
  var sb=document.getElementById('sidebar-search');
  if(sb&&sb.value)filterProjects(sb.value);
  /* hide comparison table rows */
  var tbl=document.querySelector('#panel-__comparison__ .data-table tbody');
  if(tbl)tbl.querySelectorAll('tr').forEach(function(row){
    var n=row.querySelector('td')?row.querySelector('td').textContent.trim():'';
    row.style.display=visible.has(n)?'':'none';
  });
};
window.resetFilters=function(){
  document.querySelectorAll('input[data-filter]').forEach(function(el){
    el.value=el.dataset.bound==='min'?el.min:el.max;
  });
  ['flt-has-auto','flt-has-midi','flt-rendered','flt-has-sends','flt-tempo-changes'].forEach(function(id){
    var e=document.getElementById(id);if(e)e.checked=false;
  });
  ['flt-sr','flt-ver'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  toggleAllExcludes(true);
  applyFilters();
};
function filterProjects(q){
  q=(q||'').toLowerCase();
  var items=document.querySelectorAll('.sidebar-item:not(.comparison)');
  var n=0;
  items.forEach(function(el){
    var match=!q||el.dataset.name.toLowerCase().indexOf(q)!==-1;
    var filtered=el.classList.contains('filter-hidden');
    if(match&&!filtered){el.classList.remove('hidden');n++;}
    else el.classList.add('hidden');
  });
  var ctr=document.getElementById('sidebar-count');
  if(ctr)ctr.textContent=n+' / '+items.length+' projects';
}
document.addEventListener('DOMContentLoaded',function(){
  var sb=document.getElementById('sidebar-search');
  if(sb)sb.addEventListener('input',function(){filterProjects(this.value);});
  document.querySelectorAll('input[data-filter]').forEach(function(el){
    el.addEventListener('keyup',function(e){if(e.key==='Enter')applyFilters();});
  });
  var cmp=document.querySelector('.sidebar-item.comparison');
  if(cmp){cmp.click();return;}
  renderChartsIn(document.body);
});
})();`;
}
