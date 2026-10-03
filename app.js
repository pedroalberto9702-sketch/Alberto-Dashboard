/* =============================================================================
   Painel de Contratações -- lógica da página
   =============================================================================
   Este arquivo nunca fala com o Compras.gov.br. Ele lê os arquivos JSON que a
   rotina agendada já deixou prontos na pasta dados/. É por isso que a página
   abre instantaneamente mesmo quando a API do governo está levando um minuto
   por consulta.
   ========================================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------------
     Preencha com o endereço do seu repositório para que o link "Forçar nova
     coleta" apareça no topo. Deixe vazio para esconder o link.
     Exemplo: "https://github.com/seu-usuario/painel-contratacoes"
  --------------------------------------------------------------------------- */
  const REPOSITORIO = "";

  // Único lugar onde o número da versão existe. Ele aparece no rodapé para
  // que dê para confirmar, de olho, qual código o navegador está rodando --
  // sem isso não há como distinguir "a correção não funcionou" de "a
  // correção não chegou".
  const VERSAO = "3.4.0";

  /** A base devolve o processo ora formatado, ora só com os 17 dígitos. */
  function processoFormatado(v) {
    const t = String(v || "").trim();
    if (/[./-]/.test(t)) return t;
    const d = t.replace(/\D/g, "");
    return d.length === 17
      ? d.replace(/^(\d{5})(\d{6})(\d{4})(\d{2})$/, "$1.$2/$3-$4") : t;
  }
  const UASG_PADRAO = "120641";

  const CLASSE_FASE = {
    "Aguardando sessão pública": "1",
    "Em disputa": "2",
    "Em habilitação": "3",
    "Em homologação/Adjudicação": "4",
    "Homologado": "5",
  };
  const ORDEM_FASES = Object.keys(CLASSE_FASE);

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
    estado: $("#estado"),
    painel: $("#painel"),
    unidade: $("#unidade-nome"),
    uasg: $("#campo-uasg"),
    ano: $("#campo-ano"),
    form: $("#form-unidade"),
    recarregar: $("#botao-recarregar"),
    selo: $("#selo-atualizacao"),
    seloTexto: $("#selo-texto"),
    seloLink: $("#selo-link"),
    rTotal: $("#r-total"),
    rEstimado: $("#r-estimado"),
    rHomologado: $("#r-homologado"),
    trilha: $("#trilha"),
    fases: $("#fases"),
    procura: $("#campo-procura"),
    corpo: $("#corpo"),
    vazio: $("#vazio"),
    avisos: $("#avisos"),
    avisosLista: $("#avisos-lista"),
    rodapeColeta: $("#rodape-coleta"),
    rodapeVersao: $("#rodape-versao"),
    gaveta: $("#gaveta"),
    gTitulo: $("#gaveta-titulo"),
    gObjeto: $("#gaveta-objeto"),
    gCorpo: $("#gaveta-corpo"),
    gPlanilha: $("#gaveta-planilha"),
    fSem: $("#f-sem-vencedor"),
    fAcima: $("#f-acima"),
    recado: $("#recado"),
  };

  const estado = {
    indiceGeral: null,
    dados: null,          // certames.json carregado
    fasesAtivas: new Set(),
    procura: "",
    detalhe: null,        // certame aberto na gaveta
  };

  /* ========================================================================
     utilidades
     ===================================================================== */

  function texto(valor) {
    return String(valor == null ? "" : valor);
  }

  function diaBR(iso) {
    if (!iso) return "";
    const p = String(iso).slice(0, 10).split("-");
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : "";
  }

  function quandoBR(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return diaBR(iso);
    return d.toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function horasDesde(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return Infinity;
    return (Date.now() - d.getTime()) / 36e5;
  }

  function recado(msg, erro) {
    el.recado.textContent = msg;
    el.recado.hidden = false;
    el.recado.style.background = erro
      ? "var(--fx-tinta)" : "var(--tinta)";
    clearTimeout(recado._t);
    recado._t = setTimeout(() => { el.recado.hidden = true; }, 6000);
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
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  /* ========================================================================
     carregamento
     ===================================================================== */

  function lerEndereco() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    const uasg = (h.get("uasg") || localStorage.getItem("uasg") ||
                  UASG_PADRAO).replace(/\D/g, "");
    const ano = parseInt(h.get("ano"), 10) || null;
    return { uasg, ano };
  }

  function escreverEndereco(uasg, ano) {
    const novo = `#uasg=${uasg}&ano=${ano}`;
    if (location.hash !== novo) {
      history.replaceState(null, "", novo);
    }
    try { localStorage.setItem("uasg", uasg); } catch (e) { /* modo privado */ }
  }

  async function iniciar() {
    const { uasg, ano } = lerEndereco();
    el.uasg.value = uasg;

    try {
      estado.indiceGeral = await buscarJson("dados/indice.json");
    } catch (e) {
      estado.indiceGeral = null;
    }

    await carregar(uasg, ano, false);
  }

  function anosDisponiveis(uasg) {
    const u = (estado.indiceGeral?.unidades || [])
      .find((x) => String(x.uasg) === String(uasg));
    const lista = (u?.anos || []).map((a) => a.ano);
    const atual = new Date().getFullYear();
    if (!lista.includes(atual)) lista.unshift(atual);
    return lista.sort((a, b) => b - a);
  }

  function preencherAnos(uasg, selecionado) {
    const anos = anosDisponiveis(uasg);
    el.ano.innerHTML = "";
    for (const a of anos) {
      const o = document.createElement("option");
      o.value = a;
      o.textContent = a;
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
      estado.dados = await buscarJson(
        `dados/${uasg}/${ano}/certames.json`, forcar);
      estado.dados.uasg = String(uasg);
      estado.dados.ano = ano;
      escreverEndereco(uasg, ano);
      render();
    } catch (e) {
      if (e.status === 404) {
        mostrarEstado(
          `Não há dados coletados para a UASG ${uasg} no ano ${ano}.`,
          "Para incluir esta unidade, rode a coleta informando a UASG na aba " +
          "Actions do repositório (ou acrescente-a à variável UASGS).",
          true);
      } else {
        mostrarEstado(
          "Não foi possível ler os dados publicados.",
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

  function render() {
    const d = estado.dados;
    el.estado.hidden = true;
    el.painel.hidden = false;

    // O nome da unidade é coletado, mas de propósito não vai para a tela: a
    // página é genérica e não identifica a organização.
    el.unidade.textContent = `UASG ${d.uasg} · exercício ${d.ano}`;

    const resumo = d.resumo || {};
    el.rTotal.textContent = inteiro.format(resumo.total || 0);
    el.rEstimado.textContent = moedaCurta.format(resumo.estimado || 0);
    el.rHomologado.textContent = moedaCurta.format(resumo.homologado || 0);
    el.rEstimado.title = moeda.format(resumo.estimado || 0);
    el.rHomologado.title = moeda.format(resumo.homologado || 0);

    desenharSelo(d);
    desenharTrilha(d);
    desenharFases(d);
    desenharAvisos(d);
    desenharLinhas();
  }

  function desenharSelo(d) {
    const h = horasDesde(d.atualizado);
    el.selo.hidden = false;
    el.selo.className = "selo" + (h > 30 ? " selo--velho" : "");
    const partes = [`Dados coletados em ${quandoBR(d.atualizado)}`];
    if (h > 30 && isFinite(h)) {
      partes.push(`há ${Math.floor(h / 24)} dia(s) — a rotina pode estar parada`);
    }
    el.seloTexto.textContent = partes.join(" · ");
    el.rodapeColeta.textContent = `coleta de ${quandoBR(d.atualizado)}`;

    if (REPOSITORIO) {
      el.seloLink.hidden = false;
      el.seloLink.href = `${REPOSITORIO}/actions/workflows/atualizar.yml`;
      el.seloLink.target = "_blank";
      el.seloLink.rel = "noopener";
    }
  }

  function desenharTrilha(d) {
    const porFase = (d.resumo || {}).por_fase || {};
    const total = Object.values(porFase).reduce((a, b) => a + b, 0) || 1;
    el.trilha.innerHTML = "";

    const ordenadas = [
      ...ORDEM_FASES.filter((f) => porFase[f]),
      ...Object.keys(porFase).filter((f) => !CLASSE_FASE[f]),
    ];

    for (const fase of ordenadas) {
      const parte = document.createElement("span");
      parte.className = "trilha__parte";
      parte.style.flex = String(porFase[fase]);
      parte.style.background = `var(--f${CLASSE_FASE[fase] || "x"}-tinta)`;
      parte.title = `${fase}: ${porFase[fase]} de ${total}`;
      el.trilha.appendChild(parte);
    }
  }

  function desenharFases(d) {
    const porFase = (d.resumo || {}).por_fase || {};
    el.fases.innerHTML = "";

    const ordenadas = [
      ...ORDEM_FASES.filter((f) => porFase[f]),
      ...Object.keys(porFase).filter((f) => !CLASSE_FASE[f]).sort(),
    ];

    for (const fase of ordenadas) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "fase";
      b.setAttribute("aria-pressed", estado.fasesAtivas.has(fase));

      const marca = document.createElement("span");
      marca.className = "fase__marca";
      marca.style.background = `var(--f${CLASSE_FASE[fase] || "x"}-tinta)`;

      const nome = document.createElement("span");
      nome.textContent = fase;

      const cont = document.createElement("span");
      cont.className = "fase__contagem";
      cont.textContent = porFase[fase];

      b.append(marca, nome, cont);
      b.addEventListener("click", () => {
        if (estado.fasesAtivas.has(fase)) estado.fasesAtivas.delete(fase);
        else estado.fasesAtivas.add(fase);
        b.setAttribute("aria-pressed", estado.fasesAtivas.has(fase));
        desenharLinhas();
      });
      el.fases.appendChild(b);
    }
  }

  function desenharAvisos(d) {
    const avisos = d.avisos || [];
    el.avisos.hidden = !avisos.length;
    el.avisosLista.innerHTML = "";
    for (const a of avisos) {
      const li = document.createElement("li");
      li.textContent = a;
      el.avisosLista.appendChild(li);
    }
  }

  function filtrados() {
    const termo = estado.procura.trim().toLowerCase();
    return (estado.dados.certames || []).filter((c) => {
      if (estado.fasesAtivas.size && !estado.fasesAtivas.has(c.fase)) return false;
      if (!termo) return true;
      return [c.titulo, c.numero, c.objeto, c.processo, c.modalidade]
        .some((v) => texto(v).toLowerCase().includes(termo));
    });
  }

  function desenharLinhas() {
    const lista = filtrados();
    el.corpo.innerHTML = "";
    el.vazio.hidden = lista.length > 0;

    for (const c of lista) {
      el.corpo.appendChild(linha(c));
    }
  }

  function celula(classe, conteudo) {
    const td = document.createElement("td");
    td.className = classe;
    if (conteudo != null) td.append(conteudo);
    return td;
  }

  function linha(c) {
    const tr = document.createElement("tr");

    /* ---- coluna A: o certame ---- */
    const bloco = document.createElement("div");
    bloco.className = "certame";

    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "certame__botao";
    botao.textContent = c.titulo;
    botao.addEventListener("click", () => abrirGaveta(c));
    bloco.appendChild(botao);

    // cada informação vai num span próprio: assim a linha quebra entre elas,
    // e não no meio de um número de processo
    const meta = document.createElement("span");
    meta.className = "certame__meta";
    const pedacos = [];
    if (c.abertura) pedacos.push(`abertura ${diaBR(c.abertura)}`);
    else if (c.publicacao) pedacos.push(`publicado ${diaBR(c.publicacao)}`);
    if (c.processo) pedacos.push(`proc. ${processoFormatado(c.processo)}`);
    if (!pedacos.length) pedacos.push("—");
    for (const p of pedacos) {
      const s = document.createElement("span");
      s.textContent = p;
      meta.appendChild(s);
    }
    if (c.srp) {
      const srp = document.createElement("span");
      srp.className = "certame__marca";
      srp.textContent = "SRP";
      srp.title = "Sistema de Registro de Preços";
      meta.appendChild(srp);
    }
    bloco.appendChild(meta);
    tr.appendChild(celula("c-certame", bloco));

    /* ---- coluna B: a situação ---- */
    const sinal = document.createElement("span");
    sinal.className = `sinal sinal--${CLASSE_FASE[c.fase] || "x"}`;
    sinal.textContent = c.fase;
    if (c.encerramento && c.fase === "Em disputa") {
      sinal.title = `Propostas até ${diaBR(c.encerramento)}`;
    }
    tr.appendChild(celula("c-situacao", sinal));

    /* ---- objeto ---- */
    const obj = document.createElement("span");
    obj.className = "objeto";
    obj.textContent = c.objeto || "—";
    obj.title = c.objeto || "";
    tr.appendChild(celula("c-objeto", obj));

    /* ---- itens ---- */
    const itens = document.createElement("span");
    itens.className = "numero";
    if (c.qtd_itens) {
      itens.textContent = inteiro.format(c.qtd_itens);
      if (c.qtd_com_vencedor != null && c.qtd_com_vencedor < c.qtd_itens) {
        const f = document.createElement("span");
        f.className = "fracao";
        f.textContent = ` (${c.qtd_com_vencedor} c/ venc.)`;
        itens.appendChild(f);
      }
    } else {
      itens.textContent = "—";
      itens.classList.add("numero--fraco");
    }
    tr.appendChild(celula("c-itens", itens));

    /* ---- valor ---- */
    const valor = document.createElement("span");
    valor.className = "numero";
    const temResultado = (c.valor_resultado || c.valor_homologado) > 0;
    const v = c.valor_homologado || c.valor_resultado || c.valor_estimado || 0;
    valor.textContent = v ? moedaCurta.format(v) : "—";
    valor.title = v
      ? `${moeda.format(v)} — ${temResultado ? "resultado apurado" : "valor estimado"}`
      : "";
    if (!temResultado) valor.classList.add("numero--fraco");
    tr.appendChild(celula("c-valor", valor));

    /* ---- coluna C: a planilha ---- */
    const acao = document.createElement("button");
    acao.type = "button";
    acao.className = "botao";
    acao.textContent = "Planilha";
    acao.addEventListener("click", () => baixarPlanilha(c, acao));
    tr.appendChild(celula("c-acao", acao));

    return tr;
  }

  /* ========================================================================
     planilha
     ===================================================================== */

  async function detalheDe(c) {
    return buscarJson(
      `dados/${estado.dados.uasg}/${estado.dados.ano}/certame/${c.arquivo}.json`);
  }

  async function baixarPlanilha(c, botao) {
    const antes = botao.textContent;
    botao.disabled = true;
    botao.textContent = "Gerando…";
    try {
      const detalhe = await detalheDe(c);
      detalhe.titulo = detalhe.titulo || c.titulo;
      const r = window.SILOMS.gerar(detalhe, {});
      recado(`${window.SILOMS.nomeArquivo(detalhe.titulo)} · ` +
             `${r.itens} item(ns), ${r.com} com vencedor, ` +
             `${moeda.format(r.valor)}`);
    } catch (e) {
      recado(e.message || "Não foi possível gerar a planilha.", true);
    } finally {
      botao.disabled = false;
      botao.textContent = antes;
    }
  }

  /* ========================================================================
     gaveta de detalhe
     ===================================================================== */

  async function abrirGaveta(c) {
    el.gaveta.hidden = false;
    el.gTitulo.textContent = c.titulo;
    el.gObjeto.textContent = c.objeto || "";
    el.gCorpo.innerHTML = '<p class="vazio">Carregando itens…</p>';
    document.body.style.overflow = "hidden";
    el.gaveta.querySelector("[data-fechar]").focus();

    try {
      estado.detalhe = await detalheDe(c);
      estado.detalhe.titulo = estado.detalhe.titulo || c.titulo;
      desenharItens();
    } catch (e) {
      el.gCorpo.innerHTML = "";
      const p = document.createElement("p");
      p.className = "vazio";
      p.textContent = e.status === 404
        ? "Este certame ainda não tem detalhe coletado."
        : `Não foi possível ler o detalhe: ${e.message}`;
      el.gCorpo.appendChild(p);
    }
  }

  function fecharGaveta() {
    el.gaveta.hidden = true;
    estado.detalhe = null;
    document.body.style.overflow = "";
  }

  function desenharItens() {
    const d = estado.detalhe;
    const soSem = el.fSem.checked;
    const soAcima = el.fAcima.checked;

    const porItem = new Map();
    for (const r of d.resultados || []) {
      if (!porItem.has(r.item)) porItem.set(r.item, []);
      porItem.get(r.item).push(r);
    }

    // a mesma limpeza da planilha, para a gaveta não listar item repetido
    let itens = window.SILOMS ? window.SILOMS.semRepetidos(d.itens)
                              : (d.itens || []).slice();
    if (!itens.length && porItem.size) {
      itens = [...porItem.keys()].map((id) => ({
        id, numero: porItem.get(id)[0].numero,
        descricao: "", unidade: "", quantidade: 0, estimado_unitario: 0,
      }));
    }

    el.gCorpo.innerHTML = "";
    let mostrados = 0;

    for (const it of itens) {
      const res = (porItem.get(it.id) || []).slice()
        .sort((a, b) => (a.ordem || 9999) - (b.ordem || 9999) ||
                        (a.sequencial || 9999) - (b.sequencial || 9999));

      const est = it.estimado_unitario || 0;
      const acima = est > 0 && res.length > 0 && res[0].unitario > est;

      if (soSem && res.length) continue;
      if (soAcima && !acima) continue;
      mostrados++;

      el.gCorpo.appendChild(cartaoItem(it, res, est, acima));
    }

    if (!mostrados) {
      const p = document.createElement("p");
      p.className = "vazio";
      p.textContent = itens.length
        ? "Nenhum item corresponde ao filtro."
        : "Nenhum item publicado na base de dados abertos para este certame.";
      el.gCorpo.appendChild(p);
    }
  }

  function cartaoItem(it, res, est, acima) {
    const caixa = document.createElement("div");
    caixa.className = "item";

    const topo = document.createElement("div");
    topo.className = "item__topo";

    const n = document.createElement("span");
    n.className = "item__n";
    n.textContent = it.grupo
      ? `L${it.grupo} · ${it.numero ?? "?"}`
      : `ITEM ${it.numero ?? "?"}`;

    const desc = document.createElement("span");
    desc.className = "item__desc";
    desc.textContent = it.descricao || "(sem descrição na base)";

    const info = document.createElement("span");
    info.className = "item__est";
    const bits = [];
    if (it.quantidade) bits.push(`${inteiro.format(it.quantidade)} ${it.unidade || ""}`.trim());
    if (est) bits.push(`est. ${moeda.format(est)}`);
    info.textContent = bits.join("  ·  ");

    topo.append(n, desc, info);
    caixa.appendChild(topo);

    if (!res.length) {
      const sem = document.createElement("p");
      sem.className = "item__sem";
      sem.textContent = "Sem resultado na base — deserto, fracassado ou ainda não publicado.";
      caixa.appendChild(sem);
      return caixa;
    }

    const tab = document.createElement("table");
    tab.className = "ranking";
    tab.innerHTML =
      "<thead><tr><th>#</th><th>Fornecedor</th>" +
      "<th class='n'>Unitário</th><th class='n'>Total</th>" +
      "<th>Situação</th></tr></thead>";

    const tb = document.createElement("tbody");
    res.forEach((r, i) => {
      const tr = document.createElement("tr");
      if (i === 0) tr.className = "ganhador";
      if (est > 0 && r.unitario > est) tr.classList.add("acima");

      const tdO = document.createElement("td");
      const bolinha = document.createElement("span");
      bolinha.className = "ordem";
      bolinha.textContent = r.ordem || (i + 1);
      tdO.appendChild(bolinha);

      const tdF = document.createElement("td");
      tdF.textContent = r.empresa || "—";
      if (r.ni) {
        const doc = document.createElement("span");
        doc.className = "cnpj";
        doc.textContent = formatarDoc(r.ni) + (r.porte ? ` · ${r.porte}` : "");
        tdF.appendChild(doc);
      }

      const tdU = document.createElement("td");
      tdU.className = "n";
      tdU.textContent = moeda.format(r.unitario);
      if (est > 0) {
        const dif = ((r.unitario - est) / est) * 100;
        tdU.title = `${dif >= 0 ? "+" : ""}${dif.toFixed(1)}% em relação ao estimado`;
      }

      const tdT = document.createElement("td");
      tdT.className = "n";
      tdT.textContent = moeda.format(r.total);

      const tdS = document.createElement("td");
      tdS.textContent = r.situacao || "—";

      tr.append(tdO, tdF, tdU, tdT, tdS);
      tb.appendChild(tr);
    });
    tab.appendChild(tb);
    caixa.appendChild(tab);

    if (acima) caixa.style.borderColor = "var(--fx-tinta)";
    return caixa;
  }

  function formatarDoc(ni) {
    let d = texto(ni).replace(/\D/g, "");
    // a base às vezes devolve o CNPJ sem os zeros à esquerda; completamos,
    // igual ao que a planilha faz, para os dois lados mostrarem o mesmo
    if (d.length >= 12 && d.length < 14) d = d.padStart(14, "0");
    if (d.length === 14) {
      return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    }
    if (d.length === 11) {
      return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
    }
    return d;
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

  el.ano.addEventListener("change", () => {
    carregar(el.uasg.value.replace(/\D/g, ""),
             parseInt(el.ano.value, 10), false);
  });

  el.recarregar.addEventListener("click", () => {
    carregar(el.uasg.value.replace(/\D/g, ""),
             parseInt(el.ano.value, 10), true);
  });

  let tempoProcura;
  el.procura.addEventListener("input", () => {
    clearTimeout(tempoProcura);
    tempoProcura = setTimeout(() => {
      estado.procura = el.procura.value;
      desenharLinhas();
    }, 140);
  });

  el.fSem.addEventListener("change", () => {
    if (el.fSem.checked) el.fAcima.checked = false;
    if (estado.detalhe) desenharItens();
  });
  el.fAcima.addEventListener("change", () => {
    if (el.fAcima.checked) el.fSem.checked = false;
    if (estado.detalhe) desenharItens();
  });

  el.gPlanilha.addEventListener("click", async () => {
    if (!estado.detalhe) return;
    const b = el.gPlanilha;
    const antes = b.textContent;
    b.disabled = true; b.textContent = "Gerando…";
    try {
      const r = window.SILOMS.gerar(estado.detalhe, {});
      recado(`${r.itens} item(ns), ${r.com} com vencedor, ${moeda.format(r.valor)}`);
    } catch (e) {
      recado(e.message || "Não foi possível gerar a planilha.", true);
    } finally {
      b.disabled = false; b.textContent = antes;
    }
  });

  for (const alvo of el.gaveta.querySelectorAll("[data-fechar]")) {
    alvo.addEventListener("click", fecharGaveta);
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !el.gaveta.hidden) fecharGaveta();
  });

  window.addEventListener("hashchange", () => {
    const { uasg, ano } = lerEndereco();
    if (uasg !== estado.dados?.uasg || ano !== estado.dados?.ano) {
      el.uasg.value = uasg;
      carregar(uasg, ano, false);
    }
  });

  /* ---- altura do topo, para o cabeçalho da tabela grudar no lugar certo ---
     O topo muda de altura: o selo de atualização aparece depois do
     carregamento, e os campos quebram em telas estreitas. Em vez de chutar um
     número no CSS, medimos. */
  const topo = document.querySelector(".topo");
  function medirTopo() {
    document.documentElement.style.setProperty(
      "--topo-altura", `${Math.round(topo.getBoundingClientRect().height)}px`);
  }
  if ("ResizeObserver" in window) {
    new ResizeObserver(medirTopo).observe(topo);
  } else {
    window.addEventListener("resize", medirTopo);
  }
  medirTopo();

  /* ---- instalação como aplicativo, e troca de versão sem susto ----
     Quando uma versão nova do site é publicada, o service worker novo assume
     o lugar do antigo e a página recarrega uma única vez sozinha. Sem isto,
     o navegador podia ficar rodando código velho por tempo indeterminado --
     foi o que fez uma correção publicada não chegar até a tela. */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("sw.js");

        let recarregando = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (recarregando) return;        // uma vez só, nunca em laço
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
      } catch (e) { /* sem drama: o site funciona sem isto */ }
    });
  }

  if (el.rodapeVersao) {
    el.rodapeVersao.textContent = `Painel de Contratações · v${VERSAO}`;
  }

  console.info(`Painel de Contratações v${VERSAO}`);
  iniciar();
})();
