const fs = require('fs');
const puppeteer = require('puppeteer-core');
const read = n => JSON.parse(fs.readFileSync(__dirname+'/snapshot-'+n+'.json','utf8').replace(/^\uFEFF/,''));
(async()=>{
  for(const n of ['java','ww2']){const s=read(n);console.log(n,JSON.stringify({pages:s.pages.map(p=>({id:p.id,title:p.focus})),graphs:Object.entries(s.graphs).map(([k,v])=>[k,v.status,v.graph?.nodes?.length]),facts:Object.entries(s.factChecks||{}).map(([k,v])=>[k,v.status]),reports:s.reports?.map(r=>({title:r.title,id:r.id}))}));}
  const browser=await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,pipe:true});
  try {
    const page=await browser.newPage();await page.setViewport({width:1600,height:950});
    await page.evaluateOnNewDocument(()=>{localStorage.setItem('theme','light');localStorage.setItem('atlas-map-collapsed','0');localStorage.setItem('atlas-mode','detailed');localStorage.setItem('atlas-chat-dock','center');});
    await page.setRequestInterception(true);
    page.on('request',r=>{if(r.url().includes('/api/') && r.method()==='POST') r.respond({status:503,contentType:'application/json',body:'{}'});else r.continue();});
    await page.goto('http://127.0.0.1:3000',{waitUntil:'networkidle2'});
    console.log('opening',await page.evaluate(()=>document.body.innerText.slice(0,700)));
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.toLowerCase().includes('what is world war 2')).click());
    await new Promise(r=>setTimeout(r,1500));
    console.log('opened',await page.evaluate(()=>document.body.innerText.slice(0,1000)));
    await page.screenshot({path:__dirname+'/report.png'});
    const click=async text=>{await page.evaluate(text=>{const b=[...document.querySelectorAll('button')].find(b=>b.getBoundingClientRect().width>0&&b.textContent.trim()===text);if(!b)throw Error('Missing '+text);b.click();},text);await new Promise(r=>setTimeout(r,500));};
    await click('Pages');
    await page.screenshot({path:__dirname+'/workspace.png'});
    for(const [name,text] of [['factcheck','Fact-check'],['history','History'],['graph','Map']]) {
      await click(text);await page.screenshot({path:__dirname+'/'+name+'.png'});
      const aside=await page.$('aside[aria-label]');if(aside)await aside.screenshot({path:__dirname+'/'+name+'-panel.png'});
    }
    await click('Deep research');
    const timeline=await page.$('nav[aria-label="Report contents"]');
    if(timeline){await page.evaluate(()=>[...document.querySelectorAll('nav[aria-label="Report contents"] button')].find(b=>b.textContent==='Timeline')?.click());await new Promise(r=>setTimeout(r,1000));await page.screenshot({path:__dirname+'/timeline.png'});}
    // Rasterize the existing SVG logo without altering its geometry.
    await page.setContent('<html><body style="margin:0;background:transparent">'+fs.readFileSync('atlas-logo.svg','utf8').replace('width="64" height="64"','width="600" height="600"')+'</body></html>');
    await page.setViewport({width:600,height:600});await page.screenshot({path:__dirname+'/logo.png',omitBackground:true});
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
