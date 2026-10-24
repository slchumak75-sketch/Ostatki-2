/* Standalone, read-only report charts. No requests or writes to report/reference. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=v=>Number(v).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
  const colors=['#2563eb','#dc2626','#059669','#9333ea','#d97706','#0891b2','#be185d','#4f46e5'];
  let report=null,signature='';
  const monthKey=p=>`${p.year}-${String(p.month).padStart(2,'0')}`;
  const warehouse=it=>String(it.warehouse||'Без склада');
  function aggregate(rep,kind,wh,from,to) {
    const periods=rep?.periods||[],items=rep?.items||[];
    const rows=new Map(),warehouses=new Set();let excluded=0,returns=0;
    const monthly=kind==='monthly';
    if(monthly)for(let j=from;j<=to;j++)if(periods[j])rows.set(monthKey(periods[j]),{key:monthKey(periods[j]),label:periods[j].label||monthKey(periods[j]),values:new Map(),total:0});
    for(const it of items) {
      const whName=warehouse(it);if(wh && whName!==wh)continue;
      const price=Number(it.purchasePrice);
      if(!Number.isFinite(price)||price<=0){excluded++;continue;}
      warehouses.add(whName);
      for(let j=from;j<=to;j++) {
        if(!periods[j])continue;
        const units=Number(it.monthlySales?.[j]||0);
        if(!Number.isFinite(units))continue;
        if(units<0){returns++;continue;}
        const value=units*price;if(!Number.isFinite(value))continue;
        const key=monthly?monthKey(periods[j]):String((kind==='groups'||kind==='groupShares'?it.group:it.supplier)||'(Не указан)');
        if(!rows.has(key))rows.set(key,{key,label:key,values:new Map(),total:0});
        const row=rows.get(key);row.total+=value;row.values.set(whName,(row.values.get(whName)||0)+value);
      }
    }
    const sorted=[...rows.values()].filter(r=>monthly||r.total>0);
    if(!monthly)sorted.sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label,'ru'));
    return {rows:sorted,warehouses:[...warehouses].sort((a,b)=>a.localeCompare(b,'ru')),total:sorted.reduce((s,r)=>s+r.total,0),excluded,returns};
  }
  function render() {
    if(!$('chartsContent'))return;
    if(!report?.items?.length||!report.periods?.length){$('chartsContent').innerHTML='<p class="charts-empty">Загрузите ведомость с помесячными продажами.</p>';return;}
    const from=Number($('chartFrom').value),to=Number($('chartTo').value);
    if(from>to){$('chartsContent').innerHTML='<p class="charts-empty">Начало периода должно быть не позже окончания.</p>';return;}
    const kind=$('chartKind').value,data=aggregate(report,kind,$('chartWarehouse').value,from,to);
    const shares=kind.endsWith('Shares');
    if(!(data.total>0)){$('chartsContent').innerHTML=`<p class="charts-empty">За выбранный период нет положительных продаж с заполненной ценой. Строк без положительной цены: ${data.excluded}.</p>`;return;}
    const title=$('chartKind').selectedOptions[0].textContent;
    const width=1200,left=390,right=195,rowH=38,plot=width-left-right,max=shares?data.total:Math.max(...data.rows.map(r=>r.total));
    const height=50+data.rows.length*rowH;
    const bars=data.rows.map((r,i)=>{
      const y=42+i*rowH;let x=left;
      const parts=data.warehouses.map((wh,k)=>{
        const value=r.values.get(wh)||0,w=plot*value/max;
        const svg=value>0?`<rect x="${x}" y="${y-16}" width="${w}" height="24" fill="${colors[k%colors.length]}"><title>${esc(r.label)} — ${esc(wh)}: ${money(value)} руб.; ${money(100*value/data.total)}% от общего объёма</title></rect>`:'';
        x+=w;return svg;
      }).join('');
      return `<g><text x="${left-12}" y="${y}" text-anchor="end"><title>${esc(r.label)}</title>${esc(r.label.length>47?r.label.slice(0,45)+'…':r.label)}</text>${parts}<text x="${Math.min(x+8,width-right+8)}" y="${y}" class="chart-bar-value">${shares?money(100*r.total/data.total)+'% · ':''}${money(r.total)} руб.</text></g>`;
    }).join('');
    let svg=`<svg class="sales-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${bars}</svg>`;
    if(kind==='monthly') {
      const h=440,x0=90,y0=350,pw=1020,ph=290;
      const peak=Math.max(1,...data.rows.flatMap(r=>[...r.values.values()]));
      const x=i=>x0+(data.rows.length===1?pw/2:i*pw/(data.rows.length-1));
      const y=v=>y0-ph*v/peak;
      const ticks=Array.from({length:5},(_,i)=>{
        const value=peak*i/4,yy=y(value);
        return `<line x1="${x0}" x2="${x0+pw}" y1="${yy}" y2="${yy}" stroke="#cbd5e1"/><text x="${x0-8}" y="${yy+4}" text-anchor="end">${money(value)}</text>`;
      }).join('');
      const lines=data.warehouses.map((wh,k)=>`<polyline fill="none" stroke="${colors[k%colors.length]}" stroke-width="3" points="${data.rows.map((r,i)=>`${x(i)},${y(r.values.get(wh)||0)}`).join(' ')}"/>`+data.rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r.values.get(wh)||0)}" r="4" fill="${colors[k%colors.length]}"><title>${esc(r.label)} — ${esc(wh)}: ${money(r.values.get(wh)||0)} руб.</title></circle>`).join('')).join('');
      const step=Math.max(1,Math.ceil(data.rows.length/12));
      const labels=data.rows.map((r,i)=>i%step===0||i===data.rows.length-1?`<text x="${x(i)}" y="375" text-anchor="end" transform="rotate(-25 ${x(i)} 375)">${esc(r.key)}</text>`:'').join('');
      svg=`<svg class="sales-chart" viewBox="0 0 1200 ${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><text x="${x0}" y="25">руб.</text>${ticks}${lines}${labels}</svg>`;
    }
    $('chartsContent').innerHTML=`<h2>${esc(title)}</h2><p class="charts-summary">${esc(report.periods[from].label||monthKey(report.periods[from]))} — ${esc(report.periods[to].label||monthKey(report.periods[to]))} · Всего: <strong>${money(data.total)} руб.</strong>${shares?' · Доли от общей суммы выбранного склада/складов за период':''}</p><div class="chart-legend">${data.warehouses.map((wh,k)=>`<span><i style="background:${colors[k%colors.length]}"></i>${esc(wh)}</span>`).join('')}</div>${svg}<p class="charts-note">Все ${data.rows.length} ${kind==='monthly'?'месяцев':'категорий'} показаны, без ограничения топом. Строк без положительной цены: ${data.excluded}. Отрицательных месячных значений исключено: ${data.returns}. Неполный месяц отображается как есть, без экстраполяции.</p><details><summary>Точные значения</summary><table class="chart-values"><thead><tr><th>Категория / месяц</th>${data.warehouses.map(wh=>`<th>${esc(wh)}, руб.</th>`).join('')}<th>Итого, руб.</th><th>Доля, %</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td>${esc(r.label)}</td>${data.warehouses.map(wh=>`<td>${money(r.values.get(wh)||0)}</td>`).join('')}<td>${money(r.total)}</td><td>${money(100*r.total/data.total)}</td></tr>`).join('')}</tbody></table></details>`;
  }
  function update(rep) {
    report=rep;
    if(!$('chartWarehouse'))return;
    const periods=rep?.periods||[];
    const warehouses=[...new Set((rep?.items||[]).map(warehouse))].sort((a,b)=>a.localeCompare(b,'ru'));
    const sig=JSON.stringify([rep?.fileName,periods.map(monthKey),warehouses]);
    if(sig!==signature) {
      const oldWh=$('chartWarehouse').value;signature=sig;
      $('chartWarehouse').innerHTML='<option value="">Все склады</option>'+warehouses.map(w=>`<option value="${esc(w)}">${esc(w)}</option>`).join('');
      if(warehouses.includes(oldWh))$('chartWarehouse').value=oldWh;
      for(const id of ['chartFrom','chartTo'])$(id).innerHTML=periods.map((p,i)=>`<option value="${i}">${esc(p.label||monthKey(p))}</option>`).join('');
      if(periods.length){$('chartFrom').value=String(Math.max(0,periods.length-12));$('chartTo').value=String(periods.length-1);}
    }
    render();
  }
  for(const id of ['chartKind','chartWarehouse','chartFrom','chartTo'])$(id)?.addEventListener('change',render);
  window.SalesCharts={update,aggregate};
  update(null);
})();
