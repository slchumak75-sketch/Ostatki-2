// Run with NODE_PATH pointing to an installation of jsdom.
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const items=[[8,5,0],[9,0,2],[10,0,0],[11,5,2],[12,0,-1]].map(([excelRow,sales,stock])=>({excelRow,name:`Товар ${excelRow}`,sku:excelRow===12?'+12':String(excelRow),warehouse:'Склад',group:'Группа',supplier:'Поставщик',sumSalesLast12M:sales,closingStock:stock,monthlySales:[],salesSegment:0,finalOrderQty:0,purchasePrice:1}));
const props={[JSON.stringify(['sku','11'])]:true};
const calls=[],intervals=[];
w.setInterval=(cb,ms)=>{intervals.push({cb,ms});return intervals.length;};
w.fetch=async(path,options={})=>{
 const body=options.body && typeof options.body==='string'?JSON.parse(options.body):{};calls.push({path,body});
 if(path==='api/properties') {Object.assign(props,body.properties);return {ok:true,json:async()=>({properties:props})};}
 return {ok:true,json:async()=>({report:{items,warehouses:[],groups:[],suppliers:[],periods:[],params:{},fileName:'test.xlsx'}})};
};
w.scrollTo=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,40));
(async()=>{
 await tick();
 const rows=()=>[...d.querySelectorAll('#tableBody tr[data-row]')].map(tr=>Number(tr.dataset.row)).sort((a,b)=>a-b);
 const sales=d.getElementById('btnSales12'),relevant=d.getElementById('btnRelevant');
 assert.deepEqual(rows(),[8,9,10,11,12],'Entire base includes zero sales, negative stock, + SKU, and marked items');
 assert.equal(d.getElementById('btnActiveFilter'),null);
 for(const id of ['btnSales12','btnRelevant','btnExportProperties','btnImportProperties']) assert.ok(d.getElementById(id).closest('#paramsPanel'));
 for(const b of [sales,relevant]) assert.equal(b.getAttribute('aria-pressed'),'false');
 sales.click();assert.deepEqual(rows(),[8,11],'Sales only, not stock');
 assert.ok(sales.classList.contains('property-filter-active'));
 relevant.click();assert.deepEqual(rows(),[8],'Combined filters intersect');
 assert.ok(relevant.classList.contains('property-filter-active'));
 sales.click();assert.deepEqual(rows(),[8,9,10,12],'Unmarked only');
 const chk=d.querySelector('[data-plus-row="8"]');chk.checked=true;chk.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.deepEqual(rows(),[9,10,12],'Marking removes an item immediately in unmarked view');
 relevant.click();assert.deepEqual(rows(),[8,9,10,11,12]);
 assert.equal(relevant.getAttribute('aria-pressed'),'false');
 assert.deepEqual([...d.querySelectorAll('.row-number-cell')].map(el=>el.textContent),['1','2','3','4','5']);
 for(const timer of intervals.filter(t=>t.ms===180000))timer.cb();
 await tick();
 assert.equal(calls.filter(c=>c.path==='api/properties' && c.body.save).length,0,'No periodic property saves');
 console.log('Full-base and optional sales/unmarked filter tests passed');w.close();
})().catch(err=>{console.error(err);w.close();process.exitCode=1;});
