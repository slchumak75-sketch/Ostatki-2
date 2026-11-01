const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const html=fs.readFileSync('internal/server/web/index.html','utf8'),js=fs.readFileSync('internal/server/web/app.js','utf8');
const tick=()=>new Promise(r=>setTimeout(r,50));
async function run(){
 const dom=new JSDOM(html,{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window,d=w.document,timers=[],calls=[];
 const RealDate=w.Date;let now=new RealDate(2026,9,25,23,59,58).getTime(),fail=false;
 w.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 w.setInterval=(cb,ms)=>{timers.push({cb,ms});return timers.length;};w.scrollTo=()=>{};
 const reference={etalonLoaded:true,etalonProperties:{},etalonSavedAt:'2026-10-25T12:00:00Z',etalonFileName:'Эталон.xlsx',properties:{}};
 w.fetch=async(path,options={})=>{calls.push(path);if(path==='api/etalon/import')return {ok:!fail,json:async()=>fail?{error:'Ошибка файла'}:reference};if(path==='api/properties')return {ok:true,json:async()=>reference};if(path==='api/workbook/check')return {ok:true,json:async()=>({fileName:'Ведомость.xlsx',first:'01.01.2026',last:'31.12.2026',items:2,warehouses:['Склад'],duplicates:0,noPrices:0})};return {ok:true,json:async()=>({hasWorkbook:false})};};
 w.eval(js);
 const locked=()=>{for(const id of ['btnUpload','btnLoadSavedDb']){const b=d.getElementById(id);assert.equal(b.disabled,false,'Buttons must open without a reference');assert.equal(b.classList.contains('workbook-ready'),true,'Buttons stay green without a fresh reference');assert.equal(b.classList.contains('workbook-locked'),false);}};
 const ready=()=>{for(const id of ['btnUpload','btnLoadSavedDb']){const b=d.getElementById(id);assert.equal(b.disabled,false);assert.equal(b.classList.contains('workbook-ready'),true);assert.equal(b.classList.contains('workbook-locked'),false);}};
 const dialogVisible=()=>!d.getElementById('safetyDialog').classList.contains('hidden');
 const confirmDialog=async yes=>{assert.ok(dialogVisible(),'Confirmation dialog must be visible');d.getElementById(yes?'safetyDialogYes':'safetyDialogNo').click();await tick();};
 let fileDialogs=0,etalonDialogs=0;
 d.getElementById('fileInput').click=()=>{fileDialogs++;};
 d.getElementById('etalonFileInput').click=()=>{etalonDialogs++;};
 const importEtalon=async()=>{const input=d.getElementById('etalonFileInput');Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['ref'],'Эталон.xlsx')]});input.dispatchEvent(new w.Event('change'));await tick();if(dialogVisible())await confirmDialog(true);};
 try{
  locked();await tick();locked(); // Stored reference alone is insufficient: hint only, buttons stay usable.
  // Saved-database modal opens immediately, without any reference.
  d.getElementById('btnLoadSavedDb').click();await tick();
  assert.ok(!d.getElementById('savedDbModal').classList.contains('hidden'),'Saved workbook modal must open without a reference');
  d.getElementById('btnCloseSavedDbModal').click();await tick();
  // Fresh workbook with NO reference: question first, "no" proceeds straight to the file picker.
  d.getElementById('btnUpload').click();await tick();
  assert.ok(dialogVisible());assert.match(d.getElementById('safetyDialog').textContent,/Загрузить эталон\?/);
  await confirmDialog(false);
  assert.equal(fileDialogs,1,'"No" must open the workbook picker without a reference');
  assert.equal(etalonDialogs,0);
  assert.ok(!calls.includes('api/workbook/check'));
  // "Yes" queues the reference import and then opens the workbook picker automatically.
  d.getElementById('btnUpload').click();await tick();
  await confirmDialog(true);
  assert.equal(etalonDialogs,1,'Reference picker must open on "yes"');
  await importEtalon();
  assert.equal(fileDialogs,2,'Workbook picker must follow a successful reference import');
  ready();
  // With a fresh reference no question is asked.
  d.getElementById('btnUpload').click();await tick();
  assert.ok(!dialogVisible());assert.equal(fileDialogs,3);ready();
  // Midnight: hint flips back, but loading still works and even the guarded day rollover cannot block it.
  now+=4000;timers.find(t=>t.ms===1000).cb();locked();
  now-=4000;w.dispatchEvent(new w.Event('focus'));locked(); // Clock rollback cannot fake freshness.
  now+=86400000;locked();
  const input=d.getElementById('fileInput');Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['db'],'Ведомость.xlsx')]});input.dispatchEvent(new w.Event('change'));await tick();
  await confirmDialog(true);await tick();
  assert.ok(calls.includes('api/workbook/check'),'Workbook check must run without a fresh reference');
  assert.ok(calls.includes('api/upload'),'Workbook upload must run without a fresh reference');
  locked();
  // Cancelled reference picker must not queue a surprise workbook dialog later.
  d.getElementById('etalonFileInput').dispatchEvent(new w.Event('cancel'));await tick();
  d.getElementById('btnUpload').click();await tick();await confirmDialog(true);assert.equal(etalonDialogs,2);
  d.getElementById('etalonFileInput').dispatchEvent(new w.Event('cancel'));await tick();
  assert.equal(fileDialogs,3,'Cancelling the reference picker must not open the workbook picker');
 }finally{w.close();}
}
(async()=>{await run();await run();console.log('New-session, failed import, successful import, midnight, clock rollback and always-available workbook gate passed');})().catch(e=>{console.error(e);process.exitCode=1;});
