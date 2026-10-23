// Run with NODE_PATH pointing to jsdom.
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const tick=()=>new Promise(r=>setTimeout(r,35));
async function scenario(action,fail='') {
 const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,calls=[];
 const item={excelRow:8,sku:'A',warehouse:'Склад',name:'Товар',group:'Группа',supplier:'Поставщик',sumSalesLast12M:3,closingStock:1,autoOrderQty:2,finalOrderQty:2,monthlySales:[]};
 const env={hasWorkbook:true,report:{items:[item],warehouses:[],groups:[],suppliers:[],periods:[],params:{},fileName:'test.xlsx'}};
 w.scrollTo=()=>{};
 w.fetch=async(path,options={})=>{
  const body=typeof options.body==='string'?JSON.parse(options.body):{};
  calls.push({path,body});
  if((fail==='properties' && path==='api/properties' && body.save) || (fail==='database' && path==='api/db/save') || (fail==='clear' && path.startsWith('api/clear?'))) return {ok:false,json:async()=>({error:'Test failure'})};
  const data=path==='api/properties'?{properties:{},fileName:'properties.json'}:path==='api/column-widths'?{widths:{}}:path==='api/db/save'?{fileName:'saved.xlsx'}:env;
  return {ok:true,json:async()=>data};
 };
 w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
 try {
  await tick();calls.length=0;
  const modal=d.getElementById('clearConfirmModal');
  d.getElementById('btnClearDatabase').click();
  assert.equal(modal.classList.contains('hidden'),false);
  assert.equal(d.querySelectorAll('#tableBody tr[data-row]').length,1,'Opening confirmation must not clear');
  assert.equal(calls.filter(c=>c.path.startsWith('api/clear?')).length,0);
  if(action==='escape') d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  else d.getElementById(action).click();
  await tick();
  const clear=calls.filter(c=>c.path.startsWith('api/clear?'));
  const saves=calls.filter(c=>c.path==='api/db/save');
  if(action==='btnClearSaveCancel' || action==='escape') {
   assert.equal(clear.length,0);assert.equal(saves.length,0);
   assert.equal(modal.classList.contains('hidden'),true);
   assert.equal(d.querySelectorAll('#tableBody tr[data-row]').length,1);
  } else if(fail) {
   assert.equal(d.querySelectorAll('#tableBody tr[data-row]').length,1,'Failure must preserve visible database');
   assert.equal(modal.classList.contains('hidden'),false);
   if(fail!=='clear') assert.equal(clear.length,0,'Save failure must prevent clearing');
   assert.equal(d.getElementById('btnClearSaveCancel').disabled,false);
  } else {
   assert.equal(clear.length,1);
   assert.equal(d.querySelectorAll('#tableBody tr[data-row]').length,0);
   assert.equal(modal.classList.contains('hidden'),true);
   if(action==='btnClearSaveYes') {
    assert.equal(saves.length,1);
    assert.ok(calls.some(c=>c.path==='api/properties' && c.body.save));
    assert.ok(calls.indexOf(saves[0])<calls.indexOf(clear[0]),'Save before clear');
   } else {assert.equal(saves.length,0);assert.ok(!calls.some(c=>c.path==='api/properties' && c.body.save));}
  }
 } finally {w.close();}
}
(async()=>{
 await scenario('btnClearSaveCancel');await scenario('escape');
 await scenario('btnClearSaveNo');await scenario('btnClearSaveYes');
 await scenario('btnClearSaveYes','properties');await scenario('btnClearSaveYes','database');await scenario('btnClearSaveNo','clear');
 console.log('Clear-database save confirmation tests passed');
})().catch(err=>{console.error(err);process.exitCode=1;});
