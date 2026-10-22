import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SCADA_POLL_MS,SCADA_QUOTA_KEY,quotaState,reserveAttempt} from '../scada-quota.mjs';

function store() {
 const map=new Map();
 return {
  getItem:k=>map.has(k)?map.get(k):null,
  setItem:(k,v)=>{map.set(k,String(v))},
  removeItem:k=>map.delete(k),
  map
 };
}
const start=Date.parse('2026-10-22T08:00:00Z');

test('máximo una reserva por hora, sin disparar ninguna por abrir el SCADA',()=>{
 const local=store();
 assert.equal(quotaState(local,start).allowed,true);
 assert.equal(local.map.size,0);
 const one=reserveAttempt(local,start);
 assert.equal(one.allowed,true);
 assert.equal(local.getItem(SCADA_QUOTA_KEY),String(start));
 assert.equal(reserveAttempt(local,start+1).allowed,false);
 assert.equal(quotaState(local,start+SCADA_POLL_MS-1).remainingMs,1);
 assert.equal(reserveAttempt(local,start+SCADA_POLL_MS).allowed,true);
});

test('las peticiones manuales y automáticas comparten el mismo cupo de navegador',()=>{
 const sameStorage=store();
 assert.equal(reserveAttempt(sameStorage,start).allowed,true); // manual
 assert.equal(reserveAttempt(sameStorage,start+300000).allowed,false); // auto
 assert.equal(reserveAttempt(sameStorage,start+3500000).allowed,false);
 assert.equal(reserveAttempt(sameStorage,start+3600000).allowed,true);
});

test('una reserva fallida de red cuenta: no repetir inmediatamente',()=>{
 const local=store();
 const reservation=reserveAttempt(local,start);
 assert.equal(reservation.allowed,true);
 // La reserva se hace ANTES de fetch; si falla la red, ya ha consumido intento.
 assert.equal(local.getItem(SCADA_QUOTA_KEY),String(start));
 assert.equal(reserveAttempt(local,start+5000).allowed,false);
});

test('un error de localStorage bloquea peticiones al proveedor (fail closed)',()=>{
 const broken={getItem(){throw Error('almacén deshabilitado')},setItem(){throw Error('no write')}};
 assert.equal(quotaState(broken,start).allowed,false);
 assert.equal(reserveAttempt(broken,start).allowed,false);
 const cannotWrite={getItem:()=>null,setItem:()=>{throw Error('quota exceeded')}};
 assert.equal(reserveAttempt(cannotWrite,start).allowed,false);
});
test('registro corrupto no provoca una ráfaga de llamadas',()=>{
 const local=store();local.setItem(SCADA_QUOTA_KEY,'not-a-timestamp');
 const result=reserveAttempt(local,start);
 assert.equal(result.allowed,false);assert.match(result.error,/ilegible/);
});

test('un retroceso de reloj no invalida el cupo',()=>{
 const local=store();reserveAttempt(local,start);
 assert.equal(reserveAttempt(local,start-3600000).allowed,false);
});

test('SCADA opt-in horario: no hay auto-fetch al abrir ni cron KSTAR',()=>{
 const html=readFileSync(new URL('../scada.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../scada-app.mjs',import.meta.url),'utf8');
 assert.match(html,/Automático FV \/ 60 min/);
 assert.match(app,/autoTimer=setInterval\(\(\)=>refreshPV\(\{auto:true\}\),SCADA_POLL_MS\)/);
 assert.match(app,/reserveHourlyUpdate\(\{auto\}\)/);
 assert.doesNotMatch(app,/setInterval\(\(\)=>refreshPV\(\{auto:true\}\),300000\)/);
 assert.doesNotMatch(app,/\/spc\/intercambio/);
 assert.doesNotMatch(app,/await refreshPV\(/); // init only reload()
});
