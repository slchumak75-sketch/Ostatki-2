// Батч-33: селектор «Окно рейтинга продаж» должен запускать пересчёт сразу
// (регрессия б32: селектор был в форме и в collectParamsFromUI, но отсутствовал
// в списке change-обработчиков — таблица не обновлялась при смене 6 -> 12).
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.setInterval=()=>1;
const make=(excelRow,sku)=>({excelRow,sku,name:'Товар '+sku,warehouse:'Мир',supplier:'Поставщик',group:'Группа',closingStock:3,sumSalesLast12M:10,salesSegment:3,monthlySales:[],autoOrderQty:0,finalOrderQty:0,purchasePrice:2,manualOverride:null});
const items=[make(8,'001'),make(9,'002')];
const report={fileName:'Тест.xlsx',items,params:{budgetCap:0,ratingWindowMonths:6},periods:[],warehouses:[],groups:[],suppliers:[]};
w.fetch=async(path,options={})=>{calls.push({path,options});if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:true})};if(path==='api/params'){const req=JSON.parse(options.body);report.params={...report.params,...req};}return {ok:true,json:async()=>({report})};};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__actions={state}; bootstrap();'));
const tick=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 await tick();const {state}=w.__actions;
 const sel=d.getElementById('selRatingWindow');
 assert.ok(sel,'Селектор окна рейтинга должен быть в разметке');
 assert.equal(sel.value,'6','По умолчанию окно 6 месяцев');
 assert.ok(state.report,'Расчёт должен быть загружен до изменений');
 const beforeParams=calls.filter(c=>c.path==='api/params').length;
 sel.value='12';
 sel.dispatchEvent(new w.Event('change',{bubbles:true}));
 // debounce пересчёта — ждём появления запроса до 3 секунд
 let sent=null;
 for(let i=0;i<30&&!sent;i++){await tick(100);const p=calls.filter(c=>c.path==='api/params');if(p.length>beforeParams)sent=JSON.parse(p.at(-1).options.body);}
 assert.ok(sent,'Смена окна рейтинга должна запустить POST api/params');
 assert.equal(sent.ratingWindowMonths,12,'В параметрах должно уйти окно 12');
 console.log('rating-window-recalc: OK');
 process.exit(0);
}catch(e){console.error('FAIL:',e.message);process.exit(1);}})();
