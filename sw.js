/* =============================================================================
   Service worker
   =============================================================================
   Duas estratégias diferentes, porque as necessidades são diferentes:

   - A CASCA (html, css, js, ícones) vem do cache primeiro. É o que faz a
     página abrir instantaneamente, inclusive sem rede.
   - Os DADOS vêm da rede primeiro, com o cache como reserva. Você sempre vê
     a coleta mais recente quando há conexão, e a última conhecida quando não
     há -- útil num celular com sinal ruim.

   Ao mudar arquivos da casca, suba o número da VERSAO para que os
   navegadores que já instalaram o painel busquem a versão nova.
   ========================================================================== */

const VERSAO = "v3.0.0";
const CASCA = `casca-${VERSAO}`;
const DADOS = `dados-${VERSAO}`;

const ARQUIVOS = [
  "./",
  "index.html",
  "estilo.css",
  "app.js",
  "siloms.js",
  "manifest.webmanifest",
  "icone-192.png",
  "icone-512.png",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches.open(CASCA)
      // addAll falha inteiro se um arquivo faltar; individualmente é tolerante
      .then((c) => Promise.allSettled(ARQUIVOS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes.filter((n) => n !== CASCA && n !== DADOS)
             .map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // CDN e fontes: direto

  // ---- dados: rede primeiro --------------------------------------------
  if (url.pathname.includes("/dados/")) {
    ev.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) {
            const copia = r.clone();
            caches.open(DADOS).then((c) => c.put(req, copia));
          }
          return r;
        })
        .catch(() => caches.match(req).then((c) => c || Response.error()))
    );
    return;
  }

  // ---- casca: cache primeiro, atualizando por trás ----------------------
  ev.respondWith(
    caches.match(req).then((guardado) => {
      const rede = fetch(req).then((r) => {
        if (r.ok) {
          const copia = r.clone();
          caches.open(CASCA).then((c) => c.put(req, copia));
        }
        return r;
      });
      return guardado || rede;
    }).catch(() => caches.match("index.html"))
  );
});
