// Layout contract regression: one scroll owner, header top=0 (not toolbar height).
// jsdom does not paint; native Windows/Chromium scrolling still needs a visual check.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const css=fs.readFileSync('internal/server/web/styles.css','utf8');
const style=d.createElement('style');style.textContent=css;d.head.appendChild(style);
const items=Array.from({length:40},(_,i)=>({excelRow:i+8,sku:String(i),name:`Товар ${i}`,warehouse:'Склад',group:'Группа',supplier:'Поставщик',sumSalesLast12M:1,closingStock:i+1,monthlySales:[],salesSegment:0,finalOrderQty:0,purchasePrice:1,isOverstock:true,overstockValue:i+1}));
w.fetch=async path=>({ok:true,json:async()=>path==='api/properties'?{properties:{}}:{report:{items,warehouses:[],groups:[],suppliers:[],periods:[],params:{},fileName:'radar.xlsx',overstockFrozenCost:820}}});
w.scrollTo=()=>{};w.setInterval=()=>1;
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{
 try {
  await tick();d.querySelector('[data-tab="overstock"]').click();await tick();
  const panel=d.getElementById('view-overstock'),card=d.getElementById('overstockContainer');
  const viewport=card.querySelector('.table-scroll');
  assert.equal(w.getComputedStyle(panel).overflow,'hidden');
  assert.equal(w.getComputedStyle(card).minHeight,'0');
  assert.equal(w.getComputedStyle(viewport).overflowY,'auto');
  assert.equal(w.getComputedStyle(viewport).minHeight,'0');
  for(const th of d.querySelectorAll('#overstockTable th')) {
   assert.equal(w.getComputedStyle(th).position,'sticky');
   assert.equal(w.getComputedStyle(th).top,'0px');
  }
  assert.equal(d.querySelectorAll('#overstockTable tbody tr[data-jump-row]').length,40);
  assert.ok(!css.includes('--sticky-table-head-top'),'No obsolete outer-toolbar offset');
  const first=d.querySelector('#overstockTable tbody tr').textContent;
  d.querySelector('#overstockTable [data-ov-sort="overstockValue"]').click();
  assert.notEqual(d.querySelector('#overstockTable tbody tr').textContent,first,'Radar sorting still works');
  d.querySelector('[data-tab="table"]').click();d.querySelector('[data-tab="overstock"]').click();
  assert.equal(w.getComputedStyle(d.querySelector('#overstockTable th')).top,'0px','Tab switch must not restore an outer header offset');
  console.log('Radar single scroll viewport and sticky header layout tests passed');
 } finally {w.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
