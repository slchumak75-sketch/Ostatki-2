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
 w.fetch=async(path,options={})=>{calls.push(path);if(path==='api/etalon/import')return {ok:!fail,json:async()=>fail?{error:'Ошибка файла'}:reference};if(path==='api/properties')return {ok:true,json:async()=>reference};return {ok:true,json:async()=>({hasWorkbook:false})};};
 w.eval(js);
 const gate=ready=>{for(const id of ['btnUpload','btnLoadSavedDb']){const b=d.getElementById(id);assert.equal(b.disabled,!ready);assert.equal(b.classList.contains('workbook-ready'),ready);assert.equal(b.classList.contains('workbook-locked'),!ready);}};
 const load=async()=>{const input=d.getElementById('etalonFileInput');Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['ref'],'Эталон.xlsx')]});input.dispatchEvent(new w.Event('change'));await tick();if(!d.getElementById('safetyDialog').classList.contains('hidden')){d.getElementById('safetyDialogYes').click();await tick();}};
 try{
  gate(false);await tick();gate(false); // Stored reference alone is insufficient.
  fail=true;await load();gate(false);fail=false;
  await load();gate(true);
  now+=4000;timers.find(t=>t.ms===1000).cb();gate(false);
  now-=4000;w.dispatchEvent(new w.Event('focus'));gate(false); // Clock rollback cannot revive approval.
  now+=4000;await load();gate(true);
  now+=86400000;const input=d.getElementById('fileInput');Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['db'],'Ведомость.xlsx')]});input.dispatchEvent(new w.Event('change'));await tick();gate(false);assert.ok(!calls.includes('api/upload'));assert.ok(!calls.includes('api/workbook/check'));
 }finally{w.close();}
}
(async()=>{await run();await run();console.log('New-session, failed import, successful import, midnight, clock rollback and guarded-load red/green gate passed');})().catch(e=>{console.error(e);process.exitCode=1;});
