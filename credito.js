/* =============================================================================
   Crédito disponível
   =============================================================================
   De onde vêm os números:

   1. Da rotina do GitHub, que lê a planilha do Tesouro no e-mail e publica
      dados/credito/credito.enc.json -- CIFRADO, porque o repositório e o
      site são públicos. A senha é pedida uma vez por aparelho.
   2. De uma planilha carregada à mão neste navegador ("Carregar planilha"),
      para os dias em que não se quer esperar o e-mail. Esta fica só aqui.
   Vale a mais nova das duas.

   O que é SEU, e não do Tesouro: a movimentação (valor que soma ou subtrai
   da linha) e o lembrete. Ficam gravados só neste navegador, ligados à
   linha pela chave ação|fonte|PTRES|PI|natureza, e sobrevivem à chegada de
   uma planilha nova. Como o Tesouro pode passar a refletir uma movimentação
   que você lançou, o painel avisa quando chega planilha nova para você
   decidir se zera.

   Todos os cálculos são feitos em centavos inteiros, para a soma não
   acumular erro de ponto flutuante.
   ========================================================================== */

(() => {
  "use strict";

  const VERSAO = "3.6.0";
  const PASTA = "dados/credito/";
  const ACOES = "https://github.com/pedroalberto9702-sketch/Alberto-Dashboard/actions/workflows/atualizar.yml";
  const HORAS_VELHA = 30;                 // acima disso a planilha é "de ontem"

  const $ = (s) => document.querySelector(s);
  const el = {
    fonte: $("#cred-fonte"), estado: $("#estado"), painel: $("#painel"),
    banner: $("#banner"), bannerTexto: $("#banner-texto"),
    bannerZerar: $("#banner-zerar"), bannerManter: $("#banner-manter"),
    tRecebido: $("#t-recebido"), tDisp: $("#t-disponivel"),
    tMov: $("#t-mov"), tAtual: $("#t-atualizado"),
    procura: $("#campo-procura"), fNd: $("#f-nd"), fFonte: $("#f-fonte"),
    fSaldo: $("#f-saldo"),
    carregar: $("#botao-carregar"), arquivo: $("#arquivo"),
    exportar: $("#botao-exportar"), zerar: $("#botao-zerar"),
    recarregar: $("#botao-recarregar"),
    tabela: $("#tabela"), corpo: $("#corpo"), rodape: $("#rodape-tabela"),
    vazio: $("#vazio"), recado: $("#recado"), versao: $("#rodape-versao"),
  };

  const estado = {
    dados: null,          // { linhas: [...], atualizado, origem }
    ajustes: {},          // chave -> { mov (centavos), nota }
    base: "",             // 'atualizado' da planilha sobre a qual os ajustes foram feitos
    ordem: { chave: "", dir: 1 },
    visiveis: [],
  };

  /* ---------------------------------------------------------------------
     dinheiro: sempre em centavos inteiros
     ------------------------------------------------------------------ */

  const centavos = (x) => Math.round((Number(x) || 0) * 100);
  const nf = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt = (c) => nf.format(c / 100);
  const fmtCurto = (c) => {
    const v = c / 100, a = Math.abs(v);
    if (a >= 1e6) return `R$\u00a0${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(v / 1e6)}\u00a0mi`;
    return `R$\u00a0${nf.format(v)}`;
  };

  /** Lê o que foi digitado em pt-BR. Devolve centavos, 0 se vazio, NaN se inválido. */
  function lerValor(txt) {
    let t = String(txt || "").replace(/R\$|\s/g, "");
    if (!t) return 0;
    let neg = false;
    if (t.startsWith("(") && t.endsWith(")")) { neg = true; t = t.slice(1, -1); }
    if (t.startsWith("-")) { neg = !neg; t = t.slice(1); }
    else if (t.startsWith("+")) t = t.slice(1);
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
    else if (/^\d+(,\d+)?$/.test(t)) t = t.replace(",", ".");
    else if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
    const c = Math.round(parseFloat(t) * 100);
    return neg ? -c : c;
  }

  /* ---------------------------------------------------------------------
     utilidades
     ------------------------------------------------------------------ */

  function recado(texto, erro) {
    el.recado.textContent = texto;
    el.recado.hidden = false;
    el.recado.style.background = erro ? "#8B2B2B" : "";
    clearTimeout(recado.t);
    recado.t = setTimeout(() => { el.recado.hidden = true; }, erro ? 6500 : 3200);
  }

  function ler(chave, padrao) {
    try { const v = localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; }
    catch (e) { return padrao; }
  }
  function gravar(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); return true; }
    catch (e) { return false; }
  }
  function apagar(chave) { try { localStorage.removeItem(chave); } catch (e) { /* ok */ } }

  const quando = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  function mostrarEstado(html, dica, extra) {
    el.painel.hidden = true;
    el.estado.hidden = false;
    el.estado.className = "estado";
    el.estado.innerHTML = "";
    const p = document.createElement("p");
    p.className = "estado__texto";
    p.textContent = html;
    el.estado.appendChild(p);
    if (dica) {
      const d = document.createElement("p");
      d.className = "estado__dica";
      d.textContent = dica;
      el.estado.appendChild(d);
    }
    if (extra) el.estado.appendChild(extra);
    return el.estado;
  }

  /* ---------------------------------------------------------------------
     cifra (compatível com a rotina em Python)
     ------------------------------------------------------------------ */

  async function decifrar(env, senha) {
    const b = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveKey"]);
    const chave = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b(env.salt), iterations: env.iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b(env.iv) }, chave, b(env.ct));
    return JSON.parse(new TextDecoder().decode(claro));
  }

  /* ---------------------------------------------------------------------
     leitura da planilha do Tesouro (a mesma lógica do credito.py)
     ------------------------------------------------------------------ */

  function lerPlanilhaXlsx(buffer) {
    if (!window.XLSX) throw new Error("A biblioteca de planilhas não carregou (rede bloqueando o CDN?).");
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws["!ref"]) throw new Error("A planilha está vazia.");
    const faixa = XLSX.utils.decode_range(ws["!ref"]);

    // desfaz as células mescladas: toda célula da mescla recebe o valor da primeira
    const mesclado = new Map();
    for (const m of ws["!merges"] || []) {
      const ini = ws[XLSX.utils.encode_cell(m.s)];
      const v = ini ? ini.v : undefined;
      for (let r = m.s.r; r <= m.e.r; r++)
        for (let c = m.s.c; c <= m.e.c; c++) mesclado.set(r + ":" + c, v);
    }
    const cel = (r, c) => {
      const k = r + ":" + c;
      if (mesclado.has(k)) return mesclado.get(k);
      const x = ws[XLSX.utils.encode_cell({ r, c })];
      return x ? x.v : undefined;
    };
    const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
    const num = (v) => {
      if (v === undefined || v === null || v === "") return 0;
      if (typeof v === "number") return Math.round(v * 100) / 100;
      const t = String(v).replace(/R\$|\s/g, "");
      const n = parseFloat(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
      return isNaN(n) ? 0 : Math.round(n * 100) / 100;
    };

    let cab = -1;
    for (let r = faixa.s.r; r <= Math.min(faixa.e.r, faixa.s.r + 30) && cab < 0; r++)
      for (let c = faixa.s.c; c <= faixa.e.c; c++)
        if (txt(cel(r, c)) === "Ação Governo") { cab = r; break; }
    if (cab < 0) throw new Error("Esta não parece a planilha de Crédito Disponível (não achei 'Ação Governo').");

    const acha = (nome, desloc) => {
      for (let c = faixa.s.c; c <= faixa.e.c; c++)
        for (const d of desloc)
          if (txt(cel(cab + d, c)).toLowerCase() === nome.toLowerCase()) return c;
      return -1;
    };
    const col = {
      acao: acha("Ação Governo", [0]), fonte: acha("Fonte Recursos Detalhada", [0]),
      ptres: acha("PTRES", [0]), pi: acha("PI", [0]),
      nd: acha("Natureza Despesa", [1, 0]), recebido: acha("Crédito Recebido", [0]),
      disponivel: acha("CREDITO DISPONIVEL", [0]), empenhado: acha("DESPESAS EMPENHADAS", [0]),
    };
    const faltam = Object.keys(col).filter((k) => col[k] < 0);
    if (faltam.length) throw new Error("Layout diferente do esperado. Colunas não encontradas: " + faltam.join(", "));
    col.descricao = col.pi + 1;

    const linhas = [];
    for (let r = cab + 2; r <= faixa.e.r; r++) {
      const nd = txt(cel(r, col.nd)), rec = cel(r, col.recebido);
      if (!nd && (rec === undefined || rec === "")) break;
      const l = {
        acao: txt(cel(r, col.acao)), fonte: txt(cel(r, col.fonte)),
        ptres: txt(cel(r, col.ptres)), pi: txt(cel(r, col.pi)),
        descricao: txt(cel(r, col.descricao)), nd,
        recebido: num(rec), disponivel: num(cel(r, col.disponivel)),
        empenhado: num(cel(r, col.empenhado)),
      };
      l.chave = [l.acao, l.fonte, l.ptres, l.pi, l.nd].join("|");
      linhas.push(l);
    }
    if (!linhas.length) throw new Error("A planilha não tem nenhuma linha de crédito.");
    return { linhas };
  }

  /* ---------------------------------------------------------------------
     carregar: publicado (cifrado ou aberto) e/ou planilha local
     ------------------------------------------------------------------ */

  async function buscarJson(nome) {
    const r = await fetch(`${PASTA}${nome}?t=${Date.now()}`, { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`O servidor respondeu ${r.status}.`);
    return r.json();
  }

  async function obterPublicado(senhaDigitada) {
    const cif = await buscarJson("credito.enc.json");
    if (cif) {
      const senha = senhaDigitada || ler("credito:senha", "");
      if (!senha) { const e = new Error("senha"); e.pedirSenha = true; throw e; }
      try {
        const d = await decifrar(cif, senha);
        return { dados: d, senha };
      } catch (e) {
        const er = new Error("senha"); er.pedirSenha = true; er.errada = true; throw er;
      }
    }
    const aberto = await buscarJson("credito.json");
    return aberto ? { dados: aberto } : null;
  }

  async function iniciar(senhaDigitada, lembrar) {
    mostrarEstado("Carregando…");
    let publicado = null, falha = null;
    try {
      const r = await obterPublicado(senhaDigitada);
      if (r) {
        publicado = r.dados;
        if (r.senha && senhaDigitada && lembrar) gravar("credito:senha", r.senha);
      }
    } catch (e) {
      if (e.pedirSenha) { pedirSenha(e.errada); return; }
      falha = e;
    }

    // a planilha carregada à mão vale se foi carregada DEPOIS da última
    // rodada da rotina; do contrário vale a publicada
    const local = ler("credito:local", null);
    let escolhido = null, origem = "";
    if (publicado && local && local.dados) {
      const ultimaRotina = new Date(publicado.coletado || publicado.atualizado);
      if (new Date(local.carregadoEm) > ultimaRotina) {
        escolhido = local.dados; origem = "carregada neste navegador";
      } else { escolhido = publicado; origem = "publicada automaticamente"; }
    } else if (publicado) { escolhido = publicado; origem = "publicada automaticamente"; }
    else if (local && local.dados) { escolhido = local.dados; origem = "carregada neste navegador"; }

    if (!escolhido) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "botao botao--primario"; b.style.marginTop = "16px";
      b.textContent = "Carregar planilha…";
      b.addEventListener("click", () => el.arquivo.click());
      mostrarEstado(
        falha ? `Não foi possível ler os dados publicados: ${falha.message}`
              : "Ainda não há planilha de crédito.",
        "Quando a rotina ler o e-mail do Tesouro, ela aparece aqui sozinha. " +
        "Para começar agora, carregue o arquivo que chegou no e-mail.", b);
      return;
    }

    estado.dados = { ...escolhido, origem };
    carregarAjustes();
    popularFiltros();
    el.estado.hidden = true;
    el.painel.hidden = false;
    desenharFonte();
    avaliarBanner();
    desenhar();
  }

  function pedirSenha(errada) {
    const st = mostrarEstado("Esta página é protegida por senha.",
      errada ? "Senha incorreta. Tente de novo." : "Digite a senha uma vez; ela fica lembrada neste aparelho.");
    if (errada) st.classList.add("estado--erro");
    const f = document.createElement("form");
    f.className = "cred-senha";
    f.innerHTML =
      '<input type="password" id="senha" autocomplete="current-password" ' +
      'placeholder="Senha" aria-label="Senha" required>' +
      '<button class="botao botao--primario" type="submit">Abrir</button>' +
      '<label class="interruptor"><input type="checkbox" id="lembrar" checked>' +
      '<span>Lembrar neste aparelho</span></label>';
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      iniciar(f.querySelector("#senha").value, f.querySelector("#lembrar").checked);
    });
    st.appendChild(f);
    f.querySelector("#senha").focus();
  }

  function desenharFonte() {
    const d = estado.dados;
    const horas = (Date.now() - new Date(d.atualizado)) / 36e5;
    el.fonte.textContent = `Planilha do Tesouro de ${quando(d.atualizado)} · ${d.origem}` +
      (horas > HORAS_VELHA ? " · desatualizada" : "");
    el.fonte.classList.toggle("marca__velha", horas > HORAS_VELHA);
  }

  /* ---------------------------------------------------------------------
     movimentações e lembretes (só neste navegador)
     ------------------------------------------------------------------ */

  const chaveArmazem = () => "credito:ajustes";

  function carregarAjustes() {
    const g = ler(chaveArmazem(), { base: "", linhas: {} });
    estado.ajustes = g.linhas || {};
    estado.base = g.base || "";
  }

  let tSalvar;
  function salvarAjustes() {
    clearTimeout(tSalvar);
    tSalvar = setTimeout(() => {
      // não guarda linhas vazias
      const limpo = {};
      for (const [k, v] of Object.entries(estado.ajustes)) {
        if ((v.mov && v.mov !== 0) || (v.nota && v.nota.trim())) limpo[k] = v;
      }
      estado.ajustes = limpo;
      const ok = gravar(chaveArmazem(), { base: estado.dados.atualizado, linhas: limpo });
      estado.base = estado.dados.atualizado;
      if (!ok) recado("Não consegui gravar neste navegador (armazenamento bloqueado?). Suas anotações podem se perder.", true);
    }, 250);
  }

  const aj = (l) => estado.ajustes[l.chave] || { mov: 0, nota: "" };
  const movDe = (l) => aj(l).mov || 0;
  const atualizadoDe = (l) => centavos(l.disponivel) + movDe(l);

  function temMovimento() {
    return Object.values(estado.ajustes).some((v) => v.mov && v.mov !== 0);
  }

  function avaliarBanner() {
    el.banner.hidden = true;
    if (!estado.base) { estado.base = estado.dados.atualizado; return; }
    if (estado.base === estado.dados.atualizado) return;
    if (!temMovimento()) {
      estado.base = estado.dados.atualizado;
      gravar(chaveArmazem(), { base: estado.base, linhas: estado.ajustes });
      return;
    }
    el.bannerTexto.textContent =
      `Chegou uma planilha mais nova (${quando(estado.dados.atualizado)}). ` +
      `Suas movimentações foram lançadas sobre a de ${quando(estado.base)}. ` +
      `Se o Tesouro já reflete alguma delas, zere-a (use o ✕ na linha) para não contar duas vezes.`;
    el.banner.hidden = false;
  }

  /* ---------------------------------------------------------------------
     filtros e ordenação
     ------------------------------------------------------------------ */

  function popularFiltros() {
    const preencher = (sel, valores) => {
      const atual = sel.value;
      sel.innerHTML = '<option value="">Todas</option>';
      for (const v of [...new Set(valores)].filter(Boolean).sort()) {
        const o = document.createElement("option");
        o.value = v; o.textContent = v;
        sel.appendChild(o);
      }
      sel.value = [...sel.options].some((o) => o.value === atual) ? atual : "";
    };
    preencher(el.fNd, estado.dados.linhas.map((l) => l.nd));
    preencher(el.fFonte, estado.dados.linhas.map((l) => l.fonte));
  }

  const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function filtradas() {
    const t = semAcento(el.procura.value.trim());
    const nd = el.fNd.value, fo = el.fFonte.value, saldo = el.fSaldo.checked;
    let lista = estado.dados.linhas.filter((l) => {
      if (nd && l.nd !== nd) return false;
      if (fo && l.fonte !== fo) return false;
      if (saldo && !(l.disponivel > 0 || atualizadoDe(l) !== 0)) return false;
      if (t) {
        const alvo = semAcento([l.descricao, l.pi, l.ptres, l.acao, aj(l).nota].join(" "));
        if (!alvo.includes(t)) return false;
      }
      return true;
    });

    const { chave, dir } = estado.ordem;
    if (chave) {
      const valor = (l) => chave === "mov" ? movDe(l)
        : chave === "atualizado" ? atualizadoDe(l) : l[chave];
      lista = lista.slice().sort((a, b) => {
        const x = valor(a), y = valor(b);
        const r = typeof x === "number" && typeof y === "number"
          ? x - y : String(x).localeCompare(String(y), "pt-BR", { numeric: true });
        return r * dir;
      });
    }
    return lista;
  }

  /* ---------------------------------------------------------------------
     desenho
     ------------------------------------------------------------------ */

  function td(classe, texto, rotulo) {
    const c = document.createElement("td");
    if (classe) c.className = classe;
    if (texto !== undefined) c.textContent = texto;
    if (rotulo) c.dataset.rotulo = rotulo;
    return c;
  }

  function desenhar() {
    estado.visiveis = filtradas();
    el.corpo.innerHTML = "";
    el.vazio.hidden = estado.visiveis.length > 0;
    el.tabela.hidden = estado.visiveis.length === 0;

    for (const l of estado.visiveis) el.corpo.appendChild(linha(l));
    marcarOrdem();
    totais();
  }

  function linha(l) {
    const tr = document.createElement("tr");
    tr.dataset.chave = l.chave;

    const ap = td("c-acao-gov mono", undefined, "Ação / PTRES");
    const a1 = document.createElement("span"); a1.textContent = l.acao || "—";
    const a2 = document.createElement("span"); a2.className = "ap__ptres"; a2.textContent = l.ptres || "—";
    ap.append(a1, a2);
    tr.appendChild(ap);
    tr.appendChild(td("c-fonte mono", l.fonte, "Fonte"));

    const pi = td("c-pi", undefined, "Programa");
    const d = document.createElement("span");
    d.className = "pi__desc"; d.textContent = l.descricao || "—";
    const c = document.createElement("span");
    c.className = "pi__cod"; c.textContent = l.pi;
    pi.append(d, c);
    tr.appendChild(pi);

    tr.appendChild(td("c-nd mono", l.nd, "ND"));
    tr.appendChild(td("c-num", fmt(centavos(l.recebido)), "Recebido"));
    tr.appendChild(td("c-num" + (l.disponivel > 0 ? "" : " c-zero"), fmt(centavos(l.disponivel)), "Disponível (Tesouro)"));
    tr.appendChild(td("c-num" + (l.empenhado > 0 ? "" : " c-zero"), fmt(centavos(l.empenhado)), "Empenhado"));

    // ---- as três colunas suas ----
    const tdMov = td("c-meu c-meu--ini c-mov", undefined, "Movimentação (R$)");
    const caixa = document.createElement("div");
    caixa.className = "mov";
    const inp = document.createElement("input");
    inp.type = "text"; inp.inputMode = "decimal"; inp.autocomplete = "off";
    inp.placeholder = "0,00";
    inp.setAttribute("aria-label", `Movimentação de ${l.descricao} ${l.nd}`);
    const m0 = movDe(l);
    inp.value = m0 ? fmt(m0) : "";
    const zero = document.createElement("button");
    zero.type = "button"; zero.className = "mov__zerar";
    zero.title = "Já aparece no Tesouro: zerar a movimentação desta linha";
    zero.setAttribute("aria-label", "Zerar movimentação desta linha");
    zero.textContent = "✕";
    zero.hidden = !m0;
    caixa.append(inp, zero);
    tdMov.appendChild(caixa);
    tr.appendChild(tdMov);

    const tdAtual = td("c-meu c-num c-atual", undefined, "Disponível atualizado");
    tr.appendChild(tdAtual);
    pintarAtual(tdAtual, l);

    const tdNota = td("c-meu c-nota", undefined, "Lembrete");
    const nota = document.createElement("textarea");
    nota.rows = 1; nota.maxLength = 500;
    nota.placeholder = "Lembrete";
    nota.setAttribute("aria-label", `Lembrete de ${l.descricao} ${l.nd}`);
    nota.value = aj(l).nota || "";
    tdNota.appendChild(nota);
    tr.appendChild(tdNota);
    requestAnimationFrame(() => autoaltura(nota));

    inp.addEventListener("input", () => {
      const c = lerValor(inp.value);
      inp.classList.toggle("invalido", Number.isNaN(c));
      if (Number.isNaN(c)) return;
      estado.ajustes[l.chave] = { ...aj(l), mov: c };
      zero.hidden = !c;
      pintarAtual(tdAtual, l);
      totais();
      salvarAjustes();
    });
    inp.addEventListener("blur", () => {
      const c = lerValor(inp.value);
      if (Number.isNaN(c)) { inp.value = movDe(l) ? fmt(movDe(l)) : ""; inp.classList.remove("invalido"); recado("Valor inválido: use números, por exemplo 1.250,00 ou -300.", true); return; }
      inp.value = c ? fmt(c) : "";
    });
    inp.addEventListener("focus", () => inp.select());
    zero.addEventListener("click", () => {
      estado.ajustes[l.chave] = { ...aj(l), mov: 0 };
      inp.value = ""; zero.hidden = true;
      pintarAtual(tdAtual, l); totais(); salvarAjustes();
    });
    nota.addEventListener("input", () => {
      estado.ajustes[l.chave] = { ...aj(l), nota: nota.value };
      autoaltura(nota);
      salvarAjustes();
    });
    return tr;
  }

  function autoaltura(t) {
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, 140) + "px";
  }

  function pintarAtual(celula, l) {
    const v = atualizadoDe(l);
    celula.textContent = fmt(v);
    celula.classList.toggle("c-neg", v < 0);
    celula.classList.toggle("c-zero", v === 0);
    celula.classList.toggle("c-mudou", movDe(l) !== 0);
  }

  function somar(lista) {
    const s = { rec: 0, disp: 0, emp: 0, mov: 0, atual: 0 };
    for (const l of lista) {
      s.rec += centavos(l.recebido); s.disp += centavos(l.disponivel);
      s.emp += centavos(l.empenhado); s.mov += movDe(l); s.atual += atualizadoDe(l);
    }
    return s;
  }

  function totais() {
    const t = somar(estado.dados.linhas);
    el.tRecebido.textContent = fmtCurto(t.rec);
    el.tDisp.textContent = fmtCurto(t.disp);
    el.tMov.textContent = (t.mov > 0 ? "+ " : t.mov < 0 ? "− " : "") + fmtCurto(Math.abs(t.mov));
    el.tMov.classList.toggle("c-neg", t.mov < 0);
    el.tAtual.textContent = fmtCurto(t.atual);
    el.tAtual.classList.toggle("c-neg", t.atual < 0);
    for (const [e, v] of [[el.tRecebido, t.rec], [el.tDisp, t.disp], [el.tMov, t.mov], [el.tAtual, t.atual]]) {
      e.title = `R$ ${fmt(v)}`;
    }

    // rodapé da tabela: só das linhas à mostra
    const v = somar(estado.visiveis);
    el.rodape.innerHTML = "";
    const tr = document.createElement("tr");
    const rot = document.createElement("td");
    rot.colSpan = 4; rot.className = "tf-rotulo";
    rot.textContent = estado.visiveis.length === estado.dados.linhas.length
      ? `Total (${estado.visiveis.length} linhas)`
      : `Total do filtro (${estado.visiveis.length} de ${estado.dados.linhas.length})`;
    tr.appendChild(rot);
    for (const [valor, cls] of [[v.rec, "c-num"], [v.disp, "c-num"], [v.emp, "c-num"],
                                [v.mov, "c-meu c-meu--ini c-num"], [v.atual, "c-meu c-num"]]) {
      const c = document.createElement("td");
      c.className = cls + (valor < 0 ? " c-neg" : "");
      c.textContent = fmt(valor);
      tr.appendChild(c);
    }
    const fim = document.createElement("td");
    fim.className = "c-meu";
    tr.appendChild(fim);
    el.rodape.appendChild(tr);
  }

  function marcarOrdem() {
    for (const b of el.tabela.querySelectorAll("th button[data-ordem]")) {
      const ativa = b.dataset.ordem === estado.ordem.chave;
      b.closest("th").setAttribute("aria-sort",
        ativa ? (estado.ordem.dir === 1 ? "ascending" : "descending") : "none");
    }
  }

  /* ---------------------------------------------------------------------
     exportar
     ------------------------------------------------------------------ */

  function exportar() {
    if (!window.XLSX) { recado("A biblioteca de planilhas não carregou.", true); return; }
    const cab = ["Ação", "Fonte", "PTRES", "PI", "Descrição", "ND", "Crédito recebido",
                 "Disponível (Tesouro)", "Despesas empenhadas", "Movimentação",
                 "Disponível atualizado", "Lembrete"];
    const linhas = estado.dados.linhas.map((l) => [
      l.acao, l.fonte, l.ptres, l.pi, l.descricao, l.nd, l.recebido, l.disponivel, l.empenhado,
      movDe(l) / 100, atualizadoDe(l) / 100, aj(l).nota || ""]);
    const t = somar(estado.dados.linhas);
    linhas.push(["Total", "", "", "", "", "", t.rec / 100, t.disp / 100, t.emp / 100,
                 t.mov / 100, t.atual / 100, ""]);

    const ws = XLSX.utils.aoa_to_sheet([cab, ...linhas]);
    ws["!cols"] = [8, 13, 9, 14, 42, 9, 16, 18, 18, 16, 20, 40].map((w) => ({ wch: w }));
    const ult = linhas.length;
    for (let r = 1; r <= ult; r++)
      for (const c of [6, 7, 8, 9, 10]) {
        const ref = ws[XLSX.utils.encode_cell({ r, c })];
        if (ref) ref.z = "#,##0.00;[Red]-#,##0.00";
      }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Crédito Disponível");
    const dia = new Date(estado.dados.atualizado);
    const nome = `Credito disponivel - ${isNaN(dia) ? "atual" : dia.toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, nome);
    recado(`${nome} gerado, com suas movimentações e lembretes.`);
  }

  /* ---------------------------------------------------------------------
     ligações
     ------------------------------------------------------------------ */

  let tBusca;
  el.procura.addEventListener("input", () => { clearTimeout(tBusca); tBusca = setTimeout(desenhar, 140); });
  for (const e of [el.fNd, el.fFonte, el.fSaldo]) e.addEventListener("change", desenhar);

  el.tabela.querySelector("thead").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-ordem]");
    if (!b) return;
    const k = b.dataset.ordem;
    if (estado.ordem.chave === k) {
      if (estado.ordem.dir === 1) estado.ordem.dir = -1;
      else estado.ordem = { chave: "", dir: 1 };      // terceiro clique: volta à ordem do arquivo
    } else estado.ordem = { chave: k, dir: 1 };
    desenhar();
  });

  el.recarregar.addEventListener("click", async () => {
    el.recarregar.disabled = true;
    el.recarregar.querySelector(".icone").classList.add("girando");
    await iniciar();
    el.recarregar.disabled = false;
    el.recarregar.querySelector(".icone").classList.remove("girando");
    if (estado.dados) recado(`Planilha de ${quando(estado.dados.atualizado)} (${estado.dados.origem}).`);
  });

  el.carregar.addEventListener("click", () => el.arquivo.click());
  el.arquivo.addEventListener("change", async () => {
    const f = el.arquivo.files[0];
    el.arquivo.value = "";
    if (!f) return;
    try {
      const dados = lerPlanilhaXlsx(await f.arrayBuffer());
      // o arquivo não traz a data do relatório; a do arquivo é a melhor pista
      dados.atualizado = new Date(f.lastModified || Date.now()).toISOString();
      const ok = gravar("credito:local",
        { dados, nome: f.name, carregadoEm: new Date().toISOString() });
      if (!ok) recado("Planilha lida, mas não consegui guardá-la neste navegador; vale só até recarregar.", true);
      await iniciar();
      recado(`${f.name}: ${dados.linhas.length} linhas carregadas.`);
    } catch (e) {
      recado(e.message || "Não consegui ler esta planilha.", true);
    }
  });

  el.exportar.addEventListener("click", exportar);

  let tZerar;
  function zerarTudo() {
    for (const k of Object.keys(estado.ajustes)) estado.ajustes[k].mov = 0;
    salvarAjustes();
    el.banner.hidden = true;
    desenhar();
    recado("Todas as movimentações foram zeradas. Os lembretes continuam.");
  }
  el.zerar.addEventListener("click", () => {
    if (!temMovimento()) { recado("Não há movimentações para zerar."); return; }
    if (el.zerar.dataset.confirma) {
      clearTimeout(tZerar); delete el.zerar.dataset.confirma;
      el.zerar.textContent = "Zerar movimentações";
      zerarTudo();
      return;
    }
    el.zerar.dataset.confirma = "1";
    el.zerar.textContent = "Confirmar: zerar todas";
    tZerar = setTimeout(() => {
      delete el.zerar.dataset.confirma; el.zerar.textContent = "Zerar movimentações";
    }, 4000);
  });
  el.bannerZerar.addEventListener("click", zerarTudo);
  el.bannerManter.addEventListener("click", () => {
    estado.base = estado.dados.atualizado;
    gravar(chaveArmazem(), { base: estado.base, linhas: estado.ajustes });
    el.banner.hidden = true;
  });

  if (el.versao) el.versao.textContent = `Crédito Disponível · v${VERSAO}`;

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
