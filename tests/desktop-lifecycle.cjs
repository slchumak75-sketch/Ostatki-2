const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[],beacons=[];
w.fetch=async(path,opts={})=>{
 calls.push(path);
 return {ok:true,json:async()=>path==='api/properties'?{properties:{},persisted:true,markedCount:0,directory:'test'}:path==='api/column-widths'?{widths:{}}:{desktopMode:true,report:null}};
};
w.navigator.sendBeacon=(path,body)=>{beacons.push({path,body});return true;};
const closeWindow=w.close.bind(w);
w.scrollTo=()=>{};w.close=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
(async()=>{
 try {
  await tick();assert.ok(calls.includes('api/heartbeat'),'Connect heartbeat immediately');
  w.dispatchEvent(new w.Event('pagehide'));
  assert.ok(!beacons.some(b=>b.path==='api/shutdown'),'Reload/pagehide must not terminate the server');
  assert.ok(beacons.some(b=>b.path==='api/client-detach'),'Native close gets a cancellable detach hint');
  beacons.length=0;
  const cached=new w.Event('pagehide');Object.defineProperty(cached,'persisted',{value:true});w.dispatchEvent(cached);
  assert.ok(!beacons.some(b=>b.path==='api/client-detach'),'BFCache page must remain resumable');
  assert.ok(beacons.some(b=>b.path==='api/properties'),'Keep last-chance property saving');
  calls.length=0;w.dispatchEvent(new w.Event('pageshow'));await tick();
  assert.ok(calls.includes('api/heartbeat'));
  d.getElementById('btnCloseApp').click();d.getElementById('btnCloseSaveNo').click();await tick();
  assert.ok(calls.includes('api/shutdown'),'Confirmed in-app exit must still terminate server');
  console.log('Desktop reload/resume/explicit-exit lifecycle tests passed');
 } finally {closeWindow();}
})().catch(err=>{console.error(err);process.exitCode=1;});
