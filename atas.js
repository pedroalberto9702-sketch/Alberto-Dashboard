/* =============================================================================
   Página de Atas de Registro de Preços
   =============================================================================
   Lista apenas os pregões por registro de preços (SRP) que já têm resultado,
   porque só esses geram ata. Cada certame abre numa lista dos fornecedores
   que venceram itens, e cada fornecedor vira uma ata.

   O que você digita -- número do DOU, data do DOU e número de cada ata --
   fica guardado no seu navegador (localStorage). Não sobe para o
   repositório nem para servidor nenhum: é informação interna da seção, e
   nenhuma base pública a possui.

   Consequência honesta disso: o que você digitar aqui existe neste
   computador e neste navegador. Em outra máquina, os campos aparecem
   vazios.
   ========================================================================== */

(function () {
  "use strict";

  const VERSAO = "3.3.0";
  const UASG_PADRAO = "120641";

  const moeda = new Intl.NumberFormat("pt-BR", {
    style: "currency", currency: "BRL",
  });
  const moedaCurta = new Intl.NumberFormat("pt-BR", {
    style: "currency", currency: "BRL",
    notation: "compact", maximumFractionDigits: 1,
  });
  const inteiro = new Intl.NumberFormat("pt-BR");

  const $ = (s) => document.querySelector(s);

  const el = {
    estado: $("#estado"), painel: $("#painel"),
    unidade: $("#unidade-nome"),
    uasg: $("#campo-uasg"), ano: $("#campo-ano"),
    form: $("#form-unidade"), recarregar: $("#botao-recarregar"),
    rCertames: $("#r-certames"), rFornecedores: $("#r-fornecedores"),
    rValor: $("#r-valor"), rNumeradas: $("#r-numeradas"),
    procura: $("#campo-procura"),
    lista: $("#lista"), vazio: $("#vazio"),
    recado: $("#recado"),
    rodapeVersao: $("#rodape-versao"), rodapeColeta: $("#rodape-coleta"),
  };

  const estado = {
    dados: null,          // certames.json
    srp: [],              // só os SRP com resultado
    detalhes: new Map(),  // idCompra -> { fornecedores: [...] }
    abertos: new Set(),
    procura: "",
  };

  /* ========================================================================
     o que você digita
     ===================================================================== */

  function chave() {
    return `atas:${estado.dados.uasg}:${estado.dados.ano}`;
  }

  function lerAnotacoes() {
    try {
      return JSON.parse(localStorage.getItem(chave()) || "{}");
    } catch (e) {
      return {};
    }
  }

  function anotacao(idCertame) {
    const tudo = lerAnotacoes();
    return tudo[idCertame] || { douNum: "", douData: "", atas: {} };
  }

  function anotar(idCertame, mudanca) {
    const tudo = lerAnotacoes();
    const atual = tudo[idCertame] || { douNum: "", douData: "", atas: {} };
    tudo[idCertame] = { ...atual, ...mudanca,
                        atas: { ...atual.atas, ...(mudanca.atas || {}) } };
    try {
      localStorage.setItem(chave(), JSON.stringify(tudo));
    } catch (e) {
      recado("Não consegui guardar o que você digitou neste navegador.", true);
    }
    return tudo[idCertame];
  }

  /* ========================================================================
     utilidades
     ===================================================================== */

  function recado(msg, erro) {
    el.recado.textContent = msg;
    el.recado.hidden = false;
    el.recado.style.background = erro ? "var(--fx-tinta)" : "var(--tinta)";
    clearTimeout(recado._t);
    recado._t = setTimeout(() => { el.recado.hidden = true; }, 6500);
  }

  function quandoBR(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 10);
    return d.toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function mostrarEstado(msg, dica, erro) {
    el.estado.hidden = false;
    el.estado.className = "estado" + (erro ? " estado--erro" : "");
    el.estado.innerHTML = "";
    const p = document.createElement("p");
    p.className = "estado__texto";
    p.textContent = msg;
    el.estado.appendChild(p);
    if (dica) {
      const d = document.createElement("p");
      d.className = "estado__dica";
      d.textContent = dica;
      el.estado.appendChild(d);
    }
    el.painel.hidden = true;
  }

  async function buscarJson(caminho, forcar) {
    const url = forcar ? `${caminho}?t=${Date.now()}` : caminho;
    const r = await fetch(url, { cache: forcar ? "reload" : "no-cache" });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }

  /* ========================================================================
     carregamento
     ===================================================================== */

  function lerEndereco() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    const uasg = (h.get("uasg") || localStorage.getItem("uasg") ||
                  UASG_PADRAO).replace(/\D/g, "");
    return { uasg, ano: parseInt(h.get("ano"), 10) || null };
  }

  async function iniciar() {
    const { uasg, ano } = lerEndereco();
    el.uasg.value = uasg;
    let geral = null;
    try { geral = await buscarJson("dados/indice.json"); } catch (e) { /* sem menu */ }
    estado.geral = geral;
    await carregar(uasg, ano, false);
  }

  function preencherAnos(uasg, selecionado) {
    const u = (estado.geral?.unidades || [])
      .find((x) => String(x.uasg) === String(uasg));
    const lista = (u?.anos || []).map((a) => a.ano);
    const atual = new Date().getFullYear();
    if (!lista.includes(atual)) lista.unshift(atual);
    el.ano.innerHTML = "";
    for (const a of [...new Set(lista)].sort((x, y) => y - x)) {
      const o = document.createElement("option");
      o.value = a; o.textContent = a;
      if (String(a) === String(selecionado)) o.selected = true;
      el.ano.appendChild(o);
    }
  }

  async function carregar(uasg, ano, forcar) {
    ano = ano || parseInt(el.ano.value, 10) || new Date().getFullYear();
    preencherAnos(uasg, ano);
    mostrarEstado("Carregando…");
    el.recarregar.querySelector(".icone").classList.add("girando");
    el.recarregar.disabled = true;

    try {
      const d = await buscarJson(`dados/${uasg}/${ano}/certames.json`, forcar);
      d.uasg = String(uasg); d.ano = ano;
      estado.dados = d;
      estado.detalhes.clear();
      estado.abertos.clear();

      // só SRP, e só os que já têm resultado: antes disso não há o que registrar
      estado.srp = (d.certames || []).filter(
        (c) => c.srp && (c.tem_resultado || c.qtd_com_vencedor > 0));

      history.replaceState(null, "", `#uasg=${uasg}&ano=${ano}`);
      try { localStorage.setItem("uasg", uasg); } catch (e) { /* modo privado */ }
      render();
      precarregarDetalhes(d);
    } catch (e) {
      if (e.status === 404) {
        mostrarEstado(
          `Não há dados coletados para a UASG ${uasg} no ano ${ano}.`,
          "Rode a coleta na aba Actions do repositório.", true);
      } else {
        mostrarEstado("Não foi possível ler os dados publicados.",
                      `Detalhe técnico: ${e.message}`, true);
      }
    } finally {
      el.recarregar.querySelector(".icone").classList.remove("girando");
      el.recarregar.disabled = false;
    }
  }

  /* ========================================================================
     desenho
     ===================================================================== */

  /**
   * Lê em segundo plano o detalhe de cada pregão. São arquivos pequenos; assim
   * o total de fornecedores e a busca por nome funcionam sem abrir cada seta.
   * Se a UASG/ano mudar no meio do caminho, a rodada antiga para.
   */
  async function precarregarDetalhes(d) {
    for (const c of estado.srp) {
      if (estado.dados !== d) return;
      if (estado.detalhes.has(c.id)) continue;
      try {
        const det = await buscarJson(
          `dados/${d.uasg}/${d.ano}/certame/${c.arquivo}.json`);
        if (estado.dados !== d) return;
        if (!estado.detalhes.has(c.id)) {
          estado.detalhes.set(c.id, {
            detalhe: det, fornecedores: window.ATA.vencedores(det) });
        }
      } catch (e) { /* o erro aparece ao abrir a seta daquele pregão */ }
    }
    if (estado.dados === d) atualizarResumo();
  }

  function render() {
    const d = estado.dados;
    el.estado.hidden = true;
    el.painel.hidden = false;
    el.unidade.textContent = `UASG ${d.uasg} · exercício ${d.ano}`;
    el.rodapeColeta.textContent = `coleta de ${quandoBR(d.atualizado)}`;
    desenharLista();
  }

  function filtrados() {
    const t = estado.procura.trim().toLowerCase();
    if (!t) return estado.srp;
    return estado.srp.filter((c) => {
      if ([c.titulo, c.numero, c.objeto, c.processo]
          .some((v) => String(v || "").toLowerCase().includes(t))) return true;
      const det = estado.detalhes.get(c.id);
      return det && det.fornecedores.some(
        (f) => f.nome.toLowerCase().includes(t) || f.ni.includes(t.replace(/\D/g, "")));
    });
  }

  function desenharLista() {
    const lista = filtrados();
    el.lista.innerHTML = "";

    if (!estado.srp.length) {
      el.vazio.hidden = false;
      el.vazio.textContent =
        "Nenhum pregão por registro de preços com resultado publicado neste ano.";
      atualizarResumo();
      return;
    }
    el.vazio.hidden = lista.length > 0;
    if (!lista.length) el.vazio.textContent = "Nenhum certame corresponde ao filtro.";

    for (const c of lista) el.lista.appendChild(painelCertame(c));
    atualizarResumo();
  }

  function atualizarResumo() {
    let fornecedores = 0, valor = 0, numeradas = 0;
    for (const c of estado.srp) {
      const det = estado.detalhes.get(c.id);
      const an = anotacao(c.id);
      if (det) {
        fornecedores += det.fornecedores.length;
        valor += det.fornecedores.reduce((s, f) => s + f.total, 0);
        numeradas += det.fornecedores.filter((f) => (an.atas || {})[f.ni]).length;
      } else {
        valor += c.valor_resultado || 0;
        numeradas += Object.values(an.atas || {}).filter(Boolean).length;
      }
    }
    el.rCertames.textContent = inteiro.format(estado.srp.length);
    el.rFornecedores.textContent = fornecedores
      ? inteiro.format(fornecedores) : "—";
    el.rValor.textContent = moedaCurta.format(valor);
    el.rValor.title = moeda.format(valor);
    el.rNumeradas.textContent = inteiro.format(numeradas);
  }

  /* ---- um certame ---- */

  function painelCertame(c) {
    const an = anotacao(c.id);
    const caixa = document.createElement("article");
    caixa.className = "ata";
    caixa.dataset.id = c.id;

    /* --- cabeçalho --- */
    const topo = document.createElement("div");
    topo.className = "ata__topo";

    const seta = document.createElement("button");
    seta.type = "button";
    seta.className = "ata__seta";
    seta.setAttribute("aria-expanded", estado.abertos.has(c.id));
    seta.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" class="icone">' +
      '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    seta.setAttribute("aria-label", `Ver fornecedores de ${c.titulo}`);
    seta.addEventListener("click", () => alternar(c, caixa, seta));

    const ident = document.createElement("div");
    ident.className = "ata__ident";
    const h = document.createElement("h2");
    h.className = "ata__titulo";
    h.textContent = c.titulo;
    const obj = document.createElement("p");
    obj.className = "ata__objeto";
    obj.textContent = c.objeto || "—";
    const meta = document.createElement("p");
    meta.className = "ata__meta";
    const bits = [];
    if (c.processo) bits.push(`proc. ${c.processo}`);
    if (c.qtd_itens) bits.push(`${c.qtd_itens} itens`);
    if (c.valor_resultado) bits.push(moeda.format(c.valor_resultado));
    meta.textContent = bits.join("  ·  ");
    ident.append(h, obj, meta);

    topo.append(seta, ident);
    caixa.appendChild(topo);

    /* --- linha do DOU + gerar todas --- */
    const barra = document.createElement("div");
    barra.className = "ata__barra";

    const campoNum = campo("DOU nº", "text", an.douNum, (v) => {
      anotar(c.id, { douNum: v.trim() });
      revalidar(caixa, c);
    });
    campoNum.querySelector("input").inputMode = "numeric";
    campoNum.querySelector("input").style.width = "78px";

    const campoData = campo("Data do DOU", "date", an.douData, (v) => {
      anotar(c.id, { douData: v });
      revalidar(caixa, c);
    });

    const todas = document.createElement("button");
    todas.type = "button";
    todas.className = "botao botao--primario ata__todas";
    todas.textContent = "Gerar todas";
    todas.addEventListener("click", () => gerarTodas(c, caixa, todas));

    const aviso = document.createElement("span");
    aviso.className = "ata__aviso";

    barra.append(campoNum, campoData, aviso, todas);
    caixa.appendChild(barra);

    /* --- corpo (fornecedores) --- */
    const corpo = document.createElement("div");
    corpo.className = "ata__corpo";
    corpo.hidden = !estado.abertos.has(c.id);
    caixa.appendChild(corpo);

    if (estado.abertos.has(c.id)) desenharFornecedores(c, caixa);
    revalidar(caixa, c);
    return caixa;
  }

  function campo(rotulo, tipo, valor, aoMudar) {
    const l = document.createElement("label");
    l.className = "campo";
    const s = document.createElement("span");
    s.textContent = rotulo;
    const i = document.createElement("input");
    i.type = tipo;
    i.value = valor || "";
    i.addEventListener("input", () => aoMudar(i.value));
    l.append(s, i);
    return l;
  }

  /* ---- expandir ---- */

  async function alternar(c, caixa, seta) {
    const abrindo = !estado.abertos.has(c.id);
    if (abrindo) estado.abertos.add(c.id); else estado.abertos.delete(c.id);
    seta.setAttribute("aria-expanded", abrindo);
    const corpo = caixa.querySelector(".ata__corpo");
    corpo.hidden = !abrindo;
    if (!abrindo) return;

    if (!estado.detalhes.has(c.id)) {
      corpo.innerHTML = '<p class="ata__carregando">Carregando fornecedores…</p>';
      try {
        const det = await buscarJson(
          `dados/${estado.dados.uasg}/${estado.dados.ano}/certame/${c.arquivo}.json`);
        estado.detalhes.set(c.id, {
          detalhe: det,
          fornecedores: window.ATA.vencedores(det),
        });
      } catch (e) {
        corpo.innerHTML = "";
        const p = document.createElement("p");
        p.className = "ata__carregando";
        p.textContent = e.status === 404
          ? "Este certame ainda não tem detalhe coletado."
          : `Não foi possível ler o detalhe: ${e.message}`;
        corpo.appendChild(p);
        return;
      }
    }
    desenharFornecedores(c, caixa);
    revalidar(caixa, c);
    atualizarResumo();
  }

  function desenharFornecedores(c, caixa) {
    const corpo = caixa.querySelector(".ata__corpo");
    const info = estado.detalhes.get(c.id);
    corpo.innerHTML = "";
    if (!info) return;

    if (!info.fornecedores.length) {
      const p = document.createElement("p");
      p.className = "ata__carregando";
      p.textContent = "Nenhum fornecedor venceu itens neste certame.";
      corpo.appendChild(p);
      return;
    }

    const an = anotacao(c.id);
    for (const f of info.fornecedores) {
      corpo.appendChild(linhaFornecedor(c, f, an, caixa));
    }
  }

  function linhaFornecedor(c, f, an, caixa) {
    const linha = document.createElement("div");
    linha.className = "forn";
    linha.dataset.ni = f.ni;

    const ident = document.createElement("div");
    ident.className = "forn__ident";
    const nome = document.createElement("span");
    nome.className = "forn__nome";
    nome.textContent = f.nome || "—";
    const doc = document.createElement("span");
    doc.className = "forn__doc";
    doc.textContent = window.ATA.documento(f.ni);
    ident.append(nome, doc);

    const nums = document.createElement("div");
    nums.className = "forn__nums";
    const qi = document.createElement("span");
    qi.className = "numero";
    qi.textContent = `${inteiro.format(f.itens.length)} ${f.itens.length === 1 ? "item" : "itens"}`;
    const vl = document.createElement("span");
    vl.className = "numero";
    vl.textContent = moeda.format(f.total);
    nums.append(qi, vl);

    const campoAta = campo("Ata nº", "text", (an.atas || {})[f.ni] || "", (v) => {
      anotar(c.id, { atas: { [f.ni]: v.trim() } });
      revalidar(caixa, c);
      atualizarResumo();
    });
    campoAta.classList.add("forn__ata");
    campoAta.querySelector("input").placeholder = "334/2025";

    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "botao forn__gerar";
    botao.textContent = "Gerar ATA";
    botao.addEventListener("click", () => gerarUma(c, f, botao));

    linha.append(ident, nums, campoAta, botao);
    return linha;
  }

  /* ========================================================================
     o que libera o download
     ===================================================================== */

  function pendencias(c, f) {
    const an = anotacao(c.id);
    const falta = [];
    if (!an.douNum) falta.push("nº do DOU");
    if (!an.douData) falta.push("data do DOU");
    if (f && !(an.atas || {})[f.ni]) falta.push("nº da ata");
    return falta;
  }

  function revalidar(caixa, c) {
    const an = anotacao(c.id);
    const info = estado.detalhes.get(c.id);
    const douOk = !!(an.douNum && an.douData);

    for (const linha of caixa.querySelectorAll(".forn")) {
      const ni = linha.dataset.ni;
      const pronto = douOk && !!(an.atas || {})[ni];
      const b = linha.querySelector(".forn__gerar");
      b.disabled = !pronto;
      b.title = pronto ? "" : "Falta " + pendencias(c, { ni }).join(" e ");
    }

    const todas = caixa.querySelector(".ata__todas");
    const aviso = caixa.querySelector(".ata__aviso");
    if (!info) {
      todas.disabled = true;
      todas.textContent = "Gerar todas";
      aviso.textContent = douOk ? "Abra para ver os fornecedores"
                                : "Informe o DOU deste pregão";
      return;
    }
    const semNumero = info.fornecedores.filter((f) => !(an.atas || {})[f.ni]);
    const pronto = douOk && semNumero.length === 0 && info.fornecedores.length > 0;
    todas.disabled = !pronto;
    todas.textContent = `Gerar todas (${info.fornecedores.length})`;
    if (pronto) {
      aviso.textContent = "";
    } else if (!douOk) {
      aviso.textContent = "Informe o DOU deste pregão";
    } else {
      aviso.textContent = `Falta numerar ${semNumero.length} ata` +
                          (semNumero.length > 1 ? "s" : "");
    }
  }

  /* ========================================================================
     geração
     ===================================================================== */

  function montarDados(c, f) {
    const an = anotacao(c.id);
    return {
      certame: c,
      fornecedor: f,
      numeroAta: (an.atas || {})[f.ni] || "",
      douNum: an.douNum,
      douData: an.douData,
    };
  }

  function gerarUma(c, f, botao) {
    const antes = botao.textContent;
    botao.disabled = true;
    botao.textContent = "Gerando…";
    try {
      const nome = window.ATA.gerar(montarDados(c, f));
      recado(`${nome} — ${f.itens.length} item(ns), ${moeda.format(f.total)}`);
    } catch (e) {
      recado(e.message || "Não foi possível gerar a ata.", true);
    } finally {
      botao.disabled = false;
      botao.textContent = antes;
    }
  }

  async function gerarTodas(c, caixa, botao) {
    const info = estado.detalhes.get(c.id);
    if (!info) return;
    const antes = botao.textContent;
    botao.disabled = true;
    try {
      const lista = info.fornecedores.map((f) => montarDados(c, f));
      const nomeZip = `ATAs - Pregão ${String(c.numero).replace(/\//g, "-")}.zip`;
      const nomes = await window.ATA.gerarZip(lista, nomeZip, (i, n) => {
        botao.textContent = `Gerando ${i} de ${n}…`;
      });
      recado(`${nomes.length} atas geradas em ${nomeZip}.`);
    } catch (e) {
      recado(e.message || "Não foi possível gerar as atas.", true);
    } finally {
      botao.disabled = false;
      botao.textContent = antes;
      revalidar(caixa, c);
    }
  }

  /* ========================================================================
     ligações
     ===================================================================== */

  el.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const uasg = el.uasg.value.replace(/\D/g, "");
    if (!uasg) { recado("Informe o código da UASG.", true); return; }
    carregar(uasg, parseInt(el.ano.value, 10), false);
  });

  el.ano.addEventListener("change", () =>
    carregar(el.uasg.value.replace(/\D/g, ""), parseInt(el.ano.value, 10), false));

  el.recarregar.addEventListener("click", () =>
    carregar(el.uasg.value.replace(/\D/g, ""), parseInt(el.ano.value, 10), true));

  let t;
  el.procura.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { estado.procura = el.procura.value; desenharLista(); }, 140);
  });

  const topo = document.querySelector(".topo");
  function medirTopo() {
    document.documentElement.style.setProperty(
      "--topo-altura", `${Math.round(topo.getBoundingClientRect().height)}px`);
  }
  if ("ResizeObserver" in window) new ResizeObserver(medirTopo).observe(topo);
  else window.addEventListener("resize", medirTopo);
  medirTopo();

  if (el.rodapeVersao) {
    el.rodapeVersao.textContent = `Atas de Registro de Preços · v${VERSAO}`;
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("sw.js");
        let recarregando = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (recarregando) return;
          recarregando = true;
          location.reload();
        });
        reg.addEventListener("updatefound", () => {
          const novo = reg.installing;
          if (!novo) return;
          novo.addEventListener("statechange", () => {
            if (novo.state === "installed" && navigator.serviceWorker.controller) {
              novo.postMessage("atualizar-agora");
            }
          });
        });
        reg.update();
      } catch (e) { /* sem drama */ }
    });
  }

  iniciar();
})();
