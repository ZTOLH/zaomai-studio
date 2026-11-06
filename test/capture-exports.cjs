/* Capture browser-encoded exports from ZAOMAI LAB and save to test/exports. */
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'E:/.CS/zaomai-studio';
const OUT = path.join(ROOT, 'test', 'exports');
const port = 9700 + Math.floor(Math.random() * 200);
const profile = path.join(ROOT, 'test', '.chrome-capture-' + port);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(p) { return new Promise((res, rej) => { const q = http.get({host:'127.0.0.1',port,path:p,timeout:1500}, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}}); }); q.on('error',rej); q.on('timeout',()=>q.destroy(new Error('timeout'))); }); }
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.nextId = 1; this.pending = new Map(); this.logs = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id) { const p=this.pending.get(m.id); if(p){this.pending.delete(m.id); m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} }
      else if (m.method === 'Runtime.consoleAPICalled') this.logs.push('[console] ' + (m.params.args||[]).map(a=>a.value!==undefined?a.value:(a.description||a.type)).join(' '));
      else if (m.method === 'Runtime.exceptionThrown') this.logs.push('[exception] ' + JSON.stringify(m.params.exceptionDetails).slice(0,800));
    });
  }
  async send(method, params) { await this.ready; const id=this.nextId++; return new Promise((res,rej)=>{this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params:params||{}}));}); }
  close(){try{this.ws.close()}catch(e){}}
}
async function evalAwait(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true, userGesture:true});
  if (r.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.exceptionDetails).slice(0,1500));
  return r.result.value;
}
(async () => {
  fs.rmSync(OUT,{recursive:true,force:true}); fs.mkdirSync(OUT,{recursive:true});
  fs.rmSync(profile,{recursive:true,force:true}); fs.mkdirSync(profile,{recursive:true});
  const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files','--autoplay-policy=no-user-gesture-required','--no-first-run','--no-default-browser-check','--window-size=1440,1000','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
  let err=''; chrome.stderr.on('data',d=>err+=d);
  let wsUrl=null;
  for(let i=0;i<80;i++){ try{const l=await httpJson('/json/list'); const p=l.find(t=>t.type==='page'); if(p&&p.webSocketDebuggerUrl){wsUrl=p.webSocketDebuggerUrl;break;}}catch(e){} await sleep(150); }
  if(!wsUrl){ console.error('no page', err.slice(-2000)); process.exit(2); }
  const cdp = new CDP(wsUrl); await cdp.ready;
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate',{url:'file:///E:/.CS/zaomai-studio/index.html?autotest=full'});
  let ready=false;
  for(let i=0;i<240;i++){ try{ const v=await evalAwait(cdp,'!!window.__AUTOTEST__'); if(v){ready=true;break;} }catch(e){} await sleep(500); }
  if(!ready) throw new Error('autotest did not finish');
  console.log('autotest ready');
  const formats = [
    ['wav16','wav'],['wav24','wav'],['wav32f','wav'],['mp3','mp3'],['flac','flac'],['ogg','ogg'],['aiff','aiff']
  ];
  const report = [];
  for (const fmt of formats) {
    const id = fmt[0], ext = fmt[1];
    const t0 = Date.now();
    const expr = '(async()=>{const b=await ZaomaiApp.encodeCurrent(' + JSON.stringify(id) + ');const u=new Uint8Array(await b.arrayBuffer());let s="";const c=0x8000;for(let i=0;i<u.length;i+=c){s+=String.fromCharCode.apply(null,u.subarray(i,i+c));}return {size:b.size,type:b.type,b64:btoa(s)};})()';
    const r = await evalAwait(cdp, expr);
    const buf = Buffer.from(r.b64,'base64');
    const file = path.join(OUT, 'browser_' + id + '.' + ext);
    fs.writeFileSync(file, buf);
    report.push({id, ext, size:r.size, type:r.type, bytes:buf.length, ms:Date.now()-t0});
    console.log(JSON.stringify(report[report.length-1]));
  }
  await evalAwait(cdp, '(()=>{const s=document.getElementById("sample-rate");s.value="44100";s.dispatchEvent(new Event("change",{bubbles:true}));return s.value;})()');
  for (const fmt of [['wav16','wav'],['mp3','mp3']]) {
    const id = fmt[0], ext = fmt[1];
    const expr = '(async()=>{const b=await ZaomaiApp.encodeCurrent(' + JSON.stringify(id) + ');const u=new Uint8Array(await b.arrayBuffer());let s="";const c=0x8000;for(let i=0;i<u.length;i+=c){s+=String.fromCharCode.apply(null,u.subarray(i,i+c));}return {size:b.size,type:b.type,b64:btoa(s)};})()';
    const r = await evalAwait(cdp, expr);
    const buf = Buffer.from(r.b64,'base64');
    fs.writeFileSync(path.join(OUT, 'browser_44100_' + id + '.' + ext), buf);
    console.log('resample', id, buf.length);
  }
  fs.writeFileSync(path.join(ROOT,'test','browser-export-report.json'), JSON.stringify(report,null,2));
  console.log('logs', cdp.logs.slice(-30));
  try { await cdp.send('Browser.close'); } catch(e){}
  cdp.close();
  try { execSync('taskkill /PID ' + chrome.pid + ' /T /F',{stdio:'ignore'}); } catch(e){}
  process.exit(0);
})().catch(e=>{ console.error('CAPTURE ERROR', e.stack||e); process.exit(1); });
