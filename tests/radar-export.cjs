const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
const items=Array.from({length:640},(_,i)=>({excelRow:i+8,sku:String(i),name:`Товар ${i}`,warehouse:i%2?'B':'A',group:'Группа',supplier:'Поставщик',sumSalesLast12M:1,closingStock:i+1,monthlySales:[],salesSegment:3,finalOrderQty:0,purchasePrice:1,isOverstock:true,overstockValue:i+1}));
let downloads=0;
w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
w.HTMLAnchorElement.prototype.click=function(){downloads++;};
w.scrollTo=()=>{};w.setInterval=()=>1;
w.fetch=async(path,options={})=>{
 if(path==='api/export/radar'){calls.push(JSON.parse(options.body));return {ok:true,headers:{get:()=>''},blob:async()=>new w.Blob(['xlsx'])};}
 return {ok:true,json:async()=>path==='api/properties'?{properties:{}}:{report:{items,warehouses:[],groups:[],suppliers:[],periods:[],params:{},fileName:'radar.xlsx',overstockFrozenCost:205120}}};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,70));
(async()=>{try{
 await tick();
 const button=d.getElementById('btnExportRadar');
 assert.equal(button.closest('#paramsPanel').id,'paramsPanel');assert.ok(d.getElementById('paramsPanel').classList.contains('hidden'),'Radar export is in the collapsed Parameters panel');
 assert.equal(d.querySelectorAll('#overstockTable tr[data-jump-row]').length,500);
 const before=JSON.stringify(items);button.click();await tick();
 assert.equal(downloads,1);assert.equal(calls[0].excelRows.length,640,'Export all matching radar rows, not 500 displayed');
 assert.equal(calls[0].excelRows[0],647,'Preserve descending frozen-value sort');
 const wh=d.getElementById('ovFltWarehouse');wh.value='B';wh.dispatchEvent(new w.Event('change'));button.click();await tick();
 assert.equal(calls[1].excelRows.length,320);assert.ok(calls[1].excelRows.every(id=>(id-8)%2===1));
 const search=d.getElementById('ovInpSearch');search.value='нет такого товара';search.dispatchEvent(new w.Event('input'));button.click();await tick();
 assert.equal(calls.length,2,'Empty selection must not download all rows accidentally');
 assert.equal(button.disabled,false);assert.equal(JSON.stringify(items),before);
 console.log('Radar export full selection, ordering, warehouse filters, empty state and button placement passed');
}finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
