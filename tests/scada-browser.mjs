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
let requests=0,archiveReads=0,archiveWrites=0;const errors=[],archive=new Map();
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
  await page.route(/https:\/\/qa-scada-worker\.example\.invalid\/historico\/.*/,async route=>{
    const path=new URL(route.request().url()).pathname;
    const body=route.request().method()==='POST'?route.request().postDataJSON():{};
    const json=obj=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(obj)});
    if(path==='/historico/validar'){
      const items=body.items||[];
      return json({version:'migracion-v3',ok:true,validas:items.length,
        rechazadas:0,incidencias:[],
        aceptadas:items.map(x=>({tipo:x.tipo,fecha:x.fecha,filas:x.rows?.length||x.payload?.rows?.length||0}))});
    }
    if(path==='/historico/guardar'){
      archiveWrites++;
      for(const item of body.items||[])archive.set(item.tipo+'|'+item.fecha,item);
      return json({version:'migracion-v3',ok:true,guardadas:(body.items||[]).length,
        rechazadas:0,incidencias:[],pendientesPotencia:0,pendientesEnergia:0});
    }
    if(path==='/historico/estado'){
      archiveReads++;
      const dias={A:[],B:[],S:[]};
      for(const source of archive.values())dias[source.tipo].push(source.fecha);
      const coverage={};
      for(const type of ['A','B','S']){
        dias[type]=[...new Set(dias[type])].sort();
        coverage[type]={dias:dias[type].length,desde:dias[type][0]||null,hasta:dias[type].at(-1)||null};
      }
      return json({ok:true,dias,cobertura:coverage,proveedorConsultado:false});
    }
    if(path==='/historico/datos'){
      archiveReads++;
      return json({fuentes:[...archive.values()].filter(f=>f.fecha>=body.desde&&f.fecha<=body.hasta),
        meta:{desde:body.desde,hasta:body.hasta,proveedorConsultado:false}});
    }
    return route.fulfill({status:404,contentType:'application/json',body:'{"error":"Ruta desconocida"}'});
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
    // Serie SINTÉTICA con suficientes puntos para ver curvas y probar el
    // signo del intercambio. No representa medidas del edificio.
    const A=[],B=[],rows=[];let imp=0,exp=0,produccionA=0,produccionB=0;
    for(let i=0;i<=100;i++){
      const minutes=6*60+i*5,hr=Math.floor(minutes/60),mm=minutes%60;
      const time=String(hr).padStart(2,'0')+':'+String(mm).padStart(2,'0');
      const sun=Math.max(0,Math.sin(Math.PI*(hr+mm/60-6)/13));
      const gen=Math.max(0,71*sun*(0.95+0.05*Math.sin(i/5)));
      const a=gen*.55,b=gen*.45;
      const consumption=32+3*Math.sin(i/12);
      const imported=Math.max(0,consumption-gen),exported=Math.max(0,gen-consumption);
      if(i){imp+=imported/12;exp+=exported/12;produccionA+=a/12;produccionB+=b/12}
      const dt=new Date(date+'T'+String(hr-2).padStart(2,'0')+':'+String(mm).padStart(2,'0')+':00Z');
      A.push({ts:dt,pot:a,dia:produccionA,acum:3000+produccionA});
      B.push({ts:dt,pot:b,dia:produccionB,acum:2500+produccionB});
      rows.push({saveTime:date+' '+time+':00',
        positiveActiveElec:100+imp,reverseActiveElec:10+exp});
    }
    const entries=[
      {id:'A|Fichero QA',tipo:'A',nombre:'SINTÉTICO QA A',unidadPotencia:'kW',rows:A},
      {id:'B|Fichero QA',tipo:'B',nombre:'SINTÉTICO QA B',unidadPotencia:'kW',rows:B},
      {id:'S|'+date,tipo:'S',fecha:date,payload:{date,rows,
        daily:[{date,importKWh:imp,exportKWh:exp,
          selfConsumptionKWh:produccionA+produccionB-exp}],
        meta:{fuente:'spc',stationId:'2026032317114373',
          meterId:'210261430F3060020000661',desde:date,hasta:date,completo:true,
          medidoresEstacion:1,timezoneVerified:true,actualizado:'2026-10-20T12:00:00Z',
          fetchedAt:'2026-10-20T12:00:00Z'}}}
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
      document.querySelector('#powerGen')?.textContent!=='—';
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
  const value=v=>Number(v.replace(/[^0-9,-]/g,'').replace(',','.'));
  const generation=value(reading.gen),consumption=value(reading.cons);
  const imported=value(reading.imp),exported=value(reading.exp);
  assert.ok(generation>0&&consumption>0,'potencias sintéticas válidas');
  assert.ok(imported>=0&&exported>=0,'intercambio no negativo');
  assert.ok(Math.abs(generation+imported-exported-consumption)<0.3,
    'identidad consumo = generación + importación - exportación');
  assert.equal(reading.series.length,4);
  assert.ok(reading.series.every(x=>x.nonNull>=60),JSON.stringify(reading));
  assert.equal(reading.labels,288);
  assert.equal(requests,0,'abrir el SCADA no debe consumir ninguna llamada API');
  // Ambos paneles usan las mismas rutas de archivo, sin consultar proveedores.
  await page.locator('#pushHistory').click();
  await page.waitForFunction(()=>document.querySelector('#sharedState')?.textContent.includes('Migración v3 finalizada'));
  assert.ok(archiveWrites>=1);
  assert.equal(archive.size,3,'se comparten inversores A/B y SPC');
  await page.evaluate(async()=>{
    const db=await new Promise((ok,bad)=>{const r=indexedDB.open('gorraiz_datos',1);
      r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error)});
    await new Promise((ok,bad)=>{const tx=db.transaction('fuentes','readwrite');
      tx.objectStore('fuentes').clear();tx.oncomplete=ok;tx.onerror=()=>bad(tx.error)});
    db.close();
  });
  await page.locator('#reload').click();
  await page.waitForFunction(()=>document.querySelector('#powerGen')?.textContent!=='—'&&
    document.querySelector('#coverageSPC')?.textContent.includes('2026-10-19'));
  assert.ok(archiveReads>=2,'recupera del archivo central después de vaciar caché del equipo');
  assert.equal(requests,0,'recuperar histórico NO consulta Solarman');
  assert.match(await page.locator('#coverageA').innerText(),/2026-10-19/);
  assert.match(await page.locator('#coverageB').innerText(),/2026-10-19/);
  assert.match(await page.locator('#coverageSPC').innerText(),/2026-10-19/);
  assert.equal(await page.locator('#lastSpc').isEnabled(),true);
  // Sin datos en otro día: explicación visible en todas las vistas afectadas.
  await page.locator('#day').fill('2026-10-21');
  await page.locator('#day').dispatchEvent('change');
  await page.waitForFunction(()=>document.querySelector('#blankState')?.hidden===false);
  assert.match(await page.locator('#blankDetail').innerText(),/No hay muestras válidas/);
  await page.locator('.scada-nav [data-view-link="red"]').click();
  await page.waitForFunction(()=>document.querySelector('#blankDetail')?.textContent.includes('No hay intervalos KSTAR'));
  assert.match(await page.locator('#blankDetail').innerText(),/No hay intervalos KSTAR/);
  await page.locator('#lastSpc').click();
  await page.waitForFunction(()=>document.querySelector('#day')?.value==='2026-10-19');
  assert.equal(await page.locator('#blankState').isVisible(),false);
  assert.equal(requests,0,'seleccionar último SPC no consulta al proveedor');
  const views=['planta','inversores','red','historicos','diagnostico','general'];
  const chartByView={planta:'plantChart',inversores:'inverterAChart',
    red:'redDetailChart',historicos:'historyChart',general:'mainChart'};
  for(const view of views){
    await page.locator('.scada-nav [data-view-link="'+view+'"]').click();
    await page.waitForFunction(v=>document.querySelector('[data-view-panel="'+v+'"]')?.hidden===false,view);
    assert.equal(await page.locator('.scada-nav [data-view-link="'+view+'"]').getAttribute('aria-current'),'page');
    assert.equal(await page.locator('[data-view-panel]:visible').count(),1,'solo una vista activa');
    if(chartByView[view]){
      const chart=chartByView[view];
      await page.waitForFunction(id=>!!Chart.getChart(document.getElementById(id)),chart);
    }else{
      assert.ok(await page.locator('#diagWarnings p').count()>0,'diagnóstico con validaciones');
    }
    assert.equal(requests,0,'navegar entre '+view+' no consume API');
  }
  await page.locator('#auto').check();
  await page.waitForTimeout(350);
  assert.equal(requests,0,'activar automático tampoco hace llamada inmediata');
  // Advertencia exclusiva del artefacto de QA, nunca de la aplicación real.
  await page.evaluate(()=>{
    const warning=document.createElement('strong');
    warning.textContent='PRUEBA VISUAL · DATOS SINTÉTICOS';
    warning.style.cssText='display:inline-block;padding:5px 12px;background:#413719;color:#ffd77d;border-radius:8px;font-size:11px;margin-bottom:9px';
    document.querySelector('main').prepend(warning);
  });
  mkdirSync(join(root,'artifacts'),{recursive:true});
  await page.screenshot({path:join(root,'artifacts/scada-desktop-qa.png'),fullPage:true});
  await page.locator('#updatePV').click();
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('Solarman actualizado'));
  assert.equal(requests,1,'botón solicita una vez a Worker de prueba');
  await page.locator('#updatePV').click();
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent.includes('Cupo Solarman'));
  assert.equal(requests,1,'segundo click no debe provocar segunda consulta');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.mobile-nav').isVisible(),true,'navegación móvil presente');
  await page.locator('.mobile-nav [data-view-link="inversores"]').click();
  await page.waitForFunction(()=>!document.getElementById('view-inversores').hidden);
  await page.waitForFunction(()=>!!Chart.getChart(document.getElementById('inverterBChart')));
  assert.equal(requests,1,'navegar en móvil no hace otra consulta');
  await page.locator('.mobile-nav [data-view-link="general"]').click();
  await page.waitForFunction(()=>!!Chart.getChart(document.getElementById('mainChart')));
  await page.screenshot({path:join(root,'artifacts/scada-movil-qa.png'),fullPage:true});
  const width=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  assert.ok(width<=3,'desbordamiento horizontal móvil: '+width+' px');
  assert.deepEqual(errors,[],'errores JS en navegador');
  // Preview se publica en el MISMO origen de Pages. Conserva el mismo
  // IndexedDB, pero no contiene ningún camino de conexión hacia las APIs.
  await page.setViewportSize({width:1440,height:900});
  const requestsBeforePreview=requests;
  await page.goto(addr+'/scada-preview/index.html',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{
    const chart=window.Chart?.getChart(document.getElementById('mainChart'));
    return chart?.data?.datasets?.length===4 &&
      document.querySelector('#powerGen')?.textContent !== '—';
  },{timeout:15000});
  assert.equal(requests,requestsBeforePreview,
    'la preview no debe llamar a Solarman ni a KSTAR');
  assert.equal(await page.locator('#updatePV').isDisabled(),true);
  assert.equal(await page.locator('#auto').count(),0,
    'la preview no debe ofrecer control automático');
  assert.match(await page.locator('body').innerText(),/SOLO LECTURA/);
  assert.match(await page.locator('#coverageSPC').innerText(),/2026-10-19/);
  await page.locator('#lastSpc').click();
  assert.equal(requests,requestsBeforePreview,'la vista previa no consulta SPC');
  for(const view of ['planta','inversores','red','historicos','diagnostico','general']){
    await page.locator('.scada-nav [data-view-link="'+view+'"]').click();
    await page.waitForFunction(v=>!document.querySelector('[data-view-panel="'+v+'"]').hidden,view);
    assert.equal(requests,requestsBeforePreview,'vista previa sin peticiones al cambiar a '+view);
  }
  await page.screenshot({path:join(root,'artifacts/scada-preview-escritorio.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(root,'artifacts/scada-preview-movil.png'),fullPage:true});
  const previewOverflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  assert.ok(previewOverflow<=3,'preview desborda ancho móvil '+previewOverflow);
  assert.deepEqual(errors,[],'sin errores JS en ninguna pantalla');
  console.log('SCADA: gráficos completos y preview SOLO LECTURA en Chromium. Ninguna consulta API al abrir. OK.');
} finally {
  await browser.close();
  await new Promise(r=>server.close(r));
}
