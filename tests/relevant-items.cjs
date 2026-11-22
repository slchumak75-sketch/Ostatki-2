// Run with NODE_PATH pointing to an installation of jsdom.
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const items=[[8,5,0],[9,0,2],[10,0,0],[11,5,2],[12,0,-1]].map(([excelRow,sales,stock])=>({excelRow,name:`Товар ${excelRow}`,sku:excelRow===12?'+12':String(excelRow),warehouse:'Склад',group:'Группа',supplier:'Поставщик',sumSalesLast12M:sales,closingStock:stock,monthlySales:[],salesSegment:0,finalOrderQty:0,purchasePrice:1}));
const props={[JSON.stringify(['sku','11','Склад'])]:true};
const calls=[],intervals=[];
w.setInterval=(cb,ms)=>{intervals.push({cb,ms});return intervals.length;};
w.fetch=async(path,options={})=>{
 const body=options.body && typeof options.body==='string'?JSON.parse(options.body):{};calls.push({path,body});
 if(path==='api/properties') {Object.assign(props,body.properties);return {ok:true,json:async()=>({properties:props,etalonProperties:{[JSON.stringify(['sku','8','Склад'])]:true,[JSON.stringify(['sku','11','Склад'])]:false},etalonLoaded:true})};}
 return {ok:true,json:async()=>({report:{items,warehouses:[],groups:[],suppliers:[],periods:[],params:{},fileName:'test.xlsx'}})};
};
w.scrollTo=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,40));
// Фактические ширины заголовков фиксируются до базовых переключений (в браузере они реальные).
const thsAll=[...d.querySelectorAll('#itemsTable thead th')];
const plusIdx0=thsAll.findIndex(th=>th.classList.contains('plus-col'));
const dataIdxs0=thsAll.map((th,i)=>i).filter(i=>i!==plusIdx0);
const fakeW0=new Map(dataIdxs0.map((i,k)=>[i,80+k*7]));fakeW0.set(plusIdx0,32);
thsAll.forEach((th,i)=>{th.getBoundingClientRect=()=>({width:fakeW0.get(i),top:0,left:0,right:0,bottom:0});});
(async()=>{
 await tick();
 const rows=()=>[...d.querySelectorAll('#tableBody tr[data-row]')].map(tr=>Number(tr.dataset.row)).sort((a,b)=>a-b);
 const sales=d.getElementById('btnSales12'),relevant=d.getElementById('btnRelevant');
 assert.deepEqual(rows(),[8],'Both filters are enabled by default');
 assert.equal(thsAll.findIndex(th=>th.classList.contains('plus-col')),0,'Plus column is the first header');
 assert.equal(d.getElementById('btnActiveFilter'),null);
 for(const id of ['btnSales12','btnRelevant'])assert.ok(d.getElementById(id).closest('.topbar-actions'));
 for(const id of ['btnExportProperties','btnImportProperties','btnSaveProperties','btnSaveDb'])assert.equal(d.getElementById(id),null);
 for(const button of [sales,relevant])assert.equal(button.getAttribute('aria-pressed'),'true');
 sales.click();assert.deepEqual(rows(),[8,9,10,12],'Б59: один клик выключает продажи');
 relevant.click();assert.deepEqual(rows(),[8,9,10,11,12],'Б59: один клик выключает актуально');
 sales.click();assert.deepEqual(rows(),[8,11],'Re-enable sales immediately');
 relevant.click();assert.deepEqual(rows(),[8]);
 const chk=d.querySelector('[data-plus-row="8"]');chk.checked=true;chk.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.deepEqual(rows(),[],'Live marking hides the current row immediately');
 for(const button of [sales,relevant])button.click(); // Б59: один клик
 assert.deepEqual(rows(),[8,9,10,11,12]);
 assert.equal(relevant.getAttribute('aria-pressed'),'false');
 assert.deepEqual([...d.querySelectorAll('.row-number-cell')].map(el=>el.textContent),['1','2','3','4','5']);
 for(const timer of intervals.filter(t=>t.ms===180000))timer.cb();
 await tick();
 assert.equal(calls.filter(c=>c.path==='api/properties' && c.body.save).length,0,'No periodic property saves');
 // Батч-34: столбец «+» первый и всегда виден — «Актуально» не трогает раскладку.
 const ths=[...d.querySelectorAll('#itemsTable thead th')];
 assert.equal(ths.findIndex(th=>th.classList.contains('plus-col')),0,'Plus column stays first in the header');
 const colWidths=()=>[...d.querySelectorAll('#itemsTable > colgroup > col')].map(c=>c.style.width);
 const sameWidths=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 const cgBefore=d.querySelector('#itemsTable > colgroup');
 assert.ok(cgBefore,'Colgroup exists before toggling');
 const widthsBefore=colWidths();
 assert.equal(widthsBefore.length,ths.length,'Colgroup covers every column (plus always visible)');
 assert.ok(d.querySelector('#tableBody tr[data-row]')?.firstElementChild?.classList.contains('plus-cell'),'First body cell is the plus checkbox');
 relevant.click();await tick();
 assert.equal(d.querySelector('#itemsTable > colgroup'),cgBefore,'Colgroup node must survive toggling (no layout teardown)');
 assert.ok(sameWidths(colWidths(),widthsBefore),'Column widths unchanged when relevance is re-enabled');
 relevant.click();await tick();
 assert.equal(d.querySelector('#itemsTable > colgroup'),cgBefore,'Colgroup node still the same');
 assert.ok(sameWidths(colWidths(),widthsBefore),'Column widths unchanged when relevance is disabled');
 for(const th of ths)delete th.getBoundingClientRect;
 const css49=fs.readFileSync('internal/server/web/styles.css','utf8');
 assert.match(css49,/\.topbar-actions \.btn \{\n  background: var\(--btnbar-bg\)/,'Б49: все кнопки верхней плашки одного цвета');
 assert.match(css49,/\.topbar-actions #btnSales12\[aria-pressed="false"\],\s*\n\.topbar-actions #btnRelevant\[aria-pressed="false"\],\s*\n\.topbar-actions #btnToggleAdvanced\[aria-expanded="false"\] \{\n  background: #ffffff/,'Б55: выключенные 12 мес./актуально/параметры — белые');
 console.log('Full-base and optional sales/unmarked filter tests passed');w.close();
})().catch(err=>{console.error(err);w.close();process.exitCode=1;});
