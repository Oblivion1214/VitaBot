const fs = require('node:fs');
const path = require('node:path');

function crearAlmacenConfiguracionJson(file, io = fs) {
    let revision = 0;
    return {
        read() {
            let text;
            try { text = io.readFileSync(file, 'utf8'); }
            catch (error) {
                if (error.code === 'ENOENT') return {};
                throw new Error('No se pudo leer la configuración de auditoría.', { cause: error });
            }
            try {
                const value = JSON.parse(text);
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Formato inválido');
                return value;
            } catch (error) {
                throw new Error('La configuración de auditoría está dañada; se conserva el archivo original.', { cause: error });
            }
        },
        write(config) {
            const temporary = `${file}.${process.pid}.${++revision}.tmp`;
            let descriptor;
            try {
                io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
                descriptor = io.openSync(temporary, 'wx', 0o600);
                io.writeFileSync(descriptor, JSON.stringify(config, null, 2), 'utf8');
                io.fsyncSync(descriptor);
                io.closeSync(descriptor); descriptor = undefined;
                io.renameSync(temporary, file);
            } catch (error) {
                throw new Error('No se pudo guardar la configuración de auditoría.', { cause: error });
            } finally {
                if (descriptor !== undefined) io.closeSync(descriptor);
                try { io.unlinkSync(temporary); } catch { /* Ya renombrado, o no llegó a crearse. */ }
            }
        },
    };
}
module.exports = { crearAlmacenConfiguracionJson };
