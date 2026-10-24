/* Read-only liquidity analytics; independent of purchasing forecasts and marks. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>Number.isFinite(v)?v.toLocaleString('ru-RU',{maximumFractionDigits:2}):'—';
  const names={fast:'До 30 дней',normal:'31–90 дней',slow:'91–180 дней',excess:'181–365 дней',overyear:'Более 365 дней',nosales:'Запас без продаж',nostock:'Нет положительного остатка'};
  const monthKey=p=>`${p.year}-${String(p.month).padStart(2,'0')}`;
  let report=null,signature='',analysis=null,page=0;
  const pageSize=100;
  function category(stock,sales,days) {
    if(stock<=0)return 'nostock';
    if(sales<=0)return 'nosales';
    if(days<=30)return 'fast';if(days<=90)return 'normal';if(days<=180)return 'slow';if(days<=365)return 'excess';return 'overyear';
  }
  function analyze(rep,from,to) {
    const periods=rep?.periods||[],items=rep?.items||[];
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to>=periods.length||from>to)return {rows:[],days:0,error:'Начало периода должно быть не позже окончания.'};
    const exposures=[];let days=0;
    for(let j=from;j<=to;j++) {
      const p=periods[j];
      let fraction=Number(p.completeness);
      if(j===periods.length-1 && Number(rep.lastMonthCompleteness)>0)fraction=Number(rep.lastMonthCompleteness);
      if(!(fraction>0&&fraction<=1))fraction=1;
      const duration=new Date(Date.UTC(p.year,p.month,0)).getUTCDate();
      const elapsed=Math.max(1,Math.round(duration*fraction));
      days+=elapsed;exposures.push(elapsed/duration);
    }
    let missingPrices=0,negativeStocks=0,returns=0;
    const rows=items.map((it,index)=>{
      const price=Number(it.purchasePrice),validPrice=Number.isFinite(price)&&price>0;
      if(!validPrice)missingPrices++;
      const rawStock=Number(it.closingStock),stock=Number.isFinite(rawStock)?Math.max(0,rawStock):0;
      if(rawStock<0)negativeStocks++;
      let sales=0;const months=[];
      for(let j=from;j<=to;j++) {
        const raw=Number(it.monthlySales?.[j]||0),v=Number.isFinite(raw)?Math.max(0,raw):0;
        if(raw<0)returns++;
        sales+=v;months.push(v/exposures[j-from]);
      }
      const daily=sales/days,coverage=daily>0?stock/daily:null;
      const mean=months.reduce((s,v)=>s+v,0)/months.length;
      const cv=mean>0?Math.sqrt(months.reduce((s,v)=>s+(v-mean)**2,0)/months.length)/mean:null;
      const xyz=sales<=0?'Нет продаж':months.length<3?'—':cv<=0.1?'X':cv<=0.25?'Y':'Z';
      return {index,excelRow:it.excelRow,warehouse:String(it.warehouse||'Без склада'),sku:String(it.sku||''),name:String(it.name||''),group:String(it.group||'(Не указана)'),supplier:String(it.supplier||'(Не указан)'),rawStock,stock,sales,daily,coverage,turnover:stock>0?sales/stock:null,price:validPrice?price:null,salesValue:validPrice?sales*price:0,stockValue:validPrice?stock*price:0,abc:validPrice?'C':'—',xyz,cv,share:0,category:category(stock,sales,coverage)};
    });
    const warehouses=new Map();
    for(const row of rows){if(!warehouses.has(row.warehouse))warehouses.set(row.warehouse,[]);warehouses.get(row.warehouse).push(row);}
    for(const group of warehouses.values()) {
      const ranked=group.filter(r=>r.price!==null).sort((a,b)=>b.salesValue-a.salesValue||a.index-b.index);
      const total=ranked.reduce((s,r)=>s+r.salesValue,0);let before=0,lastValue=null,lastClass='C';
      for(const row of ranked) {
        row.share=total>0?row.salesValue/total:0;
        if(row.salesValue>0) {
          row.abc=row.salesValue===lastValue?lastClass:before/total<0.8?'A':before/total<0.95?'B':'C';
          lastValue=row.salesValue;lastClass=row.abc;
        }
        before+=row.salesValue;
      }
    }
    return {rows,days,missingPrices,negativeStocks,returns,error:null};
  }
  function calculate() {
    page=0;
    analysis=report?.items?.length&&report.periods?.length?analyze(report,Number($('liqFrom').value),Number($('liqTo').value)):null;
    render();
  }
  function filtered() {
    const wh=$('liqWarehouse').value,cat=$('liqCategory').value,abc=$('liqABC').value,xyz=$('liqXYZ').value,q=$('liqSearch').value.trim().toLocaleLowerCase('ru');
    return analysis.rows.filter(r=>(!wh||r.warehouse===wh)&&(!cat||r.category===cat)&&(!abc||r.abc===abc)&&(!xyz||r.xyz===xyz)&&(!q||`${r.name} ${r.sku} ${r.group} ${r.supplier}`.toLocaleLowerCase('ru').includes(q)));
  }
  function render() {
    const content=$('liquidityContent');if(!content)return;
    if(!analysis){content.innerHTML='<p class="charts-empty">Загрузите ведомость с помесячными продажами.</p>';return;}
    if(analysis.error){content.innerHTML=`<p class="charts-empty">${esc(analysis.error)}</p>`;return;}
    const mode=$('liqMode').value,rows=filtered();
    // No-sales and long coverage first; pagination only affects rendering, never totals/classes.
    rows.sort((a,b)=>(b.category==='nosales')-(a.category==='nosales')||b.stockValue-a.stockValue||a.index-b.index);
    const stockValue=rows.reduce((s,r)=>s+r.stockValue,0),salesValue=rows.reduce((s,r)=>s+r.salesValue,0);
    const summaries=new Map();
    for(const row of rows){const s=summaries.get(row.warehouse)||{count:0,stock:0,sales:0};s.count++;s.stock+=row.stockValue;s.sales+=row.salesValue;summaries.set(row.warehouse,s);}
    const distribution=Object.entries(names).map(([key,label])=>{const group=rows.filter(r=>r.category===key),value=group.reduce((s,r)=>s+r.stockValue,0);return `<div class="liq-distribution-row"><span>${label}: ${group.length}</span><progress max="${stockValue||1}" value="${value}" aria-label="${label}"></progress><strong>${num(value)} руб.</strong></div>`;}).join('');
    const coverage=mode!=='abcxyz',abcxyz=mode!=='coverage';
    page=Math.min(page,Math.max(0,Math.ceil(rows.length/pageSize)-1));
    const visible=rows.slice(page*pageSize,(page+1)*pageSize);
    const head='<th>Склад</th><th>Артикул / номенклатура</th><th>Группа / поставщик</th><th>Продажи, ед.</th><th>Продажи, руб.</th><th>Остаток, ед.</th><th>Запас, руб.</th>'+(coverage?'<th>Запас, дней</th><th>Оборот*</th><th>Категория</th>':'')+(abcxyz?'<th>Доля склада, %</th><th>ABC</th><th>XYZ</th><th>CV, %</th>':'');
    const body=visible.map(r=>`<tr data-liq-row="${r.excelRow}"><td>${esc(r.warehouse)}</td><td><small>${esc(r.sku||'Без артикула')}</small><br>${esc(r.name)}</td><td>${esc(r.group)}<br><small>${esc(r.supplier)}</small></td><td>${num(r.sales)}</td><td>${r.price===null?'Нет цены':num(r.salesValue)}</td><td>${num(r.rawStock)}</td><td>${r.price===null?'Нет цены':num(r.stockValue)}</td>${coverage?`<td>${r.coverage===null?(r.stock>0?'∞':'—'):num(r.coverage)}</td><td>${num(r.turnover)}</td><td>${names[r.category]}</td>`:''}${abcxyz?`<td>${r.price===null?'—':num(r.share*100)}</td><td>${r.abc}</td><td>${r.xyz}</td><td>${num(r.cv===null?null:r.cv*100)}</td>`:''}</tr>`).join('');
    content.innerHTML=`<div class="liquidity-summary"><strong>Позиций: ${rows.length} из ${analysis.rows.length}</strong><span>Учтено дней: ${analysis.days}</span><span>Продажи: ${num(salesValue)} руб.</span><span>Текущий запас: ${num(stockValue)} руб.</span></div><div class="liquidity-warehouses">${[...summaries].map(([wh,s])=>`<div><strong>${esc(wh)}</strong> · ${s.count} поз. · Продажи ${num(s.sales)} руб. · Запас ${num(s.stock)} руб.</div>`).join('')}</div><p class="charts-note">По всей ведомости: без положительной цены ${analysis.missingPrices}; отрицательных остатков ${analysis.negativeStocks}; отрицательных месячных продаж исключено ${analysis.returns}. Суммы и сводка относятся ко всей выбранной выборке, не только странице. Классы ABC рассчитаны по полному складу.</p>${coverage?`<details open><summary>Стоимость запаса по срокам покрытия</summary>${distribution}</details>`:''}<div class="liquidity-pagination"><button type="button" data-liq-page="-1" ${page===0?'disabled':''}>Назад</button><span>Страница ${page+1} из ${Math.max(1,Math.ceil(rows.length/pageSize))} · по ${pageSize} строк</span><button type="button" data-liq-page="1" ${(page+1)*pageSize>=rows.length?'disabled':''}>Далее</button></div><div class="liquidity-table-wrap"><table class="liquidity-table"><thead><tr>${head}</tr></thead><tbody>${body||`<tr><td colspan="${7+(coverage?3:0)+(abcxyz?4:0)}">Нет позиций по выбранным фильтрам.</td></tr>`}</tbody></table></div>${coverage?'<p class="charts-note">* Оборот = продажи за период ÷ текущий положительный остаток; при нулевом остатке не определяется. Это не классическая оборачиваемость по среднему остатку.</p>':''}`;
  }
  function update(rep) {
    report=rep;if(!$('liqWarehouse'))return;
    const periods=rep?.periods||[],warehouses=[...new Set((rep?.items||[]).map(it=>String(it.warehouse||'Без склада')))].sort((a,b)=>a.localeCompare(b,'ru'));
    const sig=JSON.stringify([rep?.fileName,periods.map(monthKey),warehouses]);
    if(sig!==signature) {
      signature=sig;const old=$('liqWarehouse').value;
      $('liqWarehouse').innerHTML='<option value="">Все склады</option>'+warehouses.map(wh=>`<option value="${esc(wh)}">${esc(wh)}</option>`).join('');
      if(warehouses.includes(old))$('liqWarehouse').value=old;
      for(const id of ['liqFrom','liqTo'])$(id).innerHTML=periods.map((p,i)=>`<option value="${i}">${esc(p.label||monthKey(p))}</option>`).join('');
      if(periods.length){$('liqFrom').value=String(Math.max(0,periods.length-12));$('liqTo').value=String(periods.length-1);}
    }
    calculate();
  }
  for(const id of ['liqFrom','liqTo'])$(id)?.addEventListener('change',calculate);
  for(const id of ['liqMode','liqWarehouse','liqCategory','liqABC','liqXYZ'])$(id)?.addEventListener('change',()=>{page=0;render();});
  $('liqSearch')?.addEventListener('input',()=>{page=0;render();});
  $('liquidityContent')?.addEventListener('click',e=>{const b=e.target.closest('[data-liq-page]');if(b&&!b.disabled){page+=Number(b.dataset.liqPage);render();}});
  window.LiquidityAnalysis={update,analyze,category};update(null);
})();
