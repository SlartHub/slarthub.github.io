/**
 * WAV Studio Web — Analysis Web Worker
 * Ports the full Python analysis engine to JavaScript.
 * Runs off the main thread to keep the UI responsive.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function dbVal(x) {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}

function fmtDb(v, prec = 1) {
  if (!isFinite(v)) return "-inf";
  return (v >= 0 ? "+" : "") + v.toFixed(prec);
}

function rms(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

// ── WAV Parser ───────────────────────────────────────────────────────────────

function parseWav(buffer) {
  const view = new DataView(buffer);

  // RIFF header
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== "RIFF") throw new Error("Not a valid WAV file (missing RIFF header)");

  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (wave !== "WAVE") throw new Error("Not a valid WAV file (missing WAVE marker)");

  // Find chunks
  let fmtChunk = null, dataChunk = null;
  let offset = 12;
  while (offset < buffer.byteLength - 8) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);

    if (id === "fmt ") {
      fmtChunk = { offset: offset + 8, size };
    } else if (id === "data") {
      dataChunk = { offset: offset + 8, size };
    }

    offset += 8 + size;
    if (size % 2 !== 0) offset++; // padding byte
  }

  if (!fmtChunk) throw new Error("No fmt chunk found");
  if (!dataChunk) throw new Error("No data chunk found");

  const audioFormat = view.getUint16(fmtChunk.offset, true);
  const channels = view.getUint16(fmtChunk.offset + 2, true);
  const sampleRate = view.getUint32(fmtChunk.offset + 4, true);
  const bitsPerSample = view.getUint16(fmtChunk.offset + 14, true);
  const sampWidth = bitsPerSample / 8;

  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`Unsupported audio format: ${audioFormat} (only PCM supported)`);
  }

  const bytesPerSample = sampWidth;
  const totalSamples = Math.floor(dataChunk.size / bytesPerSample);
  const nframes = Math.floor(totalSamples / channels);

  // Decode samples to float
  const samples = new Float64Array(totalSamples);
  const dOff = dataChunk.offset;

  if (sampWidth === 2) {
    for (let i = 0; i < totalSamples; i++) {
      samples[i] = view.getInt16(dOff + i * 2, true) / 32768.0;
    }
  } else if (sampWidth === 3) {
    for (let i = 0; i < totalSamples; i++) {
      const o = dOff + i * 3;
      const b0 = view.getUint8(o);
      const b1 = view.getUint8(o + 1);
      const b2 = view.getUint8(o + 2);
      let val = b0 | (b1 << 8) | (b2 << 16);
      if (b2 & 0x80) val |= 0xFF000000; // sign extend
      samples[i] = val / 8388608.0;
    }
  } else if (sampWidth === 4) {
    if (audioFormat === 3) {
      // 32-bit float
      for (let i = 0; i < totalSamples; i++) {
        samples[i] = view.getFloat32(dOff + i * 4, true);
      }
    } else {
      // 32-bit int PCM
      for (let i = 0; i < totalSamples; i++) {
        samples[i] = view.getInt32(dOff + i * 4, true) / 2147483648.0;
      }
    }
  } else {
    throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
  }

  return { samples, channels, sampWidth, sampleRate, nframes, bitsPerSample };
}

// ── True Peak (4x polyphase FIR oversampling) ────────────────────────────────

const TP_COEFFS = [
  [-0.0017, 0.0049, -0.0110, 0.0210, -0.0372, 0.0657,
   -0.1336, 0.6282, 0.6282, -0.1336, 0.0657, -0.0372,
    0.0210, -0.0110, 0.0049, -0.0017],
  [-0.0024, 0.0083, -0.0212, 0.0479, -0.1127, 0.6016,
    0.6016, -0.1127, 0.0479, -0.0212, 0.0083, -0.0024],
  [-0.0017, 0.0049, -0.0110, 0.0210, -0.0372, 0.0657,
   -0.1336, 0.6282, 0.6282, -0.1336, 0.0657, -0.0372,
    0.0210, -0.0110, 0.0049, -0.0017],
];

function truePeakChannel(samples, n) {
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (n < 32) return peak;

  for (const coeffs of TP_COEFFS) {
    const half = coeffs.length >> 1;
    for (let i = half; i < n - half; i++) {
      let acc = 0;
      for (let k = 0; k < coeffs.length; k++) {
        acc += coeffs[k] * samples[i - half + k];
      }
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

// ── Biquad / SOS filter ──────────────────────────────────────────────────────

/**
 * Apply second-order sections filter (equivalent to scipy.signal.sosfilt).
 * sos is an array of sections: [[b0,b1,b2, 1, a1,a2], ...]
 */
function sosfilt(sos, x) {
  const out = new Float64Array(x.length);
  out.set(x);

  for (const section of sos) {
    const [b0, b1, b2, _a0, a1, a2] = section;
    let z1 = 0, z2 = 0;
    for (let i = 0; i < out.length; i++) {
      const xi = out[i];
      const yi = b0 * xi + z1;
      z1 = b1 * xi - a1 * yi + z2;
      z2 = b2 * xi - a2 * yi;
      out[i] = yi;
    }
  }
  return out;
}

// ── K-weighting (BS.1770-4) ──────────────────────────────────────────────────

function kWeightSos(sr) {
  // Stage 1: High-shelf pre-filter
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const A = Math.pow(10, G / 40);
  const w0 = 2 * Math.PI * f0 / sr;
  const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);

  const sqrtA = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cosw0 + 2 * sqrtA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
  const b2 = A * ((A + 1) + (A - 1) * cosw0 - 2 * sqrtA * alpha);
  const a0 = (A + 1) - (A - 1) * cosw0 + 2 * sqrtA * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cosw0);
  const a2 = (A + 1) - (A - 1) * cosw0 - 2 * sqrtA * alpha;

  const shelf = [b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0];

  // Stage 2: 2nd-order Butterworth high-pass at 38 Hz (RLB weighting)
  const hp = butterHighpass2(38.0, sr);

  return [shelf, ...hp];
}

/**
 * 2nd-order Butterworth high-pass filter, returned as SOS.
 */
function butterHighpass2(fc, fs) {
  const w0 = 2 * Math.PI * fc / fs;
  const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  // Q = 1/sqrt(2) for Butterworth
  const alpha = sinw0 / (2 * Math.SQRT1_2);

  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;

  return [[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]];
}

function kWeight(signal, sr) {
  return sosfilt(kWeightSos(sr), signal);
}

// ── Butterworth bandpass filter ──────────────────────────────────────────────

/**
 * 4th-order Butterworth bandpass filter as cascaded biquad sections.
 * Equivalent to scipy butter(4, [lo, hi], btype='band', output='sos')
 *
 * We build this as two cascaded 2nd-order bandpass biquads with adjusted Q.
 * For a 4th-order Butterworth, we use Q values from the Butterworth poles.
 */
function butterBandpass4(lo, hi, fs) {
  const nyq = fs / 2;
  const loN = lo / nyq;
  const hiN = hi / nyq;
  if (loN >= hiN || loN <= 0 || hiN >= 1) return null;

  // Pre-warp
  const wLo = Math.tan(Math.PI * loN);
  const wHi = Math.tan(Math.PI * hiN);
  const w0 = Math.sqrt(wLo * wHi);
  const bw = wHi - wLo;

  // 4th-order Butterworth has 2 pole pairs with angles:
  // pi/8 and 3*pi/8 from the negative real axis
  // For bandpass, each analog prototype pole becomes a pair of poles
  const sections = [];
  const poleAngles = [Math.PI * 3 / 8, Math.PI * 1 / 8]; // reversed for stability

  for (const angle of poleAngles) {
    // Analog prototype pole: s = exp(j * (pi/2 + angle)) for upper half
    const sigma = -Math.sin(angle);
    const omega = Math.cos(angle);

    // Bandpass transform: s -> (s^2 + w0^2) / (bw * s)
    // This gives us a biquad section via bilinear transform
    // Using direct biquad bandpass design with computed Q
    const Q_bp = w0 / bw / (-sigma / Math.sqrt(sigma * sigma + omega * omega));

    // Biquad bandpass coefficients using bilinear transform
    const w0d = 2 * Math.atan(w0); // digital center frequency
    const cosw = Math.cos(w0d);
    const sinw = Math.sin(w0d);
    const alpha = sinw / (2 * Q_bp);

    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw;
    const a2 = 1 - alpha;

    sections.push([b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]);
  }

  return sections;
}

/**
 * Simpler approach: cascaded 2nd-order Butterworth bandpass biquads.
 * This gives cleaner results for our use case.
 */
function bandFilter(signal, lo, hi, sr) {
  const nyq = sr / 2;
  if (lo >= hi || lo <= 0 || hi >= nyq) return new Float64Array(signal.length);

  // Use two cascaded 2nd-order bandpass biquads for ~4th-order response
  const sections = [];
  for (let stage = 0; stage < 2; stage++) {
    const w0 = 2 * Math.PI * Math.sqrt(lo * hi) / sr;
    const bw = 2 * Math.PI * (hi - lo) / sr;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    // For Butterworth cascade: Q = sqrt(2) for each 2nd-order section
    // gives 4th-order Butterworth overall
    const Q = Math.pow(2, 0.5);
    const alpha = sinw / (2 * Q);

    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw;
    const a2 = 1 - alpha;

    sections.push([b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]);
  }

  return sosfilt(sections, signal);
}

// ── Frequency bands ──────────────────────────────────────────────────────────

const FREQ_BANDS = [
  ["Sub",     20,    60],
  ["Bass",    60,   250],
  ["Low-mid", 250,  2000],
  ["Mid",    2000,  4000],
  ["Hi-mid", 4000,  8000],
  ["Air",    8000, 20000],
];

// ── Main analysis function ───────────────────────────────────────────────────

function analyze(buffer, fileName, fileSize) {
  const post = (type, data) => self.postMessage({ type, ...data });
  const status = (text) => post("status", { text });
  const line = (text) => post("line", { text: text || "" });

  status("Reading file...");
  const { samples, channels, sampWidth, sampleRate, nframes, bitsPerSample } = parseWav(buffer);
  const duration = nframes / sampleRate;
  const isStereo = channels === 2;

  let left, right, n;
  if (isStereo) {
    n = nframes;
    left = new Float64Array(n);
    right = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = samples[i * 2];
      right[i] = samples[i * 2 + 1];
    }
  } else {
    n = nframes;
    left = new Float64Array(n);
    for (let i = 0; i < n; i++) left[i] = samples[i];
    right = null;
  }

  const lines = [];
  const emit = (text = "") => { lines.push(text); line(text); };

  // ── File info ──────────────────────────────────────────────────────────
  status("File info...");
  emit("=".repeat(62));
  emit("  WAV ANALYSIS");
  emit("=".repeat(62));
  emit(`  File     : ${fileName}`);
  emit(`  Size     : ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
  emit(`  Format   : ${bitsPerSample}-bit PCM  /  ${sampleRate} Hz  /  ${isStereo ? "Stereo" : "Mono"}`);
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  emit(`  Duration : ${mins}m ${secs.toFixed(3)}s  (${nframes} frames)`);

  // ── Peak levels ────────────────────────────────────────────────────────
  status("Computing peak levels...");
  let peakL = 0, peakR = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(left[i]);
    if (a > peakL) peakL = a;
  }
  if (isStereo) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(right[i]);
      if (a > peakR) peakR = a;
    }
  } else {
    peakR = peakL;
  }
  const peak = Math.max(peakL, peakR);

  emit();
  emit("-- PEAK LEVELS " + "-".repeat(47));
  if (isStereo) {
    emit(`  Peak L         : ${fmtDb(dbVal(peakL))} dBFS`);
    emit(`  Peak R         : ${fmtDb(dbVal(peakR))} dBFS`);
  }
  emit(`  Peak (max)     : ${fmtDb(dbVal(peak))} dBFS`);

  // ── True peak ──────────────────────────────────────────────────────────
  status("Computing true peak (4x FIR oversampling)...");
  const tpL = truePeakChannel(left, n);
  const tpR = isStereo ? truePeakChannel(right, n) : tpL;
  const tp = Math.max(tpL, tpR);

  if (isStereo) {
    emit(`  True Peak L    : ${fmtDb(dbVal(tpL))} dBTP`);
    emit(`  True Peak R    : ${fmtDb(dbVal(tpR))} dBTP`);
  }
  emit(`  True Peak (max): ${fmtDb(dbVal(tp))} dBTP`);

  // ── Clipping ───────────────────────────────────────────────────────────
  status("Checking for clipping...");
  const clipThresh = 1.0 - 1 / Math.pow(2, bitsPerSample - 1);
  let clipsL = 0, clipsR = 0;
  for (let i = 0; i < n; i++) if (Math.abs(left[i]) >= clipThresh) clipsL++;
  if (isStereo) for (let i = 0; i < n; i++) if (Math.abs(right[i]) >= clipThresh) clipsR++;

  emit();
  emit("-- CLIPPING " + "-".repeat(50));
  if (isStereo) {
    emit(`  Clipped samples L : ${clipsL}`);
    emit(`  Clipped samples R : ${clipsR}`);
  } else {
    emit(`  Clipped samples   : ${clipsL}`);
  }
  const clipping = clipsL > 0 || clipsR > 0;
  emit(`  Status            : ${clipping ? "!!  CLIPPING DETECTED" : "CLEAN"}`);

  // ── RMS / Crest ────────────────────────────────────────────────────────
  status("Computing RMS and crest factor...");
  const rmsL = rms(left);
  const rmsR = isStereo ? rms(right) : rmsL;
  const rmsAvg = isStereo ? Math.sqrt((rmsL * rmsL + rmsR * rmsR) / 2) : rmsL;

  const dbPeakL = dbVal(peakL), dbRmsL = dbVal(rmsL);
  const cfL = (isFinite(dbPeakL) && isFinite(dbRmsL)) ? dbPeakL - dbRmsL : 0;
  let cfR = cfL;
  if (isStereo) {
    const dbPeakR = dbVal(peakR), dbRmsR = dbVal(rmsR);
    cfR = (isFinite(dbPeakR) && isFinite(dbRmsR)) ? dbPeakR - dbRmsR : 0;
  }

  emit();
  emit("-- RMS & DYNAMICS " + "-".repeat(44));
  if (isStereo) {
    emit(`  RMS L          : ${fmtDb(dbVal(rmsL))} dBFS`);
    emit(`  RMS R          : ${fmtDb(dbVal(rmsR))} dBFS`);
    emit(`  RMS avg        : ${fmtDb(dbVal(rmsAvg))} dBFS`);
    emit(`  Crest factor L : ${cfL.toFixed(2)} dB`);
    emit(`  Crest factor R : ${cfR.toFixed(2)} dB`);
  } else {
    emit(`  RMS            : ${fmtDb(dbVal(rmsL))} dBFS`);
    emit(`  Crest factor   : ${cfL.toFixed(2)} dB`);
  }

  // ── Loudness (unweighted) ──────────────────────────────────────────────
  status("Computing integrated loudness (LUFS)...");
  const block = Math.max(1, Math.round(sampleRate * 0.4));
  const hop = Math.max(1, Math.round(sampleRate * 0.1));
  const chRight = isStereo ? right : left;

  const powers = [];
  for (let i = 0; i + block <= n; i += hop) {
    let sumL = 0, sumR = 0;
    for (let j = 0; j < block; j++) {
      sumL += left[i + j] * left[i + j];
      sumR += chRight[i + j] * chRight[i + j];
    }
     powers.push(isStereo ? (sumL + sumR) / block : sumL / block);
  }

  const absGate = Math.pow(10, (-70 - 0.691) / 10);
  const g1 = powers.filter(p => p > absGate);
  let lufsI = -Infinity;
  if (g1.length > 0) {
    const relGate = (g1.reduce((a, b) => a + b, 0) / g1.length) * 0.1;
    const g2 = g1.filter(p => p > relGate);
    if (g2.length > 0) {
      lufsI = -0.691 + 10 * Math.log10(g2.reduce((a, b) => a + b, 0) / g2.length);
    }
  }

  // ── LRA ────────────────────────────────────────────────────────────────
  status("Computing loudness range (LRA)...");
  const blockS = Math.max(1, Math.round(sampleRate * 3.0));
  const hopS = Math.max(1, Math.round(sampleRate * 1.0));

  const stPwr = [];
  for (let i = 0; i + blockS <= n; i += hopS) {
    let sumL = 0, sumR = 0;
    for (let j = 0; j < blockS; j++) {
      sumL += left[i + j] * left[i + j];
      sumR += chRight[i + j] * chRight[i + j];
    }
    stPwr.push((sumL + sumR) / (2 * blockS));
  }

  let lra = 0;
  let lufsSMax = -Infinity;
  const lufsMMax = powers.length > 0 ? -0.691 + 10 * Math.log10(Math.max(...powers)) : -Infinity;

  const stAbs = stPwr.filter(p => p > absGate);
  if (stAbs.length >= 2) {
    const stUngatedMean = stAbs.reduce((a, b) => a + b, 0) / stAbs.length;
    const stRelGate = stUngatedMean * 0.01;
    const stGated = stAbs.filter(p => p > stRelGate).sort((a, b) => a - b);
    if (stGated.length >= 2) {
      const stDb = stGated.map(p => 10 * Math.log10(p));
      lra = stDb[Math.floor(stDb.length * 0.95)] - stDb[Math.floor(stDb.length * 0.10)];
    }
    lufsSMax = -0.691 + 10 * Math.log10(Math.max(...stAbs));
  }

  // ── K-weighted LUFS ────────────────────────────────────────────────────
  status("Computing K-weighted LUFS (BS.1770-4)...");
  let lufsK = -Infinity, lufsKSMax = -Infinity, lufsKMMax = -Infinity;

  const kl = kWeight(left, sampleRate);
  const kr = isStereo ? kWeight(right, sampleRate) : kl;

  const kpowers = [];
  for (let i = 0; i + block <= n; i += hop) {
    let sumL = 0, sumR = 0;
    for (let j = 0; j < block; j++) {
      sumL += kl[i + j] * kl[i + j];
      sumR += kr[i + j] * kr[i + j];
    }
    kpowers.push((sumL + sumR) / (2 * block));
  }

  const kg1 = kpowers.filter(p => p > absGate);
  if (kg1.length > 0) {
    const krel = (kg1.reduce((a, b) => a + b, 0) / kg1.length) * 0.1;
    const kg2 = kg1.filter(p => p > krel);
    if (kg2.length > 0) {
      lufsK = -0.691 + 10 * Math.log10(kg2.reduce((a, b) => a + b, 0) / kg2.length);
    }
  }
  lufsKMMax = kpowers.length > 0 ? -0.691 + 10 * Math.log10(Math.max(...kpowers)) : -Infinity;

  const kst = [];
  for (let i = 0; i + blockS <= n; i += hopS) {
    let sumL = 0, sumR = 0;
    for (let j = 0; j < blockS; j++) {
      sumL += kl[i + j] * kl[i + j];
      sumR += kr[i + j] * kr[i + j];
    }
    kst.push((sumL + sumR) / (2 * blockS));
  }
  const kstAbs = kst.filter(p => p > absGate);
  if (kstAbs.length > 0) {
    lufsKSMax = -0.691 + 10 * Math.log10(Math.max(...kstAbs));
  }

  // Print loudness section
  const lufsForTargets = lufsK;
  emit();
  emit("-- LOUDNESS (BS.1770-4 K-weighted) " + "-".repeat(27));
  emit(`  Integrated LUFS  : ${fmtDb(lufsK)} LUFS`);
  emit(`  Max Short-term   : ${fmtDb(lufsKSMax)} LUFS`);
  emit(`  Max Momentary    : ${fmtDb(lufsKMMax)} LUFS`);
  emit(`  LRA              : ${lra.toFixed(2)} LU`);
  emit();
  emit("  Streaming targets:");
  emit(`  Spotify  -14 LUFS  ->  delta ~ ${fmtDb(lufsForTargets - (-14))} LU`);
  emit(`  Apple    -16 LUFS  ->  delta ~ ${fmtDb(lufsForTargets - (-16))} LU`);
  emit(`  YouTube  -14 LUFS  ->  delta ~ ${fmtDb(lufsForTargets - (-14))} LU`);

  // ── DC offset ──────────────────────────────────────────────────────────
  status("Computing DC offset...");
  let dcL = 0;
  for (let i = 0; i < n; i++) dcL += left[i];
  dcL /= n || 1;
  let dcR = 0;
  if (isStereo) {
    for (let i = 0; i < n; i++) dcR += right[i];
    dcR /= n || 1;
  }

  emit();
  emit("-- DC OFFSET " + "-".repeat(49));
  if (isStereo) {
    emit(`  DC L : ${dcL >= 0 ? "+" : ""}${dcL.toFixed(7)}  (${fmtDb(dbVal(Math.abs(dcL)))} dBFS)`);
    emit(`  DC R : ${dcR >= 0 ? "+" : ""}${dcR.toFixed(7)}  (${fmtDb(dbVal(Math.abs(dcR)))} dBFS)`);
  } else {
    emit(`  DC   : ${dcL >= 0 ? "+" : ""}${dcL.toFixed(7)}  (${fmtDb(dbVal(Math.abs(dcL)))} dBFS)`);
  }
  const dcWarn = Math.abs(dcL) > 0.001 || (isStereo && Math.abs(dcR) > 0.001);
  emit(`  ${dcWarn ? "!!  DC offset present -- consider high-pass filter" : "OK -- negligible"}`);

  // ── Stereo field ───────────────────────────────────────────────────────
  let corr = null, rmsMid = null, rmsSide = null, msRatio = null;
  if (isStereo) {
    status("Computing stereo field...");
    const meanL = dcL, meanR = dcR;
    let numC = 0, denL = 0, denR = 0;
    for (let i = 0; i < n; i++) {
      const dl = left[i] - meanL, dr = right[i] - meanR;
      numC += dl * dr;
      denL += dl * dl;
      denR += dr * dr;
    }
    const denC = Math.sqrt(denL * denR);
    corr = denC > 0 ? numC / denC : 0;

    const mid = new Float64Array(n);
    const side = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      mid[i] = (left[i] + right[i]) / 2;
      side[i] = (left[i] - right[i]) / 2;
    }
    rmsMid = rms(mid);
    rmsSide = rms(side);
    const dbMid = dbVal(rmsMid), dbSide = dbVal(rmsSide);
    msRatio = (isFinite(dbSide) && isFinite(dbMid)) ? dbSide - dbMid : -Infinity;

    let widthStr;
    if (corr > 0.95) widthStr = "Near-mono";
    else if (corr > 0.7) widthStr = "Narrow";
    else if (corr > 0.4) widthStr = "Moderate";
    else if (corr > 0.0) widthStr = "Wide";
    else widthStr = "Out-of-phase / extreme";

    emit();
    emit("-- STEREO FIELD " + "-".repeat(46));
    emit(`  L/R Correlation  : ${corr >= 0 ? "+" : ""}${corr.toFixed(4)}  (1=mono, 0=unrelated, -1=out-of-phase)`);
    emit(`  Mid RMS          : ${fmtDb(dbVal(rmsMid))} dBFS`);
    emit(`  Side RMS         : ${fmtDb(dbVal(rmsSide))} dBFS`);
    emit(`  Side/Mid ratio   : ${fmtDb(msRatio)} dB`);
    emit(`  Width assessment : ${widthStr}`);
  }

  // ── Silence ────────────────────────────────────────────────────────────
  status("Counting silence...");
  const silThresh = Math.pow(10, -60 / 20);
  let silL = 0, silR = 0;
  for (let i = 0; i < n; i++) if (Math.abs(left[i]) < silThresh) silL++;
  if (isStereo) for (let i = 0; i < n; i++) if (Math.abs(right[i]) < silThresh) silR++;

  emit();
  emit("-- SILENCE (below -60 dBFS) " + "-".repeat(34));
  if (isStereo) {
    emit(`  L : ${silL.toLocaleString()} samples  (${(100 * silL / n).toFixed(2)}%)`);
    emit(`  R : ${silR.toLocaleString()} samples  (${(100 * silR / n).toFixed(2)}%)`);
  } else {
    emit(`  ${silL.toLocaleString()} samples  (${(100 * silL / n).toFixed(2)}%)`);
  }

  // ── RMS over time ──────────────────────────────────────────────────────
  status("Building RMS timeline...");
  const numSegs = 20;
  const segSize = n >= numSegs ? Math.floor(n / numSegs) : n;
  const actualSegs = segSize > 0 ? Math.min(numSegs, Math.floor(n / segSize)) : 0;
  const segDb = [];
  const barWidth = 28;

  for (let i = 0; i < actualSegs; i++) {
    const start = i * segSize;
    let sumSq = 0;
    for (let j = 0; j < segSize; j++) {
      const sl = left[start + j];
      const sr = isStereo ? right[start + j] : sl;
      sumSq += sl * sl + sr * sr;
    }
    const r = Math.sqrt(sumSq / (2 * segSize));
    segDb.push(dbVal(r));
  }

  const finiteDb = segDb.filter(v => isFinite(v));
  let dbMin, dbMax;
  if (finiteDb.length > 0) {
    dbMin = Math.min(...finiteDb) - 1;
    dbMax = Math.max(...finiteDb) + 1;
    if (dbMax - dbMin < 3) {
      const midV = (dbMax + dbMin) / 2;
      dbMin = midV - 1.5;
      dbMax = midV + 1.5;
    }
  } else {
    dbMin = -40; dbMax = 0;
  }

  if (actualSegs > 0) {
    emit();
    emit("-- RMS OVER TIME (20 segments) " + "-".repeat(31));
    emit(`  ${"Time range".padEnd(18)}  ${"RMS".padStart(8)}   Level`);
    emit(`  ${"-".repeat(18)}  ${"-".repeat(8)}   ${"-".repeat(barWidth)}`);

    for (let i = 0; i < actualSegs; i++) {
      const t0 = (i * segSize / sampleRate).toFixed(1);
      const t1 = ((i + 1) * segSize / sampleRate).toFixed(1);
      const v = segDb[i];
      let fill;
      if (!isFinite(v)) fill = 0;
      else fill = Math.round(Math.max(0, Math.min(1, (v - dbMin) / (dbMax - dbMin))) * barWidth);
      const bar = "#".repeat(fill) + ".".repeat(barWidth - fill);
      emit(`  ${t0.padStart(5)}s - ${t1.padStart(5)}s  ${fmtDb(v).padStart(8)}   ${bar}`);
    }
  }

  // ── Per-segment stereo correlation ─────────────────────────────────────
  const segCorrs = [];
  if (isStereo && segSize > 0) {
    status("Computing per-segment stereo correlation...");
    emit();
    emit("-- STEREO CORRELATION OVER TIME " + "-".repeat(30));
    emit(`  ${"Time range".padEnd(18)}  ${"Corr".padStart(6)}   Width`);
    emit(`  ${"-".repeat(18)}  ${"-".repeat(6)}   ${"-".repeat(16)}`);

    for (let i = 0; i < actualSegs; i++) {
      const start = i * segSize;
      let ml = 0, mr = 0;
      for (let j = 0; j < segSize; j++) {
        ml += left[start + j];
        mr += right[start + j];
      }
      ml /= segSize; mr /= segSize;

      let numS = 0, denSL = 0, denSR = 0;
      for (let j = 0; j < segSize; j++) {
        const dl = left[start + j] - ml;
        const dr = right[start + j] - mr;
        numS += dl * dr;
        denSL += dl * dl;
        denSR += dr * dr;
      }
      const denS = Math.sqrt(denSL * denSR);
      const sc = denS > 0 ? numS / denS : 0;
      segCorrs.push(sc);

      const t0 = (i * segSize / sampleRate).toFixed(1);
      const t1 = ((i + 1) * segSize / sampleRate).toFixed(1);
      let wl;
      if (sc > 0.95) wl = "Near-mono";
      else if (sc > 0.7) wl = "Narrow";
      else if (sc > 0.4) wl = "Moderate";
      else if (sc > 0.0) wl = "Wide";
      else wl = "Out-of-phase";
      emit(`  ${t0.padStart(5)}s - ${t1.padStart(5)}s  ${(sc >= 0 ? "+" : "") + sc.toFixed(3).padStart(5)}   ${wl}`);
    }
  }

  // ── Frequency band analysis ────────────────────────────────────────────
  const bandData = {};
  status("Computing frequency band analysis...");

  emit();
  emit("-- FREQUENCY BAND ANALYSIS " + "-".repeat(35));
  if (isStereo) {
    emit(`  ${"Band".padEnd(20)} ${"RMS L".padStart(7)} ${"RMS R".padStart(7)} ${"Avg".padStart(7)}  ${"Crest".padStart(6)}`);
    emit(`  ${"-".repeat(20)} ${"-".repeat(7)} ${"-".repeat(7)} ${"-".repeat(7)}  ${"-".repeat(6)}`);
  } else {
    emit(`  ${"Band".padEnd(20)} ${"RMS".padStart(7)}  ${"Crest".padStart(6)}`);
    emit(`  ${"-".repeat(20)} ${"-".repeat(7)}  ${"-".repeat(6)}`);
  }

  for (const [name, lo, hi] of FREQ_BANDS) {
    const hiEff = Math.min(hi, Math.floor(sampleRate / 2) - 1);
    if (lo >= hiEff) continue;

    const fl = bandFilter(left, lo, hiEff, sampleRate);
    const fr = isStereo ? bandFilter(right, lo, hiEff, sampleRate) : fl;

    const rmsBl = rms(fl);
    const rmsBr = isStereo ? rms(fr) : rmsBl;
    const rmsBa = isStereo ? Math.sqrt((rmsBl * rmsBl + rmsBr * rmsBr) / 2) : rmsBl;

    let pkBa = 0;
    for (let i = 0; i < fl.length; i++) { const a = Math.abs(fl[i]); if (a > pkBa) pkBa = a; }
    if (isStereo) for (let i = 0; i < fr.length; i++) { const a = Math.abs(fr[i]); if (a > pkBa) pkBa = a; }

    const dbRmsBa = dbVal(rmsBa);
    const dbPkBa = dbVal(pkBa);
    const crestB = (isFinite(dbPkBa) && isFinite(dbRmsBa)) ? dbPkBa - dbRmsBa : 0;

    bandData[name] = { rms_l: rmsBl, rms_r: rmsBr, rms_avg: rmsBa, peak: pkBa, crest: crestB };

    const hzLabel = `${name} (${lo}-${hiEff})`;
    if (isStereo) {
      emit(`  ${hzLabel.padEnd(20)} ${fmtDb(dbVal(rmsBl), 1).padStart(7)} ${fmtDb(dbVal(rmsBr), 1).padStart(7)} ${fmtDb(dbRmsBa, 1).padStart(7)}  ${crestB.toFixed(1)} dB`);
    } else {
      emit(`  ${hzLabel.padEnd(20)} ${fmtDb(dbRmsBa, 1).padStart(7)}  ${crestB.toFixed(1)} dB`);
    }
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  emit();
  emit("=".repeat(62));
  emit("  K-weighted LUFS computed per ITU-R BS.1770-4.");
  emit("  Band analysis uses cascaded 2nd-order Butterworth filters.");
  emit("=".repeat(62));

  // ── Build timeline data ────────────────────────────────────────────────
  const timelineData = [];
  for (let i = 0; i < actualSegs; i++) {
    timelineData.push([
      i * segSize / sampleRate,
      (i + 1) * segSize / sampleRate,
      segDb[i]
    ]);
  }

  // ── Build analysis dict ────────────────────────────────────────────────
  const analysis = {
    file: fileName, size_mb: fileSize / (1024 * 1024),
    bits: bitsPerSample, sr: sampleRate, channels,
    stereo: isStereo, duration, nframes,
    peak_l: peakL, peak_r: peakR, peak,
    tp_l: tpL, tp_r: tpR, tp,
    clips_l: clipsL, clips_r: isStereo ? clipsR : 0,
    clips: clipsL + (isStereo ? clipsR : 0),
    rms_l: rmsL, rms_r: rmsR, rms_avg: rmsAvg,
    crest_l: cfL, crest_r: cfR,
    lufs_i: lufsI, lufs_s_max: lufsSMax, lufs_m_max: lufsMMax,
    lufs_k: lufsK, lufs_k_s_max: lufsKSMax, lufs_k_m_max: lufsKMMax,
    lra,
    dc_l: dcL, dc_r: isStereo ? dcR : 0,
    corr, rms_mid: rmsMid, rms_side: rmsSide, ms_ratio: msRatio,
    rms_timeline: timelineData,
    band_data: bandData, seg_corrs: segCorrs,
    text: lines.join("\n"),
  };

  post("analysis", { data: analysis });
  post("done", {});
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { type, buffer, fileName, fileSize } = e.data;
  if (type === "analyze") {
    try {
      analyze(buffer, fileName, fileSize);
    } catch (err) {
      self.postMessage({ type: "error", text: err.message || String(err) });
    }
  }
};
