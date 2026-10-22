// Humo visual sin producción ni credenciales: 2 inversores + medidor ficticios.
// Requiere: npm install --no-save playwright chart.js; npx playwright install chromium.
// El test no llama ni a Solarman ni a KSTAR reales.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {join,resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const chartScript=readFileSync(join(root,'node_modules/chart.js/dist/chart.umd.js'));
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.svg':'image/svg+xml'};
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/blank'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Semilla de QA</title>');return}
  const absolute=resolve(root,'.'+decodeURIComponent(path));
  if(!absolute.startsWith(root+sep)){res.writeHead(403);res.end();return}
  try{const body=readFileSync(absolute);res.writeHead(200,{'content-type':mime[extname(absolute)]||'text/plain'});res.end(body)}
  catch{res.writeHead(404);res.end('No encontrado')}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const addr='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
let requests=0;const errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/**',
    route=>route.fulfill({status:200,contentType:'application/javascript',body:chartScript}));
  await page.route('https://fonts.googleapis.com/**',
    route=>route.fulfill({status:200,contentType:'text/css',body:''}));
  await page.route('https://fonts.gstatic.com/**',route=>route.abort());
  await page.route('https://qa-scada-worker.example.invalid/**/produccion',route=>{
    requests++;
    const fake={
      A:[{ts:'2026-10-19T08:05:00Z',pot:21.3,acum:3000,dia:40}],
      B:[{ts:'2026-10-19T08:05:00Z',pot:17,acum:2500,dia:30}],
      meta:{fuente:'ficticia QA'}
    };
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fake)});
  });
  await page.goto(addr+'/blank');
  await page.evaluate(async ()=>{
    localStorage.setItem('gorraiz_api_cfg',JSON.stringify({
      url:'https://qa-scada-worker.example.invalid',key:'CLAVE_FICTICIA_QA'}));
    const db=await new Promise((resolve,reject)=>{
      const rq=indexedDB.open('gorraiz_datos',1);
      rq.onupgradeneeded=()=>rq.result.createObjectStore('fuentes',{keyPath:'id'});
      rq.onsuccess=()=>resolve(rq.result);rq.onerror=()=>reject(rq.error);
    });
    const date='2026-10-19';
    const entries=[
      {id:'A|Fichero QA',tipo:'A',nombre:'Ficticio QA A',rows:[
        {ts:new Date(date+'T08:05:00Z'),pot:21.3,dia:40,acum:3020}]},
      {id:'B|Fichero QA',tipo:'B',nombre:'Ficticio QA B',rows:[
        {ts:new Date(date+'T08:05:00Z'),pot:17,dia:30,acum:2540}]},
      {id:'S|'+date,tipo:'S',fecha:date,payload:{date,
        rows:[
          {saveTime:date+' 10:00:00',positiveActiveElec:100,reverseActiveElec:10},
          {saveTime:date+' 10:05:00',positiveActiveElec:100.5,reverseActiveElec:10.1},
          {saveTime:date+' 10:10:00',positiveActiveElec:101,reverseActiveElec:10.2}],
        daily:[{date,importKWh:1,exportKWh:.2,selfConsumptionKWh:7}],
        meta:{completo:true,medidoresEstacion:1,timezoneVerified:true,fetchedAt:'2026-10-20T12:00:00Z'}}}
    ];
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('fuentes','readwrite'),os=tx.objectStore('fuentes');
      for(const e of entries)os.put(e);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
  });
  await page.goto(addr+'/scada.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{
    const el=document.getElementById('mainChart');
    return window.Chart?.getChart(el)&&
      document.querySelector('#powerGen')?.textContent.includes('38,3');
  },{timeout:15000});
  const reading=await page.evaluate(()=>{
    const chart=Chart.getChart(document.getElementById('mainChart'));
    return{gen:document.getElementById('powerGen').textContent,
      imp:document.getElementById('powerImp').textContent,
      exp:document.getElementById('powerExp').textContent,
      cons:document.getElementById('powerCons').textContent,
      series:chart.data.datasets.map(d=>({label:d.label,nonNull:d.data.filter(v=>v!==null).length})),
      labels:chart.data.labels.length}
  });
  assert.match(reading.gen,/38,3 kW/);
  assert.match(reading.imp,/6 kW/);
  assert.match(reading.exp,/1,2 kW/);
  assert.match(reading.cons,/43,1 kW/);
  assert.equal(reading.series.length,4);
  assert.ok(reading.series.every(x=>x.nonNull>=1),JSON.stringify(reading));
  assert.equal(reading.labels,288);
  assert.equal(requests,0,'abrir el SCADA no debe consumir ninguna llamada API');
  await page.locator('#auto').check();
  await page.waitForTimeout(350);
  assert.equal(requests,0,'activar automático tampoco hace llamada inmediata');
  mkdirSync(join(root,'artifacts'),{recursive:true});
  await page.screenshot({path:join(root,'artifacts/scada-desktop-qa.png'),fullPage:true});
  await page.locator('#updatePV').click();
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('Solarman actualizado'));
  assert.equal(requests,1,'botón solicita una vez a Worker de prueba');
  await page.locator('#updatePV').click();
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('Cupo Solarman'));
  assert.equal(requests,1,'segundo click no debe provocar segunda consulta');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(root,'artifacts/scada-movil-qa.png'),fullPage:true});
  const width=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  assert.ok(width<=3,'desbordamiento horizontal móvil: '+width+' px');
  assert.deepEqual(errors,[],'errores JS en navegador');
  console.log('SCADA Chromium QA: cuatro curvas, 288 marcas, balance consistente, 0 llamadas al abrir, bloqueo 1/h, diseño móvil. OK.');
} finally {
  await browser.close();
  await new Promise(r=>server.close(r));
}
