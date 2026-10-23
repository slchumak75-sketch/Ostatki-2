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
  await tick();const scroll=d.getElementById('tableScrollContainer');
  if(count>400){scroll.scrollTop=1800;scroll.dispatchEvent(new w.Event('scroll'));await tick();}
  const rows=()=>[...d.querySelectorAll('#tableBody tr[data-row]')].map(row=>Number(row.dataset.row));
  const before=rows(),position=scroll.scrollTop,target=before[3];
  const checkbox=d.querySelector(`[data-plus-row="${target}"]`);
  checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.deepEqual(rows(),before,'No immediate row movement');
  await tick();
  assert.deepEqual(rows(),before,'Server recalculation must not reorder checkmark edits');
  assert.equal(scroll.scrollTop,position,'Viewport must not jump');
  assert.equal(d.querySelector(`[data-qty-row="${target}"]`).value,'0','Order must still be recalculated');
  // Explicit sorting must work on the newly calculated quantities.
  d.querySelector('th[data-sort="finalOrderQty"]').click();await tick();
  scroll.scrollTop=0;scroll.dispatchEvent(new w.Event('scroll'));await tick();
  assert.equal(rows()[0],target,'Explicit sort still uses updated order quantity');
  d.getElementById('btnRelevant').click();
  assert.ok(!rows().includes(target),'Unmarked filter must still hide marked rows');
 } finally {w.close();}
}
(async()=>{await run(30);await run(600);console.log('Stable checkmark rows and virtual viewport tests passed');})().catch(err=>{console.error(err);process.exitCode=1;});
