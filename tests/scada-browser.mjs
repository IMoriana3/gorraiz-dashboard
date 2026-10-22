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
let requests=0,archiveReads=0,archiveWrites=0,kstarCalls=0;
const kstarDates=[],errors=[],archive=new Map();
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
  await page.route('https://qa-kstar-scada.workers.dev/spc/intercambio',route=>{
    kstarCalls++;
    const data=route.request().postDataJSON();
    const date=data.desde;
    kstarDates.push(date);
    assert.ok(date<='2026-10-21','SPC solo día cerrado');
    assert.equal(data.desde,data.hasta,'KSTAR solo consulta un día');
    const body={rows:[
       {saveTime:date+' 10:00:00',positiveActiveElec:100,reverseActiveElec:0},
       {saveTime:date+' 10:05:00',positiveActiveElec:101,reverseActiveElec:0}],
      daily:[{date,importKWh:1,exportKWh:0,selfConsumptionKWh:15}],
      meta:{fuente:'spc',stationId:'2026032317114373',
        meterId:'210261430F3060020000661',desde:date,hasta:date,
        completo:true,actualizado:'2026-10-22T10:00:00Z',fetchedAt:'2026-10-22T10:00:00Z'}
    };
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
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
      series:chart.data.datasets.map(d=>({label:d.label,nonNull:d.data.filter(v=>v!==null).length,
        min:Math.min(...d.data.filter(v=>v!==null))})),
      labels:chart.data.labels.length}
  });
  const value=v=>Number(v.replace(/[^0-9,-]/g,'').replace(',','.'));
  const generation=value(reading.gen),consumption=value(reading.cons);
  const imported=value(reading.imp),exported=value(reading.exp);
  assert.ok(generation>0&&consumption>0,'potencias sintéticas válidas');
  assert.ok(imported>=0&&exported<=0,'importación positiva / exportación negativa en tarjetas');
  assert.ok(Math.abs(generation+imported+exported-consumption)<0.3,
    'identidad consumo = generación + importación + exportación con signo negativo');
  assert.equal(reading.series.length,4);
  assert.ok(reading.series.every(x=>x.nonNull>=60),JSON.stringify(reading));
  assert.ok(reading.series[3].min<0,'la curva amarilla de exportación debe caer bajo cero');
  assert.match(reading.series[1].label,/SIN VALIDAR/,'consumo provisional claramente etiquetado');
  assert.equal(await page.locator('#provisional').isChecked(),true,
    'solicitud del usuario: mostrar estimación provisional por defecto');
  assert.equal(reading.labels,288);
  assert.equal(await page.locator('.cards .card').count(),4,
    'solo hay cuatro indicadores de kW en la parte superior');
  assert.equal(await page.locator('#powerSelf').count(),0,
    'autoconsumo SPC diario no es una tarjeta de potencia');
  assert.match(await page.locator('#dailySelf').innerText(),/kWh/,
    'el autoconsumo de SPC debe estar con los balances diarios');
  assert.match(await page.locator('#dailyBalanceDay').innerText(),/19\/10\/2026/);
  assert.match(await page.locator('#snapshotTitle').innerText(),/19\/10\/2026.*14:20/);
  assert.match(await page.locator('#snapshotExplanation').innerText(),/misma casilla nominal/);
  assert.match(await page.locator('#snapshotIndependent').innerText(),/NO comparables/);
  const sameHour=await page.evaluate(()=>['subGen','subCons','subImp','subExp']
    .map(id=>document.getElementById(id).textContent.match(/\d\d:\d\d/)?.[0]||null));
  assert.ok(sameHour.every(t=>t==='14:20'),JSON.stringify(sameHour)+
    ': todas las tarjetas deben mostrar el mismo instante');
  assert.equal(await page.locator('#synopticTime').innerText().then(x=>x.includes('14:20')),true);
  // Son dos sinópticos visibles, cada uno con una magnitud y un alcance propios.
  assert.equal(await page.locator('.synoptic-duo > .panel').count(),2);
  assert.match(await page.locator('.synoptic-duo').innerText(),/Sinóptico de potencia · kW/);
  assert.match(await page.locator('#energyHeading').innerText(),/energía generada y balance · kWh/);
  for(const id of ['energyMatchGen','energyMatchSelf','energySelfRepeat','energyMatchLoad',
    'energyMatchImport','energyMatchExport','energySelectedPv','energyLifetimePv']){
    assert.match(await page.locator('#'+id).innerText(),/kWh/,
      'el sinóptico energético debe mostrar '+id+' en kWh');
  }
  assert.match(await page.locator('#energyScope').innerText(),/1\/1 días comparables/);
  assert.match(await page.locator('#energyComparable').innerText(),/1\/1 día/);
  assert.equal(await page.locator('.energy-equation-row').count(),2,
    'sinóptico diario separado en dos ecuaciones físicas');
  const left=await page.locator('.energy-equation-row').first().innerText();
  const right=await page.locator('.energy-equation-row').nth(1).innerText();
  assert.match(left,/FV GENERADA/);assert.match(left,/EXPORTACIÓN/);
  assert.match(left,/FV AUTOCONSUMIDA/);
  assert.match(right,/FV AUTOCONSUMIDA/);assert.match(right,/IMPORTACIÓN RED/);
  assert.match(right,/CONSUMO DERIVADO/);
  assert.equal(await page.locator('#energyMatchSelf').innerText(),
    await page.locator('#energySelfRepeat').innerText(),
    'el autoconsumo repetido es la misma cifra, no energía sumada dos veces');
  const firstEnergy=await page.locator('#energyMatchGen').innerText();

  assert.equal(await page.locator('.cards').evaluate(el=>
    getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length),4,
    'fila de cuatro tarjetas en escritorio');
  const beforeDisable={pv:await page.locator('#powerGen').innerText(),
    imp:await page.locator('#powerImp').innerText()};
  await page.locator('#provisional').uncheck();
  assert.equal(await page.locator('#energyMatchGen').innerText(),firstEnergy,
    'ocultar consumo instantáneo no cambia el acumulado energético');
  assert.equal(await page.locator('#powerCons').innerText(),'—',
    'permitir ocultar la inferencia sin tocar el resto de medidas');
  assert.equal(await page.locator('#powerGen').innerText(),beforeDisable.pv);
  assert.equal(await page.locator('#powerImp').innerText(),beforeDisable.imp);
  await page.locator('#provisional').check();
  assert.notEqual(await page.locator('#powerCons').innerText(),'—');
  assert.equal(requests,0,'cambiar el instante de representación o la estimación no consulta API');
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
  // Conectar y usar KSTAR directamente desde SCADA, sin abrir el Informe.
  assert.equal(await page.locator('#saveCentral').count(),1);
  assert.equal(await page.locator('#saveSpc').count(),1);
  await page.locator('#connections summary').click();
  const originalArchiveReads=archiveReads;
  await page.locator('#scadaSpcUrl').fill('https://qa-kstar-scada.workers.dev');
  await page.locator('#scadaSpcKey').fill('CLAVE_FICTICIA_SPC_DE_PRUEBA_2026');
  await page.locator('#saveSpc').click();
  assert.equal(requests,0,'guardar configuración SPC no consulta Solarman');
  assert.equal(kstarCalls,0,'guardar configuración SPC no consulta KSTAR');
  assert.equal(archiveReads,originalArchiveReads,'guardar configuración no lee servidor');
  await page.locator('#spcDownloadDate').fill('2026-10-18');
  await page.locator('#spcDownloadDate').dispatchEvent('change');
  await page.locator('#spcDownloadHasta').fill('2026-10-18');
  await page.locator('#spcDownloadHasta').dispatchEvent('change');
  await page.locator('#fetchSPC').click();
  await page.waitForFunction(()=>document.querySelector('#sharedState')?.textContent.includes('Descarga SPC por rango finalizada') &&
    document.querySelector('#sharedState')?.textContent.includes('SPC 2026-10-18'));
  assert.equal(kstarCalls,1,'un clic SPC provoca una sola consulta KSTAR');
  assert.equal(requests,0,'consultar SPC no consume Solarman');
  assert.equal(archive.get('S|2026-10-18')?.payload?.meta?.completo,true,
    'la descarga SPC se guardó en el archivo central');
  // Repetir un día SPC completo no recontacta al proveedor.
  await page.locator('#spcDownloadDate').fill('2026-10-18');
  await page.locator('#fetchSPC').click();
  assert.equal(kstarCalls,1,'el SPC completo no se vuelve a consultar');

  // Descarga multifecha solo SPC: los días completos 18 y 19 se omiten.
  await page.locator('#spcDownloadDate').fill('2026-10-16');
  await page.locator('#spcDownloadDate').dispatchEvent('change');
  await page.locator('#spcDownloadHasta').fill('2026-10-19');
  await page.locator('#spcDownloadHasta').dispatchEvent('change');
  await page.locator('#fetchSPC').click();
  await page.waitForFunction(()=>document.querySelector('#sharedState')?.textContent.includes('Descarga SPC por rango finalizada') &&
    document.querySelector('#sharedState')?.textContent.includes('SPC 2026-10-16'));
  assert.deepEqual(kstarDates,['2026-10-18','2026-10-16','2026-10-17'],
    'solo se consulta KSTAR de los días pendientes y uno por solicitud. Estado: '+
      await page.locator('#sharedState').innerText());
  assert.equal(kstarCalls,3);
  assert.ok(archive.has('S|2026-10-16')&&archive.has('S|2026-10-17'),
    'los días nuevos quedan en la misma base central');
  assert.equal(requests,0,'descargar SPC por rango no gasta cuota Solarman');
  await page.locator('#spcDownloadDate').fill('2026-10-01');
  await page.locator('#spcDownloadDate').dispatchEvent('change');
  await page.locator('#spcDownloadHasta').fill('2026-10-18');
  await page.locator('#spcDownloadHasta').dispatchEvent('change');
  await page.locator('#fetchSPC').click();
  await page.waitForFunction(()=>document.querySelector('#sharedState')?.textContent.includes('14 días'));
  assert.equal(kstarCalls,3,'rango SPC >14 no emite llamadas');
  assert.equal(requests,0,'rango SPC inválido no consulta Solarman');
  await page.locator('#day').fill('2026-10-19');
  await page.locator('#day').dispatchEvent('change');
  assert.equal(requests,0);

  assert.match(await page.locator('#coverageA').innerText(),/2026-10-19/);
  assert.match(await page.locator('#coverageB').innerText(),/2026-10-19/);
  assert.match(await page.locator('#coverageSPC').innerText(),/2026-10-19/);
  assert.equal(await page.locator('#lastSpc').isEnabled(),true);
  // Sin datos en otro día: explicación visible en todas las vistas afectadas.
  await page.locator('#day').fill('2026-10-21');
  await page.locator('#day').dispatchEvent('change');
  await page.waitForFunction(()=>document.querySelector('#blankState')?.hidden===false);
  assert.match(await page.locator('#blankDetail').innerText(),/No hay muestras válidas/);
  assert.match(await page.locator('#pvDayAudit').innerText(),/No constan filas originales FV/);
  assert.match(await page.locator('#coverageDayRows').textContent(),/0 \/ 0/);
  assert.match(await page.locator('#solarGapSummary').textContent(),/no existen dos casillas conjuntas/);
  assert.equal(await page.locator('#solarGapRows tr').count(),0);
  assert.equal(requests,0,'consultar el origen de huecos FV no consume Solarman');
  assert.equal(requests,0,'diagnosticar las fuentes originales no consume cuota Solarman');
  await page.locator('.scada-nav [data-view-link="red"]').click();
  await page.waitForFunction(()=>document.querySelector('#blankDetail')?.textContent.includes('No hay intervalos KSTAR'));
  assert.match(await page.locator('#blankDetail').innerText(),/No hay intervalos KSTAR/);
  await page.locator('#lastSpc').click();
  await page.waitForFunction(()=>document.querySelector('#day')?.value==='2026-10-19');
  assert.equal(await page.locator('#blankState').isVisible(),false);
  await page.waitForFunction(()=>document.querySelector('#solarGapSummary')?.textContent.includes('ventana FV'));
  assert.match(await page.locator('#solarGapSummary').textContent(),/casillas conjuntas válidas/);
  await page.locator('#dailyCoverageDetail summary').click();
  assert.equal(await page.locator('#solarGapExport').isVisible(),true);
  const download=page.waitForEvent('download');
  await page.locator('#solarGapExport').click();
  assert.match((await download).suggestedFilename(),/^gorraiz_huecos_solarman_2026-10-19\.csv$/);
  assert.equal(requests,0,'exportar CSV de huecos no contacta al proveedor Solarman');
  const views=['planta','inversores','red','cotejo','historicos','diagnostico','general'];
  const chartByView={planta:'plantChart',inversores:'inverterAChart',
    red:'redDetailChart',cotejo:'contrastChart',historicos:'historyChart',general:'mainChart'};
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
  // Contraste FV/SPC: mismas fuentes, mismo día, sin consultas de proveedores.
  await page.locator('.scada-nav [data-view-link="cotejo"]').click();
  await page.waitForFunction(()=>!!Chart.getChart(document.getElementById('contrastChart')));
  assert.match(await page.locator('#contrastInterpretation').innerText(),/Casillas FV/);
  const paired=Number((await page.locator('#contrastMatched').innerText()).split(' / ')[0]);
  assert.ok(paired>40,'más de cuarenta muestras FV/SPC sintéticas comparables');
  assert.match(await page.locator('#contrastEnergyPv').innerText(),/kWh/);
  assert.match(await page.locator('#contrastEnergyLoad').innerText(),/kWh/);
  assert.equal(await page.locator('#contrastDailyRows tr').count(),7);
  assert.equal(await page.locator('#contrastHourRows tr').count(),24);
  const comparison=await page.evaluate(()=>{
   const c=Chart.getChart(document.getElementById('contrastChart'));
   return c.data.datasets.map(d=>d.label)
  });
  assert.equal(comparison.length,4,'el usuario solicitó visualizar consumo estimado por defecto');
  assert.match(comparison[3],/NO VALIDADO/);
  assert.equal(await page.locator('#contrastLoad').isChecked(),true);
  const minExport=await page.locator('#contrastChart').evaluate(el=>{
    const chart=Chart.getChart(el);return Math.min(...chart.data.datasets[2].data.filter(v=>v!==null));
  });
  assert.ok(minExport<0,'exportación negativa en el gráfico de contraste');
  await page.locator('#contrastLoad').uncheck();
  assert.equal(await page.locator('#contrastChart').evaluate(el=>
    Chart.getChart(el).data.datasets.length),3,
    'el usuario puede ocultar consumo provisional sin perder datos');
  await page.locator('#contrastShift').evaluate(el=>{
   el.value='5';el.dispatchEvent(new Event('input',{bubbles:true}));
  });
  assert.equal(await page.locator('#contrastShiftValue').innerText(),'+5 min');
  await page.locator('#contrastLoad').check();
  assert.equal(await page.locator('#contrastChart').evaluate(
   el=>Chart.getChart(el).data.datasets.length),4);
  assert.match(await page.locator('#contrastChart').evaluate(
   el=>Chart.getChart(el).data.datasets[3].label),/NO VALIDADO/);
  await page.locator('#contrastZero').click();
  assert.equal(await page.locator('#contrastShiftValue').innerText(),'0 min');
  assert.equal(requests,0,'desfasar SPC y calcular demanda no consulta Solarman');
  assert.equal(kstarCalls,3,'desfasar SPC y calcular demanda no consulta KSTAR');
  await page.locator('.scada-nav [data-view-link="general"]').click();
  await page.locator('#seven').click();
  assert.match(await page.locator('#energyScope').innerText(),/1\/7 días comparables/,
    'el balance semanal no atribuye datos SPC a días sin fuentes');
  assert.equal(await page.locator('#energyMatchGen').innerText(),firstEnergy,
    'solo un día con balance comparable preserva su producción real');
  assert.match(await page.locator('#energyPvCoverage').innerText(),/1\/7 días/);
  await page.locator('#one').click();
  assert.match(await page.locator('#energyScope').innerText(),/1\/1 días comparables/);
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
  // La preview es una copia read-only preexistente: no tiene la pestaña nueva
  // de cotejo operativo del SCADA principal y no debe simularla.
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
