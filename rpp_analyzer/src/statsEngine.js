export function formatDuration(seconds) {
  if (seconds <= 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function sortedObj(obj) {
  return Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
}

export function computeProjectStats(data) {
  // ---- tracks ----
  const totalTracks   = data.tracks.length;
  const folderTracks  = data.tracks.filter(t => t.isbus === 1).length;
  const mutedTracks   = data.tracks.filter(t => t.isMuted);
  const maxDepth      = Math.max(0, ...data.tracks.map(t => t.nestingDepth));
  const totalFx       = data.tracks.reduce((s, t) => s + t.plugins.length, 0);

  // ---- plugins ----
  const allPlugins     = data.tracks.flatMap(t => t.plugins);
  const pluginCounter  = {}, vendorCounter = {}, typeCounter = {};
  const uniqueNames    = new Set();
  for (const p of allPlugins) {
    pluginCounter[p.displayName] = (pluginCounter[p.displayName] || 0) + 1;
    uniqueNames.add(p.displayName);
    const v = p.vendor || 'Unknown';
    vendorCounter[v] = (vendorCounter[v] || 0) + 1;
    let type;
    if (p.pluginType === 'JSFX') type = 'JSFX';
    else if (p.isInstrument)     type = 'Instruments (VSTi)';
    else                         type = 'Effects (VST)';
    typeCounter[type] = (typeCounter[type] || 0) + 1;
  }

  // ---- items ----
  const allItems   = data.tracks.flatMap(t => t.items);
  const midiItems  = allItems.filter(i => i.isMidi);
  const audioItems = allItems.filter(i => i.isAudio);
  const lengths    = allItems.map(i => i.length).filter(l => l > 0);
  const longestItem  = lengths.length ? Math.max(...lengths) : 0;
  const shortestItem = lengths.length ? Math.min(...lengths) : 0;

  // arrangement density (32 bins)
  const BINS = 32;
  const density = new Array(BINS).fill(0);
  if (data.estimatedDuration > 0 && allItems.length > 0) {
    const binSize = data.estimatedDuration / BINS;
    for (const item of allItems) {
      const s = Math.max(0, Math.floor(item.position / binSize));
      const e = Math.min(BINS - 1, Math.floor((item.position + item.length) / binSize));
      for (let b = s; b <= e; b++) density[b]++;
    }
  }

  // ---- MIDI ----
  const totalMidiNotes    = midiItems.reduce((s, i) => s + i.midiNotes, 0);
  const totalMidiDuration = midiItems.reduce((s, i) => s + i.length, 0);
  const midiChannels      = new Set(midiItems.flatMap(i => i.midiChannels));

  // ---- routing ----
  const tracksWithSends = data.tracks.filter(t => t.receives > 0);

  // ---- automation ----
  const allEnvs = data.tracks.flatMap(t => t.envelopes);
  const totalAutoPts = allEnvs.reduce((s, e) => s + e.pointCount, 0);
  const automatedParams = [...new Set([
    ...allEnvs.map(e => e.name),
    ...data.tracks.flatMap(t =>
      t.plugins.filter(p => p.hasAutomation).map(p => `${p.name} (param)`)
    ),
  ])].filter(Boolean);

  // ---- fingerprint (raw, normalized later in batch) ----
  return {
    projectName:          data.filename,
    reaperVersion:        data.reaperVersion,
    platform:             data.platform,
    lastSaved:            data.lastSaved
                            ? data.lastSaved.toISOString().replace('T',' ').slice(0,16)+' UTC'
                            : 'Unknown',
    lastSavedRaw:         data.lastSaved ? data.lastSaved.toISOString() : '',
    tempo:                data.tempo,
    timeSignature:        `${data.timeSigNum}/${data.timeSigDenom}`,
    sampleRate:           data.sampleRate,
    estimatedDuration:    data.estimatedDuration,
    durationFormatted:    formatDuration(data.estimatedDuration),
    wasRendered:          data.wasRendered,
    renderFile:           data.renderFile,
    masterVolumeDb:       data.masterVolDb,

    totalTracks,
    folderTracks,
    leafTracks:           totalTracks - folderTracks,
    mutedTracks:          mutedTracks.length,
    mutedTrackNames:      mutedTracks.map(t => t.name),
    maxNestingDepth:      maxDepth,
    avgFxPerTrack:        totalTracks > 0 ? totalFx / totalTracks : 0,

    totalPluginInstances: allPlugins.length,
    uniquePlugins:        uniqueNames.size,
    pluginCounts:         sortedObj(pluginCounter),
    vendorCounts:         sortedObj(vendorCounter),
    typeCounts:           typeCounter,
    bypassedFxCount:      allPlugins.filter(p => p.isBypassed).length,
    pluginDiversity:      allPlugins.length > 0 ? uniqueNames.size / allPlugins.length : 0,
    pluginList:           [...uniqueNames].sort(),

    totalItems:           allItems.length,
    midiItems:            midiItems.length,
    audioItems:           audioItems.length,
    mutedItems:           allItems.filter(i => i.isMuted).length,
    avgItemLength:        lengths.length ? lengths.reduce((a,b)=>a+b,0)/lengths.length : 0,
    longestItem,
    shortestItem,
    longestItemName:      allItems.find(i => i.length === longestItem)?.name || '',
    shortestItemName:     allItems.find(i => i.length === shortestItem)?.name || '',
    arrangementDensity:   density,

    totalMidiNotes,
    midiNoteDensity:      totalMidiDuration > 0 ? (totalMidiNotes / totalMidiDuration) * 60 : 0,
    midiChannelsUsed:     [...midiChannels].sort((a,b)=>a-b),
    totalMidiDuration,

    totalSends:           data.tracks.reduce((s, t) => s + t.receives, 0),
    tracksWithSends:      tracksWithSends.map(t => t.name),

    totalEnvelopes:       allEnvs.length,
    totalAutomationPoints: totalAutoPts,
    automatedParams,
    automationIntensity:  data.estimatedDuration > 0 ? totalAutoPts / data.estimatedDuration : 0,

    tempoChanges:         Math.max(0, data.tempoEnvelope.length - 1),
    tempoCurve:           data.tempoEnvelope,

    markerCount:          data.markers.length,
    markers:              data.markers,

    fingerprint:          {},
  };
}

export function computeBatchStats(allStats) {
  const names        = allStats.map(s => s.projectName);
  const trackCounts  = allStats.map(s => s.totalTracks);
  const pluginCounts = allStats.map(s => s.totalPluginInstances);
  const durations    = allStats.map(s => s.estimatedDuration);
  const tempos       = allStats.map(s => s.tempo);
  const midiCounts   = allStats.map(s => s.midiItems);
  const audioCounts  = allStats.map(s => s.audioItems);

  const globalPlugins = {}, globalVendors = {};
  for (const s of allStats) {
    for (const [k, v] of Object.entries(s.pluginCounts))
      globalPlugins[k] = (globalPlugins[k] || 0) + v;
    for (const [k, v] of Object.entries(s.vendorCounts))
      globalVendors[k] = (globalVendors[k] || 0) + v;
  }

  const normalize = vals => {
    const mn = Math.min(...vals), mx = Math.max(...vals);
    if (mx === mn) return vals.map(() => 0.5);
    return vals.map(v => (v - mn) / (mx - mn));
  };

  const nTracks   = normalize(trackCounts);
  const nFx       = normalize(pluginCounts);
  const nMidi     = normalize(allStats.map(s => s.totalItems > 0 ? s.midiItems / s.totalItems : 0));
  const nAuto     = normalize(allStats.map(s => s.automationIntensity));
  const nDensity  = normalize(allStats.map(s => s.arrangementDensity.length ? Math.max(...s.arrangementDensity) : 0));
  const nDiversity = normalize(allStats.map(s => s.pluginDiversity));

  const fingerprints = allStats.map((s, idx) => ({
    name: s.projectName,
    tracks: nTracks[idx], fxCount: nFx[idx],
    midiRatio: nMidi[idx], automation: nAuto[idx],
    density: nDensity[idx], diversity: nDiversity[idx],
  }));

  const projects = allStats.map(s => ({
    name: s.projectName, tracks: s.totalTracks,
    plugins: s.totalPluginInstances, items: s.totalItems,
    durationFmt: s.durationFormatted, tempo: s.tempo,
    reaperVersion: s.reaperVersion, lastSaved: s.lastSaved,
    lastSavedRaw: s.lastSavedRaw,
  }));

  return {
    projects, names, trackCounts, pluginCounts, durations,
    tempos, midiCounts, audioCounts,
    globalPluginCounts: Object.fromEntries(
      Object.entries(globalPlugins).sort((a,b)=>b[1]-a[1]).slice(0,30)),
    globalVendorCounts: Object.fromEntries(
      Object.entries(globalVendors).sort((a,b)=>b[1]-a[1])),
    fingerprints,
  };
}
