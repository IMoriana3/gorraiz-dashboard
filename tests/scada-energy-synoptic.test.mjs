import test from 'node:test';
import assert from 'node:assert/strict';
import {energySynoptic} from '../scada-energy-synoptic.mjs';
const on='2026-10-21';
const today='2026-10-22';
const addDays=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const inverter=(type,date,daily,accum,time='18:00')=>({
 tipo:type,unidadPotencia:'kW',
 rows:[{ts:date+'T10:00:00+02:00',pot:20,dia:daily*0.2,acum:accum-daily*.8},
 {ts:date+'T'+time+':00+02:00',pot:0,dia:daily,acum:accum}]
});
function grid(date,imp,exp,{complete=true,self=40}={}){
 const rows=[];
 for(let i=0;i<288;i++){
  const minutes=i*5,hr=String(Math.floor(minutes/60)).padStart(2,'0'),
    min=String(minutes%60).padStart(2,'0');
  rows.push({saveTime:date+' '+hr+':'+min+':00',
    positiveActiveElec:1000+(imp*i/287),
    reverseActiveElec:250+(exp*i/287)});
 }
 return {tipo:'S',fecha:date,payload:{date,rows,daily:[
  {date,importKWh:imp,exportKWh:exp,selfConsumptionKWh:self}],
  meta:{completo:complete,medidoresEstacion:1,
    timezoneVerified:false,fuente:'spc',desde:date,hasta:date}}};
}
const row=(date,{pvA=80,pvB=70,imp=90,exp=20,closed=true,self=126}={})=>[
 inverter('A',date,pvA,4000+pvA),inverter('B',date,pvB,3000+pvB),
 grid(date,imp,exp,{complete:closed,self})];
test('dos sinópticos no mezclan kW y kWh: jornada cerrada y balance',()=>{
 const result=energySynoptic(row(on),{date:on,today,range:1});
 assert.equal(result.days,1);
 assert.equal(result.generatedInPeriod,150);
 assert.equal(result.generatedDays,1);
 assert.equal(result.gridDays,1);
 assert.equal(result.comparableDays,1);
 assert.deepEqual(Object.values(result.matched).slice(0,5),[150,90,20,220,130]);
 assert.equal(result.matched.spcDeclaredSelf,126);
 assert.equal(result.productionAccumulated.kwh,7150);
 assert.equal(result.productionAccumulated.day,on);
 assert.match(result.explanation,/datos FV y SPC|Balance de 1\/1/);
});
test('siete días con red en dos: el balance usa solo esos dos, FV periodo se conserva separada',()=>{
 const start='2026-10-15';
 const days=Array.from({length:7},(_,i)=>addDays(start,i));
 const items=[];
 days.forEach((d,i)=>{
  items.push(inverter('A',d,40,4000+i*40));
  items.push(inverter('B',d,30,3000+i*30));
  if(i===2||i===6)items.push(grid(d,10,5,{self:65}));
 });
 const r=energySynoptic(items,{date:on,range:7,today});
 assert.equal(r.days,7);
 assert.equal(r.generatedDays,7);
 assert.equal(r.generatedInPeriod,490);
 assert.equal(r.gridDays,2);
 assert.equal(r.comparableDays,2);
 assert.equal(r.matched.generation,140);
 assert.equal(r.matched.import,20);
 assert.equal(r.matched.export,10);
 assert.equal(r.matched.load,150);
 assert.equal(r.matched.self,130);
 assert.match(r.explanation,/NO se mezcla con red de menos días/);
});
test('SPC parcial y día en curso nunca se contabilizan como balance cerrado',()=>{
 const d='2026-10-22';
 const items=[
   ...row('2026-10-21',{imp:20,exp:10,closed:false}),
   ...row(d,{imp:20,exp:10,closed:true})
 ];
 const r=energySynoptic(items,{date:d,range:7,today:d});
 assert.equal(r.generatedDays,2);
 assert.equal(r.gridDays,0);
 assert.equal(r.comparableDays,0);
 assert.equal(r.openDays,1);
 assert.equal(r.matched.load,null);
 assert.equal(r.generatedInPeriod,300);
 assert.match(r.explanation,/No hay ningún día/);
});
test('no se inventa energía derivada si falta B o falta SPC',()=>{
 const d=on,items=[inverter('A',d,40,4040),grid(d,20,0)];
 const result=energySynoptic(items,{date:d,today});
 assert.equal(result.generatedInPeriod,null);
 assert.equal(result.gridDays,1);
 assert.equal(result.comparableDays,0);
 assert.equal(result.matched.load,null);
});
test('excluye día con exportación superior a FV reportada; evita consumo imposible',()=>{
 const r=energySynoptic(row(on,{pvA:10,pvB:5,imp:30,exp:40}),{date:on,today});
 assert.equal(r.comparableDays,0);
 assert.equal(r.excludedDayCount,1);
 assert.match(r.issues[0],/exportación supera/);
 assert.equal(r.generatedInPeriod,15);
});
test('acumulado histórico requiere dos inversores en el mismo día y <=30min',()=>{
 const r=energySynoptic([
  inverter('A',on,40,4500,'18:00'),
  inverter('B',on,30,3500,'17:25'),
  grid(on,10,0)
 ],{date:on,today});
 assert.equal(r.matched.load,80,'balance del día correcto aunque no haya acumulados comparables');
 assert.equal(r.productionAccumulated.kwh,null,
   'no sumar los últimos acumulados A y B de tiempos incompatibles');
});
