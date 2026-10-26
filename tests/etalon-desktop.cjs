// NODE_PATH=/tmp/ui-check/node_modules node tests/etalon-desktop.cjs
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const calls=[];
let failExport=false;
w.scrollTo=()=>{};w.setInterval=()=>1;w.confirm=()=>true;
w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
w.fetch=async(path,opts={})=>{
  let body={};if(typeof opts.body==='string')body=JSON.parse(opts.body);calls.push({path,body,method:opts.method||'GET'});
  if(path==='api/state')return {ok:true,json:async()=>({desktopMode:true,report:{items:[],params:{},warehouses:[],suppliers:[],groups:[],periods:[],fileName:'1C.xlsx'}})};
  if(path==='api/properties')return {ok:true,json:async()=>({properties:{},nomenclature:{},etalonLoaded:true,etalonFileName:'Эталон, 26.10.2026.xlsx',etalonSavedAt:'2026-10-26T16:23:00+03:00'})};
  if(path==='api/column-widths')return {ok:true,json:async()=>({widths:{}})};
  if(path==='api/etalon/preview')return {ok:true,json:async()=>({token:'preview',source:'old.xlsx',newSource:'new.xlsx',total:0,marks:0,stocks:0,ratings:0,added:0})};
  if(path==='api/etalon/backup')return {ok:true,json:async()=>({fileName:'Эталон, 26.10.2026, резервная копия.json',directory:'Загрузки/Эталон',saved:true})};
  if(path==='api/etalon/export')return failExport?{ok:false,json:async()=>({error:'эталон повреждён'})}:{ok:true,json:async()=>({fileName:'Эталон, 26.10.2026.xlsx',directory:'Загрузки/Эталон',saved:true})};
  return {ok:true,json:async()=>({})};
};
new w.MutationObserver(()=>{const box=d.getElementById('safetyDialog');if(box&&!box.classList.contains('hidden'))d.getElementById('safetyDialogYes').click();}).observe(d.body,{subtree:true,attributes:true,attributeFilter:['class']});
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
const toastText=()=>d.getElementById('toast').textContent;
(async()=>{try{
 await tick();
 assert.equal(calls.filter(c=>c.path==='api/state').length,1);
 // Desktop export writes to the Downloads folder instead of a browser download.
 d.getElementById('btnExportEtalon').click();await tick();
 const exports=()=>calls.filter(c=>c.path==='api/etalon/export');
 assert.equal(exports().length,1);assert.equal(exports()[0].method,'POST');
 assert.match(toastText(),/Загрузки \/ Эталон • Эталон, 26\.10\.2026\.xlsx/);
 // Backup refreshes both files so a same-minute export and backup keep the same time.
 d.getElementById('btnBackupEtalon').click();await tick();
 assert.ok(calls.some(c=>c.path==='api/etalon/backup'&&c.method==='POST'));
 assert.equal(exports().length,2,'Backup must refresh the dated Excel copy too');
 assert.match(toastText(),/JSON-копия/);assert.match(toastText(),/Эталон, 26\.10\.2026\.xlsx/);
 // If the Excel refresh fails the JSON is still kept and the reason is shown.
 failExport=true;d.getElementById('btnBackupEtalon').click();await tick();
 assert.equal(exports().length,3);
 assert.match(toastText(),/JSON-копия сохранена/);assert.match(toastText(),/эталон повреждён/);
 console.log('Desktop etalon export and backup with same-time Excel refresh passed');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
