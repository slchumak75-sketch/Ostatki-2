const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,count=1500;
const items=Array.from({length:count},(_,i)=>({excelRow:i+8,sku:String(i+8),name:`Товар ${i+8}`,warehouse:'Склад',group:'Группа',supplier:'Поставщик',monthlySales:[],salesSegment:3,sumSalesLast12M:5,closingStock:1,autoOrderQty:count-i,finalOrderQty:count-i,purchasePrice:1}));
w.fetch=async(path)=>({ok:true,json:async()=>path==='api/properties'?{properties:{}}:path==='api/column-widths'?{widths:{}}:{report:{fileName:'test.xlsx',items,params:{},periods:[],warehouses:[],groups:[],suppliers:[]}}});
w.scrollTo=()=>{};
let rowMeasurements=0;
const originalRect=w.HTMLElement.prototype.getBoundingClientRect;
w.HTMLElement.prototype.getBoundingClientRect=function(){
 if(this.matches('tr[data-row]')) {rowMeasurements++;return {height:rowMeasurements%2?31:47,width:800,top:0,bottom:47,left:0,right:800,x:0,y:0};}
 return originalRect.call(this);
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(resolve=>setTimeout(resolve,45));
(async()=>{
 try {
  await tick();for(const id of ['btnSales12','btnRelevant'])for(let i=0;i<4;i++)d.getElementById(id).click();
  const scroll=d.getElementById('tableScrollContainer');
  const height=parseFloat(d.getElementById('itemsTable').style.getPropertyValue('--item-row-height'));
  assert.equal(height,24);
  const verify=()=>{
   const rows=[...d.querySelectorAll('#tableBody tr[data-row]')];
   const spacers=[...d.querySelectorAll('#tableBody tr.virtual-spacer td')].reduce((sum,cell)=>sum+parseFloat(cell.style.height),0);
   assert.equal(spacers+rows.length*height,count*height,'Total virtual height must remain constant');
   const visibleIndex=Math.floor(scroll.scrollTop/height);
   assert.ok(Number(rows[0].dataset.row)-8<=visibleIndex);
   assert.ok(Number(rows.at(-1).dataset.row)-8>=visibleIndex);
  };
  verify();
  for(const offset of [1200,6000,16000,28000,34000,22000,10000,3500,0]) {
   scroll.scrollTop=offset;scroll.dispatchEvent(new w.Event('scroll'));await tick();
   assert.equal(scroll.scrollTop,offset,'Window replacement must not change wheel position');verify();
  }
  const input=d.querySelector('[data-qty-row]');input.focus();
  let refocuses=0;
  const originalFocus=w.HTMLElement.prototype.focus;
  w.HTMLElement.prototype.focus=function(...args){refocuses++;return originalFocus.apply(this,args);};
  scroll.scrollTop=1500;scroll.dispatchEvent(new w.Event('scroll'));await tick();verify();
  assert.equal(refocuses,0,'Wheel scrolling must not refocus a recreated order editor');
  assert.equal(rowMeasurements,0,'Wheel rendering must not recalibrate row height from fluctuating samples');
  console.log('Constant virtual height and bidirectional scrolling tests passed');
 } finally {w.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
