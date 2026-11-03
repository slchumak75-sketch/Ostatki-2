/* Standalone, read-only report charts. No requests or writes to report/reference. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=v=>Number(v).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
  const qty=v=>Number(v).toLocaleString('ru-RU',{maximumFractionDigits:2});
  const int=v=>Math.round(Number(v)||0).toLocaleString('ru-RU');
  const pct=(v,total)=>money(100*v/total)+'%';
  const colors=['#2563eb','#dc2626','#059669','#9333ea','#d97706','#0891b2','#be185d','#4f46e5'];
  let report=null,signature='';
  const monthKey=p=>`${p.year}-${String(p.month).padStart(2,'0')}`;
  const warehouse=it=>String(it.warehouse||'Без склада');
  const unitMode=()=>($('chartUnit')?.value||'money');
  const topMode=()=>$('chartTop')?.value||'all';
  const unitWord=mode=>mode==='units'?'шт.':'руб.';
  const fmtMetric=(v,mode)=>mode==='units'?qty(v):money(v);

  // Ядро агрегации продаж: деньги (цена обязательна) или штуки.
  // Виды: группы/поставщики (столбцы), доли, monthlyGroups — месяцы × товарные группы.
  function aggregate(rep,kind,wh,from,to,opts={}) {
    const periods=rep?.periods||[],items=rep?.items||[];
    const mode=opts.unit||'money';
    const rows=new Map(),warehouses=new Set();let excluded=0,returns=0,total=0;
    const monthlyGroups=kind==='monthlyGroups';
    if(monthlyGroups)for(let j=from;j<=to;j++)if(periods[j])rows.set(monthKey(periods[j]),{key:monthKey(periods[j]),label:periods[j].label||monthKey(periods[j]),values:new Map(),total:0,units:0,skuSet:new Set()});
    for(const it of items) {
      const whName=warehouse(it);if(wh && whName!==wh)continue;
      const price=Number(it.purchasePrice);
      if(mode==='money'&&(!Number.isFinite(price)||price<=0)){excluded++;continue;}
      warehouses.add(whName);
      for(let j=from;j<=to;j++) {
        if(!periods[j])continue;
        const units=Number(it.monthlySales?.[j]||0);
        if(!Number.isFinite(units))continue;
        if(units<0){returns++;continue;}
        const value=mode==='units'?units:units*price;
        if(!Number.isFinite(value))continue;
        const key=monthlyGroups?monthKey(periods[j]):String((kind==='groups'||kind==='groupShares'?it.group:it.supplier)||'(Не указан)');
        const series=monthlyGroups?String(it.group||'(Не указан)'):null;
        if(!rows.has(key))rows.set(key,{key,label:key,values:new Map(),total:0,units:0,skuSet:new Set()});
        const row=rows.get(key);
        const target=monthlyGroups?series:whName;
        row.total+=value;row.units+=units;row.skuSet.add(it.excelRow);
        row.values.set(target,(row.values.get(target)||0)+value);
        total+=value;
      }
    }
    const sorted=[...rows.values()].filter(r=>monthlyGroups||r.total>0);
    if(!monthlyGroups)sorted.sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label,'ru'));
    const seriesNames=monthlyGroups?[...new Set(sorted.flatMap(r=>[...r.values.keys()]))]:[...warehouses].sort((a,b)=>a.localeCompare(b,'ru'));
    return {rows:sorted,warehouses:seriesNames,total,unitsTotal:sorted.reduce((s,r)=>s+r.units,0),excluded,returns};
  }

  function applyTop(rows,toppable) {
    if(!toppable||topMode()!=='top10'||rows.length<=11)return {rows,note:''};
    const head=rows.slice(0,10),tail=rows.slice(10);
    const merged={key:'__other__',label:`Прочие (${tail.length})`,values:new Map(),total:0,skuSet:new Set(),units:0};
    for(const r of tail){merged.total+=r.total;merged.units+=r.units||0;for(const [wh,v] of r.values)merged.values.set(wh,(merged.values.get(wh)||0)+v);for(const s of r.skuSet||[])merged.skuSet.add(s);}
    return {rows:[...head,merged],note:`Показан топ-10, остальные ${tail.length} свёрнуты в «Прочие».`};
  }

  function barSectionSvg(section) {
    const mode=section.metric,unit=unitWord(mode==='sku'?'sku':mode);
    const {rows,note}=applyTop(section.rows,section.toppable);
    if(!rows.length)return `<p class="charts-empty">Нет данных за выбранный период.</p>`;
    const width=1200,left=390,right=195,rowH=38,plot=width-left-right;
    const max=Math.max(...rows.map(r=>r.total),section.shares?section.total:0)||1;
    const height=50+rows.length*rowH;
    const fmt=v=>fmtMetric(v,mode==='sku'?'sku':mode);
    const bars=rows.map((r,i)=>{
      const y=42+i*rowH;let x=left;
      const series=section.singleSeries?[{wh:'',v:r.total,color:colors[0]}]:section.warehouses.map((wh,k)=>({wh,v:r.values.get(wh)||0,color:colors[k%colors.length]}));
      const parts=series.map(({wh,v,color})=>{
        const w=plot*v/max;
        const skuPart=r.skuSet?.size?` · SKU: ${int(r.skuSet.size)}`:'';
        const svg=v>0?`<rect x="${x}" y="${y-16}" width="${w}" height="24" fill="${color}"><title>${esc(r.label)}${wh?` — ${esc(wh)}`:''}: ${fmt(v)} ${unit}${skuPart}; ${pct(v,section.total)} от итога</title></rect>`:'';
        x+=w;return svg;
      }).join('');
      const skuPart=r.skuSet?.size?` · ${int(r.skuSet.size)} SKU`:'';
      return `<g><text x="${left-12}" y="${y}" text-anchor="end"><title>${esc(r.label)}</title>${esc(r.label.length>47?r.label.slice(0,45)+'…':r.label)}</text>${parts}<text x="${Math.min(x+8,width-right+8)}" y="${y}" class="chart-bar-value">${section.shares?pct(r.total,section.total)+' · ':''}${fmt(r.total)} ${unit}${skuPart}</text></g>`;
    }).join('');
    const legend=section.singleSeries?'':`<div class="chart-legend">${section.warehouses.map((wh,k)=>`<span><i style="background:${colors[k%colors.length]}"></i>${esc(wh)}</span>`).join('')}</div>`;
    const table=`<details><summary>Точные значения</summary><table class="chart-values data-table"><thead><tr><th>Категория</th>${section.singleSeries?'':section.warehouses.map(wh=>`<th>${esc(wh)}, ${unit}</th>`).join('')}<th>Итого, ${unit}</th><th>Доля, %</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.label)}</td>${section.singleSeries?'':section.warehouses.map(wh=>`<td>${fmt(r.values.get(wh)||0)}</td>`).join('')}<td>${fmt(r.total)}</td><td>${pct(r.total,section.total)}</td></tr>`).join('')}</tbody></table></details>`;
    return `${legend}<svg class="sales-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(section.title)}"><title>${esc(section.title)}</title>${bars}</svg>${note?`<p class="charts-note">${esc(note)}</p>`:''}${table}`;
  }

  // Динамика продаж по товарным группам: гладкие кривые по месяцам, топ-7 групп + «Прочие».
  function monthlyGroupsSvg(data,title) {
    const mode=unitMode(),unit=unitWord(mode);
    const seriesTotals=new Map();
    for(const r of data.rows)for(const [g,v] of r.values)seriesTotals.set(g,(seriesTotals.get(g)||0)+v);
    const allSeries=[...seriesTotals.entries()].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]),'ru')).map(([g])=>g);
    const series=allSeries.slice(0,7),extra=allSeries.slice(7);
    const otherLabel=extra.length?`Прочие (${extra.length})`:'';
    const note=extra.length?`Показаны топ-7 товарных групп по продажам за период, остальные ${extra.length} свёрнуты в «Прочие».`:'';
    const valueOf=(r,g)=>g==='__other__'?extra.reduce((s,g2)=>s+(r.values.get(g2)||0),0):(r.values.get(g)||0);
    const h=440,x0=90,y0=350,pw=1020,ph=290;
    const peak=Math.max(1,...data.rows.flatMap(r=>series.map(g=>valueOf(r,g)),extra.length?data.rows.map(r=>valueOf(r,'__other__')):0));
    const x=i=>x0+(data.rows.length===1?pw/2:i*pw/(data.rows.length-1));
    const y=v=>y0-ph*v/peak;
    const ticks=Array.from({length:5},(_,i)=>{const v=peak*i/4,yy=y(v);return `<line x1="${x0}" x2="${x0+pw}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/><text x="${x0-8}" y="${yy+4}" text-anchor="end">${fmtMetric(v,mode)}</text>`;}).join('');
    // Гладкая кривая через точки: кубические Безье с горизонтальными касательными.
    const smooth=pts=>{if(pts.length<2)return `M ${pts[0].x} ${pts[0].y}`;let d=`M ${pts[0].x} ${pts[0].y}`;for(let i=1;i<pts.length;i++){const p0=pts[i-1],p1=pts[i];const cx=(p0.x+p1.x)/2;d+=` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;}return d;};
    const paths=series.map((g,k)=>{
      const name=g==='__other__'?otherLabel:g;
      const pts=data.rows.map((r,i)=>({x:x(i),y:y(valueOf(r,g))}));
      const dots=pts.map((p,i)=>`<circle cx="${p.x}" cy="${p.y}" r="5" fill="${colors[k%colors.length]}"><title>${esc(data.rows[i].label)} — ${esc(name)}: ${fmtMetric(valueOf(data.rows[i],g),mode)} ${unit}; ${pct(valueOf(data.rows[i],g),data.total)} от итога</title></circle>`).join('');
      return `<path d="${smooth(pts)}" fill="none" stroke="${colors[k%colors.length]}" stroke-width="3.5" stroke-linecap="round"><title>${esc(name)}</title></path>${dots}`;
    }).join('');
    const step=Math.max(1,Math.ceil(data.rows.length/12));
    const labels=data.rows.map((r,i)=>i%step===0||i===data.rows.length-1?`<text x="${x(i)}" y="375" text-anchor="end" transform="rotate(-25 ${x(i)} 375)">${esc(r.key)}</text>`:'').join('');
    const svg=`<svg class="sales-chart" viewBox="0 0 1200 ${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><text x="${x0}" y="25">${unit}</text>${ticks}${paths}${labels}</svg>`;
    const legend=`<div class="chart-legend">${series.map((g,k)=>`<span><i style="background:${colors[k%colors.length]}"></i>${esc(g==='__other__'?otherLabel:g)}</span>`).join('')}</div>`;
    return legend+svg+(note?`<p class="charts-note">${esc(note)}</p>`:'');
  }

  function render() {
    if(!$('chartsContent'))return;
    if(!report?.items?.length||!report.periods?.length){$('chartsContent').innerHTML='<p class="charts-empty">Загрузите ведомость с помесячными продажами.</p>';return;}
    const from=Number($('chartFrom').value),to=Number($('chartTo').value);
    if(from>to){$('chartsContent').innerHTML='<p class="charts-empty">Начало периода должно быть не позже окончания.</p>';return;}
    const kind=$('chartKind').value,title=$('chartKind').selectedOptions[0].textContent,wh=$('chartWarehouse').value,mode=unitMode();
    const data=aggregate(report,kind,wh,from,to,{unit:mode});
    const shares=kind.endsWith('Shares');
    if(!(data.total>0)){$('chartsContent').innerHTML=`<p class="charts-empty">За выбранный период нет положительных продаж${mode==='money'?' с заполненной ценой':''}. Строк без положительной цены: ${data.excluded}.</p>`;return;}
    const metric=unitWord(mode);
    if(kind==='monthlyGroups') {
      $('chartsContent').innerHTML=`<h2>${esc(title)}</h2><p class="charts-summary">${esc(report.periods[from].label||monthKey(report.periods[from]))} — ${esc(report.periods[to].label||monthKey(report.periods[to]))} · Всего: <strong>${fmtMetric(data.total,mode)} ${metric}</strong>${mode==='money'?` · в штуках: ${qty(data.unitsTotal)}`:''}</p>${monthlyGroupsSvg(data,title)}<details><summary>Точные значения</summary><table class="chart-values data-table"><thead><tr><th>Месяц</th>${data.warehouses.map(g=>`<th>${esc(g)}, ${metric}</th>`).join('')}<th>Итого, ${metric}</th><th>Доля, %</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td>${esc(r.label)}</td>${data.warehouses.map(g=>`<td>${fmtMetric(r.values.get(g)||0,mode)}</td>`).join('')}<td>${fmtMetric(data.warehouses.reduce((s,g)=>s+(r.values.get(g)||0),0),mode)}</td><td>${pct(data.warehouses.reduce((s,g)=>s+(r.values.get(g)||0),0),data.total)}</td></tr>`).join('')}</tbody></table></details>`;
      return;
    }
    const {rows,note}=applyTop(data.rows,true);
    const section={title,rows,warehouses:data.warehouses,total:data.total,metric:mode,shares,toppable:false};
    $('chartsContent').innerHTML=`<h2>${esc(title)}</h2><p class="charts-summary">${esc(report.periods[from].label||monthKey(report.periods[from]))} — ${esc(report.periods[to].label||monthKey(report.periods[to]))} · Всего: <strong>${fmtMetric(data.total,mode)} ${metric}</strong>${mode==='money'?` · в штуках: ${qty(data.unitsTotal)}`:''}${shares?' · Доли от общей суммы выбранного склада/складов за период':''}</p>${barSectionSvg(section)}${note?`<p class="charts-note">${esc(note)}</p>`:''}<p class="charts-note">${rows.length} категорий. Строк без положительной цены: ${data.excluded}. Отрицательных месячных значений исключено: ${data.returns}. Неполный месяц отображается как есть, без экстраполяции.</p>`;
  }
  function update(rep) {
    report=rep;
    if(!$('chartWarehouse'))return;
    const periods=rep?.periods||[];
    const warehouses=[...new Set((rep?.items||[]).map(warehouse))].sort((a,b)=>a.localeCompare(b,'ru'));
    const sig=JSON.stringify([rep?.fileName,periods.map(monthKey),warehouses]);
    if(sig!==signature) {
      const oldWh=$('chartWarehouse').value;signature=sig;
      $('chartWarehouse').innerHTML='<option value="">Все склады</option>'+warehouses.map(w2=>`<option value="${esc(w2)}">${esc(w2)}</option>`).join('');
      if(warehouses.includes(oldWh))$('chartWarehouse').value=oldWh;
      for(const id of ['chartFrom','chartTo'])$(id).innerHTML=periods.map((p,i)=>`<option value="${i}">${esc(p.label||monthKey(p))}</option>`).join('');
      if(periods.length){$('chartFrom').value=String(Math.max(0,periods.length-12));$('chartTo').value=String(periods.length-1);}
    }
    render();
  }
  for(const id of ['chartKind','chartWarehouse','chartFrom','chartTo','chartTop','chartUnit'])$(id)?.addEventListener('change',render);
  window.SalesCharts={update,aggregate};
  update(null);
})();
