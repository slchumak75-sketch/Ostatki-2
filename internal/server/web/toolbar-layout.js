(() => {
  const panel=document.querySelector('.topbar-actions');
  if(!panel)return;
  const params=document.getElementById('paramsPanel');
  const allButtons=[...panel.querySelectorAll(':scope > button'),...(params?.querySelectorAll('button')||[])];
  for(const button of allButtons)if(!button.id)button.id=`btnPreset_${button.dataset.preset}`;
  const groups=new Map([['topbar',panel]]);
  for(const button of allButtons)if(button.parentElement!==panel && ![...groups.values()].includes(button.parentElement))groups.set(`params-${groups.size}`,button.parentElement);
  const initialParent=new Map(allButtons.map(button=>[button.id,button.parentElement]));
  const buttons=()=>[...groups.values()].flatMap(group=>[...group.children].filter(node=>allButtons.includes(node)));
  const hosts=[panel,...(params?[params]:[])];
  const menu=document.createElement('div');menu.className='toolbar-layout-menu hidden';menu.setAttribute('role','menu');
  const toggle=document.createElement('button');toggle.type='button';toggle.className='btn btn-beige';toggle.setAttribute('role','menuitem');menu.append(toggle);document.body.append(menu);
  const layer=document.createElement('div');layer.className='toolbar-edit-layer hidden';document.body.append(layer);
  let editing=false,gesture=null,ready=false,saveQueue=Promise.resolve();
  const clampWidth=width=>Math.max(40,Math.min(1200,window.innerWidth-20,width));
  const snapshot=()=>({order:buttons().map(b=>b.id),groups:Object.fromEntries([...groups].map(([key,group])=>[key,[...group.children].filter(b=>allButtons.includes(b)).map(b=>b.id)])),widths:Object.fromEntries(buttons().filter(b=>b.style.width).map(b=>[b.id,parseFloat(b.style.width)]))});
  function apply(layout){
    const byId=new Map(buttons().map(b=>[b.id,b]));
    for(const id of layout.order||[])if(byId.has(id)){const entry=Object.entries(layout.groups||{}).find(([,ids])=>Array.isArray(ids)&&ids.includes(id));const parent=entry&&groups.get(entry[0])||initialParent.get(id);parent.append(byId.get(id));}
    for(const [id,b] of byId){const width=layout.widths?.[id];b.style.width=Number.isFinite(width)&&width>=40&&width<=1200?`${clampWidth(width)}px`:'';b.classList.toggle('toolbar-custom-width',Boolean(b.style.width));}
  }
  function notice(message){let status=document.getElementById('toolbarLayoutStatus');if(!status){status=document.createElement('div');status.id='toolbarLayoutStatus';status.className='toolbar-layout-status';status.setAttribute('role','status');document.body.append(status);}status.textContent=message;}
  function persist(){const layout=snapshot();saveQueue=saveQueue.catch(()=>{}).then(async()=>{const response=await fetch('api/toolbar-layout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(layout)});if(!response.ok)throw new Error();document.getElementById('toolbarLayoutStatus')?.remove();}).catch(()=>notice('Не удалось сохранить расположение кнопок. Повторите настройку.'));}
  function overlays(){
    layer.replaceChildren();if(!editing)return;
    for(const b of buttons()){
      const rect=b.getBoundingClientRect();if(!rect.width||!rect.height)continue;
      const cover=document.createElement('div');cover.className='toolbar-button-cover';cover.dataset.buttonId=b.id;cover.title='Перетащите кнопку. Правый край — изменить ширину.';
      Object.assign(cover.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
      const handle=document.createElement('span');handle.className='toolbar-width-handle';handle.title='Изменить только ширину';cover.append(handle);layer.append(cover);
    }
  }
  function finish(cancel=false){if(!gesture)return;if(cancel)apply(gesture.before);gesture=null;overlays();if(!cancel)persist();}
  function setEditing(value){finish();editing=value;hosts.forEach(host=>host.classList.toggle('toolbar-editing',editing));layer.classList.toggle('hidden',!editing);toggle.textContent=editing?'Завершить настройку панели':'Настроить панель';overlays();}
  hosts.forEach(host=>host.addEventListener('contextmenu',e=>{e.preventDefault();menu.classList.remove('hidden');toggle.disabled=!ready;toggle.textContent=editing?'Завершить настройку панели':'Настроить панель';menu.style.left=`${Math.max(8,Math.min(e.clientX,window.innerWidth-230))}px`;menu.style.top=`${Math.max(8,Math.min(e.clientY,window.innerHeight-60))}px`;toggle.focus();}));
  layer.addEventListener('contextmenu',e=>{e.preventDefault();setEditing(false);});
  toggle.addEventListener('click',()=>{setEditing(!editing);menu.classList.add('hidden');});
  document.addEventListener('click',e=>{if(!menu.contains(e.target))menu.classList.add('hidden');if(editing&&hosts.some(host=>host.contains(e.target))){e.preventDefault();e.stopImmediatePropagation();}},true);
  layer.addEventListener('pointerdown',e=>{
    const cover=e.target.closest('[data-button-id]');if(!cover||e.button!==0)return;e.preventDefault();
    const button=document.getElementById(cover.dataset.buttonId);
    gesture={button,resize:e.target.classList.contains('toolbar-width-handle'),x:e.clientX,width:button.getBoundingClientRect().width,before:snapshot()};layer.setPointerCapture?.(e.pointerId);
  });
  layer.addEventListener('pointermove',e=>{
    if(!gesture)return;e.preventDefault();
    if(gesture.resize){gesture.button.style.width=`${clampWidth(gesture.width+e.clientX-gesture.x)}px`;gesture.button.classList.add('toolbar-custom-width');}
    else{
      const target=buttons().find(b=>{if(b===gesture.button || (panel.contains(b)!==panel.contains(gesture.button)))return false;const r=b.getBoundingClientRect();return e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom;});
      if(target){const rect=target.getBoundingClientRect();target.parentElement.insertBefore(gesture.button,e.clientX<rect.left+rect.width/2?target:target.nextSibling);}
    }
    overlays();
  });
  layer.addEventListener('pointerup',()=>finish());layer.addEventListener('pointercancel',()=>finish(true));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(gesture)finish(true);else setEditing(false);menu.classList.add('hidden');}});
  window.addEventListener('blur',()=>finish(true));window.addEventListener('resize',overlays);document.addEventListener('scroll',overlays,true);
  const observer=new ResizeObserver(overlays);hosts.forEach(host=>observer.observe(host));
  if(params)new MutationObserver(overlays).observe(params,{attributes:true,attributeFilter:['class']});
  hosts.forEach(host=>host.title='Правая кнопка мыши — настройка порядка и ширины кнопок');
  fetch('api/toolbar-layout').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(apply).catch(()=>notice('Не удалось загрузить настройки верхней панели.')).finally(()=>{ready=true;});
})();
