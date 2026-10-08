/* =============================================================================
   Service worker
   =============================================================================
   REDE PRIMEIRO, cache como reserva -- para tudo.

   A primeira versão deste arquivo servia o código (html, css, js) do cache
   primeiro, para a página abrir instantaneamente. O efeito colateral só
   apareceu na prática: depois de uma correção publicada, o navegador
   continuava rodando a versão antiga, e a correção simplesmente não chegava.
   Foi o que aconteceu com a limpeza de itens repetidos -- o arquivo certo
   estava no servidor, e a planilha continuava saindo dobrada.

   Num projeto em construção isso é inaceitável, e a troca custa pouco: o
   site inteiro tem menos de 100 KB atrás de uma CDN, então buscar da rede é
   questão de milissegundos. O cache continua existindo e continua salvando
   a página quando não há conexão -- ele só deixou de ter a última palavra.
   ========================================================================== */

const VERSAO = "v3.6.0";
const CACHE = `painel-${VERSAO}`;

const ARQUIVOS = [
  "./",
  "index.html",
  "atas.html",
  "atas.js",
  "ata.js",
  "ata-modelo.js",
  "credito.html",
  "credito.js",
  "estilo.css",
  "app.js",
  "siloms.js",
  "manifest.webmanifest",
  "icone-192.png",
  "icone-512.png",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      // addAll falha inteiro se um arquivo faltar; individualmente é tolerante
      .then((c) => Promise.allSettled(ARQUIVOS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // CDN e fontes: direto

  ev.respondWith(
    fetch(req)
      .then((r) => {
        if (r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return r;
      })
      .catch(async () => {
        const guardado = await caches.match(req);
        if (guardado) return guardado;
        // navegação sem rede e sem cópia da rota: devolve a página inicial
        if (req.mode === "navigate") {
          const inicial = await caches.match("index.html");
          if (inicial) return inicial;
        }
        return Response.error();
      })
  );
});

/* Permite que a página peça a troca imediata, sem esperar outro carregamento. */
self.addEventListener("message", (ev) => {
  if (ev.data === "atualizar-agora") self.skipWaiting();
});
