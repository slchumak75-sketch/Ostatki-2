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
    let days=0;
    for(let j=from;j<=to;j++) {
      const p=periods[j];
      let fraction=Number(p.completeness);
      if(j===periods.length-1 && Number(rep.lastMonthCompleteness)>0)fraction=Number(rep.lastMonthCompleteness);
      if(!(fraction>0&&fraction<=1))fraction=1;
      const duration=new Date(Date.UTC(p.year,p.month,0)).getUTCDate();
      const elapsed=Math.max(1,Math.round(duration*fraction));
      days+=elapsed;
    }
    let missingPrices=0,negativeStocks=0,returns=0;
    const rows=items.map((it,index)=>{
      const price=Number(it.purchasePrice),validPrice=Number.isFinite(price)&&price>0;
      if(!validPrice)missingPrices++;
      const rawStock=Number(it.closingStock),stock=Number.isFinite(rawStock)?Math.max(0,rawStock):0;
      if(rawStock<0)negativeStocks++;
      let sales=0;
      for(let j=from;j<=to;j++) {
        const raw=Number(it.monthlySales?.[j]||0),v=Number.isFinite(raw)?Math.max(0,raw):0;
        if(raw<0)returns++;
        sales+=v;
      }
      const daily=sales/days,coverage=daily>0?stock/daily:null;
      return {index,excelRow:it.excelRow,warehouse:String(it.warehouse||'Без склада'),sku:String(it.sku||''),name:String(it.name||''),group:String(it.group||'(Не указана)'),supplier:String(it.supplier||'(Не указан)'),rawStock,stock,sales,daily,coverage,turnover:stock>0?sales/stock:null,price:validPrice?price:null,salesValue:validPrice?sales*price:0,stockValue:validPrice?stock*price:0,category:category(stock,sales,coverage)};
    });
    return {rows,days,missingPrices,negativeStocks,returns,error:null};
  }
  const colors={fast:'#16a34a',normal:'#2563eb',slow:'#d97706',excess:'#9333ea',overyear:'#dc2626',nosales:'#64748b',nostock:'#0891b2'};
  function monthlyTrend(rep,from,to,wh='',query='',basis='value') {
    const q=query.trim().toLocaleLowerCase('ru');
    const selected=(rep?.items||[]).filter(it=>(!wh||String(it.warehouse||'Без склада')===wh)&&(!q||`${it.name||''} ${it.sku||''} ${it.group||''} ${it.supplier||''}`.toLocaleLowerCase('ru').includes(q)));
    const result=[];
    for(let j=from;j<=to;j++) {
      if(!rep?.periods?.[j])continue;
      const p=rep.periods[j];let fraction=Number(p.completeness);
      if(j===rep.periods.length-1 && Number(rep.lastMonthCompleteness)>0)fraction=Number(rep.lastMonthCompleteness);
      if(!(fraction>0&&fraction<=1))fraction=1;
      const days=Math.max(1,Math.round(new Date(Date.UTC(p.year,p.month,0)).getUTCDate()*fraction));
      const totals=Object.fromEntries(Object.keys(names).map(k=>[k,0]));let total=0;
      for(const it of selected) {
        const rawStock=Number(it.closingStock),rawSales=Number(it.monthlySales?.[j]),price=Number(it.purchasePrice);
        const stock=Number.isFinite(rawStock)?Math.max(0,rawStock):0,sales=Number.isFinite(rawSales)?Math.max(0,rawSales):0;
        const weight=basis==='count'?1:Number.isFinite(price)&&price>0?stock*price:0;
        const key=category(stock,sales,sales>0?stock*days/sales:null);
        totals[key]+=weight;total+=weight;
      }
      result.push({key:monthKey(p),label:p.label||monthKey(p),total,percent:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,total>0?100*v/total:0]))});
    }
    return result;
  }
  function trendHTML(rep,from,to,wh,query,basis) {
    const months=monthlyTrend(rep,from,to,wh,query,basis);
    const x=i=>90+(months.length===1?510:i*1020/Math.max(1,months.length-1)),y=v=>340-v*2.8;
    const grid=[0,25,50,75,100].map(v=>`<line x1="90" x2="1110" y1="${y(v)}" y2="${y(v)}" stroke="#cbd5e1"/><text x="80" y="${y(v)+4}" text-anchor="end">${v}%</text>`).join('');
    const lines=Object.entries(names).map(([key,label])=>`<g data-liq-series="${key}"><polyline fill="none" stroke="${colors[key]}" stroke-width="2.5" points="${months.map((m,i)=>`${x(i)},${y(m.percent[key])}`).join(' ')}"/>${months.map((m,i)=>`<circle cx="${x(i)}" cy="${y(m.percent[key])}" r="4" fill="${colors[key]}"><title>${esc(m.label)} · ${label}: ${num(m.percent[key])}%</title></circle>`).join('')}</g>`).join('');
    const step=Math.max(1,Math.ceil(months.length/12));
    const labels=months.map((m,i)=>i%step===0||i===months.length-1?`<text x="${x(i)}" y="365" text-anchor="end" transform="rotate(-25 ${x(i)} 365)">${esc(m.key)}</text>`:'').join('');
    const values=months.map(m=>`<tr><td>${esc(m.label)}</td>${Object.keys(names).map(k=>`<td>${num(m.percent[k])}%</td>`).join('')}</tr>`).join('');
    return `<section class="liquidity-trend"><h3>Изменение структуры ликвидности по месяцам · оценка</h3><p class="charts-note">Текущий остаток одинаков для всех месяцев; меняется только темп продаж месяца. Это не история фактических запасов. Доли — ${basis==='count'?'по количеству позиций':'по стоимости текущего запаса в «Цене»'}. График учитывает склад и поиск, но не фильтр категории.</p><div class="chart-legend">${Object.entries(names).map(([k,label])=>`<span><i style="background:${colors[k]}"></i>${label}</span>`).join('')}</div>${months.some(m=>m.total>0)?`<svg class="sales-chart" viewBox="0 0 1200 420" role="img" aria-label="Оценочная ликвидность по месяцам"><title>Доли категорий ликвидности по месяцам, проценты</title>${grid}${lines}${labels}</svg>`:'<p>Нет базы для расчёта процентов. Выберите другой склад, поиск или проценты по количеству позиций.</p>'}<details><summary>Помесячные проценты</summary><table class="chart-values"><thead><tr><th>Месяц</th>${Object.values(names).map(n=>`<th>${n}</th>`).join('')}</tr></thead><tbody>${values}</tbody></table></details></section>`;
  }
  function calculate() {
    page=0;
    analysis=report?.items?.length&&report.periods?.length?analyze(report,Number($('liqFrom').value),Number($('liqTo').value)):null;
    render();
  }
  function filtered() {
    const wh=$('liqWarehouse').value,cat=$('liqCategory').value,q=$('liqSearch').value.trim().toLocaleLowerCase('ru');
    return analysis.rows.filter(r=>(!wh||r.warehouse===wh)&&(!cat||r.category===cat)&&(!q||`${r.name} ${r.sku} ${r.group} ${r.supplier}`.toLocaleLowerCase('ru').includes(q)));
  }
  function render() {
    const content=$('liquidityContent');if(!content)return;
    if(!analysis){content.innerHTML='<p class="charts-empty">Загрузите ведомость с помесячными продажами.</p>';return;}
    if(analysis.error){content.innerHTML=`<p class="charts-empty">${esc(analysis.error)}</p>`;return;}
    const rows=filtered(),basis=$('liqBasis').value;
    // No-sales and long coverage first; pagination only affects rendering, never totals/classes.
    rows.sort((a,b)=>(b.category==='nosales')-(a.category==='nosales')||b.stockValue-a.stockValue||a.index-b.index);
    const stockValue=rows.reduce((s,r)=>s+r.stockValue,0),salesValue=rows.reduce((s,r)=>s+r.salesValue,0);
    const summaries=new Map();
    for(const row of rows){const s=summaries.get(row.warehouse)||{count:0,stock:0,sales:0};s.count++;s.stock+=row.stockValue;s.sales+=row.salesValue;summaries.set(row.warehouse,s);}
    const distribution=Object.entries(names).map(([key,label])=>{
      const group=rows.filter(r=>r.category===key),value=group.reduce((s,r)=>s+r.stockValue,0);
      const denominator=basis==='count'?rows.length:stockValue,numerator=basis==='count'?group.length:value;
      const percent=denominator>0?100*numerator/denominator:0;
      return `<div class="liq-distribution-row"><span>${label}: ${group.length} поз.</span><progress max="100" value="${percent}" aria-label="${label}"></progress><strong>${num(value)} руб. · ${num(percent)}%</strong></div>`;
    }).join('');
    page=Math.min(page,Math.max(0,Math.ceil(rows.length/pageSize)-1));
    const visible=rows.slice(page*pageSize,(page+1)*pageSize);
    const head='<th>Склад</th><th>Артикул / номенклатура</th><th>Группа / поставщик</th><th>Продажи, ед.</th><th>Продажи, руб.</th><th>Остаток, ед.</th><th>Запас, руб.</th><th>Доля запаса, %</th><th>Запас, дней</th><th>Оборот*</th><th>Категория</th>';
    const body=visible.map(r=>`<tr data-liq-row="${r.excelRow}"><td>${esc(r.warehouse)}</td><td><small>${esc(r.sku||'Без артикула')}</small><br>${esc(r.name)}</td><td>${esc(r.group)}<br><small>${esc(r.supplier)}</small></td><td>${num(r.sales)}</td><td>${r.price===null?'Нет цены':num(r.salesValue)}</td><td>${num(r.rawStock)}</td><td>${r.price===null?'Нет цены':num(r.stockValue)}</td><td>${r.price===null?'—':num(stockValue>0?100*r.stockValue/stockValue:0)}</td><td>${r.coverage===null?(r.stock>0?'∞':'—'):num(r.coverage)}</td><td>${num(r.turnover)}</td><td>${names[r.category]}</td></tr>`).join('');
    content.innerHTML=`<div class="liquidity-summary"><strong>Позиций: ${rows.length} из ${analysis.rows.length}</strong><span>Учтено дней: ${analysis.days}</span><span>Продажи: ${num(salesValue)} руб.</span><span>Текущий запас: ${num(stockValue)} руб.</span></div><div class="liquidity-warehouses">${[...summaries].map(([wh,s])=>`<div><strong>${esc(wh)}</strong> · ${s.count} поз. · Продажи ${num(s.sales)} руб. · Запас ${num(s.stock)} руб.</div>`).join('')}</div><p class="charts-note">По всей ведомости: без положительной цены ${analysis.missingPrices}; отрицательных остатков ${analysis.negativeStocks}; отрицательных месячных продаж исключено ${analysis.returns}. Суммы и сводка относятся ко всей выбранной выборке, не только странице. Доли в таблице — по стоимости запаса всей текущей выборки.</p><details open><summary>Распределение запаса · ${basis==='count'?'% позиций':'% стоимости'}</summary>${distribution}</details>${trendHTML(report,Number($('liqFrom').value),Number($('liqTo').value),$('liqWarehouse').value,$('liqSearch').value,basis)}<div class="liquidity-pagination"><button type="button" data-liq-page="-1" ${page===0?'disabled':''}>Назад</button><span>Страница ${page+1} из ${Math.max(1,Math.ceil(rows.length/pageSize))} · по ${pageSize} строк</span><button type="button" data-liq-page="1" ${(page+1)*pageSize>=rows.length?'disabled':''}>Далее</button></div><div class="liquidity-table-wrap"><table class="liquidity-table"><thead><tr>${head}</tr></thead><tbody>${body||`<tr><td colspan="11">Нет позиций по выбранным фильтрам.</td></tr>`}</tbody></table></div><p class="charts-note">* Оборот = продажи за период ÷ текущий положительный остаток; при нулевом остатке не определяется. Это не классическая оборачиваемость по среднему остатку.</p>`;
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
  for(const id of ['liqBasis','liqWarehouse','liqCategory'])$(id)?.addEventListener('change',()=>{page=0;render();});
  $('liqSearch')?.addEventListener('input',()=>{page=0;render();});
  $('liquidityContent')?.addEventListener('click',e=>{const b=e.target.closest('[data-liq-page]');if(b&&!b.disabled){page+=Number(b.dataset.liqPage);render();}});
  window.LiquidityAnalysis={update,analyze,category,monthlyTrend};update(null);
})();
