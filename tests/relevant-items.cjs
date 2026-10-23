// Run with NODE_PATH pointing to an installation of jsdom.
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const dom = new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'), {
  url:'http://app.test', runScripts:'outside-only', pretendToBeVisual:true,
});
const w = dom.window, d = w.document;
const items = [[8,5,0],[9,0,2],[10,0,0],[11,5,2],[12,0,-1]].map(([excelRow,sales,stock]) => ({
  excelRow, name:`Товар ${excelRow}`, sku:String(excelRow), warehouse:'Склад', group:'Группа',
  supplier:'Поставщик', sumSalesLast12M:sales, closingStock:stock, monthlySales:[],
  salesSegment:0, finalOrderQty:0, purchasePrice:1,
}));
w.fetch = async () => ({ok:true,json:async()=>({report:{items,warehouses:[],groups:[],suppliers:[],periods:[],params:{},fileName:'test.xlsx'}})});
w.scrollTo = () => {};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
setTimeout(() => {
  try {
    const rows = () => [...d.querySelectorAll('#tableBody tr[data-row]')].map(tr=>Number(tr.dataset.row)).sort((a,b)=>a-b);
    assert.deepEqual(rows(),[8,9,11], 'Sales OR positive stock; no sales and zero/negative stock excluded');
    d.querySelector('[data-filter-col="name"]').click();
    assert.deepEqual([...d.querySelectorAll('[data-excel-value]')].map(el=>el.dataset.excelValue).sort(),['Товар 11','Товар 8','Товар 9']);
    d.getElementById('efBtnCancel').click();
    assert.equal(d.getElementById('btnRelevant'),null);
    assert.deepEqual([...d.querySelectorAll('.row-number-cell')].map(el=>el.textContent),['1','2','3']);
    console.log('Sales-or-stock relevance tests passed');
  } catch(err) {console.error(err);process.exitCode=1;}
  finally {w.close();}
},30);
