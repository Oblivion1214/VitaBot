const RESPUESTA_TEMA_TECNICO = 'Hmph, deja los códigos y los tutoriales de IA por un rato. ¿Te atreves con una adivinanza o prefieres hablar de anime?';
const RESPUESTA_TEMA_NO_PERMITIDO = 'Hmph… Ese tema lo dejamos. Mejor charlemos: ¿una historia o una adivinanza?';

function normalizar(texto) {
    return texto.normalize('NFKC').normalize('NFD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase();
}

function esSolicitudTecnica(texto) {
    const mensaje = normalizar(texto);
    const accion = /\b(?:program\w*|depur\w*|debug\w*|refactor\w*|implement\w*|compil\w*|arregl\w*|corrig\w*|revisa\w*|crea\w*|escrib\w*|haz\w*|dame|genera\w*|desarroll\w*|explic\w*|defin\w*|ensen\w*|ayud\w*|configur\w*|entren\w*|como|que (?:es|son)|write|fix|build|help|explain|teach|generate)\b/.test(mensaje);
    const tema = /\b(?:codigos?|programacion|programar|scripts?|algoritmos?|apis?|sql|javascript|typescript|python|java|html|css|php|rust|golang|ruby|kotlin|swift|bash|powershell|docker|ssh|programa|bots?|prompts?|chatgpt|gemini|openai|claude|llms?|ia|inteligencia artificial|machine learning|redes neuronales)\b/.test(mensaje);
    const charla = /\b(?:historia|cuento|chiste|adivinanza|pelicula|opinas|charlar|roleplay|animame|animas|consuelame|cansad\w*|agotad\w*|frustrad\w*)\b|\bprograma de (?:television|radio)\b/.test(mensaje);
    const tareaExplicita = /\b(?:codigo|scripts?|depur\w*|debug\w*|refactor\w*|implement\w*|compil\w*|prompts?|configur\w*|entren\w*)\b/.test(mensaje);
    return accion && tema && (!charla || tareaExplicita);
}

function esRespuestaTecnica(texto) {
    return /```|(?:^|\n)\s*(?:import\s+\w|from\s+\w+\s+import|(?:const|let|var)\s+\w+\s*=|def\s+\w+\s*\(|function\s+\w*\s*\(|#include\s*[<"]|<script\b)|\bconsole\.log\s*\(/m.test(texto)
        || /\b(?:primero|paso\s+\d|abre|instala|para (?:usar|configurar|entrenar))\b[\s\S]*\b(?:chatgpt|gemini|openai|llm|ia|inteligencia artificial)\b/.test(normalizar(texto));
}

module.exports = { esSolicitudTecnica, esRespuestaTecnica, RESPUESTA_TEMA_TECNICO, RESPUESTA_TEMA_NO_PERMITIDO };
