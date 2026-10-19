// Los controles siguen el acceso local o Tailscale usado para abrir Homepage.
(() => {
  const permitidos = new Set(['192.168.1.250', '100.98.90.80']);
  const adaptar = () => {
    if (!permitidos.has(window.location.hostname)) return;
    document.querySelectorAll('a[href]').forEach((enlace) => {
      try {
        const destino = new URL(enlace.href);
        if (destino.port === '8788' && permitidos.has(destino.hostname)
            && destino.pathname.startsWith('/control/')
            && destino.hostname !== window.location.hostname) {
          destino.hostname = window.location.hostname;
          enlace.href = destino.href;
        }
      } catch { /* Un enlace ajeno a los controles queda intacto. */ }
    });
  };
  adaptar();
  new MutationObserver(adaptar).observe(document.documentElement, { childList: true, subtree: true });
})();
