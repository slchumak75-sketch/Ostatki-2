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
  // Fresh workbook with NO reference: диалог выбора; «Загрузить ведомость» открывает подбор файла.
  d.getElementById('btnUpload').click();await tick();
  const choice=()=>d.getElementById('uploadChoiceModal');
  assert.ok(!choice().classList.contains('hidden'),'Upload choice must open without a reference');
  assert.deepEqual([...choice().querySelectorAll('.v4-modal-toolbar button')].map(b=>b.textContent.trim()),['Загрузить ведомость','Загрузить эталон','Отмена'],'Three actions in the dialog');
  d.getElementById('btnPickWorkbookFile').click();await tick();
  assert.ok(choice().classList.contains('hidden'),'Choice closes before the picker');
  assert.equal(fileDialogs,1,'Workbook picker opens from the choice');
  assert.equal(etalonDialogs,0);
  assert.ok(!calls.includes('api/workbook/check'));
  // «Загрузить эталон» из того же диалога: импорт больше не открывает ведомость автоматически.
  d.getElementById('btnUpload').click();await tick();
  d.getElementById('btnPickEtalonFile').click();await tick();
  assert.equal(etalonDialogs,1,'Reference picker opens from the choice');
  await importEtalon();
  assert.equal(fileDialogs,1,'Reference import must not auto-open the workbook picker');
  ready();
  // Со свежим эталоном — тот же диалог и то же действие ведомости.
  d.getElementById('btnUpload').click();await tick();
  d.getElementById('btnPickWorkbookFile').click();await tick();
  assert.equal(fileDialogs,2);ready();
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
  d.getElementById('btnUpload').click();await tick();
  d.getElementById('btnPickEtalonFile').click();await tick();assert.equal(etalonDialogs,2);
  d.getElementById('etalonFileInput').dispatchEvent(new w.Event('cancel'));await tick();
  assert.equal(fileDialogs,2,'Cancelling the reference picker must not open the workbook picker');
  // «Отмена»/Esc на вопросе об эталоне отменяет всё: ни одного окна, ни одной проверки.
  const callsBeforeCancel=calls.length;
  d.getElementById('btnUpload').click();await tick();
  d.getElementById('uploadChoiceModal').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
  assert.ok(choice().classList.contains('hidden'),'Escape closes the choice');
  assert.equal(fileDialogs,2,'Cancel must not open the workbook picker');
  assert.equal(etalonDialogs,2,'Cancel must not open the reference picker');
  assert.equal(calls.length,callsBeforeCancel,'Cancel must not probe the workbook');
  d.getElementById('btnUpload').click();await tick();
  d.getElementById('btnCancelUploadChoice').click();await tick();
  assert.ok(choice().classList.contains('hidden'));assert.equal(fileDialogs,2);assert.equal(etalonDialogs,2);
  assert.equal(calls.length,callsBeforeCancel,'Cancel button must not probe the workbook either');
 }finally{w.close();}
}
(async()=>{await run();await run();console.log('New-session, failed import, successful import, midnight, clock rollback and always-available workbook gate passed');})().catch(e=>{console.error(e);process.exitCode=1;});
