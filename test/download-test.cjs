/* Headless Chrome: verify real exportAll ZIP and compare-PNG downloads. */
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'E:/.CS/zaomai-studio';
const DL = path.join(ROOT, 'test', 'downloads');
const port = 9400 + Math.floor(Math.random() * 300);
const profile = path.join(ROOT, 'test', '.chrome-dl-' + port);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(p) { return new Promise((resolve,reject)=>{ const req=http.get({host:'127.0.0.1',port,path:p,timeout:1500},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});}); req.on('error',reject); req.on('timeout',()=>req.destroy(new Error('timeout'))); }); }
class CDP { constructor(wsUrl){ this.ws=new WebSocket(wsUrl); this.nextId=1; this.pending=new Map(); this.events=[]; this.ready=new Promise((res,rej)=>{this.ws.addEventListener('open',res);this.ws.addEventListener('error',rej);}); this.ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id){const p=this.pending.get(m.id); if(p){this.pending.delete(m.id); m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}} else this.events.push(m);}); } async send(method,params){ await this.ready; const id=this.nextId++; return new Promise((res,rej)=>{this.pending.set(id,{resolve:res,reject:rej}); this.ws.send(JSON.stringify({id,method,params:params||{}}));}); } close(){try{this.ws.close();}catch(e){}} }
(async()=>{
  fs.rmSync(DL,{recursive:true,force:true}); fs.mkdirSync(DL,{recursive:true});
  fs.rmSync(profile,{recursive:true,force:true}); fs.mkdirSync(profile,{recursive:true});
  const chrome = spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files','--autoplay-policy=no-user-gesture-required','--no-first-run','--no-default-browser-check','--window-size=1440,1000','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let err=''; chrome.stderr.on('data',d=>err+=d.toString());
  let ws=null;
  for(let i=0;i<80;i++){ try{const list=await httpJson('/json/list'); const p=list.find(t=>t.type==='page'); if(p&&p.webSocketDebuggerUrl){ws=p.webSocketDebuggerUrl;break;}}catch(e){} await sleep(150); }
  if(!ws){ console.error('NO_CDP '+err.slice(-1200)); try{execSync('taskkill /PID '+chrome.pid+' /T /F',{stdio:'ignore'});}catch(e){} process.exit(2); }
  const cdp=new CDP(ws); await cdp.ready; await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:DL,eventsEnabled:true});
  await cdp.send('Page.navigate',{url:'file:///E:/.CS/zaomai-studio/index.html?autotest=1'});
  let ready=false;
  for(let i=0;i<120;i++){ await sleep(500); try{const r=await cdp.send('Runtime.evaluate',{expression:'!!window.__AUTOTEST__',returnByValue:true}); if(r.result&&r.result.value){ready=true;break;}}catch(e){} }
  if(!ready) throw new Error('autotest ready timeout');
  const app = await cdp.send('Runtime.evaluate',{expression:'JSON.stringify({source:!!(ZaomaiApp.getState().source),presets:ZaomaiApp.getPresets().map(p=>p.id)})',returnByValue:true});
  console.log('STATE', app.result.value);
  const ev = await cdp.send('Runtime.evaluate',{expression:'(async()=>{await ZaomaiApp.exportAll();return "EXPORTALL_DONE";})()',awaitPromise:true,returnByValue:true});
  console.log('EXPORTALL', ev.result && ev.result.value);
  // wait for zip download to settle
  let zipPath=null;
  for(let i=0;i<180;i++){
    const files=fs.readdirSync(DL);
    const z=files.find(f=>f.endsWith('.zip'));
    const tmp=files.find(f=>f.endsWith('.crdownload'));
    if(z && !tmp){ zipPath=path.join(DL,z); break; }
    await sleep(500);
  }
  if(!zipPath) throw new Error('zip download not found: '+JSON.stringify(fs.readdirSync(DL)));
  console.log('ZIP', path.basename(zipPath), fs.statSync(zipPath).size);
  const pngEv = await cdp.send('Runtime.evaluate',{expression:'(async()=>{await ZaomaiApp.exportComparePng();return "PNG_DONE";})()',awaitPromise:true,returnByValue:true});
  console.log('PNG', pngEv.result && pngEv.result.value);
  let pngPath=null;
  for(let i=0;i<120;i++){
    const files=fs.readdirSync(DL);
    const p=files.find(f=>f.endsWith('.png') && !f.endsWith('.crdownload'));
    const tmp=files.find(f=>f.endsWith('.crdownload'));
    if(p && !tmp){ pngPath=path.join(DL,p); break; }
    await sleep(500);
  }
  if(!pngPath) throw new Error('png download not found: '+JSON.stringify(fs.readdirSync(DL)));
  console.log('PNG_FILE', path.basename(pngPath), fs.statSync(pngPath).size);
  console.log('ALL_DOWNLOADS', JSON.stringify(fs.readdirSync(DL)));
  try { await cdp.send('Browser.close'); } catch(e) {}
  cdp.close(); try{execSync('taskkill /PID '+chrome.pid+' /T /F',{stdio:'ignore'});}catch(e){}
  process.exit(0);
})().catch(async e=>{ console.error('FAIL', e && e.stack || e); try{await new Promise(r=>setTimeout(r,500));}catch(_){} process.exit(1); });
