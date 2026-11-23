// Б82: введённый заказ «пропадал» из ячейки после прокрутки туда-обратно.
// Причина: тихий коммит количества заменял state.report новыми объектами,
// а state.filteredItems (источник отрисовки строк) ссылался на прежние.
// Тест имитирует реальный сервер: каждый ответ — СВЕЖИЕ объекты (JSON),
// а не те же ссылки (как в старых моках, маскировавших баг).
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;w.scrollTo=()=>{};w.setInterval=()=>1;
const make=(excelRow)=>({excelRow,sku:'00'+excelRow,name:'Товар '+excelRow,warehouse:'Склад Мир',group:'Группа',supplier:'Поставщик',closingStock:3,sumSalesLast12M:10,salesSegment:3,monthlySales:[],autoOrderQty:0,finalOrderQty:0,purchasePrice:2,manualOverride:null});
const serverItems=Array.from({length:10},(_,i)=>make(i+8));
const freshReport=()=>JSON.parse(JSON.stringify({fileName:'Тест.xlsx',items:serverItems,params:{budgetCap:0},periods:[],warehouses:[],groups:[],suppliers:[]}));
w.fetch=async(path,options={})=>{
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/column-widths')return {ok:true,json:async()=>({widths:{}})};
 if(path==='api/orders/sent-marks')return {ok:true,json:async()=>({sent:[]})};
 if(path==='api/override'){
   const req=JSON.parse(options.body);
   const it=serverItems.find(x=>x.excelRow===req.excelRow);
   it.finalOrderQty=req.value; it.manualOverride=req.value;
   return {ok:true,json:async()=>({report:freshReport()})};
 }
 return {ok:true,json:async()=>({report:freshReport()})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__b82={state,renderTableBodyWindow}; bootstrap();'));
const tick=(ms=90)=>new Promise(r=>setTimeout(r,ms));
const typeQty=(row,val)=>{const inp=d.querySelector(`[data-qty-row="${row}"]`);assert.ok(inp,'строка '+row+' отрисована');inp.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));inp.value=val;inp.dispatchEvent(new w.Event('input',{bubbles:true}));return inp;};
const cellVal=(row)=>d.querySelector(`[data-qty-row="${row}"]`)?.value;
(async()=>{try{
 await tick();await tick();
 const {state,renderTableBodyWindow}=w.__b82;
 assert.equal(cellVal(8),'','исходно ячейка пуста');
 // 1) Первый заказ — сохраняется тихо, отчёт на клиенте заменяется новыми объектами.
 typeQty(8,'4');await tick(600);
 // 2) Второй заказ — вводится УЖЕ после замены отчёта (именно он и терялся).
 typeQty(9,'7');await tick(600);
 // 3) «Уехал вниз и вернулся»: полная перерисовка строк из отображаемого списка.
 renderTableBodyWindow(true);
 assert.equal(cellVal(8),'4','Б82: первый заказ на месте после перерисовки');
 assert.equal(cellVal(9),'7','Б82: второй заказ НЕ должен пропадать после прокрутки туда-обратно');
 // 4) Черновик в полёте: ввели и сразу перерисовали (сохранение ещё не вернулось).
 typeQty(10,'5');
 renderTableBodyWindow(true);
 assert.equal(cellVal(10),'5','Б82: несохранённый ввод виден при перерисовке (pending)');
 await tick(600);
 renderTableBodyWindow(true);
 assert.equal(cellVal(10),'5','Б82: после подтверждения значение осталось');
 // 5) На «сервере» все три значения действительно сохранены.
 assert.deepEqual(serverItems.slice(0,3).map(it=>it.finalOrderQty),[4,7,5],'Б82: сервер хранит все заказы');
 assert.equal(state.rowMap.get(9).finalOrderQty,7,'Б82: актуальный отчёт согласован');
 console.log('BATCH-82: qty survives scroll-away-and-back after silent commits: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
