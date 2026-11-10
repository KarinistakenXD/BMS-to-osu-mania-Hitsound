export interface SampleFingerprint {
  exact: string;
  pitch: number;
  spectrum: Float32Array;
  envelope: Float32Array;
  waveform: Float32Array;
  duration: number;
  singlePartial: boolean;
}

const FFT_SIZE = 4096;
const SPECTRUM_BANDS = 44;
const WINDOW = Float64Array.from({ length: FFT_SIZE }, (_, i) =>
  .5 - .5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

function powerSpectrum(data: Float32Array, start: number): Float64Array {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0, reversed = 0; i < FFT_SIZE; i++) {
    re[reversed] = (data[start + i] ?? 0) * WINDOW[i];
    let bit = FFT_SIZE >> 1;
    while (reversed & bit) { reversed ^= bit; bit >>= 1; }
    reversed ^= bit;
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size >> 1;
    for (let offset = 0; offset < half; offset++) {
      const angle = -2 * Math.PI * offset / size;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let i = offset; i < FFT_SIZE; i += size) {
        const j = i + half;
        const x = re[j] * cos - im[j] * sin;
        const y = re[j] * sin + im[j] * cos;
        re[j] = re[i] - x;
        im[j] = im[i] - y;
        re[i] += x;
        im[i] += y;
      }
    }
  }
  return Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => re[i] ** 2 + im[i] ** 2);
}

function peakBin(power: Float64Array, i: number): number {
  const left = Math.log(power[i - 1] + 1e-20);
  const center = Math.log(power[i] + 1e-20);
  const right = Math.log(power[i + 1] + 1e-20);
  const denominator = left - 2 * center + right;
  return i + (denominator ? .5 * (left - right) / denominator : 0);
}

function normalize(values: Float32Array): void {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return;
  for (let i = 0; i < values.length; i++) values[i] = Math.sqrt(values[i] / total);
}

export function fingerprintSample(buffer: AudioBuffer, trimMs = 0): SampleFingerprint | undefined {
  if (!buffer.length) return undefined;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const envelope = new Float32Array(16);
  let hash = 2166136261;
  let strongest = channels[0];
  let mostEnergy = 0;
  for (const data of channels) {
    const levels = new Float64Array(envelope.length);
    for (let i = 0; i < 512; i++) {
      const value = data[Math.floor(i * (data.length - 1) / 511)];
      hash = Math.imul(hash ^ Math.round(value * 32768), 16777619);
      levels[i >> 5] += value * value;
    }
    let energy = 0;
    for (let i = 0; i < levels.length; i++) {
      envelope[i] = Math.max(envelope[i], levels[i]);
      energy += levels[i];
    }
    if (energy > mostEnergy) { strongest = data; mostEnergy = energy; }
  }
  if (mostEnergy < 1e-5) return undefined;
  normalize(envelope);
  const waveform = new Float32Array(256);
  let waveformEnergy = 0;
  for (let i = 0; i < waveform.length; i++) {
    const index = i * (strongest.length - 1) / (waveform.length - 1);
    const left = Math.floor(index);
    const mix = index - left;
    const value = strongest[left] * (1 - mix) + (strongest[left + 1] ?? 0) * mix;
    waveform[i] = value;
    waveformEnergy += value * value;
  }
  if (waveformEnergy > 1e-5) {
    const norm = Math.sqrt(waveformEnergy);
    for (let i = 0; i < waveform.length; i++) waveform[i] /= norm;
  } else {
    waveform.fill(0);
  }

  const onset = Math.min(buffer.length - 1, Math.round(trimMs * buffer.sampleRate / 1000));
  let start = onset;
  let bestEnergy = -1;
  for (const offset of [0, FFT_SIZE / 4, FFT_SIZE / 2, FFT_SIZE]) {
    const candidate = onset + offset;
    let energy = 0;
    const end = Math.min(strongest.length, candidate + FFT_SIZE);
    for (let i = candidate; i < end; i += 8) {
      energy += strongest[i] ** 2 * WINDOW[i - candidate];
    }
    if (energy > bestEnergy) { start = candidate; bestEnergy = energy; }
  }

  const power = powerSpectrum(strongest, start);
  const minimumBin = Math.max(2, Math.ceil(32 * FFT_SIZE / buffer.sampleRate));
  let dominant = minimumBin;
  let total = 0;
  for (let i = minimumBin; i < power.length - 1; i++) {
    total += power[i];
    if (power[i] > power[dominant]) dominant = i;
  }

  const spectrum = new Float32Array(SPECTRUM_BANDS);
  const strength = power[dominant - 1] + power[dominant] + power[dominant + 1];
  const pitchBin = strength > total * .22 && dominant < power.length - 2 ? peakBin(power, dominant) : 0;
  let partials = 0;
  if (pitchBin) {
    for (let i = minimumBin; i < power.length - 1; i++) {
      if (power[i] < power[dominant] * .003 || power[i] <= power[i - 1] || power[i] <= power[i + 1]) continue;
      const position = Math.log2(peakBin(power, i) / pitchBin) * 6 + 14;
      const left = Math.floor(position);
      if (left < 0 || left + 1 >= spectrum.length) continue;
      const level = power[i - 1] + power[i] + power[i + 1];
      const fraction = position - left;
      spectrum[left] += level * (1 - fraction);
      spectrum[left + 1] += level * fraction;
      if (level > strength * .015) partials++;
    }
    normalize(spectrum);
  }
  return {
    exact: `${buffer.length}:${buffer.sampleRate}:${channels.length}:${hash >>> 0}`,
    pitch: pitchBin * buffer.sampleRate / FFT_SIZE,
    spectrum, envelope, waveform, duration: buffer.duration, singlePartial: partials < 2,
  };
}

function similarity(a: Float32Array, b: Float32Array): number {
  let score = 0;
  for (let i = 0; i < a.length; i++) score += a[i] * b[i];
  return score;
}

export function sampleVoiceScore(a: SampleFingerprint | undefined, b: SampleFingerprint | undefined): number {
  if (!a || !b) return 0;
  if (a.exact === b.exact) return 1.2;
  if (Math.min(a.duration, b.duration) * 4 < Math.max(a.duration, b.duration)) return 0;
  const envelope = similarity(a.envelope, b.envelope);
  if (envelope >= .975) {
    // Resampling changes pitch and duration together. Compare corresponding
    // points in the wave before relying on the looser instrument heuristic.
    const waveform = Math.abs(similarity(a.waveform, b.waveform));
    if (waveform >= .98) return 1.05 + waveform * .1;
  }
  if (!a.pitch || !b.pitch || Math.min(a.pitch, b.pitch) * 4 < Math.max(a.pitch, b.pitch)) return 0;
  const spectrum = similarity(a.spectrum, b.spectrum);
  const singlePartial = a.singlePartial || b.singlePartial;
  // shortcut: a short spectral snapshot misses some same-instrument variants, prefer separate lanes when uncertain.
  return spectrum >= .96 && envelope >= (singlePartial ? .99 : .88)
    ? spectrum * .8 + envelope * .2 : 0;
}

interface FamilyCandidate {
  id: string;
  nameKey?: string;
  fingerprint?: SampleFingerprint;
}

export function inferSampleFamilies(candidates: FamilyCandidate[]): Map<string, string> {
  const families = new Map<string, string>();
  const named = new Map<string, SampleFingerprint[]>();
  const representatives: FamilyCandidate[] = [];
  for (const { nameKey, fingerprint } of candidates) {
    if (!nameKey || !fingerprint) continue;
    const group = named.get(nameKey) ?? [];
    group.push(fingerprint);
    named.set(nameKey, group);
  }

  for (const candidate of candidates) {
    if (candidate.nameKey) {
      families.set(candidate.id, candidate.nameKey);
      continue;
    }
    let family = `id:${candidate.id}`;
    let best = 0, runnerUp = 0;
    let supported = false;
    for (const [name, samples] of named) {
      let score = 0, matches = 0;
      for (const sample of samples) {
        const current = sampleVoiceScore(candidate.fingerprint, sample);
        if (current) matches++;
        score = Math.max(score, current);
      }
      if (score > best) {
        runnerUp = best;
        best = score;
        family = name;
        supported = score > 1 || matches >= Math.min(2, samples.length);
      } else {
        runnerUp = Math.max(runnerUp, score);
      }
    }
    if (supported && (!runnerUp || best - runnerUp >= .03)) {
      families.set(candidate.id, family);
      continue;
    }

    family = `id:${candidate.id}`;
    best = 0;
    runnerUp = 0;
    for (const other of representatives) {
      const score = sampleVoiceScore(candidate.fingerprint, other.fingerprint);
      if (score > best) {
        runnerUp = best;
        best = score;
        family = `id:${other.id}`;
      } else {
        runnerUp = Math.max(runnerUp, score);
      }
    }
    if (!best || (runnerUp && best - runnerUp < .03)) {
      family = `id:${candidate.id}`;
      if (candidate.fingerprint) representatives.push(candidate);
    }
    families.set(candidate.id, family);
  }
  return families;
}
