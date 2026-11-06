/* Headless Chrome CDP harness for ZAOMAI LAB autotest + screenshots. */
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'E:/.CS/zaomai-studio';
const outPrefix = process.argv[2] || 'test/shot-autotest';
const url = process.argv[3] || 'file:///E:/.CS/zaomai-studio/index.html?autotest=1';
const waitForDone = process.argv[4] !== '--no-wait';
const port = 9300 + Math.floor(Math.random() * 400);
const profile = path.join(ROOT, 'test', '.chrome-cdp-' + port);
const logLines = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      } else {
        this.events.push(msg);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const vals = (msg.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
          logLines.push('[console.' + msg.params.type + '] ' + vals);
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          logLines.push('[exception] ' + (d.text || '') + ' ' + (d.exception && (d.exception.description || d.exception.value) || ''));
        }
        if (msg.method === 'Log.entryAdded') {
          logLines.push('[log.' + msg.params.entry.level + '] ' + msg.params.entry.text);
        }
      }
    });
  }
  async send(method, params) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--window-size=1440,1000', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });
  let wsUrl = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await httpJson('/json/list');
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(150);
  }
  if (!wsUrl) {
    console.error('No CDP page. chrome stderr:\n' + chromeErr.slice(-3000));
    try { execSync('taskkill /PID ' + chrome.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
    process.exit(2);
  }
  const cdp = new CDP(wsUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });
  await sleep(1200);

  let result = null;
  const deadline = Date.now() + 180000;
  if (waitForDone) {
    while (Date.now() < deadline) {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: 'window.__AUTOTEST__ ? JSON.stringify(window.__AUTOTEST__) : null',
          returnByValue: true, awaitPromise: false
        });
        if (r && r.result && r.result.value) { result = JSON.parse(r.result.value); break; }
      } catch (e) {}
      await sleep(500);
    }
  }
  // Let layout settle, then screenshot.
  await sleep(500);
  let shot = null;
  try {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    shot = Buffer.from(s.data, 'base64');
    fs.writeFileSync(path.join(ROOT, outPrefix + '.png'), shot);
  } catch (e) { logLines.push('[screenshot-error] ' + e.message); }

  const state = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ title: document.title, ready: document.readyState, body: document.body.getAttribute("data-autotest"), app: window.ZaomaiApp ? window.ZaomaiApp.getState() : null, hasDSP: !!window.ZaomaiDSP, hasExport: !!window.ZaomaiExport, hasDemo: !!window.ZaomaiDemo, autotest: window.__AUTOTEST__ || null, toast: (document.getElementById("toast")||{}).textContent || "", hint: (document.getElementById("proc-hint")||{}).textContent || "", wave: (document.getElementById("wave-info")||{}).textContent || "", statLufs: (document.getElementById("stat-lufs")||{}).textContent || "", statTp: (document.getElementById("stat-tp")||{}).textContent || "", procLabel: (document.getElementById("btn-process-label")||{}).textContent || "" })',
    returnByValue: true
  }).catch(e => ({ result: { value: '{"error":"' + e.message + '"}' } }));

  fs.writeFileSync(path.join(ROOT, outPrefix + '-result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(ROOT, outPrefix + '-console.txt'), logLines.join('\n'));
  console.log(JSON.stringify({ ok: !!result, result, state: JSON.parse(state.result.value || '{}'), console: logLines.slice(-80), screenshot: outPrefix + '.png', chromePid: chrome.pid }, null, 2));
  try { await cdp.send('Browser.close'); } catch (e) {}
  cdp.close();
  try { execSync('taskkill /PID ' + chrome.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
  process.exit(result ? 0 : 3);
})().catch(async e => {
  console.error('HARNESS ERROR', e && e.stack || e);
  process.exit(1);
});
