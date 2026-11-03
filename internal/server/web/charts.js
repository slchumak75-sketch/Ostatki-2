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
  const MONTHS=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  let report=null,signature='';
  const monthKey=p=>`${p.year}-${String(p.month).padStart(2,'0')}`;
  const warehouse=it=>String(it.warehouse||'Без склада');
  const unitMode=()=>($('chartUnit')?.value||'money');
  const topMode=()=>$('chartTop')?.value||'all';
  const unitWord=mode=>mode==='units'?'шт.':'руб.';
  const fmtMetric=(v,mode)=>mode==='units'?qty(v):money(v);

  // Ядро агрегации продаж: деньги (цена обязательна) или штуки. Ключи: группы/поставщики/месяцы/календарные месяцы.
  function aggregate(rep,kind,wh,from,to,opts={}) {
    const periods=rep?.periods||[],items=rep?.items||[];
    const mode=opts.unit||'money';
    const rows=new Map(),warehouses=new Set();let excluded=0,returns=0,total=0;
    const monthly=kind==='monthly',seasonal=kind==='seasonality';
    if(monthly)for(let j=from;j<=to;j++)if(periods[j])rows.set(monthKey(periods[j]),{key:monthKey(periods[j]),label:periods[j].label||monthKey(periods[j]),values:new Map(),total:0,units:0,skuSet:new Set()});
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
        const key=monthly?monthKey(periods[j]):seasonal?String(Math.min(12,Math.max(1,Number(periods[j].month)||1))):String((kind==='groups'||kind==='groupShares'?it.group:it.supplier)||'(Не указан)');
        if(!rows.has(key))rows.set(key,{key,label:seasonal?MONTHS[Number(key)-1]:key,values:new Map(),total:0,units:0,skuSet:new Set()});
        const row=rows.get(key);row.total+=value;row.units+=units;row.skuSet.add(it.excelRow);
        row.values.set(whName,(row.values.get(whName)||0)+value);
        total+=value;
      }
    }
    const sorted=[...rows.values()].filter(r=>monthly||seasonal||r.total>0);
    if(!monthly&&!seasonal)sorted.sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label,'ru'));
    if(seasonal){
      // Среднее по годам: значение календарного месяца делится на число лет, в которых месяц входит в период.
      const years=new Map();
      for(let j=from;j<=to;j++){if(!periods[j])continue;const m=String(Math.min(12,Math.max(1,Number(periods[j].month)||1)));const y=periods[j].year;if(!years.has(m))years.set(m,new Set());years.get(m).add(y);}
      for(const r of sorted){const n=Math.max(1,years.get(r.key)?.size||1);r.total/=n;for(const [whName,v] of r.values)r.values.set(whName,v/n);}
      total=sorted.reduce((s,r)=>s+r.total,0);
    }
    return {rows:sorted,warehouses:[...warehouses].sort((a,b)=>a.localeCompare(b,'ru')),total,unitsTotal:sorted.reduce((s,r)=>s+r.units,0),excluded,returns};
  }

  // Покрытие запаса: SKU по соотношению остатка к средним продажам в месяц (цена не требуется).
  function coverData(rep,wh,from,to) {
    const periods=rep?.periods||[],items=rep?.items||[];
    const months=Math.max(1,to-from+1);
    const defs=[['< 1 мес',c=>c<1],['1–3 мес',c=>c>=1&&c<3],['3–6 мес',c=>c>=3&&c<6],['6–12 мес',c=>c>=6&&c<12],['> 12 мес',c=>c>=12],['Нет продаж',c=>c===null]];
    const rows=defs.map(([label])=>({key:label,label,values:new Map(),total:0,skuSet:new Set(),units:0}));
    const warehouses=new Set();let returns=0;
    for(const it of items) {
      const whName=warehouse(it);if(wh && whName!==wh)continue;
      const stock=Number(it.closingStock)||0;
      let sales=0;
      for(let j=from;j<=to;j++){const u=Number(it.monthlySales?.[j]||0);if(!Number.isFinite(u))continue;if(u<0){returns++;continue;}sales+=u;}
      const avg=sales/months;
      let cover=avg>0?stock/avg:null;
      if(avg<=0&&stock<=0)continue;
      const idx=defs.findIndex(([,test])=>test(cover));
      if(idx<0)continue;
      warehouses.add(whName);
      const row=rows[idx];row.total+=1;row.skuSet.add(it.excelRow);
      row.values.set(whName,(row.values.get(whName)||0)+1);
    }
    return {rows,warehouses:[...warehouses].sort((a,b)=>a.localeCompare(b,'ru')),total:rows.reduce((s,r)=>s+r.total,0),returns};
  }

  // Структура бюджета: заказ по поставщикам (текущие количества) + остатки в закупочных ценах по складам.
  function budgetSections(rep,wh) {
    const items=rep?.items||[];
    const sup=new Map(),stock=new Map();let excluded=0;
    for(const it of items) {
      const whName=warehouse(it);if(wh && whName!==wh)continue;
      const price=Number(it.purchasePrice);
      if(!Number.isFinite(price)||price<=0){excluded++;continue;}
      const order=Number(it.finalOrderQty)||0;
      if(order>0){
        const key=String(it.supplier||'(Не указан)');
        if(!sup.has(key))sup.set(key,{key,label:key,values:new Map(),total:0,skuSet:new Set(),units:0});
        const row=sup.get(key);row.total+=order*price;row.units+=order;row.skuSet.add(it.excelRow);
        row.values.set(whName,(row.values.get(whName)||0)+order*price);
      }
      const value=(Number(it.closingStock)||0)*price;
      if(value>0){
        if(!stock.has(whName))stock.set(whName,{key:whName,label:whName,values:new Map(),total:0,skuSet:new Set(),units:0});
        const row=stock.get(whName);row.total+=value;row.skuSet.add(it.excelRow);
        row.values.set(whName,row.total);
      }
    }
    const supRows=[...sup.values()].sort((a,b)=>b.total-a.total);
    const stockRows=[...stock.values()].sort((a,b)=>b.total-a.total);
    return [
      {title:'Заказ по поставщикам, руб.',rows:supRows,warehouses:[...new Set(supRows.flatMap(r=>[...r.values.keys()]))].sort((a,b)=>a.localeCompare(b,'ru')),total:supRows.reduce((s,r)=>s+r.total,0),metric:'money',shares:true,toppable:true},
      {title:'Остатки по складам, руб.',rows:stockRows,warehouses:[],total:stockRows.reduce((s,r)=>s+r.total,0),metric:'money',shares:true,singleSeries:true,toppable:false},
    ].map(s=>({...s,excluded}));
  }

  // Неликвиды: «заморожено сверх года» по товарным группам и поставщикам.
  function nonliquidSections(rep,wh) {
    const items=rep?.items||[];
    const groups=new Map(),sups=new Map();
    for(const it of items) {
      const whName=warehouse(it);if(wh && whName!==wh)continue;
      const value=Number(it.overstockValue)||0;
      if(!(value>0))continue;
      for(const [map,key] of [[groups,String(it.group||'(Не указан)')],[sups,String(it.supplier||'(Не указан)')]]) {
        if(!map.has(key))map.set(key,{key,label:key,values:new Map(),total:0,skuSet:new Set(),units:0});
        const row=map.get(key);row.total+=value;row.skuSet.add(it.excelRow);
        row.values.set(whName,(row.values.get(whName)||0)+value);
      }
    }
    const toRows=m=>[...m.values()].sort((a,b)=>b.total-a.total);
    const gRows=toRows(groups),sRows=toRows(sups);
    const whs=rows=>[...new Set(rows.flatMap(r=>[...r.values.keys()]))].sort((a,b)=>a.localeCompare(b,'ru'));
    return [
      {title:'По товарным группам, руб.',rows:gRows,warehouses:whs(gRows),total:gRows.reduce((s,r)=>s+r.total,0),metric:'money',shares:true,toppable:true},
      {title:'По поставщикам, руб.',rows:sRows,warehouses:whs(sRows),total:sRows.reduce((s,r)=>s+r.total,0),metric:'money',shares:true,toppable:true},
    ];
  }

  // Рейтинг продаж: SKU и продажи за 12 месяцев по сегментам.
  function ratingSections(rep,wh) {
    const items=rep?.items||[];
    const defs=[['Без продаж',0],['Сегмент 1',1],['Сегмент 2',2],['Сегмент 3',3],['Сегмент 4',4],['Сегмент 5+',5]];
    const sku=defs.map(([label])=>({key:label,label,values:new Map(),total:0,skuSet:new Set(),units:0}));
    const sales=defs.map(([label])=>({key:label,label,values:new Map(),total:0,skuSet:new Set(),units:0}));
    const warehouses=new Set();
    for(const it of items) {
      const whName=warehouse(it);if(wh && whName!==wh)continue;
      const raw=Number(it.salesSegment)||0;
      const idx=raw<=0?0:Math.min(5,Math.max(1,Math.round(raw)));
      warehouses.add(whName);
      sku[idx].total+=1;sku[idx].skuSet.add(it.excelRow);
      sku[idx].values.set(whName,(sku[idx].values.get(whName)||0)+1);
      const s12=Number(it.sumSalesLast12M)||0;
      if(s12>0){sales[idx].total+=s12;sales[idx].skuSet.add(it.excelRow);sales[idx].values.set(whName,(sales[idx].values.get(whName)||0)+s12);}
    }
    return [
      {title:'SKU по рейтингу',rows:sku,warehouses:[...warehouses].sort((a,b)=>a.localeCompare(b,'ru')),total:sku.reduce((s,r)=>s+r.total,0),metric:'sku',shares:true,toppable:false},
      {title:'Продажи за 12 месяцев, шт.',rows:sales,warehouses:[...warehouses].sort((a,b)=>a.localeCompare(b,'ru')),total:sales.reduce((s,r)=>s+r.total,0),metric:'units',shares:true,toppable:false},
    ];
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

  function monthlySvg(data,title) {
    const mode=unitMode(),unit=unitWord(mode);
    const h=440,x0=90,y0=350,pw=1020,ph=290;
    const peak=Math.max(1,...data.rows.flatMap(r=>[...r.values.values()]));
    const totals=data.rows.map(r=>data.warehouses.reduce((s,wh)=>s+(r.values.get(wh)||0),0));
    const cumMax=Math.max(1,totals.reduce((s,v)=>s+v,0));
    const x=i=>x0+(data.rows.length===1?pw/2:i*pw/(data.rows.length-1));
    const y=v=>y0-ph*v/peak;
    const cy=v=>y0-ph*v/cumMax;
    const ticks=Array.from({length:5},(_,i)=>{const value=peak*i/4,yy=y(value);return `<line x1="${x0}" x2="${x0+pw}" y1="${yy}" y2="${yy}" stroke="#cbd5e1"/><text x="${x0-8}" y="${yy+4}" text-anchor="end">${fmtMetric(value,mode)}</text>`;}).join('');
    const cumTicks=[0,.25,.5,.75,1].map(f=>{const v=cumMax*f;return `<text x="${x0+pw+8}" y="${cy(v)+4}">${fmtMetric(v,mode)}</text>`;}).join('');
    const lines=data.warehouses.map((wh,k)=>`<polyline fill="none" stroke="${colors[k%colors.length]}" stroke-width="3" points="${data.rows.map((r,i)=>`${x(i)},${y(r.values.get(wh)||0)}`).join(' ')}"/>`+data.rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r.values.get(wh)||0)}" r="4" fill="${colors[k%colors.length]}"><title>${esc(r.label)} — ${esc(wh)}: ${fmtMetric(r.values.get(wh)||0,mode)} ${unit}</title></circle>`).join('')).join('');
    // Скользящее среднее (3 мес), линейный тренд и накопленная кривая — по сумме всех складов.
    const ma=totals.map((_,i)=>{const s=totals.slice(Math.max(0,i-2),i+1);return s.reduce((a,v)=>a+v,0)/s.length;});
    const maLine=`<polyline fill="none" stroke="#f59e0b" stroke-width="2.5" points="${ma.map((v,i)=>`${x(i)},${y(v)}`).join(' ')}"/>`+ma.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="#f59e0b"><title>${esc(data.rows[i].label)} — среднее 3 мес: ${fmtMetric(v,mode)} ${unit}</title></circle>`).join('');
    const n=totals.length,xm=(n-1)/2,ym=totals.reduce((a,v)=>a+v,0)/n;
    const b=n>1?totals.reduce((s,v,i)=>s+(i-xm)*(v-ym),0)/totals.reduce((s,_,i)=>s+(i-xm)**2,0):0;
    const trendLine=n>1?`<polyline fill="none" stroke="#334155" stroke-width="2" stroke-dasharray="7 5" points="${x(0)},${y(ym-b*xm)} ${x(n-1)},${y(ym+b*(n-1-xm))}"><title>Линейный тренд</title></polyline>`:'';
    let acc=0;const cum=totals.map(v=>acc+=v);
    const cumLine=`<polyline fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="2 4" points="${cum.map((v,i)=>`${x(i)},${cy(v)}`).join(' ')}"/>`+cum.map((v,i)=>`<circle cx="${x(i)}" cy="${cy(v)}" r="3" fill="#64748b"><title>${esc(data.rows[i].label)} — накопленно: ${fmtMetric(v,mode)} ${unit}</title></circle>`).join('');
    const step=Math.max(1,Math.ceil(data.rows.length/12));
    const labels=data.rows.map((r,i)=>i%step===0||i===data.rows.length-1?`<text x="${x(i)}" y="375" text-anchor="end" transform="rotate(-25 ${x(i)} 375)">${esc(r.key)}</text>`:'').join('');
    const svg=`<svg class="sales-chart" viewBox="0 0 1200 ${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><text x="${x0}" y="25">${unit}</text><text x="${x0+pw+8}" y="25" fill="#64748b">накопленно</text>${ticks}${cumTicks}${lines}${maLine}${trendLine}${cumLine}${labels}</svg>`;
    const legend=`<div class="chart-legend">${data.warehouses.map((wh,k)=>`<span><i style="background:${colors[k%colors.length]}"></i>${esc(wh)}</span>`).join('')}<span><i style="background:#f59e0b"></i>Среднее 3 мес</span><span><i style="background:#334155"></i>Тренд</span><span><i style="background:#64748b"></i>Накопленно (правая ось)</span></div>`;
    return legend+svg;
  }

  function render() {
    if(!$('chartsContent'))return;
    if(!report?.items?.length||!report.periods?.length){$('chartsContent').innerHTML='<p class="charts-empty">Загрузите ведомость с помесячными продажами.</p>';return;}
    const from=Number($('chartFrom').value),to=Number($('chartTo').value);
    if(from>to){$('chartsContent').innerHTML='<p class="charts-empty">Начало периода должно быть не позже окончания.</p>';return;}
    const kind=$('chartKind').value,title=$('chartKind').selectedOptions[0].textContent,wh=$('chartWarehouse').value,mode=unitMode();
    if(kind==='stockCover') {
      const data=coverData(report,wh,from,to);
      if(!(data.total>0)){$('chartsContent').innerHTML='<p class="charts-empty">Нет позиций с остатком за выбранный период.</p>';return;}
      const section={title,rows:data.rows,warehouses:data.warehouses,total:data.total,metric:'sku',shares:true,toppable:false};
      $('chartsContent').innerHTML=`<h2>${esc(title)}</h2><p class="charts-summary">Позиций с остатком: <strong>${int(data.total)} SKU</strong> · Период: ${esc(report.periods[from].label||monthKey(report.periods[from]))} — ${esc(report.periods[to].label||monthKey(report.periods[to]))}</p>${barSectionSvg(section)}<p class="charts-note">Запас в месяцах = «Остаток» ÷ средние продажи в месяц за выбранный период. «Нет продаж» — позиции с остатком, не продававшиеся за период. Закупочная цена не требуется.</p>`;
      return;
    }
    if(kind==='budgetStructure'||kind==='nonliquid'||kind==='ratings') {
      const sections=kind==='budgetStructure'?budgetSections(report,wh):kind==='nonliquid'?nonliquidSections(report,wh):ratingSections(report,wh);
      const notes={
        budgetStructure:'Заказ: текущее количество «Заказ» × закупочная цена, по всем складам с учётом фильтра склада. Остатки: «Остаток» × закупочная цена. Строк без положительной цены: '+int(sections[0].excluded||0)+'.',
        nonliquid:'«Заморожено сверх года» — стоимость остатка, превышающего 12 месяцев продаж. Пусто, если таких позиций нет.',
        ratings:'Сегменты — рейтинг продаж из ведомости; продажи за 12 месяцев в штуках.',
      };
      $('chartsContent').innerHTML=`<h2>${esc(title)}</h2>${sections.map(s=>`<h3 class="chart-section-title">${esc(s.title)}</h3>${barSectionSvg(s)}`).join('')}<p class="charts-note">${notes[kind]}</p>`;
      return;
    }
    const data=aggregate(report,kind,wh,from,to,{unit:mode});
    const shares=kind.endsWith('Shares');
    if(!(data.total>0)){$('chartsContent').innerHTML=`<p class="charts-empty">За выбранный период нет положительных продаж${mode==='money'?' с заполненной ценой':''}. Строк без положительной цены: ${data.excluded}.</p>`;return;}
    const metric=unitWord(mode);
    if(kind==='monthly') {
      $('chartsContent').innerHTML=`<h2>${esc(title)}</h2><p class="charts-summary">${esc(report.periods[from].label||monthKey(report.periods[from]))} — ${esc(report.periods[to].label||monthKey(report.periods[to]))} · Всего: <strong>${fmtMetric(data.total,mode)} ${metric}</strong>${mode==='money'?` · в штуках: ${qty(data.unitsTotal)}`:''}</p>${monthlySvg(data,title)}<p class="charts-summary">Итого за период с нарастающим итогом: <strong>${fmtMetric(data.total,mode)} ${metric}</strong></p><details><summary>Точные значения</summary><table class="chart-values data-table"><thead><tr><th>Месяц</th>${data.warehouses.map(w2=>`<th>${esc(w2)}, ${metric}</th>`).join('')}<th>Итого, ${metric}</th><th>Доля, %</th></tr></thead><tbody>${data.rows.map((r,i)=>`<tr><td>${esc(r.label)}</td>${data.warehouses.map(w2=>`<td>${fmtMetric(r.values.get(w2)||0,mode)}</td>`).join('')}<td>${fmtMetric(data.warehouses.reduce((s,w2)=>s+(r.values.get(w2)||0),0),mode)}</td><td>${pct(data.warehouses.reduce((s,w2)=>s+(r.values.get(w2)||0),0),data.total)}</td></tr>`).join('')}</tbody></table></details>`;
      return;
    }
    const {rows,note}=applyTop(data.rows,true);
    const section={title,rows,warehouses:data.warehouses,total:data.total,metric:mode,shares,toppable:false};
    const seasonNote=kind==='seasonality'?' · Среднее значение календарного месяца по годам периода':'';
    $('chartsContent').innerHTML=`<h2>${esc(title)}</h2><p class="charts-summary">${esc(report.periods[from].label||monthKey(report.periods[from]))} — ${esc(report.periods[to].label||monthKey(report.periods[to]))} · Всего: <strong>${fmtMetric(data.total,mode)} ${metric}</strong>${mode==='money'?` · в штуках: ${qty(data.unitsTotal)}`:''}${shares?' · Доли от общей суммы выбранного склада/складов за период':''}${seasonNote}</p>${barSectionSvg(section)}${note?`<p class="charts-note">${esc(note)}</p>`:''}<p class="charts-note">${rows.length} ${kind==='seasonality'?'календарных месяцев':'категорий'}. Строк без положительной цены: ${data.excluded}. Отрицательных месячных значений исключено: ${data.returns}. Неполный месяц отображается как есть, без экстраполяции.</p>`;
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
