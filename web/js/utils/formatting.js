// ==================== ФОРМАТИРОВАНИЕ ВРЕМЕНИ ====================

/** Форматирование времени в формате HH:MM:SS из миллисекунд */
export function formatTimeHHMMSS(ms, useUTC = false) {
    const d = new Date(ms);
    const h = useUTC ? d.getUTCHours() : d.getHours();
    const m = useUTC ? d.getUTCMinutes() : d.getMinutes();
    const s = useUTC ? d.getUTCSeconds() : d.getSeconds();
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}
