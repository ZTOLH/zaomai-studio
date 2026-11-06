/* Screenshot sections of ZAOMAI LAB for visual QA. */
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'E:/.CS/zaomai-studio';
const port = 9900 + Math.floor(Math.random() * 90);
const profile = path.join(ROOT,'test','.chrome-shots-'+port);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function httpJson(p){return new Promise((res,rej)=>{const q=http.get({host:'127.0.0.1',port,path:p,timeout:1500},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});q.on('error',rej);q.on('timeout',()=>q.destroy(new Error('timeout')))});}
class CDP{constructor(u){this.ws=new WebSocket(u);this.id=1;this.p=new Map();this.logs=[];this.ready=new Promise((res,rej)=>{this.ws.addEventListener('open',res);this.ws.addEventListener('error',rej)});this.ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id){const p=this.p.get(m.id);if(p){this.p.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}}else if(m.method==='Runtime.consoleAPICalled')this.logs.push('[console] '+(m.params.args||[]).map(a=>a.value!==undefined?a.value:(a.description||a.type)).join(' '));else if(m.method==='Runtime.exceptionThrown')this.logs.push('[exception] '+JSON.stringify(m.params.exceptionDetails).slice(0,500));else if(m.method==='Log.entryAdded')this.logs.push('[log] '+m.params.entry.level+' '+m.params.entry.text)});}async send(m,p){await this.ready;const id=this.id++;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method:m,params:p||{}}))})}close(){try{this.ws.close()}catch(e){}}}
async function ev(c,e){const r=await c.send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,1000));return r.result.value}
(async()=>{
  fs.rmSync(profile,{recursive:true,force:true});fs.mkdirSync(profile,{recursive:true});
  const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--allow-file-access-from-files','--autoplay-policy=no-user-gesture-required','--no-first-run','--no-default-browser-check','--hide-scrollbars','--window-size=1440,1000','--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let err='';chrome.stderr.on('data',d=>err+=d);
  let ws=null;
  for(let i=0;i<80;i++){try{const l=await httpJson('/json/list');const p=l.find(t=>t.type==='page');if(p&&p.webSocketDebuggerUrl){ws=p.webSocketDebuggerUrl;break}}catch(e){}await sleep(150)}
  if(!ws){console.error('no page',err.slice(-2000));process.exit(2)}
  const c=new CDP(ws);await c.ready;await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await c.send('Page.navigate',{url:'file:///E:/.CS/zaomai-studio/index.html?autotest=full'});
  let ok=false;for(let i=0;i<240;i++){try{if(await ev(c,'!!window.__AUTOTEST__')){ok=true;break}}catch(e){}await sleep(500)}
  if(!ok)throw new Error('autotest did not finish');
  await sleep(600);
  const shots=[['hero','body',0],['console','#console',-72],['levels','#levels',-72],['export','#export',-72],['guide','#guide',-72]];
  for(const s of shots){
    const name=s[0],sel=s[1],off=s[2];
    const pinfo = await ev(c,'(()=>{document.documentElement.style.scrollBehavior="auto";const e=document.querySelector('+JSON.stringify(sel)+');if(!e)return {missing:true};const y=e.getBoundingClientRect().top+window.scrollY+'+off+';window.scrollTo(0,y);return {target:y,y:window.scrollY,top:e.getBoundingClientRect().top,h:document.documentElement.scrollHeight};})()');
    console.log('scroll', name, JSON.stringify(pinfo));
    await sleep(450);
    const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(ROOT,'test','shot-'+name+'.png'),Buffer.from(r.data,'base64'));
    console.log('shot',name);
  }
  // full page
  try{
    const m=await c.send('Page.getLayoutMetrics');
    const h=Math.ceil(m.cssContentSize.height);
    const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1440,height:Math.min(h,12000),scale:1}});
    fs.writeFileSync(path.join(ROOT,'test','shot-fullpage.png'),Buffer.from(r.data,'base64'));
    console.log('fullpage height',h);
  }catch(e){console.log('fullpage failed',e.message)}
  // mobile
  await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await ev(c,'window.scrollTo(0,0)');await sleep(500);
  let r=await c.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(ROOT,'test','shot-mobile.png'),Buffer.from(r.data,'base64'));
  console.log('shot mobile');
  await ev(c,'(()=>{document.documentElement.style.scrollBehavior="auto";const e=document.querySelector("#console");window.scrollTo(0,e.getBoundingClientRect().top+window.scrollY-64);return window.scrollY;})()');await sleep(400);
  r=await c.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(ROOT,'test','shot-mobile-console.png'),Buffer.from(r.data,'base64'));
  console.log('shot mobile console');
  console.log('logs',c.logs.slice(-40));
  try{await c.send('Browser.close')}catch(e){}
  c.close();try{execSync('taskkill /PID '+chrome.pid+' /T /F',{stdio:'ignore'})}catch(e){}
  process.exit(0);
})().catch(e=>{console.error('SHOTS ERROR',e.stack||e);process.exit(1)});
