class ErrorServicioOcupado extends Error {
    constructor() { super('Servicio ocupado. Intenta de nuevo en un momento.'); this.name = 'ErrorServicioOcupado'; }
}
function crearPoliticaSolicitudes({ concurrent = 2, queued = 4, waitMs = 5000, perMinute = 6, maxScopes = 500,
    globalPerMinute = 30,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
    let active = 0;
    const queue = [], windows = new Map();
    let globalWindow = { count: 0, until: 0 };
    function charge(scope) {
        const time = now();
        if (globalWindow.until <= time) globalWindow = { count: 0, until: time + 60_000 };
        if (globalWindow.count >= globalPerMinute) throw new ErrorServicioOcupado();
        for (const [key, entry] of windows) if (entry.until <= time) windows.delete(key);
        let entry = windows.get(scope);
        if (!entry) {
            if (windows.size >= maxScopes) throw new ErrorServicioOcupado();
            windows.set(scope, entry = { count: 0, until: time + 60_000 });
        }
        if (entry.count >= perMinute) throw new ErrorServicioOcupado();
        entry.count++; globalWindow.count++;
    }
    function start(job) {
        active++; if (job.timer) cancel(job.timer);
        const release = () => {
            active--; const next = queue.shift(); if (next) start(next);
        };
        Promise.resolve().then(job.work).then(value => { release(); job.resolve(value); }, error => { release(); job.reject(error); });
    }
    return {
        run(scope, work) {
            if (active >= concurrent && queue.length >= queued) return Promise.reject(new ErrorServicioOcupado());
            try { charge(scope); } catch (error) { return Promise.reject(error); }
            return new Promise((resolve, reject) => {
                const job = { work, resolve, reject };
                if (active < concurrent) return start(job);
                job.timer = schedule(() => {
                    const index = queue.indexOf(job);
                    if (index >= 0) { queue.splice(index, 1); reject(new ErrorServicioOcupado()); }
                }, waitMs);
                queue.push(job);
            });
        },
        stats() { return { active, queued: queue.length, scopes: windows.size }; },
    };
}
module.exports = { crearPoliticaSolicitudes, ErrorServicioOcupado };
