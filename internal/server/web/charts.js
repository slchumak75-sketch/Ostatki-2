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
  // Стабильный цвет группы: ведущий номер группы фиксирует цвет — «группа 1»
  // всегда одним цветом, «группа 2» другим; без номера — по хешу имени.
  const groupPalette=['#2563eb','#dc2626','#059669','#9333ea','#d97706','#0891b2','#be185d','#4f46e5','#0d9488','#ca8a04','#7c3aed','#db2777','#0284c7','#65a30d','#ea580c','#16a34a'];
  const qColors=['#dbeafe','#dcfce7','#fef3c7','#f3e8ff'];
  const groupColor=name=>{
    const m=String(name).match(/^\s*(\d+)/);
    const idx=m?Number(m[1])-1:[...String(name)].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,7);
    return groupPalette[((idx%groupPalette.length)+groupPalette.length)%groupPalette.length];
  };
  const groupNum=name=>{const m=String(name).match(/^\s*(\d+)/);return m?Number(m[1]):Number.POSITIVE_INFINITY;};
  const groupSort=(a,b)=>{const na=groupNum(a.name),nb=groupNum(b.name);return na!==nb?na-nb:String(a.name).localeCompare(String(b.name),'ru');};
  let report=null,signature='';
  const monthKey=p=>`${p.year}-${String(p.month).padStart(2,'0')}`;
  const warehouse=it=>String(it.warehouse||'Без склада');
  const unitMode=()=>($('chartUnit')?.value||'money');
  const topMode=()=>$('chartTop')?.value||'all';
  const unitWord=mode=>mode==='units'?'шт.':'руб.';
  const fmtMetric=(v,mode)=>mode==='units'?qty(v):money(v);
  // Компактный формат для подписей над квартальными полосами: без копеек
  // и единиц, крупные числа сокращаются — подпись не «сбивается в кучу».
  const compact=v=>{
    const n=Number(v)||0,abs=Math.abs(n);
    if(abs>=1e6)return `${qty(Math.round(n/1e5)/10)} млн`;
    if(abs>=1e4)return `${qty(Math.round(n/100)/10)} тыс.`;
    return qty(Math.round(n*10)/10);
  };

  // Ядро агрегации продаж: деньги (цена обязательна) или штуки.
  // Виды: группы/поставщики (столбцы), доли, monthlyGroups — месяцы × товарные группы.
  function aggregate(rep,kind,wh,from,to,opts={}) {
    const periods=rep?.periods||[],items=rep?.items||[];
    const mode=opts.unit||'money';
    const rows=new Map(),warehouses=new Set();let excluded=0,returns=0,total=0;
    const monthlyGroups=kind==='monthlyGroups';
    if(monthlyGroups)for(let j=from;j<=to;j++)if(periods[j])rows.set(monthKey(periods[j]),{key:monthKey(periods[j]),label:periods[j].label||monthKey(periods[j]),values:new Map(),total:0,units:0,skuSet:new Set(),month:Number(periods[j].month)||1,year:Number(periods[j].year)||0});
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
    let seriesNames;
    if(monthlyGroups) {
      const totals=new Map();
      for(const r of sorted)for(const [g,v] of r.values)totals.set(g,(totals.get(g)||0)+v);
      seriesNames=[...totals.entries()].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]),'ru')).map(([g])=>g);
    } else seriesNames=[...warehouses].sort((a,b)=>a.localeCompare(b,'ru'));
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

  // Динамика продаж по товарным группам: тонкие гладкие кривые по месяцам,
  // топ-15 групп; выбор групп галочками с автомасштабом по вертикали.
  let groupSelection=new Set();
  let groupCatalog=[]; // [{name,total}] по убыванию продаж
  const TOP_GROUPS=15;
  function displayedGroups() {
    const picked=groupCatalog.filter(g=>groupSelection.has(g.name)).map(g=>g.name);
    return picked.length?picked:groupCatalog.slice(0,TOP_GROUPS).map(g=>g.name);
  }
  // Поквартальная агрегация: сумма трёх месяцев за квартал, подпись «1 кв. 2025».
  function toQuarterRows(data) {
    const out=[],map=new Map();
    for(const r of data.rows) {
      const q=Math.floor(((r.month||1)-1)/3),key=`${r.year}-Q${q+1}`;
      let qr=map.get(key);
      if(!qr){qr={key:`${q+1} кв. ${r.year}`,label:`${q+1} кв. ${r.year}`,values:new Map(),total:0,units:0,skuSet:new Set(),q,month:r.month,year:r.year};map.set(key,qr);out.push(qr);}
      for(const [g,v] of r.values)qr.values.set(g,(qr.values.get(g)||0)+v);
      qr.total+=r.total;qr.units+=r.units||0;
    }
    return out;
  }
  function monthlyGroupsSvg(data,title) {
    const mode=unitMode(),unit=unitWord(mode);
    const shown=displayedGroups();
    const sumMode=Boolean($('chartSumMode')?.checked);
    const qMode=Boolean($('chartQuarterBands')?.checked);
    const rows=qMode?toQuarterRows(data):data.rows;
    const series=sumMode?['__sum__']:shown;
    const valueOf=(r,g)=>sumMode?shown.reduce((s,g2)=>s+(r.values.get(g2)||0),0):(r.values.get(g)||0);
    const sumLabel=`Сумма (${shown.length})`;
    const seriesColor=g=>sumMode?'#b45309':groupColor(g);
    const h=440,x0=90,y0=350,pw=1020,ph=290;
    // Автомасштаб: вертикаль растягивается на максимум показанных (или суммарных) значений.
    const peak=Math.max(1,...rows.map(r=>Math.max(...series.map(g=>valueOf(r,g)),0)));
    const x=i=>x0+(rows.length===1?pw/2:i*pw/(rows.length-1));
    const y=v=>y0-ph*v/peak;
    const ticks=Array.from({length:5},(_,i)=>{const v=peak*i/4,yy=y(v);return `<line x1="${x0}" x2="${x0+pw}" y1="${yy}" y2="${yy}" stroke="#e2e8f0"/><text x="${x0-8}" y="${yy+4}" text-anchor="end">${fmtMetric(v,mode)}</text>`;}).join('');
    // Поквартальная раскраска: каждая четверть — светлая полоса своего цвета (4 тона по номеру квартала),
    // над графиком — сумма квартала в компактном формате; подписи эшелонируются в два ряда при тесноте,
    // при крайней тесноте печатаются через одну.
    let qBands='',qLegend='';
    if(qMode) {
      const step=rows.length>1?pw/(rows.length-1):pw;
      const qSumFont=11;
      let widthOf=txt=>txt.length*7;
      try{const cv=document.createElement('canvas');const ctx=cv.getContext('2d');if(ctx){ctx.font=`700 ${qSumFont}px sans-serif`;widthOf=txt=>Math.min(130,ctx.measureText(txt).width||txt.length*7);}}catch(_){/* jsdom/старые браузеры — оценка по длине */}
      const gap=8;
      const labels=rows.map((r,i)=>{
        const bx=Math.max(x0,x(i)-step/2),bx2=Math.min(x0+pw,x(i)+step/2);
        const qTotal=shown.reduce((s,g2)=>s+(r.values.get(g2)||0),0);
        const txt=`${compact(qTotal)}`;
        const cx=(Math.max(x0,bx)+Math.min(x0+pw,bx2))/2;
        return {r,i,bx,bx2,cx,txt,w:widthOf(txt),qTotal};
      });
      let skip=1;
      for(const cand of [1,2,3]) {
        const subset=labels.filter((_,i)=>i%cand===0);
        let ok=true,row=0,prevEnd=-1e9;
        for(const l of subset){if(l.cx-l.w/2<prevEnd+gap){row++;prevEnd=-1e9;}if(l.cx-l.w/2<prevEnd){ok=false;break;}prevEnd=l.cx+l.w/2;}
        if(ok&&row<=(cand===1?1:0)){skip=cand;break;}
        skip=cand;
      }
      // Эшелон: чередование двух рядов (48 и 62), если соседние подписи пересекаются в один ряд.
      let tier=0,prevRight=-1e9;
      qBands=labels.map((l,idx)=>{
        const band=`<rect class="qband" x="${l.bx.toFixed(1)}" y="${y0-ph}" width="${(l.bx2-l.bx).toFixed(1)}" height="${ph}" fill="${qColors[(l.r.q||0)%4]}"/>`;
        let textPart='';
        if(idx%skip===0){
          if(l.cx-l.w/2<prevRight+gap)tier=1-tier;else tier=0;
          const ty=tier===0?48:63;
          textPart=`<text class="qsum" x="${l.cx.toFixed(1)}" y="${ty}" text-anchor="middle" font-size="${qSumFont}"><title>${esc(l.r.key)}: ${fmtMetric(l.qTotal,mode)} ${unit}</title>${esc(l.txt)}</text>`;
          prevRight=l.cx+l.w/2;
        }
        return band+textPart;
      }).join('');
      const present=[...new Set(rows.map(r=>r.q||0))].sort((a,b)=>a-b);
      qLegend=`<div class="chart-legend qlegend">${present.map(q=>`<span><i style="background:${qColors[q%4]}"></i>${q+1} кв.</span>`).join('')}</div>`;
    }
    // Вертикальная сетка; подписи шкалы: каждый месяц — помесячно, каждый квартал с суммой — поквартально.
    const grid=rows.map((r,i)=>`<line x1="${x(i)}" x2="${x(i)}" y1="${y0-ph}" y2="${y0}" stroke="#eef2f7"/>`).join('');
    // Гладкая кривая через точки: кубические Безье с горизонтальными касательными.
    const smooth=pts=>{if(pts.length<2)return `M ${pts[0].x} ${pts[0].y}`;let d=`M ${pts[0].x} ${pts[0].y}`;for(let i=1;i<pts.length;i++){const p0=pts[i-1],p1=pts[i];const cx=(p0.x+p1.x)/2;d+=` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;}return d;};
    const paths=series.map(g=>{
      const color=seriesColor(g);
      const pts=rows.map((r,i)=>({x:x(i),y:y(valueOf(r,g))}));
      const name=g==='__sum__'?sumLabel:g;
      const dots=pts.map((p,i)=>`<circle cx="${p.x}" cy="${p.y}" r="2.6" fill="${color}"><title>${esc(rows[i].label)} — ${esc(name)}: ${fmtMetric(valueOf(rows[i],g),mode)} ${unit}${g==='__sum__'?'':`; ${pct(valueOf(rows[i],g),data.total)} от итога`}</title></circle>`).join('');
      return `<path d="${smooth(pts)}" fill="none" stroke="${color}" stroke-width="${sumMode?2.4:1.3}" stroke-linecap="round"><title>${esc(name)}</title></path>${dots}`;
    }).join('');
    const labels=rows.map((r,i)=>qMode?`<text x="${x(i)}" y="375" text-anchor="middle">${esc(r.key)}</text>`:`<text x="${x(i)}" y="375" text-anchor="end" transform="rotate(-35 ${x(i)} 375)">${esc(r.key)}</text>`).join('');
    const svg=`<svg class="sales-chart" viewBox="0 0 1200 ${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><text x="${x0}" y="25">${unit}</text>${qBands}${ticks}${grid}${paths}${labels}</svg>`;
    const legend=`<div class="chart-legend">${series.map(g=>`<span><i style="background:${seriesColor(g)}"></i>${esc(g==='__sum__'?sumLabel:g)}</span>`).join('')}</div>`;
    return legend+svg+qLegend+(qMode?'<p class="charts-note">Поквартальный режим: каждая точка — сумма за квартал, фон квартала подсвечен своим из 4 светлых цветов.</p>':'');
  }

  // Направление по проценту изменения (порог ±10%).
  const trendOf=change=>change===null?null:change>10?'рост':change<-10?'падение':'стабильно';
  // Аналитическая оценка тенденций: год к году (последний год против предыдущего)
  // и квартал к кварталу — одноимённые кварталы по годам (Q1 2026 ↔ Q1 2025 и т.д.).
  function trendAnalysis(data,title) {
    const mode=unitMode(),unit=unitWord(mode);
    const shown=displayedGroups();
    const sumMode=Boolean($('chartSumMode')?.checked);
    const months=data.rows.map(r=>({month:r.month||1,year:r.year||0,v:r}));
    const years=[...new Set(months.map(m=>m.year))].sort((a,b)=>a-b);
    if(years.length<2)return `<div class="chart-trends"><h3>Аналитика тенденций</h3><p class="charts-empty">Для сравнения год к году нужен период, охватывающий хотя бы два года (сейчас: ${years.length ? years.join(', ') : '—'}).</p></div>`;
    const series=sumMode?['__sum__']:shown;
    const valueOf=(r,g)=>sumMode?shown.reduce((s,g2)=>s+(r.values.get(g2)||0),0):(r.values.get(g)||0);
    const seriesColor=g=>sumMode?'#b45309':groupColor(g);
    const fmtPct=v=>(v>0?'+':'')+money(v)+'%';
    const groupSum=(year,g)=>months.filter(m=>m.year===year).reduce((s,m)=>s+valueOf(m.v,g),0);
    const qSum=(year,q,g)=>months.filter(m=>m.year===year&&Math.floor((m.month-1)/3)===q).reduce((s,m)=>s+valueOf(m.v,g),0);
    const qLabel=q=>`${q+1} кв.`;
    const lastYear=years[years.length-1],prevYear=years[years.length-2];
    // Кварталы, встречающиеся в обоих годах.
    const qPairs=[];
    for(let q=0;q<4;q++){
      const present=months.some(m=>m.year===lastYear&&Math.floor((m.month-1)/3)===q)&&months.some(m=>m.year===prevYear&&Math.floor((m.month-1)/3)===q);
      if(present)qPairs.push(q);
    }
    const out=[];let grow=0,fall=0,flat=0;
    for(const g of series) {
      const name=g==='__sum__'?`Сумма (${shown.length})`:g;
      const total=months.reduce((s,m)=>s+valueOf(m.v,g),0);
      if(!(total>0)){out.push({name,color:seriesColor(g),direction:'нет продаж',text:`продаж за период нет`});continue;}
      // Год к году.
      const y1=groupSum(prevYear,g),y2=groupSum(lastYear,g);
      const yChange=y1>0?(y2-y1)/y1*100:null;
      const yDir=trendOf(yChange);
      let yText;
      if(yChange===null){yText=`продажи появились в ${lastYear} (+${fmtMetric(y2,mode)} ${unit})`;}
      else yText=`${lastYear} против ${prevYear}: ${fmtMetric(y2,mode)} против ${fmtMetric(y1,mode)} ${unit} (${fmtPct(yChange)})`;
      const direction=yDir==='падение'?'падение':yDir==='рост'?'рост':'стабильно';
      if(yDir==='падение')fall++;else if(yDir==='рост')grow++;else flat++;
      // Квартал к кварталу: одноимённые кварталы по годам.
      const qParts=[];
      for(const q of qPairs){
        const a=qSum(prevYear,q,g),b=qSum(lastYear,q,g);
        if(!(a>0)&&!(b>0))continue;
        const ch=a>0?(b-a)/a*100:null;
        const d=trendOf(ch);
        qParts.push(`${qLabel(q)}: ${ch===null?`продажи появились (+${fmtMetric(b,mode)})`:`${fmtPct(ch)} — ${d}`}`);
      }
      // Пик и неравномерность по месяцам показанного периода.
      const monthVals=data.rows.map(r=>valueOf(r,g));
      const peakIdx=monthVals.indexOf(Math.max(...monthVals));
      const nonZero=monthVals.filter(v=>v>0);
      const uneven=nonZero.length>1&&Math.max(...nonZero)/Math.min(...nonZero)>=3;
      let text=`Год к году: ${yText}`;
      if(qParts.length)text+=`. Квартал к кварталу: ${qParts.join('; ')}`;
      text+=`. Пик: ${data.rows[peakIdx]?.label||'—'} (${fmtMetric(monthVals[peakIdx],mode)} ${unit})${uneven?' · продажи неравномерные':''}`;
      out.push({name,color:seriesColor(g),direction,text});
    }
    const list=out.map(r=>`<li><i class="ct-dot" style="background:${r.color}"></i><strong>${esc(r.name)}</strong> — ${esc(r.direction)}. ${esc(r.text)}</li>`).join('');
    const summary=sumMode?'':`<p class="ct-summary">Итог по ${shown.length} группам (год к году, ${lastYear} против ${prevYear}): тенденций роста — <strong>${grow}</strong>, падения — <strong>${fall}</strong>, стабильных — <strong>${flat}</strong>.</p>`;
    const note=`<p class="charts-note">«Год к году» — сумма последнего года периода против предыдущего. «Квартал к кварталу» — одноимённые кварталы по годам (${qPairs.map(qLabel).join(', ')||'нет пар'}): ${prevYear} против ${lastYear}. Порог тенденции ±10%. «Неравномерные» — максимум превышает минимум более чем втрое.</p>`;
    return `<div class="chart-trends"><h3>Аналитика тенденций — ${esc(title)}</h3><ul>${list}</ul>${summary}${note}</div>`;
  }
  function renderGroupList() {
    const list=$('chartGroupList');if(!list)return;
    const q=($('chartGroupSearch')?.value||'').trim().toLowerCase();
    // Перечень — по порядку: номер группы, затем алфавит (не по продажам).
    const rows=groupCatalog.filter(g=>!q||g.name.toLowerCase().includes(q)).sort(groupSort);
    list.innerHTML=rows.length?rows.map(g=>`<label class="cgp-item" title="${esc(g.name)}"><i class="cgp-dot" style="background:${groupColor(g.name)}"></i><input type="checkbox" data-cgp-group="${esc(g.name)}" ${groupSelection.has(g.name)?'checked':''}/><span class="cgp-name">${esc(g.name.length>48?g.name.slice(0,46)+'…':g.name)}</span></label>`).join(''):'<p class="muted" style="padding:8px">Группа не найдена</p>';
    const hint=$('chartGroupHint');
    if(hint)hint.textContent=groupSelection.size?`Отмечено групп: ${groupSelection.size} — вертикаль масштабируется по ним`:`Не отмечено — показаны топ-${TOP_GROUPS} групп`;
  }
  function syncGroupPicker() {
    const picker=$('chartGroupPicker');if(!picker)return;
    picker.classList.toggle('hidden',!report?.items?.length||$('chartKind')?.value!=='monthlyGroups');
  }

  function render() {
    if(!$('chartsContent'))return;
    if(!report?.items?.length||!report.periods?.length){$('chartsContent').innerHTML='<p class="charts-empty">Загрузите ведомость с помесячными продажами.</p>';return;}
    const from=Number($('chartFrom').value),to=Number($('chartTo').value);
    if(from>to){$('chartsContent').innerHTML='<p class="charts-empty">Начало периода должно быть не позже окончания.</p>';return;}
    const kind=$('chartKind').value,title=$('chartKind').selectedOptions[0].textContent,wh=$('chartWarehouse').value,mode=unitMode();
    syncGroupPicker();
    const data=aggregate(report,kind,wh,from,to,{unit:mode});
    const shares=kind.endsWith('Shares');
    if(!(data.total>0)){$('chartsContent').innerHTML=`<p class="charts-empty">За выбранный период нет положительных продаж${mode==='money'?' с заполненной ценой':''}. Строк без положительной цены: ${data.excluded}.</p>`;return;}
    const metric=unitWord(mode);
    if(kind==='monthlyGroups') {
      // Каталог групп (по убыванию продаж) для панели галочек; выбор чистится от исчезнувших.
      const totals=new Map();
      for(const r of data.rows)for(const [g,v] of r.values)totals.set(g,(totals.get(g)||0)+v);
      groupCatalog=[...totals.entries()].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0]),'ru')).map(([name,total])=>({name,total}));
      const names=new Set(groupCatalog.map(g=>g.name));
      for(const g of [...groupSelection])if(!names.has(g))groupSelection.delete(g);
      renderGroupList();
      $('chartsContent').innerHTML=`<h2>${esc(title)}</h2><p class="charts-summary">${esc(report.periods[from].label||monthKey(report.periods[from]))} — ${esc(report.periods[to].label||monthKey(report.periods[to]))} · Всего: <strong>${fmtMetric(data.total,mode)} ${metric}</strong>${mode==='money'?` · в штуках: ${qty(data.unitsTotal)}`:''}</p>${monthlyGroupsSvg(data,title)}${trendAnalysis(data,title)}<details><summary>Точные значения</summary><table class="chart-values data-table"><thead><tr><th>Месяц</th>${data.warehouses.map(g=>`<th>${esc(g)}, ${metric}</th>`).join('')}<th>Итого, ${metric}</th><th>Доля, %</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td>${esc(r.label)}</td>${data.warehouses.map(g=>`<td>${fmtMetric(r.values.get(g)||0,mode)}</td>`).join('')}<td>${fmtMetric(data.warehouses.reduce((s,g)=>s+(r.values.get(g)||0),0),mode)}</td><td>${pct(data.warehouses.reduce((s,g)=>s+(r.values.get(g)||0),0),data.total)}</td></tr>`).join('')}</tbody></table></details>`;
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
  for(const id of ['chartKind','chartWarehouse','chartFrom','chartTo','chartTop','chartUnit','chartSumMode','chartQuarterBands'])$(id)?.addEventListener('change',render);
  $('chartGroupSearch')?.addEventListener('input',renderGroupList);
  $('chartGroupReset')?.addEventListener('click',()=>{groupSelection.clear();renderGroupList();render();});
  $('chartGroupList')?.addEventListener('change',e=>{
    const box=e.target.closest('[data-cgp-group]');
    if(!box)return;
    if(box.checked)groupSelection.add(box.dataset.cgpGroup);else groupSelection.delete(box.dataset.cgpGroup);
    renderGroupList();render();
  });
  window.SalesCharts={update,aggregate};
  update(null);
})();
