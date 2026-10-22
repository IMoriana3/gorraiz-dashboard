// Control de frecuencia del SCADA. No consulta APIs ni utiliza credenciales.
// Reserva por intento, también si la petición posterior falla, para evitar
// múltiples accesos a Solarman en caso de problemas de red o autenticación.
// Este límite es por origen/perfil del navegador; NO es una cuota global.
export const SCADA_POLL_MS = 60 * 60 * 1000;
export const SCADA_QUOTA_KEY = 'gorraiz_scada_solarman_ultimo_intento_v1';
export const SCADA_LOCK_NAME = 'gorraiz_scada_solarman_solicitud_v1';

export function quotaState(storage, now = Date.now()) {
  try {
    const raw = storage.getItem(SCADA_QUOTA_KEY);
    if (raw === null) return {allowed:true, remainingMs:0, nextAt:null};
    const attempted = Number(raw);
    if (!Number.isFinite(attempted) || attempted <= 0) {
      return {allowed:false, remainingMs:null, nextAt:null, error:'Registro horario ilegible; bloqueado por seguridad'};
    }
    if (!Number.isFinite(now)) {
      return {allowed:false, remainingMs:null, nextAt:null, error:'Reloj no disponible'};
    }
    const nextAt = attempted + SCADA_POLL_MS;
    const remainingMs = Math.max(0, nextAt - now);
    return {allowed:remainingMs===0, remainingMs, nextAt};
  } catch {
    return {allowed:false, remainingMs:null, nextAt:null, error:'No se puede leer el control de cuota local'};
  }
}

export function reserveAttempt(storage, now = Date.now()) {
  const current = quotaState(storage, now);
  if (!current.allowed) return current;
  try {
    storage.setItem(SCADA_QUOTA_KEY, String(now));
    const saved = storage.getItem(SCADA_QUOTA_KEY);
    if (saved !== String(now)) throw new Error('No se ha podido confirmar la reserva');
    return {allowed:true, reservedAt:now, remainingMs:0, nextAt:now + SCADA_POLL_MS};
  } catch {
    // Ante un fallo de almacenamiento no se intenta consultar el proveedor.
    return {allowed:false, remainingMs:null, nextAt:null, error:'No se ha podido reservar la cuota local'};
  }
}
