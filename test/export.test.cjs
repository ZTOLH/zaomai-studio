#!/usr/bin/env node
/*
 * ZAOMAI STUDIO · 导出引擎自动测试（模块契约 v1 · 第 5.5 节）
 *
 * 运行：node test/export.test.cjs
 * 独立验证：
 *   - ffprobe 校验容器 / 编码 / 采样率 / 声道数 / 时长
 *   - ffmpeg 解码为裸 PCM，与输入量化结果逐字节比对（WAV/AIFF/FLAC bit-perfect）
 *   - Python zipfile 校验 ZIP 条目 CRC、UTF-8 文件名、解压内容
 *
 * 依赖（均在本机 PATH）：ffmpeg / ffprobe / python
 * 待测模块：src/exporters.js（Node 分支）+ vendor/lame.min.js（MP3）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'zaomai-export-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// ---------------------------------------------------------------------------
// 加载待测模块（Node 下先把 lamejs 挂到全局，模拟浏览器 vendor 脚本）
// ---------------------------------------------------------------------------

const LAME_PATH = path.join(ROOT, 'vendor', 'lame.min.js');
if (!fs.existsSync(LAME_PATH)) {
  console.error('缺少 vendor/lame.min.js，无法测试 MP3；请先恢复该文件');
  process.exit(1);
}
vm.runInThisContext(fs.readFileSync(LAME_PATH, 'utf8'), { filename: LAME_PATH });
if (typeof lamejs === 'undefined' || !lamejs || !lamejs.Mp3Encoder) {
  console.error('vendor/lame.min.js 未正确挂载全局 lamejs');
  process.exit(1);
}
const ZE = require(path.join(ROOT, 'src', 'exporters.js'));

// ---------------------------------------------------------------------------
// 测试框架
// ---------------------------------------------------------------------------

let pass = 0;
const failures = [];
let fileSeq = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push({ name: name, err: err });
    console.log('  \u2717 ' + name);
    const msg = String(err && err.message ? err.message : err);
    console.log('      ' + msg.split('\n')[0]);
  }
}

function section(title) {
  console.log('\n[' + title + ']');
}

// ---------------------------------------------------------------------------
// 子进程 / 媒体工具
// ---------------------------------------------------------------------------

function run(cmd, args) {
  const r = spawnSync(cmd, args, { maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' });
  return {
    status: r.status,
    stdout: r.stdout || Buffer.alloc(0),
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

function runOk(cmd, args, what) {
  const r = run(cmd, args);
  if (r.error) throw new Error((what || cmd) + ' 无法启动：' + r.error);
  if (r.status !== 0) {
    throw new Error((what || cmd) + ' 退出码 ' + r.status + '：' + r.stderr.trim().slice(-800));
  }
  return r;
}

function ffprobe(file) {
  const r = runOk('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 'ffprobe');
  return JSON.parse(r.stdout.toString('utf8'));
}

function audioStream(info) {
  const list = (info.streams || []).filter(function (s) { return s.codec_type === 'audio'; });
  if (!list.length) throw new Error('ffprobe 未发现音频流');
  return list[0];
}

function durationOf(info) {
  const st = audioStream(info);
  return parseFloat((info.format && info.format.duration) || st.duration || 'NaN');
}

function decode(file, fmt) {
  const out = tmpFile(fmt + '.raw');
  const r = run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-f', fmt, out]);
  if (r.status !== 0) throw new Error('ffmpeg 解码 ' + path.basename(file) + ' 失败：' + r.stderr.trim());
  return { bytes: fs.readFileSync(out), stderr: r.stderr };
}

function tmpFile(ext) {
  const p = path.join(WORK, 'f' + (++fileSeq) + (ext ? '.' + ext : ''));
  return p;
}

function writeTmp(bytes, ext) {
  const p = tmpFile(ext);
  fs.writeFileSync(p, bytes);
  return p;
}

// ---------------------------------------------------------------------------
// 量化 / 参考 PCM（与契约 3.1 一致：clamp [-1,1]，round(scale) 后饱和）
// ---------------------------------------------------------------------------

function q16(x) {
  if (!(x === x)) return 0;
  if (x > 1) x = 1; else if (x < -1) x = -1;
  let v = Math.round(x * 32768);
  if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
  return v;
}

function q24(x) {
  if (!(x === x)) return 0;
  if (x > 1) x = 1; else if (x < -1) x = -1;
  let v = Math.round(x * 8388608);
  if (v > 8388607) v = 8388607; else if (v < -8388608) v = -8388608;
  return v;
}

function cleanFloat(x) {
  if (!(x === x)) return 0;
  if (x === Infinity || x === -Infinity) return 0;
  return x;
}

function pcm16(chs) {
  const n = chs[0].length, nch = chs.length;
  const b = Buffer.alloc(n * nch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) b.writeInt16LE(q16(chs[c][i]), (i * nch + c) * 2);
  return b;
}

function pcm16be(chs) {
  const n = chs[0].length, nch = chs.length;
  const b = Buffer.alloc(n * nch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) b.writeInt16BE(q16(chs[c][i]), (i * nch + c) * 2);
  return b;
}

function pcm24(chs) {
  const n = chs[0].length, nch = chs.length;
  const b = Buffer.alloc(n * nch * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      let v = q24(chs[c][i]);
      if (v < 0) v += 16777216;
      const off = (i * nch + c) * 3;
      b[off] = v & 0xFF;
      b[off + 1] = (v >>> 8) & 0xFF;
      b[off + 2] = (v >>> 16) & 0xFF;
    }
  }
  return b;
}

function pcmF32(chs) {
  const n = chs[0].length, nch = chs.length;
  const out = new Float32Array(n * nch);
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) out[i * nch + c] = cleanFloat(chs[c][i]);
  return Buffer.from(out.buffer);
}

function comparePCM(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new Error(label + ' 字节长度不一致：' + actual.length + ' != ' + expected.length);
  }
  let diffs = 0, first = -1, maxAbs = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = actual[i] - expected[i];
    if (d !== 0) {
      diffs++;
      if (first < 0) first = i;
      if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    }
  }
  if (diffs !== 0) {
    throw new Error(label + ' 有 ' + diffs + '/' + actual.length + ' 字节不一致（首个 @' + first + '，最大差 ' + maxAbs + '）');
  }
}

// ---------------------------------------------------------------------------
// 测试音（确定性：正弦 + 噪声 + 瞬态，峰值 <= 0.98）
// ---------------------------------------------------------------------------

function makeTone(seconds, sampleRate, channelCount) {
  const n = Math.round(seconds * sampleRate);
  const chs = [];
  let seed = 0x1234567;
  function rnd() {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  }
  for (let c = 0; c < channelCount; c++) chs.push(new Float32Array(n));
  const freqs = [440, 660, 330];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const noise = rnd() * 2 - 1;
    for (let c = 0; c < channelCount; c++) {
      let v = 0.5 * Math.sin(2 * Math.PI * freqs[c % freqs.length] * t + c * 1.1) +
        0.2 * Math.sin(2 * Math.PI * 60 * t);
      v += 0.03 * noise;
      if (t > 0.5 && t < 0.502) v += 0.4;
      if (v > 0.98) v = 0.98; else if (v < -0.98) v = -0.98;
      chs[c][i] = v;
    }
  }
  return chs;
}

// ---------------------------------------------------------------------------
// 容器头部解析
// ---------------------------------------------------------------------------

function riffChunks(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', '缺少 RIFF 标识');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE', '缺少 WAVE 标识');
  const chunks = [];
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    chunks.push({ id: id, size: size, offset: off + 8 });
    off += 8 + size + (size & 1);
  }
  return { riffSize: buf.readUInt32LE(4), chunks: chunks };
}

function parseWav(buf) {
  const parsed = riffChunks(buf);
  const chunks = parsed.chunks;
  function pick(id) { return chunks.filter(function (c) { return c.id === id; })[0] || null; }
  const fmt = pick('fmt ');
  const data = pick('data');
  const fact = pick('fact');
  assert.ok(fmt, '缺少 fmt chunk');
  assert.ok(data, '缺少 data chunk');
  return {
    riffSize: parsed.riffSize,
    chunks: chunks,
    fmtSize: fmt.size,
    audioFormat: buf.readUInt16LE(fmt.offset),
    channels: buf.readUInt16LE(fmt.offset + 2),
    sampleRate: buf.readUInt32LE(fmt.offset + 4),
    byteRate: buf.readUInt32LE(fmt.offset + 8),
    blockAlign: buf.readUInt16LE(fmt.offset + 12),
    bits: buf.readUInt16LE(fmt.offset + 14),
    dataSize: data.size,
    dataOffset: data.offset,
    factSamples: fact ? buf.readUInt32LE(fact.offset) : null,
  };
}

function parseAiff(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'FORM', '缺少 FORM 标识');
  assert.equal(buf.toString('ascii', 8, 12), 'AIFF', '缺少 AIFF 标识');
  const formSize = buf.readUInt32BE(4);
  const chunks = [];
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    chunks.push({ id: id, size: size, offset: off + 8 });
    off += 8 + size + (size & 1);
  }
  const comm = chunks.filter(function (c) { return c.id === 'COMM'; })[0];
  const ssnd = chunks.filter(function (c) { return c.id === 'SSND'; })[0];
  assert.ok(comm, '缺少 COMM chunk');
  assert.ok(ssnd, '缺少 SSND chunk');
  return {
    formSize: formSize,
    chunks: chunks,
    commSize: comm.size,
    channels: buf.readUInt16BE(comm.offset),
    frames: buf.readUInt32BE(comm.offset + 2),
    bits: buf.readUInt16BE(comm.offset + 6),
    rateBytes: buf.slice(comm.offset + 8, comm.offset + 18),
    ssndSize: ssnd.size,
    dataOffset: ssnd.offset + 8,
    dataSize: ssnd.size - 8,
  };
}

function parseFlac(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'fLaC', '缺少 fLaC 标识');
  const blocks = [];
  let off = 4;
  let last = false;
  while (!last) {
    assert.ok(off + 4 <= buf.length, 'FLAC metadata 越界');
    const head = buf[off];
    last = (head & 0x80) !== 0;
    const type = head & 0x7F;
    const len = buf.readUIntBE(off + 1, 3);
    blocks.push({ type: type, len: len, offset: off + 4, last: last });
    off += 4 + len;
  }
  const si = blocks[0];
  assert.equal(si.type, 0, 'FLAC 第一个 metadata 块必须是 STREAMINFO');
  assert.equal(si.len, 34, 'STREAMINFO 长度必须为 34');
  const minB = buf.readUInt16BE(si.offset);
  const maxB = buf.readUInt16BE(si.offset + 2);
  const b10 = buf[si.offset + 10], b11 = buf[si.offset + 11];
  const b12 = buf[si.offset + 12], b13 = buf[si.offset + 13];
  const sampleRate = (b10 << 12) | (b11 << 4) | (b12 >> 4);
  const channels = ((b12 >> 1) & 7) + 1;
  const bits = (((b12 & 1) << 4) | (b13 >> 4)) + 1;
  const totalSamples = (b13 & 0x0F) * 4294967296 + buf.readUInt32BE(si.offset + 14);
  let vendor = null;
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock.type === 4) {
    const vlen = buf.readUInt32LE(lastBlock.offset);
    vendor = buf.toString('utf8', lastBlock.offset + 4, lastBlock.offset + 4 + vlen);
  }
  return {
    blocks: blocks, minB: minB, maxB: maxB, sampleRate: sampleRate, channels: channels,
    bits: bits, totalSamples: totalSamples, vendor: vendor, audioOffset: off,
  };
}

// ---------------------------------------------------------------------------
// ZIP 校验辅助
// ---------------------------------------------------------------------------

function findEocd(buf) {
  const sig = 0x06054b50;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

function parseZipEnd(buf) {
  const p = findEocd(buf);
  assert.ok(p >= 0, 'ZIP 缺少 EOCD 记录');
  return {
    offset: p,
    entriesDisk: buf.readUInt16LE(p + 8),
    entries: buf.readUInt16LE(p + 10),
    cdSize: buf.readUInt32LE(p + 12),
    cdOffset: buf.readUInt32LE(p + 16),
    commentLen: buf.readUInt16LE(p + 20),
  };
}

const PY_VERIFY = path.join(WORK, 'verify_zip.py');
fs.writeFileSync(PY_VERIFY, [
  'import sys, json, hashlib, zipfile',
  'zip_path, out_dir = sys.argv[1], sys.argv[2]',
  'z = zipfile.ZipFile(zip_path)',
  'bad = z.testzip()',
  'entries = []',
  'for info in z.infolist():',
  '    data = z.read(info.filename)',
  '    entries.append({',
  '        "name": info.filename,',
  '        "flag_bits": info.flag_bits,',
  '        "crc": info.CRC,',
  '        "size": info.file_size,',
  '        "compress_type": info.compress_type,',
  '        "date_time": list(info.date_time),',
  '        "sha256": hashlib.sha256(data).hexdigest(),',
  '    })',
  'z.extractall(out_dir)',
  'with open(zip_path + ".verify.json", "w", encoding="utf-8") as f:',
  '    json.dump({"testzip": bad, "entries": entries}, f, ensure_ascii=False)',
  'print("OK")',
].join('\n'));

function pythonVerifyZip(zipPath) {
  const outDir = path.join(WORK, 'unzip-' + (++fileSeq));
  fs.mkdirSync(outDir, { recursive: true });
  const r = runOk('python', [PY_VERIFY, zipPath, outDir], 'python zipfile');
  // Python 在中文 Windows 下 stdout 默认 GBK，JSON 必须走 UTF-8 文件，避免文件名被二次编码
  const parsed = JSON.parse(fs.readFileSync(zipPath + '.verify.json', 'utf8'));
  parsed.outDir = outDir;
  return parsed;
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function cloneChannels(chs) {
  return chs.map(function (ch) { return new Float32Array(ch); });
}

function assertChannelsEqual(actual, expected, label) {
  assert.equal(actual.length, expected.length, label + ' 声道数变化');
  for (let c = 0; c < expected.length; c++) {
    assert.equal(actual[c].length, expected[c].length, label + ' 第 ' + (c + 1) + ' 声道长度变化');
    for (let i = 0; i < expected[c].length; i++) {
      if (!(actual[c][i] === expected[c][i])) {
        throw new Error(label + ' 第 ' + (c + 1) + ' 声道 @' + i + ' 被修改：' + expected[c][i] + ' -> ' + actual[c][i]);
      }
    }
  }
}

async function expectReject(promise, pattern, label) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, label + ' 应当抛错，但没有抛错');
  assert.ok(pattern.test(String(err.message)), label + ' 错误信息不匹配 ' + pattern + '：' + err.message);
  return err;
}

(async function main() {
  const START_TS = Date.now();
  console.log('ZAOMAI STUDIO · 导出引擎自动测试（契约 v1 · 5.5）');
  console.log('  node    ' + process.version);
  const ffv = run('ffmpeg', ['-version']);
  console.log('  ffmpeg  ' + (ffv.stdout.toString('utf8').split('\n')[0] || '(未找到)'));
  const pyv = run('python', ['--version']);
  console.log('  python  ' + ((pyv.stdout.toString('utf8') + pyv.stderr.toString('utf8')).trim() || '(未找到)'));
  const probev = run('ffprobe', ['-version']);
  if (ffv.status !== 0 || probev.status !== 0) throw new Error('需要 PATH 中的 ffmpeg / ffprobe');
  if (pyv.status !== 0) throw new Error('需要 PATH 中的 python（ZIP 独立校验）');

  const SR = 48000;
  const TONE2 = makeTone(2, SR, 2);          // 2s 立体声 48k（契约 5.5 主用例）
  const TONE2_SNAPSHOT = cloneChannels(TONE2);
  const MONO2 = makeTone(2, SR, 1);          // 2s 单声道 48k
  const TONE1_441 = makeTone(1, 44100, 1);   // 1s 单声道 44.1k

  // -------------------------------------------------------------------------
  section('0. 模块接口');
  // -------------------------------------------------------------------------

  await test('FORMATS 数量与顺序符合契约 5.2', async function () {
    assert.deepEqual(ZE.FORMATS.map(function (f) { return f.id; }),
      ['wav16', 'wav24', 'wav32f', 'mp3', 'flac', 'ogg', 'aiff']);
    assert.equal(ZE.version, '1.0.0');
  });

  await test('FORMATS 每项字段完整（id/label/ext/mime/kind/options/note）', async function () {
    ZE.FORMATS.forEach(function (f) {
      ['id', 'label', 'ext', 'mime', 'kind', 'note'].forEach(function (k) {
        assert.equal(typeof f[k], 'string', f.id + ' 缺少字符串字段 ' + k);
        assert.ok(f[k].length > 0, f.id + ' 字段 ' + k + ' 为空');
      });
      assert.ok(Array.isArray(f.options), f.id + ' 的 options 必须是数组');
      assert.ok(/^(audio\/|application\/zip)/.test(f.mime), f.id + ' 的 mime 非法：' + f.mime);
    });
  });

  await test('mp3 / ogg 码率选项与默认值', async function () {
    const byId = {};
    ZE.FORMATS.forEach(function (f) { byId[f.id] = f; });
    assert.deepEqual(byId.mp3.options, [{ key: 'bitrate', values: [128, 192, 320], default: 192 }]);
    assert.deepEqual(byId.ogg.options, [{ key: 'bitrate', values: [96, 128, 192], default: 128 }]);
    ['wav16', 'wav24', 'wav32f', 'flac', 'aiff'].forEach(function (id) {
      assert.deepEqual(byId[id].options, [], id + ' 不应有可选项');
    });
  });

  await test('isSupported：Node 无 WebCodecs 时 OGG 不可用', async function () {
    assert.equal(ZE.isSupported('mp3'), true, '加载 vendor/lame.min.js 后 mp3 应可用');
    assert.equal(ZE.isSupported('ogg'), false, 'Node 环境没有 AudioEncoder，ogg 应不可用');
    ['wav16', 'wav24', 'wav32f', 'aiff', 'flac'].forEach(function (id) {
      assert.equal(ZE.isSupported(id), true, id + ' 应可用');
    });
    assert.equal(ZE.isSupported('bogus'), false);
  });

  await test('encode 返回 Promise，Node 下解析为 Buffer', async function () {
    const p = ZE.encode('wav16', [new Float32Array(16)], SR, { dither: false });
    assert.ok(p && typeof p.then === 'function', 'encode 必须返回 Promise');
    const buf = await p;
    assert.ok(Buffer.isBuffer(buf), 'Node 下 encode 应返回 Buffer');
  });

  // -------------------------------------------------------------------------
  section('1. WAV 16-bit');
  // -------------------------------------------------------------------------

  const wav16 = await ZE.encode('wav16', TONE2, SR, { dither: false });
  const wav16File = writeTmp(wav16, 'wav');

  await test('ffprobe：pcm_s16le / 48000 Hz / 2ch / 2s', async function () {
    const info = ffprobe(wav16File);
    const st = audioStream(info);
    assert.equal(st.codec_name, 'pcm_s16le');
    assert.equal(Number(st.sample_rate), SR);
    assert.equal(st.channels, 2);
    assert.equal(info.format.format_name, 'wav');
    assert.ok(Math.abs(durationOf(info) - 2) <= 0.01, '时长应为 2s，实际 ' + durationOf(info));
  });

  await test('WAV16 头部字段（RIFF 大小 / fmt / data）', async function () {
    const h = parseWav(wav16);
    assert.equal(wav16.length, 44 + 96000 * 4);
    assert.equal(wav16.length % 2, 0);
    assert.equal(h.riffSize, wav16.length - 8);
    assert.equal(h.fmtSize, 16);
    assert.equal(h.audioFormat, 1);
    assert.equal(h.channels, 2);
    assert.equal(h.sampleRate, SR);
    assert.equal(h.byteRate, SR * 4);
    assert.equal(h.blockAlign, 4);
    assert.equal(h.bits, 16);
    assert.equal(h.dataOffset, 44);
    assert.equal(h.dataSize, 96000 * 4);
    assert.deepEqual(h.chunks.map(function (c) { return c.id; }), ['fmt ', 'data']);
    assert.equal(h.factSamples, null, 'PCM 不应有 fact chunk');
  });

  await test('WAV16 解码 PCM 与量化结果逐字节一致（dither:false）', async function () {
    const dec = decode(wav16File, 's16le');
    assert.equal(dec.stderr, '', 'ffmpeg 解码出现错误：' + dec.stderr);
    comparePCM(dec.bytes, pcm16(TONE2), 'WAV16 PCM');
  });

  await test('WAV16 默认 TPDF 抖动：每样本仅 ±1 LSB 且不越界', async function () {
    const dithered = await ZE.encode('wav16', TONE2, SR, {});
    const dec = decode(writeTmp(dithered, 'wav'), 's16le');
    assert.equal(dec.bytes.length, 96000 * 4);
    let diffs = 0;
    for (let i = 0; i < 96000; i++) {
      for (let c = 0; c < 2; c++) {
        const got = dec.bytes.readInt16LE((i * 2 + c) * 2);
        const want = q16(TONE2[c][i]);
        const d = got - want;
        assert.ok(d >= -1 && d <= 1, '抖动偏移超过 1 LSB：' + got + ' vs ' + want);
        if (d !== 0) diffs++;
      }
    }
    assert.ok(diffs > 0, '默认应当开启抖动，但输出与无抖动完全相同');
  });

  await test('WAV16 满幅 / 越界 / NaN 不回绕削波', async function () {
    const input = [new Float32Array([1, -1, 1.5, -1.5, NaN, Infinity, -Infinity, 0.99999, 0.5, -0.5])];
    const exact = await ZE.encode('wav16', input, SR, { dither: false });
    const dec = decode(writeTmp(exact, 'wav'), 's16le');
    const want = [32767, -32768, 32767, -32768, 0, 32767, -32768, 32767, 16384, -16384];
    for (let i = 0; i < want.length; i++) {
      assert.equal(dec.bytes.readInt16LE(i * 2), want[i], '第 ' + i + ' 个样本');
    }
    const dithered = await ZE.encode('wav16', input, SR, {});
    const decD = decode(writeTmp(dithered, 'wav'), 's16le');
    assert.ok(decD.bytes.readInt16LE(0) > 0, '满幅 +1 不应回绕成负数');
    assert.ok(decD.bytes.readInt16LE(2) < 0, '满幅 -1 不应回绕成正数');
    for (let i = 0; i < want.length; i++) {
      const v = decD.bytes.readInt16LE(i * 2);
      assert.ok(v >= -32768 && v <= 32767);
    }
  });

  await test('WAV16 输出确定性（同输入同参数两次逐字节一致）', async function () {
    const a = await ZE.encode('wav16', TONE2, SR, {});
    const b = await ZE.encode('wav16', TONE2, SR, {});
    assert.ok(a.equals(b), '两次 WAV16 输出不一致（抖动种子应固定）');
  });

  await test('WAV16 单声道 48k 头部与长度', async function () {
    const buf = await ZE.encode('wav16', MONO2, SR, { dither: false });
    assert.equal(buf.length, 44 + 96000 * 2);
    const h = parseWav(buf);
    assert.equal(h.channels, 1);
    assert.equal(h.blockAlign, 2);
    assert.equal(h.dataSize, 96000 * 2);
    const st = audioStream(ffprobe(writeTmp(buf, 'wav')));
    assert.equal(st.channels, 1);
  });

  // -------------------------------------------------------------------------
  section('2. WAV 24-bit');
  // -------------------------------------------------------------------------

  const wav24 = await ZE.encode('wav24', TONE2, SR, {});
  const wav24File = writeTmp(wav24, 'wav');

  await test('ffprobe：pcm_s24le / 48000 Hz / 2ch / 2s', async function () {
    const st = audioStream(ffprobe(wav24File));
    assert.equal(st.codec_name, 'pcm_s24le');
    assert.equal(Number(st.sample_rate), SR);
    assert.equal(st.channels, 2);
    assert.ok(Math.abs(durationOf(ffprobe(wav24File)) - 2) <= 0.01);
  });

  await test('WAV24 头部字段（blockAlign / 24-bit / data 长度）', async function () {
    const h = parseWav(wav24);
    assert.equal(wav24.length, 44 + 96000 * 2 * 3);
    assert.equal(h.riffSize, wav24.length - 8);
    assert.equal(h.audioFormat, 1);
    assert.equal(h.blockAlign, 6);
    assert.equal(h.byteRate, SR * 6);
    assert.equal(h.bits, 24);
    assert.equal(h.dataOffset, 44);
    assert.equal(h.dataSize, 96000 * 2 * 3);
  });

  await test('WAV24 解码 s24le 与量化结果逐字节一致', async function () {
    const dec = decode(wav24File, 's24le');
    assert.equal(dec.stderr, '', 'ffmpeg 解码出现错误：' + dec.stderr);
    comparePCM(dec.bytes, pcm24(TONE2), 'WAV24 PCM');
  });

  await test('WAV24 默认无抖动，dither:true 时每样本 ±1 LSB', async function () {
    const dithered = await ZE.encode('wav24', TONE2, SR, { dither: true });
    assert.ok(!dithered.equals(wav24), 'dither:true 应与默认输出不同');
    const dec = decode(writeTmp(dithered, 'wav'), 's24le');
    let diffs = 0;
    for (let i = 0; i < 96000 * 2; i++) {
      const off = i * 3;
      let got = dec.bytes[off] | (dec.bytes[off + 1] << 8) | (dec.bytes[off + 2] << 16);
      if (got & 0x800000) got -= 16777216;
      const c = i % 2, idx = Math.floor(i / 2);
      let want = q24(TONE2[c][idx]);
      const d = got - want;
      assert.ok(d >= -1 && d <= 1, '24-bit 抖动超过 1 LSB：' + got + ' vs ' + want);
      if (d !== 0) diffs++;
    }
    assert.ok(diffs > 0, 'dither:true 未生效');
  });

  await test('WAV24 奇数 dataSize 补 RIFF pad 字节', async function () {
    const samples = [new Float32Array([0.1, 0.2, 0.3])];   // 3 样本 = 9 字节 data
    const buf = await ZE.encode('wav24', samples, SR, {});
    assert.equal(buf.length, 44 + 9 + 1, '奇数 data 应补 1 字节 RIFF pad');
    const h = parseWav(buf);
    assert.equal(h.dataSize, 9);
    assert.equal(h.dataOffset, 44);
    assert.equal(h.riffSize, buf.length - 8);
    assert.equal(buf[buf.length - 1], 0, 'pad 字节应为 0');
    const dec = decode(writeTmp(buf, 'wav'), 's24le');
    comparePCM(dec.bytes, pcm24(samples), 'WAV24 奇数长度 PCM');
  });

  // -------------------------------------------------------------------------
  section('3. WAV 32-bit float');
  // -------------------------------------------------------------------------

  const wav32 = await ZE.encode('wav32f', TONE2, SR, {});
  const wav32File = writeTmp(wav32, 'wav');

  await test('ffprobe：pcm_f32le / 48000 Hz / 2ch / 2s', async function () {
    const st = audioStream(ffprobe(wav32File));
    assert.equal(st.codec_name, 'pcm_f32le');
    assert.equal(Number(st.sample_rate), SR);
    assert.equal(st.channels, 2);
    assert.ok(Math.abs(durationOf(ffprobe(wav32File)) - 2) <= 0.01);
  });

  await test('WAV32f 头部：format=3 + fact chunk + 56 字节头', async function () {
    const h = parseWav(wav32);
    assert.equal(h.audioFormat, 3, 'float WAV 的 wFormatTag 必须是 3');
    assert.equal(h.bits, 32);
    assert.equal(h.blockAlign, 8);
    assert.equal(h.byteRate, SR * 8);
    assert.equal(h.dataOffset, 56);
    assert.equal(h.dataSize, 96000 * 2 * 4);
    assert.equal(h.factSamples, 96000, 'fact chunk 应记录每声道样本数');
    assert.equal(wav32.length, 56 + 96000 * 8);
    const fact = h.chunks.filter(function (c) { return c.id === 'fact'; })[0];
    assert.ok(fact, 'float WAV 必须有 fact chunk');
    assert.equal(fact.size, 4);
    assert.deepEqual(h.chunks.map(function (c) { return c.id; }), ['fmt ', 'fact', 'data']);
  });

  await test('WAV32f 解码 f32le 与输入逐字节一致（不量化）', async function () {
    const dec = decode(wav32File, 'f32le');
    assert.equal(dec.stderr, '');
    comparePCM(dec.bytes, pcmF32(TONE2), 'WAV32f PCM');
  });

  await test('WAV32f 无抖动且两次输出一致', async function () {
    const a = await ZE.encode('wav32f', TONE2, SR, { dither: true });
    const b = await ZE.encode('wav32f', TONE2, SR, {});
    assert.ok(a.equals(b), 'float 输出不应受 dither 选项影响');
    const c2 = await ZE.encode('wav32f', TONE2, SR, {});
    assert.ok(b.equals(c2), '两次 WAV32f 输出不一致');
  });

  // -------------------------------------------------------------------------
  section('4. AIFF 16-bit');
  // -------------------------------------------------------------------------

  const aiff = await ZE.encode('aiff', TONE2, SR, {});
  const aiffFile = writeTmp(aiff, 'aiff');

  await test('ffprobe：pcm_s16be / 48000 Hz / 2ch / 2s', async function () {
    const info = ffprobe(aiffFile);
    const st = audioStream(info);
    assert.equal(st.codec_name, 'pcm_s16be');
    assert.equal(Number(st.sample_rate), SR);
    assert.equal(st.channels, 2);
    assert.equal(info.format.format_name, 'aiff');
    assert.ok(Math.abs(durationOf(info) - 2) <= 0.01);
  });

  await test('AIFF 头部：FORM / COMM 18 / 80-bit 采样率 / SSND', async function () {
    const h = parseAiff(aiff);
    assert.equal(aiff.length, 54 + 96000 * 4);
    assert.equal(h.formSize, aiff.length - 8);
    assert.equal(h.commSize, 18);
    assert.equal(h.channels, 2);
    assert.equal(h.frames, 96000);
    assert.equal(h.bits, 16);
    assert.deepEqual(Array.from(h.rateBytes),
      [0x40, 0x0E, 0xBB, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      '48000 Hz 的 80-bit extended 编码错误');
    assert.equal(h.ssndSize, 8 + 96000 * 4);
    assert.equal(h.dataOffset, 54);
    assert.equal(h.dataSize, 96000 * 4);
    assert.deepEqual(h.chunks.map(function (c) { return c.id; }), ['COMM', 'SSND']);
  });

  await test('AIFF 解码 s16be 与量化结果逐字节一致', async function () {
    const dec = decode(aiffFile, 's16be');
    assert.equal(dec.stderr, '');
    comparePCM(dec.bytes, pcm16be(TONE2), 'AIFF PCM');
  });

  await test('AIFF 44.1k 单声道 80-bit 采样率', async function () {
    const buf = await ZE.encode('aiff', TONE1_441, 44100, {});
    const h = parseAiff(buf);
    assert.equal(h.channels, 1);
    assert.equal(h.frames, 44100);
    assert.deepEqual(Array.from(h.rateBytes),
      [0x40, 0x0E, 0xAC, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      '44100 Hz 的 80-bit extended 编码错误');
    const st = audioStream(ffprobe(writeTmp(buf, 'aiff')));
    assert.equal(Number(st.sample_rate), 44100);
    assert.equal(st.channels, 1);
  });

  await test('AIFF 1 采样可导出（头与样本值正确）', async function () {
    const buf = await ZE.encode('aiff', [new Float32Array([0.25])], SR, {});
    assert.equal(buf.length, 56);
    const h = parseAiff(buf);
    assert.equal(h.frames, 1);
    assert.equal(h.dataSize, 2);
    assert.equal(buf.readInt16BE(h.dataOffset), 8192);
  });

  // -------------------------------------------------------------------------
  section('5. FLAC 16-bit（原生编码 / bit-perfect）');
  // -------------------------------------------------------------------------

  const flac = await ZE.encode('flac', TONE2, SR, {});
  const flacFile = writeTmp(flac, 'flac');

  await test('ffprobe：flac / 48000 Hz / 2ch / 2s', async function () {
    const info = ffprobe(flacFile);
    const st = audioStream(info);
    assert.equal(st.codec_name, 'flac');
    assert.equal(Number(st.sample_rate), SR);
    assert.equal(st.channels, 2);
    assert.equal(info.format.format_name, 'flac');
    assert.ok(Math.abs(durationOf(info) - 2) <= 0.01);
  });

  await test('STREAMINFO 与 VORBIS_COMMENT 元数据正确', async function () {
    const m = parseFlac(flac);
    assert.equal(m.minB, 4096, 'STREAMINFO 最小块大小应为 4096');
    assert.equal(m.maxB, 4096, 'STREAMINFO 最大块大小应为 4096');
    assert.equal(m.sampleRate, SR);
    assert.equal(m.channels, 2);
    assert.equal(m.bits, 16);
    assert.equal(m.totalSamples, 96000);
    assert.equal(m.blocks[0].type, 0);
    assert.equal(m.blocks[0].last, false);
    assert.equal(m.blocks[m.blocks.length - 1].type, 4, '最后一个 metadata 块应为 VORBIS_COMMENT');
    assert.equal(m.blocks[m.blocks.length - 1].last, true);
    assert.equal(m.vendor, 'ZAOMAI STUDIO 1.0.0');
  });

  await test('FLAC 帧同步字 0xFFF8（fixed blocksize）', async function () {
    const m = parseFlac(flac);
    assert.ok(m.audioOffset < flac.length - 2, '缺少音频帧');
    assert.equal(flac[m.audioOffset], 0xFF);
    assert.equal(flac[m.audioOffset + 1] & 0xFE, 0xF8);
  });

  await test('FLAC 2s 立体声解码 PCM bit-perfect（CRC 校验通过）', async function () {
    const dec = decode(flacFile, 's16le');
    assert.equal(dec.stderr, '', 'ffmpeg 解码 FLAC 报错（可能是 CRC8/CRC16 不正确）：' + dec.stderr);
    comparePCM(dec.bytes, pcm16(TONE2), 'FLAC 2s PCM');
  });

  await test('FLAC 多种长度的 bit-perfect（含 4096 块边界）', async function () {
    const lengths = [16, 100, 255, 256, 257, 4095, 4096, 4097, 5000];
    for (let li = 0; li < lengths.length; li++) {
      const n = lengths[li];
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        x[i] = Math.sin(i * 0.011) * 0.6 + Math.sin(i * 0.37) * 0.1 + ((i % 7) - 3) * 0.01;
      }
      const buf = await ZE.encode('flac', [x], SR, {});
      const dec = decode(writeTmp(buf, 'flac'), 's16le');
      assert.equal(dec.stderr, '', 'n=' + n + ' ffmpeg 解码报错：' + dec.stderr);
      comparePCM(dec.bytes, pcm16([x]), 'FLAC mono n=' + n + ' PCM');
    }
  });

  await test('FLAC 44.1k 单声道 bit-perfect', async function () {
    const buf = await ZE.encode('flac', TONE1_441, 44100, {});
    const info = ffprobe(writeTmp(buf, 'flac'));
    const st = audioStream(info);
    assert.equal(Number(st.sample_rate), 44100);
    assert.equal(st.channels, 1);
    const dec = decode(writeTmp(buf, 'flac'), 's16le');
    assert.equal(dec.stderr, '');
    comparePCM(dec.bytes, pcm16(TONE1_441), 'FLAC 44.1k mono PCM');
  });

  await test('FLAC 无抖动且输出确定', async function () {
    const a = await ZE.encode('flac', TONE2, SR, { dither: true });
    const b = await ZE.encode('flac', TONE2, SR, {});
    assert.ok(a.equals(b), 'FLAC 是整数无损编码，不应受 dither 选项影响');
    assert.ok(b.equals(flac), '两次 FLAC 输出不一致');
  });

  await test('FLAC 少于 16 采样给出中文错误（STREAMINFO 最小块限制）', async function () {
    const err = await expectReject(ZE.encode('flac', [new Float32Array(5)], SR, {}), /FLAC 至少需要 16 个采样点/, 'FLAC n=5');
    assert.ok(/^导出失败：/.test(err.message), '错误信息应带中文前缀');
  });

  // -------------------------------------------------------------------------
  section('6. MP3（vendor/lame.min.js）');
  // -------------------------------------------------------------------------

  const mp3 = {};
  for (const br of [128, 192, 320]) {
    const buf = await ZE.encode('mp3', TONE2, SR, { bitrate: br });
    mp3[br] = { buf: buf, file: writeTmp(buf, 'mp3') };
  }

  await test('MP3 三档码率：ffprobe 编码/采样率/声道/时长/码率', async function () {
    const sizes = {};
    for (const br of [128, 192, 320]) {
      const info = ffprobe(mp3[br].file);
      const st = audioStream(info);
      assert.equal(st.codec_name, 'mp3', br + 'kbps 编码名');
      assert.equal(Number(st.sample_rate), SR);
      assert.equal(st.channels, 2);
      const dur = durationOf(info);
      assert.ok(Math.abs(dur - 2) <= 0.15, br + 'kbps 时长偏差过大：' + dur);
      const gotBr = Number(st.bit_rate);
      assert.ok(Math.abs(gotBr - br * 1000) <= br * 1000 * 0.1, br + 'kbps 实际码率 ' + gotBr);
      sizes[br] = mp3[br].buf.length;
    }
    assert.ok(sizes[320] > sizes[192] && sizes[192] > sizes[128],
      '码率越高字节数应越大：' + JSON.stringify(sizes));
  });

  await test('MP3 ffmpeg 解码零错误、时长正确且非静音', async function () {
    const dec = decode(mp3[192].file, 's16le');
    assert.ok(!/error|invalid|failed|corrupt/i.test(dec.stderr), 'ffmpeg 解码报错：' + dec.stderr);
    const bytesPerSec = SR * 2 * 2;
    assert.ok(dec.bytes.length >= bytesPerSec * 1.85 && dec.bytes.length <= bytesPerSec * 2.2,
      '解码 PCM 长度异常：' + dec.bytes.length);
    let nonZero = 0;
    for (let i = 0; i + 1 < dec.bytes.length; i += 2) if (dec.bytes.readInt16LE(i) !== 0) nonZero++;
    const ratio = nonZero / (dec.bytes.length / 2);
    assert.ok(ratio > 0.5, 'MP3 解码结果疑似静音，非零比例 ' + ratio.toFixed(3));
  });

  await test('MP3 单声道 48k', async function () {
    const mono1 = makeTone(1, SR, 1);
    const info = ffprobe(writeTmp(await ZE.encode('mp3', mono1, SR, { bitrate: 192 }), 'mp3'));
    const st = audioStream(info);
    assert.equal(st.channels, 1);
    assert.equal(Number(st.sample_rate), SR);
    assert.ok(Math.abs(durationOf(info) - 1) <= 0.15);
  });

  await test('MP3 44.1k 单声道可编码并可解码', async function () {
    const file = writeTmp(await ZE.encode('mp3', TONE1_441, 44100, { bitrate: 128 }), 'mp3');
    const st = audioStream(ffprobe(file));
    assert.equal(Number(st.sample_rate), 44100);
    assert.equal(st.channels, 1);
    const dec = decode(file, 's16le');
    assert.ok(dec.bytes.length > 0);
  });

  // -------------------------------------------------------------------------
  section('7. OGG Opus（浏览器 WebCodecs 路径）');
  // -------------------------------------------------------------------------

  await test('Node 环境 isSupported(ogg)=false 且 encode 抛中文错误', async function () {
    assert.equal(ZE.isSupported('ogg'), false, 'Node 没有 WebCodecs AudioEncoder');
    const err = await expectReject(ZE.encode('ogg', TONE2, SR, {}), /WebCodecs|浏览器|OGG Opus/, 'OGG in Node');
    assert.ok(err.message.indexOf('浏览器') >= 0, '错误信息应说明浏览器要求：' + err.message);
  });

  await test('OGG 浏览器路径由 test/opus-harness.html 覆盖（Chrome + ffprobe 已验证）', async function () {
    const harness = path.join(ROOT, 'test', 'opus-harness.html');
    assert.ok(fs.existsSync(harness), '缺少浏览器 OGG 验证 harness');
    const html = fs.readFileSync(harness, 'utf8');
    assert.ok(html.indexOf('ZaomaiExport') >= 0 && html.indexOf("encode('ogg'") >= 0,
      'harness 应调用 ZaomaiExport.encode(ogg)');
    assert.ok(html.indexOf('document.title') >= 0, 'harness 应设置 document.title 供 headless Chrome 判定完成');
  });

  // -------------------------------------------------------------------------
  section('8. ZIP（store / UTF-8 / CRC32）');
  // -------------------------------------------------------------------------

  const BIN = Buffer.alloc(5000);
  for (let i = 0; i < BIN.length; i++) BIN[i] = (i * 37 + 11) & 0xFF;
  const ZIP_TXT = Buffer.from('中文文件名与 UTF-8 内容测试\n第二行：导出引擎\n', 'utf8');
  const zipEntries = [
    { name: 'test-tone.wav', bytes: wav16 },
    { name: '中文目录/说明 文档.txt', bytes: ZIP_TXT },
    { name: 'empty.bin', bytes: new Uint8Array(0) },
    { name: 'nested/二进制.dat', bytes: BIN },
  ];
  const zipBuf = ZE.zip(zipEntries);
  const zipPath = writeTmp(zipBuf, 'zip');

  await test('Python zipfile：CRC 全部正确、UTF-8 文件名、解压内容一致', async function () {
    const info = pythonVerifyZip(zipPath);
    assert.equal(info.testzip, null, 'zipfile.testzip() 报告损坏条目：' + info.testzip);
    const names = zipEntries.map(function (e) { return e.name; });
    assert.deepEqual(info.entries.map(function (e) { return e.name; }), names);
    for (let i = 0; i < info.entries.length; i++) {
      const e = info.entries[i];
      const data = zipEntries[i].bytes;
      assert.ok((e.flag_bits & 0x0800) === 0x0800, e.name + ' 缺少 UTF-8 文件名标记 bit 11');
      assert.equal(e.compress_type, 0, e.name + ' 应使用 store 不压缩');
      assert.equal(e.size, data.length, e.name + ' 记录长度错误');
      assert.equal(e.crc, crc32(data), e.name + ' CRC32 错误');
      assert.equal(e.sha256, sha256(data), e.name + ' 解压内容 sha256 不一致');
      assert.deepEqual(e.date_time, [1980, 1, 1, 0, 0, 0], e.name + ' 时间戳应为固定值（可复现）');
      const extracted = fs.readFileSync(path.join(info.outDir, e.name.split('/').join(path.sep)));
      comparePCM(extracted, Buffer.from(data), e.name + ' 解压内容');
    }
  });

  await test('ZIP 结构：EOCD 记录数 / 中央目录偏移一致', async function () {
    const eocd = parseZipEnd(zipBuf);
    assert.equal(eocd.entries, zipEntries.length);
    assert.equal(eocd.entriesDisk, zipEntries.length);
    assert.equal(eocd.commentLen, 0);
    assert.equal(eocd.offset, zipBuf.length - 22);
    assert.equal(eocd.cdOffset + eocd.cdSize, eocd.offset, '中央目录偏移/长度与 EOCD 不符');
    assert.equal(zipBuf.toString('ascii', eocd.cdOffset, eocd.cdOffset + 4), 'PK\x01\x02');
    assert.equal(zipBuf.readUInt32LE(0), 0x04034B50);
  });

  await test('zipAsync 与 zip 输出等价（Uint8Array 输入）', async function () {
    const asyncBuf = await ZE.zipAsync(zipEntries);
    assert.ok(Buffer.isBuffer(asyncBuf), 'zipAsync 应返回 Promise<Buffer>');
    assert.ok(asyncBuf.equals(zipBuf), 'zipAsync 与 zip 结果不一致');
  });

  await test('ZIP 可打包全部 Node 端导出结果（flac/mp3/aiff）', async function () {
    const entries = [
      { name: 'mix.flac', bytes: flac },
      { name: 'mix.mp3', bytes: mp3[192].buf },
      { name: 'mix.aiff', bytes: aiff },
    ];
    const buf = ZE.zip(entries);
    const info = pythonVerifyZip(writeTmp(buf, 'zip'));
    assert.equal(info.testzip, null);
    assert.deepEqual(info.entries.map(function (e) { return e.name; }), ['mix.flac', 'mix.mp3', 'mix.aiff']);
    for (let i = 0; i < entries.length; i++) {
      assert.equal(info.entries[i].crc, crc32(entries[i].bytes), entries[i].name + ' CRC 错误');
      assert.equal(info.entries[i].sha256, sha256(entries[i].bytes));
    }
  });

  await test('zipAsync 支持任意 Blob（zip 不支持同步读）', async function () {
    const content = Buffer.from('任意 Blob 内容：中文测试', 'utf8');
    const blob = new Blob([content]);
    const syncErr = (function () {
      try { ZE.zip([{ name: 'blob.txt', blob: blob }]); return null; } catch (e) { return e; }
    })();
    assert.ok(syncErr, '同步 zip 读到外部 Blob 时应抛错');
    assert.ok(/无法同步读取/.test(syncErr.message) && /zipAsync/.test(syncErr.message), '同步 zip 错误信息应提示 zipAsync：' + syncErr.message);
    const buf = await ZE.zipAsync([{ name: 'blob.txt', blob: blob }]);
    const info = pythonVerifyZip(writeTmp(buf, 'zip'));
    assert.equal(info.testzip, null);
    assert.equal(info.entries[0].name, 'blob.txt');
    assert.equal(info.entries[0].crc, crc32(content));
    comparePCM(fs.readFileSync(path.join(info.outDir, 'blob.txt')), content, 'Blob 解压内容');
  });

  await test('ZIP 支持 ArrayBuffer 条目与空列表', async function () {
    const ab = new Uint8Array([9, 8, 7, 6]).buffer;
    const buf = ZE.zip([{ name: 'ab.bin', bytes: ab }]);
    const info = pythonVerifyZip(writeTmp(buf, 'zip'));
    assert.equal(info.testzip, null);
    assert.equal(info.entries[0].size, 4);
    assert.equal(info.entries[0].crc, crc32(Buffer.from([9, 8, 7, 6])));
    const emptyZip = ZE.zip([]);
    assert.equal(parseZipEnd(emptyZip).entries, 0);
  });

  // -------------------------------------------------------------------------
  section('9. 边界 / 错误处理');
  // -------------------------------------------------------------------------

  await test('非法 formatId 抛中文错误', async function () {
    const err = await expectReject(ZE.encode('bogus', [new Float32Array(8)], SR), /不支持的导出格式/, '非法 formatId');
    assert.ok(/^导出失败：/.test(err.message));
    assert.equal(ZE.isSupported('bogus'), false);
  });

  await test('声道 / 长度 / 空数据 / 采样率参数校验', async function () {
    const cases = [
      ['空声道数组', function () { return ZE.encode('wav16', [], SR); }, /声道数必须为 1 或 2/],
      ['三声道', function () { return ZE.encode('wav16', [new Float32Array(8), new Float32Array(8), new Float32Array(8)], SR); }, /声道数必须为 1 或 2/],
      ['声道长度不一致', function () { return ZE.encode('wav16', [new Float32Array(8), new Float32Array(9)], SR); }, /各声道长度不一致/],
      ['空采样数据', function () { return ZE.encode('wav16', [new Float32Array(0)], SR); }, /音频数据为空/],
      ['采样率 0', function () { return ZE.encode('wav16', [new Float32Array(8)], 0); }, /采样率非法/],
      ['采样率 NaN', function () { return ZE.encode('wav16', [new Float32Array(8)], NaN); }, /采样率非法/],
      ['非法 MP3 码率', function () { return ZE.encode('mp3', [new Float32Array(8)], SR, { bitrate: 999 }); }, /参数 bitrate 不支持/],
      ['非法 OGG 码率', function () { return ZE.encode('ogg', [new Float32Array(8)], SR, { bitrate: 999 }); }, /bitrate|WebCodecs|OGG Opus/],
    ];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      try {
        await expectReject(c[1](), c[2], c[0]);
      } catch (e) {
        throw new Error(c[0] + '：' + e.message);
      }
    }
  });

  await test('NaN / ±Infinity / 越界输入不崩溃，量化按契约饱和', async function () {
    const cycle = [0, NaN, Infinity, -Infinity, 1.5, -1.5, 0.25, -0.25];
    const weird = new Float32Array(64);
    for (let i = 0; i < 64; i++) weird[i] = cycle[i % cycle.length];
    const chans = [weird];

    const w16 = await ZE.encode('wav16', chans, SR, { dither: false });
    comparePCM(decode(writeTmp(w16, 'wav'), 's16le').bytes, pcm16(chans), '异常值 WAV16');
    const w24 = await ZE.encode('wav24', chans, SR, {});
    comparePCM(decode(writeTmp(w24, 'wav'), 's24le').bytes, pcm24(chans), '异常值 WAV24');
    const w32 = await ZE.encode('wav32f', chans, SR, {});
    comparePCM(decode(writeTmp(w32, 'wav'), 'f32le').bytes, pcmF32(chans), '异常值 WAV32f');
    const ai = await ZE.encode('aiff', chans, SR, {});
    comparePCM(decode(writeTmp(ai, 'aiff'), 's16be').bytes, pcm16be(chans), '异常值 AIFF');
    const fl = await ZE.encode('flac', chans, SR, {});
    comparePCM(decode(writeTmp(fl, 'flac'), 's16le').bytes, pcm16(chans), '异常值 FLAC');
    const mp = await ZE.encode('mp3', chans, SR, { bitrate: 128 });
    const dec = decode(writeTmp(mp, 'mp3'), 's16le');
    assert.ok(dec.bytes.length > 0, 'MP3 解码无数据');
  });

  await test('静音输入：FLAC/AIFF 全零，WAV16 抖动不越界，MP3 可解码', async function () {
    const sil = [new Float32Array(4800), new Float32Array(4800)];
    const flacSil = decode(writeTmp(await ZE.encode('flac', sil, SR, {}), 'flac'), 's16le');
    comparePCM(flacSil.bytes, Buffer.alloc(4800 * 2 * 2), 'FLAC 静音');
    const aiffSil = decode(writeTmp(await ZE.encode('aiff', sil, SR, {}), 'aiff'), 's16be');
    comparePCM(aiffSil.bytes, Buffer.alloc(4800 * 2 * 2), 'AIFF 静音');
    const wavSil = decode(writeTmp(await ZE.encode('wav16', sil, SR, {}), 'wav'), 's16le');
    for (let i = 0; i < 4800 * 2; i++) {
      const v = wavSil.bytes.readInt16LE(i * 2);
      assert.ok(v >= -1 && v <= 1, '静音抖动应限制在 ±1 LSB，实际 ' + v);
    }
    const mp3Sil = await ZE.encode('mp3', sil, SR, { bitrate: 128 });
    assert.ok(mp3Sil.length > 0);
    assert.ok(decode(writeTmp(mp3Sil, 'mp3'), 's16le').bytes.length > 0);
  });

  await test('极短输入（1 采样）可导出', async function () {
    const one = [new Float32Array([0.25])];
    const w16 = await ZE.encode('wav16', one, SR, { dither: false });
    assert.equal(w16.length, 46);
    assert.equal(parseWav(w16).dataSize, 2);
    assert.equal(w16.readInt16LE(44), 8192);
    const ai = await ZE.encode('aiff', one, SR, {});
    assert.equal(ai.length, 56);
    assert.equal(parseAiff(ai).frames, 1);
    assert.equal(Buffer.from(ai).readInt16BE(54), 8192);
    const mp = await ZE.encode('mp3', one, SR, { bitrate: 128 });
    assert.ok(mp.length > 0, 'MP3 1 采样应产出数据');
  });

  await test('导出过程不修改输入声道数据', async function () {
    assertChannelsEqual(TONE2, TONE2_SNAPSHOT, '全部导出后');
  });

  // -------------------------------------------------------------------------
  section('10. 进度回调 / 性能');
  // -------------------------------------------------------------------------

  await test('onProgress 单调非递减、范围 [0,1]、末值 1', async function () {
    const calls = [];
    await ZE.encode('mp3', TONE2, SR, { bitrate: 128 }, function (p) { calls.push(p); });
    assert.ok(calls.length >= 2, '进度回调次数过少：' + calls.length);
    assert.equal(calls[0], 0, '首个进度应为 0');
    assert.equal(calls[calls.length - 1], 1, '末个进度应为 1');
    for (let i = 0; i < calls.length; i++) {
      assert.ok(calls[i] >= 0 && calls[i] <= 1, '进度越界：' + calls[i]);
      if (i > 0) assert.ok(calls[i] >= calls[i - 1], '进度回退：' + calls[i - 1] + ' -> ' + calls[i]);
    }
  });

  await test('进度回调抛异常不影响导出', async function () {
    const buf = await ZE.encode('wav16', TONE2, SR, {}, function () { throw new Error('boom'); });
    assert.equal(buf.length, 384044);
  });

  await test('性能：16s 立体声 48k MP3/FLAC 数秒级完成', async function () {
    const big = makeTone(16, SR, 2);
    const t0 = Date.now();
    const mp3Big = await ZE.encode('mp3', big, SR, { bitrate: 192 });
    const t1 = Date.now();
    const flacCalls = [];
    const flacBig = await ZE.encode('flac', big, SR, {}, function (p) { flacCalls.push(p); });
    const t2 = Date.now();
    const mp3Ms = t1 - t0, flacMs = t2 - t1;
    console.log('      [perf] 16s 立体声 48k：MP3(192k) ' + mp3Ms + 'ms / FLAC ' + flacMs + 'ms');
    assert.ok(mp3Ms < 15000, 'MP3 16s 编码过慢：' + mp3Ms + 'ms');
    assert.ok(flacMs < 15000, 'FLAC 16s 编码过慢：' + flacMs + 'ms');
    assert.ok(mp3Big.length > 0 && flacBig.length > 0);
    assert.ok(flacCalls.length >= 2, 'FLAC 长任务应有进度回调');
    assert.equal(flacCalls[flacCalls.length - 1], 1);
    const info = ffprobe(writeTmp(mp3Big, 'mp3'));
    assert.ok(Math.abs(durationOf(info) - 16) <= 0.15, '16s MP3 时长异常：' + durationOf(info));
  });

  // -------------------------------------------------------------------------
  // 汇总
  // -------------------------------------------------------------------------

  const total = pass + failures.length;
  const elapsed = ((Date.now() - START_TS) / 1000).toFixed(1);
  console.log('');
  if (failures.length) {
    console.log('FAIL ' + failures.length + '/' + total + '，用时 ' + elapsed + 's');
    failures.forEach(function (f) {
      console.log('  - ' + f.name + '：' + String(f.err && f.err.message || f.err).split('\n')[0]);
    });
    console.log('PASS ' + pass + '/' + total);
    console.log('（临时文件保留在 ' + WORK + ' 便于排查）');
    process.exitCode = 1;
  } else {
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log('PASS ' + pass + '/' + total + '（用时 ' + elapsed + 's）');
  }
})().catch(function (err) {
  console.error('测试框架异常：', err);
  process.exitCode = 1;
});
