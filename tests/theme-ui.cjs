const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
let store={};
Object.defineProperty(w,'localStorage',{value:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}}});
const items=[{excelRow:8,sku:'001',name:'Товар один',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:10,sumSalesLast12M:5,salesSegment:2,purchasePrice:1,monthlySales:[],autoOrderQty:7,finalOrderQty:7}];
w.fetch=async()=>({ok:true,json:async()=>({report:{items,fileName:'Т.xlsx',periods:[],warehouses:[],suppliers:[],groups:[],params:{},totalItems:items.length},savedFileName:'',lastSavedAt:''})});
w.scrollTo=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const css=fs.readFileSync('internal/server/web/styles.css','utf8');
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 // Селектор темы — в шапке, после «Параметры».
 const sel=d.getElementById('themeSelect');
 assert.ok(sel,'themeSelect есть');
 assert.equal(sel.previousElementSibling.id,'btnToggleAdvanced','themeSelect после btnToggleAdvanced');
 assert.equal(sel.options.length,5,'в селекторе 5 тем');
 // По умолчанию — тёплая тема; выбор запоминается в localStorage.
 assert.equal(d.body.getAttribute('data-theme'),'warm','тема по умолчанию warm');
 sel.value='nordic';sel.dispatchEvent(new w.Event('change',{bubbles:true}));await tick();
 assert.equal(d.body.getAttribute('data-theme'),'nordic','тема переключается');
 assert.equal(store['ostatki_theme'],'nordic','выбор сохранён');
 // Невалидное сохранённое значение -> тёплая тема (второй инстанс DOM).
 const store2={'ostatki_theme':'hacker-green'};
 const dom2=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
 Object.defineProperty(dom2.window,'localStorage',{value:{getItem:k=>store2[k]??null,setItem:(k,v)=>{store2[k]=String(v);},removeItem:k=>{delete store2[k];}}});
 dom2.window.fetch=w.fetch;dom2.window.scrollTo=()=>{};
 dom2.window.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
 assert.equal(dom2.window.document.body.getAttribute('data-theme'),'warm','невалидная тема -> warm');
 await tick();
 dom2.window.close();
 // Все пять тем объявлены в CSS со своими токенами и стилистикой.
 for(const t of ['nordic','sage','lavender','sand']){
   assert.ok(css.includes(`[data-theme="${t}"]`),`тема ${t} в CSS`);
   assert.ok(css.includes(`[data-theme="${t}"] .btn`),`стилистика кнопок ${t}`);
 }
 assert.ok(css.includes('[data-theme="nordic"] .data-table thead th'),'шапка nordic');
 assert.ok(css.includes('[data-theme="sand"] .btn { border-radius: 99px'),`пилюли sand`);
 // Приглушённые цвета рейтинга: оттенки прежние, насыщенность ниже.
 assert.ok(css.includes('.seg-pill.seg-5 { background-color: #5fae77 !important'),'рейтинг 5 приглушён');
 assert.ok(css.includes('.seg-pill.seg-0 { background-color: #cf5f5b !important'),'рейтинг 0 приглушён');
 assert.ok(!css.includes('#22c55e'),'яркий зелёный рейтинга убран');
 // Базовые тёплые токены :root не тронуты (инвариант upload-choice).
 assert.match(css,/--bg: #f6f1e7;/);
 assert.match(css,/--primary: #b45309;/);
 console.log('THEME UI: 5 тем + приглушённый рейтинг: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
