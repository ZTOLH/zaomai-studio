/*!
 * ZAOMAI STUDIO - DSP 验收测试（纯 Node，无第三方依赖）
 * 运行：node test/dsp.test.cjs
 * 覆盖 CONTRACT.md 4.8 的 10 项；最后输出 PASS n/10，失败退出码非 0。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dsp = require(path.join(__dirname, '..', 'src', 'dsp.js'));

const SR = 48000;
const DUR = 8;
const N = SR * DUR;
const PRESET_IDS = ['normal', 'super', 'promax', 'firecracker'];
const OUT_DIR = __dirname;

/* ---------------- 测试信号（固定种子，可复现） ---------------- */
function makeTestSignal() {
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const v = 0.35 * Math.sin(2 * Math.PI * 60 * t) +
      0.2 * Math.sin(2 * Math.PI * 440 * t) +
      0.12 * Math.sin(2 * Math.PI * 3000 * t) +
      0.05 * (rnd() * 2 - 1);
    L[i] = v;
    R[i] = v * 0.9;
  }
  return [L, R];
}

const SIG = makeTestSignal();
const SIG_SNAPSHOT = SIG.map((c) => Float32Array.from(c));
const CACHE = Object.create(null);

function getOut(id) {
  if (!CACHE[id]) CACHE[id] = dsp.process(SIG, SR, id);
  return CACHE[id];
}

function assertFiniteChannels(channels, label) {
  assert.ok(Array.isArray(channels) && channels.length >= 1, label + ': channels 必须是数组');
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c];
    assert.ok(x instanceof Float32Array, label + ': 声道必须是 Float32Array');
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      assert.ok(Number.isFinite(v), label + ': 发现 NaN/Inf at ch' + c + '[' + i + ']');
      assert.ok(Math.abs(v) <= 1.0001, label + ': 样本超过 ±1.0001: ' + v);
    }
  }
}

/* ---------------- RBJ 双二阶（测试用） ---------------- */
function biquad(kind, sr, freq, q) {
  const w = 2 * Math.PI * Math.max(10, Math.min(freq, sr * 0.45)) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  let b0, b1, b2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  if (kind === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function bandRms(channels, sr, lo, hi) {
  const hp = biquad('highpass', sr, lo, 0.7071067811865476);
  const lp = biquad('lowpass', sr, hi, 0.7071067811865476);
  let sum = 0, count = 0;
  for (const ch of channels) {
    const y = applyBiquad(applyBiquad(ch, hp), lp);
    for (let i = 0; i < y.length; i++) { sum += y[i] * y[i]; count++; }
  }
  return Math.sqrt(sum / Math.max(1, count));
}

function transientDensity(channels, sr, threshold, refractoryMs) {
  const hp = biquad('highpass', sr, 5000, 0.7071067811865476);
  const lp = biquad('lowpass', sr, 12000, 0.7071067811865476);
  const band = channels.map((ch) => applyBiquad(applyBiquad(ch, hp), lp));
  const win = Math.max(1, Math.round(sr * 0.0025));
  const hop = Math.max(1, Math.round(sr * 0.0005));
  const env = [];
  for (let s = 0; s + win <= band[0].length; s += hop) {
    let acc = 0;
    for (const y of band) {
      for (let i = s; i < s + win; i++) acc += y[i] * y[i];
    }
    env.push(Math.sqrt(acc / (win * band.length)));
  }
  let max = 0;
  for (const v of env) if (v > max) max = v;
  const refractoryFrames = Math.max(1, Math.round((refractoryMs / 1000) / 0.0005));
  let count = 0, last = -1e9;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] >= env[i - 1] && env[i] > env[i + 1] &&
        env[i] > threshold && (i - last) >= refractoryFrames) {
      count++;
      last = i;
    }
  }
  return { count, max };
}

/* ---------------- 最小 32-bit float WAV writer ---------------- */
function writeWav(file, channels, sr) {
  const nch = channels.length;
  const n = channels[0].length;
  const dataBytes = n * nch * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);       /* IEEE float */
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * nch * 4, 28);
  buf.writeUInt16LE(nch * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      buf.writeFloatLE(channels[c][i], off);
      off += 4;
    }
  }
  fs.writeFileSync(file, buf);
  return file;
}

function ffmpegEbur128(file) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'
  ], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return null;
  const text = (r.stderr || '') + (r.stdout || '');
  const iMatches = [...text.matchAll(/I:\s+(-?[0-9.]+)\s+LUFS/g)];
  const tpMatch = text.match(/True peak:[\s\S]*?Peak:\s+(-?[0-9.]+)\s+dBFS/);
  if (!iMatches.length || !tpMatch) {
    throw new Error('无法解析 ffmpeg ebur128 输出:\n' + text.slice(-800));
  }
  return {
    integrated: parseFloat(iMatches[iMatches.length - 1][1]),
    truePeak: parseFloat(tpMatch[1])
  };
}

/* ---------------- 测试框架 ---------------- */
let passed = 0;
let failed = 0;
let total = 0;
const failures = [];

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('PASS ' + total + '/10  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('FAIL ' + total + '/10  ' + name + '  ->  ' + (err && err.message ? err.message : err));
  }
}

/* ================================================================== */
/* 1. 四档输出有限、无 NaN/Inf、|x|<=1.0001、等长、输入不被修改        */
/* ================================================================== */
test('四档输出有限、无 NaN/Inf、|x|<=1.0001、等长、输入不被修改', () => {
  for (const id of PRESET_IDS) {
    const out = getOut(id);
    assert.strictEqual(out.presetId, id);
    assert.strictEqual(out.sampleRate, SR);
    assert.strictEqual(out.channels.length, SIG.length);
    assert.strictEqual(out.channels[0].length, SIG[0].length);
    assertFiniteChannels(out.channels, id);
    for (const key of ['lufs', 'truePeakDb', 'peakDb', 'rmsDb', 'crestDb', 'durationSec', 'processingMs']) {
      assert.ok(Number.isFinite(out.stats[key]), id + ': stats.' + key + ' 不是有限数');
    }
    assert.ok(out.stats.applied && typeof out.stats.applied === 'object', id + ': 缺少 applied');
  }
  for (let c = 0; c < SIG.length; c++) {
    for (let i = 0; i < SIG[c].length; i++) {
      assert.strictEqual(SIG[c][i], SIG_SNAPSHOT[c][i], 'process 修改了输入数组');
    }
  }
});

/* ================================================================== */
/* 2. 四档 LUFS 在 target±0.8、TP<=ceiling+0.1、响度单调上升           */
/* ================================================================== */
test('四档 LUFS 在 target±0.8、TP<=ceiling+0.1、响度单调上升', () => {
  let prev = -Infinity;
  for (const id of PRESET_IDS) {
    const preset = dsp.getPreset(id);
    const s = getOut(id).stats;
    assert.strictEqual(s.applied.targetLufs, preset.targetLufs, id + ': applied.targetLufs 缺失/不符');
    assert.strictEqual(s.applied.ceilingDb, preset.ceilingDb, id + ': applied.ceilingDb 缺失/不符');
    const diff = Math.abs(s.lufs - preset.targetLufs);
    assert.ok(diff <= 0.8, id + ': LUFS ' + s.lufs.toFixed(2) +
      ' 偏离目标 ' + preset.targetLufs.toFixed(1) + ' 超过 0.8 (差 ' + diff.toFixed(2) + ')');
    assert.ok(s.truePeakDb <= preset.ceilingDb + 0.1 + 1e-6,
      id + ': TP ' + s.truePeakDb.toFixed(2) + ' 超过 ceiling+0.1 ' + (preset.ceilingDb + 0.1).toFixed(2));
    assert.ok(s.lufs > prev + 0.2, id + ': 响度未比上一档更高 (' + prev.toFixed(2) + ' -> ' + s.lufs.toFixed(2) + ')');
    prev = s.lufs;
  }
});

/* ================================================================== */
/* 3. 8–16k 高频能量相对输入上升、crest 下降                           */
/* ================================================================== */
test('8–16k 高频能量相对输入上升、crest 下降', () => {
  const inStats = dsp.measure(SIG, SR);
  const inBand = bandRms(SIG, SR, 8000, 16000);
  assert.ok(inBand > 0, '输入 8–16k 能量应大于 0');
  for (const id of PRESET_IDS) {
    const out = getOut(id);
    const band = bandRms(out.channels, SR, 8000, 16000);
    assert.ok(band > inBand * 1.10, id + ': 8–16k 能量未明显上升 (' +
      inBand.toFixed(5) + ' -> ' + band.toFixed(5) + ')');
    assert.ok(out.stats.crestDb < inStats.crestDb,
      id + ': crest 未下降 (' + inStats.crestDb.toFixed(2) + ' -> ' + out.stats.crestDb.toFixed(2) + ')');
  }
});

/* ================================================================== */
/* 4. measure 与 ffmpeg ebur128(peak=true) 交叉验证                     */
/* ================================================================== */
test('measure 与 ffmpeg ebur128(peak=true) 交叉验证', () => {
  const cases = [{ name: 'input', channels: SIG, stats: dsp.measure(SIG, SR) }];
  for (const id of PRESET_IDS) {
    const out = getOut(id);
    cases.push({ name: id, channels: out.channels, stats: out.stats });
  }
  let ffmpegOk = true;
  let skipped = false;
  for (const item of cases) {
    const wav = path.join(OUT_DIR, '_dsp_test_' + item.name + '.wav');
    writeWav(wav, item.channels, SR);
    let ff;
    try {
      ff = ffmpegEbur128(wav);
    } catch (err) {
      if (/ENOENT|not found|不是内部或外部命令/i.test(String(err && err.message))) {
        ffmpegOk = false;
        skipped = true;
        break;
      }
      throw err;
    }
    if (!ff) { ffmpegOk = false; skipped = true; break; }
    const dLufs = Math.abs(item.stats.lufs - ff.integrated);
    const dTp = Math.abs(item.stats.truePeakDb - ff.truePeak);
    assert.ok(dLufs <= 0.3, item.name + ': LUFS 与 ffmpeg 差 ' + dLufs.toFixed(2) + ' > 0.3');
    assert.ok(dTp <= 0.5, item.name + ': TP 与 ffmpeg 差 ' + dTp.toFixed(2) + ' > 0.5');
    console.log('       ' + item.name + ': ours ' + item.stats.lufs.toFixed(2) + ' LUFS / ' +
      item.stats.truePeakDb.toFixed(2) + ' dBTP, ffmpeg ' + ff.integrated.toFixed(1) + ' LUFS / ' +
      ff.truePeak.toFixed(1) + ' dBTP');
  }
  if (skipped || !ffmpegOk) console.log('       SKIP: 未找到可用 ffmpeg，已跳过交叉验证（Node 内测量仍有效）');
});

/* ================================================================== */
/* 5. 两次 process 逐样本相等（确定性）                                */
/* ================================================================== */
test('两次 process 逐样本相等（确定性）', () => {
  for (const id of PRESET_IDS) {
    const a = getOut(id);
    const b = dsp.process(SIG, SR, id);
    assert.strictEqual(a.channels.length, b.channels.length);
    for (let c = 0; c < a.channels.length; c++) {
      assert.strictEqual(a.channels[c].length, b.channels[c].length);
      for (let i = 0; i < a.channels[c].length; i++) {
        assert.strictEqual(a.channels[c][i], b.channels[c][i],
          id + ': 两次 process 不一致 ch' + c + '[' + i + ']');
      }
    }
  }
});

/* ================================================================== */
/* 6. 边界与健壮性：单/双声道、44.1k/8k/192k、静音、100 samples        */
/* ================================================================== */
test('边界与健壮性：单/双声道、44.1k/8k/192k、静音、100 samples', () => {
  const mono = new Float32Array(SR);
  for (let i = 0; i < mono.length; i++) {
    mono[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / SR);
  }
  const monoOut = dsp.process([mono], SR, 'normal');
  assert.strictEqual(monoOut.channels.length, 1);
  assert.strictEqual(monoOut.channels[0].length, mono.length);
  assertFiniteChannels(monoOut.channels, 'mono');

  const sr441 = 44100;
  const n441 = sr441;
  const l441 = new Float32Array(n441), r441 = new Float32Array(n441);
  for (let i = 0; i < n441; i++) {
    l441[i] = 0.3 * Math.sin(2 * Math.PI * 100 * i / sr441);
    r441[i] = 0.25 * Math.sin(2 * Math.PI * 440 * i / sr441);
  }
  const o441 = dsp.process([l441, r441], sr441, 'super');
  assert.strictEqual(o441.sampleRate, sr441);
  assert.strictEqual(o441.channels[0].length, n441);
  assertFiniteChannels(o441.channels, '44.1k');

  const sr8 = 8000;
  const n8 = sr8 / 2;
  const m8 = new Float32Array(n8);
  for (let i = 0; i < n8; i++) m8[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / sr8);
  const o8 = dsp.process([m8], sr8, 'firecracker');
  assert.strictEqual(o8.sampleRate, sr8);
  assert.strictEqual(o8.channels[0].length, n8);
  assertFiniteChannels(o8.channels, '8k');

  const sr192 = 192000;
  const n192 = sr192 / 2;
  const l192 = new Float32Array(n192), r192 = new Float32Array(n192);
  for (let i = 0; i < n192; i++) {
    l192[i] = 0.2 * Math.sin(2 * Math.PI * 500 * i / sr192);
    r192[i] = 0.15 * Math.sin(2 * Math.PI * 1500 * i / sr192);
  }
  const o192 = dsp.process([l192, r192], sr192, 'normal');
  assert.strictEqual(o192.sampleRate, sr192);
  assert.strictEqual(o192.channels[0].length, n192);
  assertFiniteChannels(o192.channels, '192k');

  const silent = [new Float32Array(SR), new Float32Array(SR)];
  const so = dsp.process(silent, SR, 'firecracker');
  assertFiniteChannels(so.channels, 'silence');
  assert.ok(Math.abs(so.stats.lufs + 70) < 1e-6, '静音 LUFS 应为 -70，实际 ' + so.stats.lufs);
  assert.ok(Math.abs(so.stats.truePeakDb + 120) < 1e-6, '静音 TP 应为 -120，实际 ' + so.stats.truePeakDb);
  assert.ok(Math.abs(so.stats.peakDb + 120) < 1e-6, '静音 peak 应为 -120');
  assert.ok(Math.abs(so.stats.rmsDb + 120) < 1e-6, '静音 RMS 应为 -120');
  assert.ok(Math.abs(so.stats.crestDb) < 1e-6, '静音 crest 应为 0');
  for (const ch of so.channels) for (const v of ch) assert.strictEqual(v, 0, '静音输出应全 0');

  const tiny = [new Float32Array(100).fill(0.2), new Float32Array(100).fill(-0.2)];
  const to = dsp.process(tiny, SR, 'firecracker');
  assert.strictEqual(to.channels[0].length, 100, '100 samples 输出长度应保持');
  assertFiniteChannels(to.channels, '100 samples');
});

/* ================================================================== */
/* 7. measure(输出) 与 stats 一致                                      */
/* ================================================================== */
test('measure(输出) 与 stats 一致', () => {
  for (const id of PRESET_IDS) {
    const out = getOut(id);
    const m = dsp.measure(out.channels, out.sampleRate);
    assert.ok(Math.abs(m.lufs - out.stats.lufs) <= 0.05, id + ': measure LUFS 差 ' +
      Math.abs(m.lufs - out.stats.lufs).toFixed(4));
    assert.ok(Math.abs(m.truePeakDb - out.stats.truePeakDb) <= 0.05, id + ': measure TP 差 ' +
      Math.abs(m.truePeakDb - out.stats.truePeakDb).toFixed(4));
    assert.ok(Math.abs(m.peakDb - out.stats.peakDb) <= 0.05, id + ': measure peak 差过大');
    assert.ok(Math.abs(m.rmsDb - out.stats.rmsDb) <= 0.05, id + ': measure RMS 差过大');
    assert.ok(Math.abs(m.crestDb - out.stats.crestDb) <= 0.05, id + ': measure crest 差过大');
  }
});

/* ================================================================== */
/* 8. firecracker 的 5–12k 瞬态密度明显高于 promax                     */
/* ================================================================== */
test('firecracker 的 5–12k 瞬态密度明显高于 promax', () => {
  const pm = transientDensity(getOut('promax').channels, SR, 0.24, 30);
  const fc = transientDensity(getOut('firecracker').channels, SR, 0.24, 30);
  console.log('       promax: count=' + pm.count + ' max=' + pm.max.toFixed(3) +
    ', firecracker: count=' + fc.count + ' max=' + fc.max.toFixed(3));
  assert.ok(fc.max > pm.max * 1.2, 'firecracker 5–12k 包络峰值应明显高于 promax');
  assert.ok(fc.count >= 8, 'firecracker 5–12k 瞬态数量应 >= 8，实际 ' + fc.count);
  assert.ok(fc.count > pm.count * 2 + 2, 'firecracker 瞬态密度应远高于 promax');
});

/* ================================================================== */
/* 9. 30s 立体声 48k firecracker 处理耗时 < 8s                         */
/* ================================================================== */
test('30s 立体声 48k firecracker 处理耗时 < 8s', () => {
  const sr = 48000;
  const n = sr * 30;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = 0.32 * Math.sin(2 * Math.PI * 55 * t) +
      0.18 * Math.sin(2 * Math.PI * 220 * t) +
      0.1 * Math.sin(2 * Math.PI * 2500 * t) +
      0.04 * (rnd() * 2 - 1);
    L[i] = v;
    R[i] = v * 0.85;
  }
  const t0 = process.hrtime.bigint();
  const out = dsp.process([L, R], sr, 'firecracker');
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(out.channels[0].length, n);
  assertFiniteChannels(out.channels, '30s firecracker');
  console.log('       30s stereo 48k firecracker: ' + elapsedMs.toFixed(0) + ' ms (stats ' +
    out.stats.processingMs.toFixed(0) + ' ms)');
  assert.ok(elapsedMs < 8000, '30s firecracker 处理耗时 ' + elapsedMs.toFixed(0) + ' ms >= 8s');
});

/* ================================================================== */
/* 10. overrides 越界 clamp、非法 presetId / 空 channels 抛中文错误     */
/* ================================================================== */
test('overrides 越界 clamp、非法 presetId / 空 channels 抛中文错误', () => {
  const out = dsp.process(SIG, SR, 'normal', {
    driveDb: 999,
    clipThreshold: -5,
    lowBoostDb: -99,
    highBoostDb: 999,
    crushBits: 1,
    sampleHold: 99,
    firecrackerDensity: -3,
    unknownKey: 123
  });
  const a = out.stats.applied;
  assert.strictEqual(a.driveDb, 36);
  assert.strictEqual(a.clipThreshold, 0.02);
  assert.strictEqual(a.lowBoostDb, -6);
  assert.strictEqual(a.highBoostDb, 30);
  assert.strictEqual(a.crushBits, 2);
  assert.strictEqual(a.sampleHold, 8);
  assert.strictEqual(a.firecrackerDensity, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(a, 'unknownKey'), '未知 override 键不应出现在 applied');
  assertFiniteChannels(out.channels, 'overrides clamped');

  assert.throws(() => dsp.process(SIG, SR, 'nope'), /未知的预设 ID|未知.*预设/);
  assert.throws(() => dsp.getPreset('nope'), /未知的预设 ID|未知.*预设/);
  assert.throws(() => dsp.process([], SR), /音频数据为空|至少需要 1 个声道|channels/);
  assert.throws(() => dsp.measure([], SR), /音频数据为空|至少需要 1 个声道|channels/);

  const dirty = [new Float32Array([NaN, Infinity, -Infinity, 0.5, -0.25])];
  const cleaned = dsp.process(dirty, SR, 'normal');
  assertFiniteChannels(cleaned.channels, 'NaN/Inf 清洗');
});

/* ================================================================== */
if (failed > 0) {
  console.log('\nFAIL ' + failed + '/' + (passed + failed) + ' 项失败：');
  for (const f of failures) {
    console.log('  - ' + f.name + ': ' + (f.err && f.err.stack ? f.err.stack.split('\n')[0] : f.err));
  }
  process.exitCode = 1;
} else {
  console.log('\nPASS ' + passed + '/' + (passed + failed));
}
