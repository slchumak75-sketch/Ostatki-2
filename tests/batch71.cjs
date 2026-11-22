const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[],suppliers:[],groups:[]};
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body,method:options.method||''});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/settings/paths'&&!options.method)return {ok:true,json:async()=>({workbookDir:'D:\\Ведомости',etalonDir:'D:\\Эталоны',workbookCustom:true,etalonCustom:true})};
 if(path==='api/settings/pick-folder')return {ok:true,json:async()=>({path:'D:\\Выбранная папка',cancelled:false})};
 if(path==='api/settings/mail'&&!options.method)return {ok:true,json:async()=>({host:'',port:0,username:'u@mail.ru',from:'',useTLS:false,hasPassword:false,configured:false})};
 if(path==='api/settings/mail')return {ok:true,json:async()=>({saved:true})};
 if(path==='api/settings/mail-test')return {ok:true,json:async()=>({sent:true,to:'u@mail.ru'})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 const js=fs.readFileSync('internal/server/web/app.js','utf8');
 // Б71: высота таблицы измеряется от полной доступной (не застревает маленькой).
 assert.ok(js.includes("c.style.flex = ''; c.style.height = '';"),'Б71: snap сначала возвращает естественную высоту');
 assert.ok(js.includes('snapTableViewportToRows());'),'Б71: snap вызывается при смене панелей/экрана');
 // Выбор папки настоящим окном.
 d.getElementById('btnSavePaths').click();await tick();
 assert.ok(d.getElementById('btnPickEtalonDir')&&d.getElementById('btnPickWorkbookDir'),'Б71: кнопки «Выбрать…» у обоих путей');
 d.getElementById('btnPickWorkbookDir').click();await tick();
 assert.equal(d.getElementById('savePathWorkbook').value,'D:\\Выбранная папка','Б71: выбранная в окне папка подставлена');
 const pick=calls.find(c=>c.path==='api/settings/pick-folder');
 assert.ok(pick&&/ведомости/i.test(pick.body.title),'Б71: окну выбора передан заголовок папки ведомостей');
 d.getElementById('btnSavePathsCancel').click();
 // Почта: автоподстановка сервера и SSL по порту + проверка.
 d.getElementById('btnMailSettings').click();await tick();
 const host=d.getElementById('mailHost');
 host.value='mail.ru';host.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(host.value,'smtp.mail.ru','Б71: mail.ru сам исправляется на smtp.mail.ru');
 const port=d.getElementById('mailPort'),tls=d.getElementById('mailUseTLS');
 port.value='587';port.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(tls.checked,false,'Б71: порт 587 — без SSL-галочки (STARTTLS)');
 port.value='465';port.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(tls.checked,true,'Б71: порт 465 — SSL включается сам');
 d.getElementById('btnMailTest').click();await tick();
 assert.ok(calls.some(c=>c.path==='api/settings/mail-test'),'Б71: проверка почты вызвана');
 assert.match(d.getElementById('mailTestResult').textContent,/отправлено/,'Б71: результат проверки виден в окне');
 const mailPost=calls.find(c=>c.path==='api/settings/mail'&&c.body);
 assert.equal(mailPost.body.host,'smtp.mail.ru','Б71: на сервер уходит исправленный хост');
 assert.equal(mailPost.body.useTLS,true);
 console.log('BATCH-71 UI: full-height snap, folder picker, SMTP hints + test: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
