const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const tick=()=>new Promise(resolve=>setTimeout(resolve,45));
async function run(count) {
 const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,props={};
 const items=Array.from({length:count},(_,i)=>({excelRow:i+8,sku:String(i+8),warehouse:'Склад',group:'Группа',name:`Товар ${i+8}`,supplier:'Поставщик',salesSegment:3,sumSalesLast12M:5,closingStock:1,purchasePrice:2,monthlySales:[],autoOrderQty:count-i,finalOrderQty:count-i}));
 const env=()=>({report:{fileName:'test.xlsx',params:{},items:items.map(it=>({...it,autoOrderQty:props[JSON.stringify(['sku',it.sku,it.warehouse])]?0:it.autoOrderQty,finalOrderQty:props[JSON.stringify(['sku',it.sku,it.warehouse])]?0:it.finalOrderQty})),periods:[],warehouses:[],groups:[],suppliers:[]}});
 w.fetch=async(path,options={})=>{
  if(path==='api/properties') {
   if(!options.body)return {ok:true,json:async()=>({properties:{}})};
   Object.assign(props,JSON.parse(options.body).properties);
   return {ok:true,json:async()=>({persisted:true,markedCount:1,directory:'test',state:env()})};
  }
  return {ok:true,json:async()=>env()};
 };
 w.scrollTo=()=>{};w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
 try {
  await tick();for(const id of ['btnSales12','btnRelevant'])for(let i=0;i<4;i++)d.getElementById(id).click();const scroll=d.getElementById('tableScrollContainer');
  if(count>400){scroll.scrollTop=1800;scroll.dispatchEvent(new w.Event('scroll'));await tick();}
  const rows=()=>[...d.querySelectorAll('#tableBody tr[data-row]')].map(row=>Number(row.dataset.row));
  const before=rows(),position=scroll.scrollTop,target=before[3];
  const checkbox=d.querySelector(`[data-plus-row="${target}"]`);
  const originalRows=[...d.querySelectorAll('#tableBody tr[data-row]')];
  const spacer=d.querySelector('#tableBody tr.virtual-spacer');
  const originalSpacerHTML=spacer?.outerHTML;
  checkbox.focus();
  checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.deepEqual(rows(),before,'No immediate row movement');
  originalRows.forEach((node,i)=>assert.strictEqual(d.querySelectorAll('#tableBody tr[data-row]')[i],node,'Keep row DOM nodes on immediate edit'));
  assert.strictEqual(d.activeElement,checkbox,'Checkbox must not lose focus');
  await tick();
  assert.deepEqual(rows(),before,'Server recalculation must not reorder checkmark edits');
  assert.equal(scroll.scrollTop,position,'Viewport must not jump');
  originalRows.forEach((node,i)=>assert.strictEqual(d.querySelectorAll('#tableBody tr[data-row]')[i],node,'Keep row DOM nodes after server acknowledgement'));
  assert.strictEqual(d.activeElement,checkbox);
  if(spacer) {assert.ok(spacer.isConnected);assert.equal(spacer.outerHTML,originalSpacerHTML,'Virtual spacers must not be resized on checkmarks');}
  assert.equal(d.querySelector(`[data-qty-row="${target}"]`).value,'0','Order must still be recalculated');
  // Explicit sorting must work on the newly calculated quantities.
  d.querySelector('th[data-sort="finalOrderQty"]').click();await tick();
  scroll.scrollTop=0;scroll.dispatchEvent(new w.Event('scroll'));await tick();
  assert.equal(rows()[0],target,'Explicit sort still uses updated order quantity');
  d.getElementById('btnRelevant').click();
  assert.ok(rows().includes(target),'Relevance must not hide a newly marked row absent from the reference');
 } finally {w.close();}
}
(async()=>{await run(30);await run(600);console.log('Stable checkmark rows and virtual viewport tests passed');})().catch(err=>{console.error(err);process.exitCode=1;});
