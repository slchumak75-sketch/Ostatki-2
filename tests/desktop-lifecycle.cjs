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
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__lifecycle={openCloseConfirmModal};bootstrap();'));
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
  assert.ok(!d.getElementById('btnCloseApp'),'In-app exit button must stay removed');
  w.__lifecycle.openCloseConfirmModal();d.getElementById('btnCloseSaveNo').click();await tick();
  assert.ok(calls.includes('api/shutdown'),'Confirmed in-app exit must still terminate server');
  // «Конфигурация» lives beside «Сохранить поля» and toggles only the planning-mode body.
  assert.equal(d.getElementById('btnUndoAction'),null,'Undo arrow is removed from the top bar');
  assert.equal(d.getElementById('btnRedoAction'),null,'Redo arrow is removed from the top bar');
  assert.ok(d.getElementById('safetyStatus').closest('.topbar'),'Etalon/workbook status line lives on the top bar');
  assert.ok(d.getElementById('fileMetaLine').parentElement.contains(d.getElementById('safetyStatus')),'Status shares the workbook info line');
  assert.equal(d.getElementById('etalonStorageHint'),null,'Duplicated etalon info line is removed');
  assert.ok(d.getElementById('paramsBody').classList.contains('hidden'),'Planning mode starts collapsed at program load');
  const config=d.getElementById('btnConfigurePanel');
  assert.equal(config.previousElementSibling.id,'btnSaveFields','Configuration button sits on the fields toolbar');
  assert.ok(config.closest('#paramsPanel').classList.contains('hidden'),'Panel itself starts collapsed');
  config.click();
  assert.ok(!d.getElementById('paramsBody').classList.contains('hidden'),'Configuration reveals the planning-mode body');
  assert.equal(config.getAttribute('aria-expanded'),'true');
  assert.ok(config.classList.contains('btn-active-toggle'));
  config.click();
  assert.ok(d.getElementById('paramsBody').classList.contains('hidden'),'Configuration hides only the planning-mode body');
  for(let i=0;i<4;i++)d.getElementById('btnToggleAdvanced').click(); // historical 4-click gate for «Параметры»
  assert.ok(!d.getElementById('paramsPanel').classList.contains('hidden'),'Параметры still opens the whole panel');
  assert.ok(d.getElementById('paramsBody').classList.contains('hidden'),'Configuration-left hidden body survives panel reopening');
  d.getElementById('btnToggleAdvanced').click();
  assert.ok(d.getElementById('paramsPanel').classList.contains('hidden'),'Параметры collapses the whole panel');
  console.log('Desktop reload/resume/explicit-exit lifecycle tests passed');
 } finally {closeWindow();}
})().catch(err=>{console.error(err);process.exitCode=1;});
