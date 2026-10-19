const fs = require('node:fs');
const path = require('node:path');
function shift(file, copies) {
    for (let index = copies; index >= 1; index--) {
        const target = `${file}.${index}`;
        if (fs.existsSync(target)) fs.unlinkSync(target);
        const previous = index === 1 ? file : `${file}.${index - 1}`;
        if (fs.existsSync(previous)) fs.renameSync(previous, target);
    }
}
function agregarRegistro(file, value, { limit = 1024 * 1024, copies = 2 } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const chunk = Buffer.from(value).subarray(0, Math.min(limit, 16384));
    if (fs.existsSync(file) && fs.statSync(file).size + chunk.length > limit) shift(file, copies);
    fs.appendFileSync(file, chunk, { mode: 0o600 });
}
function rotarRegistroActivo(file, { limit = 2 * 1024 * 1024, copies = 2 } = {}) {
    if (!fs.existsSync(file) || fs.statSync(file).size <= limit) return false;
    // Keep the descriptor used by PM2. Archive the latest bounded tail before truncating.
    const source = fs.openSync(file, 'r'); let tail;
    try {
        const size = fs.fstatSync(source).size; tail = Buffer.alloc(Math.min(limit, size));
        fs.readSync(source, tail, 0, tail.length, Math.max(0, size - tail.length));
    } finally { fs.closeSync(source); }
    const archive = `${file}.history`;
    if (fs.existsSync(archive)) shift(archive, copies - 1);
    fs.writeFileSync(archive, tail, { mode: 0o600 });
    fs.truncateSync(file, 0);
    return true;
}
module.exports = { agregarRegistro, rotarRegistroActivo };
