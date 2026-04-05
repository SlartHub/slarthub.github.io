import { getProp, getAllProps, getChild, getChildren } from './rppParser.js';

const f = s => parseFloat(s) || 0;
const i = s => parseInt(s, 10) || 0;

function colorrefToHex(n) {
  if (!n) return '#888888';
  const r = n & 0xFF, g = (n >> 8) & 0xFF, b = (n >> 16) & 0xFF;
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function linToDb(vol) {
  if (vol <= 0) return -144;
  return 20 * Math.log10(vol);
}

function parsePluginName(displayName, dll = '') {
  let pluginType = 'VST', name = displayName, vendor = '', isInstrument = false;
  const typeMatch = displayName.match(/^(VST3i|VSTi|VST3|VST|CLAP|JS):\s*/i);
  if (typeMatch) {
    pluginType = typeMatch[1].toUpperCase();
    name = displayName.slice(typeMatch[0].length);
    isInstrument = pluginType === 'VSTI' || pluginType === 'VST3I';
  }
  const parenMatches = [...name.matchAll(/\(([^)]+)\)/g)];
  for (let j = parenMatches.length - 1; j >= 0; j--) {
    const val = parenMatches[j][1];
    if (!/^\d+\s*(in|out|ch)/i.test(val)) { vendor = val; break; }
  }
  const cleanName = name.replace(/\s*\([^)]+\)\s*/g, '').trim() || name.trim();
  return { displayName, name: cleanName, vendor: vendor || 'Unknown', pluginType, isInstrument, dll };
}

function extractMidiNotes(sourceNode) {
  let notes = 0;
  const channels = new Set();
  for (const vals of getAllProps(sourceNode, 'E')) {
    if (vals.length < 3) continue;
    const status = parseInt(vals[1], 16);
    if (isNaN(status)) continue;
    const highNibble = (status >> 4) & 0xF;
    const velocity   = parseInt(vals[3] || vals[2] || '0', 16);
    if (highNibble === 9 && velocity > 0) {
      notes++;
      channels.add(status & 0xF);
    }
  }
  return { notes, channels: [...channels] };
}

function extractItems(trackNode) {
  return getChildren(trackNode, 'ITEM').map(itemNode => {
    const position = f(getProp(itemNode, 'POSITION')?.[0]);
    const length   = f(getProp(itemNode, 'LENGTH')?.[0]);
    const isMuted  = i(getProp(itemNode, 'MUTE')?.[0]) === 1;
    const name     = getProp(itemNode, 'NAME')?.[0] || '';
    const sourceNode = getChild(itemNode, 'SOURCE');
    let isMidi = false, isAudio = false, midiNotes = 0, midiChannels = [];
    if (sourceNode) {
      const srcType = (sourceNode.args[0] || '').toUpperCase();
      if (srcType === 'MIDI') {
        isMidi = true;
        const r = extractMidiNotes(sourceNode);
        midiNotes = r.notes; midiChannels = r.channels;
      } else if (srcType) {
        isAudio = true;
      }
    }
    return { position, length, isMuted, name, isMidi, isAudio, midiNotes, midiChannels };
  });
}

function extractPlugins(fxNode) {
  if (!fxNode) return [];
  const plugins = [];
  const bypasses = getAllProps(fxNode, 'BYPASS');
  let idx = 0;
  for (const c of fxNode.children) {
    if (c.type === 'VST' || c.type === 'CLAP') {
      const info = parsePluginName(c.args[0] || '', c.args[1] || '');
      info.isBypassed = i(bypasses[idx]?.[0]) === 1;
      info.hasAutomation = c.children.some(ch => ch.type === 'PARMENV');
      plugins.push(info); idx++;
    } else if (c.type === 'JS') {
      const scriptName = c.args[0] || '';
      plugins.push({
        displayName: `JS: ${scriptName}`, name: scriptName,
        vendor: 'JSFX', pluginType: 'JSFX', isInstrument: false, dll: '',
        isBypassed: i(bypasses[idx]?.[0]) === 1,
        hasAutomation: c.children.some(ch => ch.type === 'PARMENV'),
      });
      idx++;
    }
  }
  return plugins;
}

function extractEnvelopes(trackNode) {
  const envTypes = new Set(['VOLENV', 'VOLENV2', 'PANENV', 'PANENV2', 'MUTEENV']);
  const envs = [];
  for (const c of trackNode.children) {
    if (envTypes.has(c.type) || c.type === 'PARMENV') {
      const pts = getAllProps(c, 'PT');
      const name = getProp(c, 'NAME')?.[0] || c.args.join(' ') || c.type;
      envs.push({ name: name.trim(), pointCount: pts.length });
    }
  }
  return envs;
}

function extractTrack(trackNode, depth) {
  const colorInt = i(getProp(trackNode, 'PEAKCOL')?.[0]);
  const volpan   = getProp(trackNode, 'VOLPAN');
  const mutesolo = getProp(trackNode, 'MUTESOLO');
  const isbusV   = getProp(trackNode, 'ISBUS');
  return {
    name:         getProp(trackNode, 'NAME')?.[0] || '',
    color:        colorrefToHex(colorInt),
    volumeDb:     linToDb(f(volpan?.[0] ?? '1')),
    pan:          f(volpan?.[1] ?? '0'),
    isMuted:      i(mutesolo?.[0]) === 1,
    isSolo:       i(mutesolo?.[1]) === 1,
    isArmed:      i(getProp(trackNode, 'REC')?.[0]) === 1,
    isbus:        i(isbusV?.[0]),
    nestingDepth: depth,
    plugins:      extractPlugins(getChild(trackNode, 'FXCHAIN')),
    items:        extractItems(trackNode),
    envelopes:    extractEnvelopes(trackNode),
    receives:     getAllProps(trackNode, 'AUXRECV').length,
  };
}

export function extractProjectData(rootNode, filename) {
  const args        = rootNode.args;
  const versionStr  = args[1] || '';
  const timestamp   = parseInt(args[2] || args[args.length - 1] || '0', 10);

  const tempoV   = getProp(rootNode, 'TEMPO');
  const srV      = getProp(rootNode, 'SAMPLERATE');
  const masterV  = getProp(rootNode, 'MASTER_VOLUME');
  const renderV  = getProp(rootNode, 'RENDER_FILE');
  const renderFile = renderV?.[0] || '';

  const markers = getAllProps(rootNode, 'MARKER').map(v => ({
    id: i(v[0]), position: f(v[1]), name: v[2] || '',
  }));

  const tempoenvNode  = getChild(rootNode, 'TEMPOENVEX');
  const tempoEnvelope = tempoenvNode
    ? getAllProps(tempoenvNode, 'PT').map(v => ({ time: f(v[0]), bpm: f(v[1]) }))
    : [];

  const tracks = [];
  let depth = 0;
  for (const trackNode of getChildren(rootNode, 'TRACK')) {
    const isbusV = getProp(trackNode, 'ISBUS');
    const isbus  = i(isbusV?.[0]);
    tracks.push(extractTrack(trackNode, depth));
    if (isbus === 1) depth++;
    else if (isbus === 2) depth = Math.max(0, depth - 1);
  }

  let estimatedDuration = 0;
  for (const t of tracks)
    for (const item of t.items) {
      const end = item.position + item.length;
      if (end > estimatedDuration) estimatedDuration = end;
    }

  return {
    filename,
    reaperVersion: versionStr.split('/')[0] || 'Unknown',
    platform:      versionStr.split('/')[1] || 'Unknown',
    lastSaved:     timestamp ? new Date(timestamp * 1000) : null,
    tempo:         f(tempoV?.[0] ?? '120'),
    timeSigNum:    i(tempoV?.[1] ?? '4'),
    timeSigDenom:  i(tempoV?.[2] ?? '4'),
    sampleRate:    i(srV?.[0] ?? '44100'),
    masterVolDb:   linToDb(f(masterV?.[0] ?? '1')),
    renderFile,
    wasRendered:   renderFile !== '',
    estimatedDuration,
    tracks,
    markers,
    tempoEnvelope,
  };
}
