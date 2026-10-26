const {JSDOM}=require('jsdom');const fs=require('fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only'}),w=dom.window,d=w.document,saves=[];
w.ResizeObserver=class{observe(){}};
w.fetch=async(url,options)=>{if(options){saves.push(JSON.parse(options.body));return {ok:true};}return {ok:true,json:async()=>({order:['btnHighlightOrder','btnFillOrder'],widths:{btnFillOrder:180}})};};
const tick=()=>new Promise(r=>setTimeout(r,5));
(async()=>{try{
 w.eval(fs.readFileSync('internal/server/web/toolbar-layout.js','utf8'));await tick();const panel=d.querySelector('.topbar-actions'),fill=d.getElementById('btnFillOrder');assert.equal(panel.lastElementChild,fill);assert.equal(fill.style.width,'180px');assert.equal(fill.style.height,'');
 const buttons=()=>[...panel.children].filter(b=>b.tagName==='BUTTON');
 for(const button of buttons())button.getBoundingClientRect=()=>({left:buttons().indexOf(button)*70,right:buttons().indexOf(button)*70+(parseFloat(button.style.width)||65),top:30,bottom:57,width:parseFloat(button.style.width)||65,height:27});
 panel.dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,clientX:30,clientY:50}));d.querySelector('.toolbar-layout-menu button').click();
 assert.ok(!d.querySelector('.toolbar-edit-layer').classList.contains('hidden'));const cover=d.querySelector(`[data-button-id="${fill.id}"]`),handle=cover.querySelector('.toolbar-width-handle');
 handle.dispatchEvent(new w.MouseEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:40}));const layer=d.querySelector('.toolbar-edit-layer');layer.dispatchEvent(new w.MouseEvent('pointermove',{bubbles:true,clientX:150,clientY:400}));layer.dispatchEvent(new w.MouseEvent('pointerup',{bubbles:true}));await tick();assert.equal(fill.style.width,'230px');assert.equal(fill.style.height,'','Vertical pointer motion must never change height');assert.equal(saves.at(-1).widths.btnFillOrder,230);
 const current=d.querySelector(`[data-button-id="${fill.id}"]`);current.dispatchEvent(new w.MouseEvent('pointerdown',{bubbles:true,button:0,clientX:100}));layer.dispatchEvent(new w.MouseEvent('pointermove',{bubbles:true,clientX:2,clientY:35}));layer.dispatchEvent(new w.MouseEvent('pointerup',{bubbles:true}));await tick();assert.equal(buttons()[0],fill);assert.equal(saves.at(-1).order[0],fill.id);
 d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.ok(layer.classList.contains('hidden'));assert.ok(!d.querySelector('.toolbar-layout-menu').textContent.includes('Сброс'));
 console.log('Toolbar order persistence and horizontal-only resizing passed');
}finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
