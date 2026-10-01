/* =============================================================================
   Planilha de resultado no layout do SILOMS
   =============================================================================
   Antes esta planilha era montada no servidor, em Python. Agora é montada
   aqui, no navegador: você clica e o download sai na hora, sem ida e volta.

   Quinze colunas, uma linha por item:

     LOTE | ITEM | REQUISIÇÃO | CNPJ | EMPRESA | QTDE | UND |
     VALOR UNIT LIC | VALOR TOTAL LICI | PRAZO | DESCRIÇÃO |
     SITUAÇÃO | FORNECEDOR | MODELO/VERSAO | MARCA

   Item sem vencedor ocupa UMA linha, com o aviso no lugar do CNPJ -- e não
   duas, como fazia a ferramenta que serviu de referência.
   ========================================================================== */

(function (global) {
  "use strict";

  const COLUNAS = [
    "LOTE", "ITEM", "REQUISIÇÃO", "CNPJ", "EMPRESA", "QTDE", "UND",
    "VALOR UNIT LIC", "VALOR TOTAL LICI", "PRAZO", "DESCRIÇÃO",
    "SITUAÇÃO", "FORNECEDOR", "MODELO/VERSAO", "MARCA",
  ];

  const LARGURAS = [8, 8, 12, 52, 45, 10, 8, 15, 17, 8, 30, 16, 18, 16, 14];

  const SEM_RESULTADO =
    "Item deserto/fracassado ou sem retorno na base consultada";

  const PRAZO_PADRAO = 30;

  // colunas (base zero) que recebem formato numérico de 4 casas
  const COL_VALOR = [7, 8];
  const COL_CNPJ = 3;

  /** CNPJ/CPF como texto, para o Excel não comer o zero à esquerda. */
  function documento(ni) {
    const d = String(ni || "").replace(/\D/g, "");
    if (!d) return "";
    return d.length <= 11 ? d.padStart(11, "0") : d.padStart(14, "0");
  }

  function numero(v) {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function ordemItem(n) {
    const i = parseInt(n, 10);
    return Number.isFinite(i) ? i : 1e9;
  }

  /**
   * Monta as linhas cruzando itens com seus resultados.
   *
   * opcoes.extras             preenche UND, DESCRIÇÃO e SITUAÇÃO
   *                           (o modelo do SILOMS vem com elas em branco)
   * opcoes.todosClassificados uma linha por fornecedor, não só o vencedor
   */
  function montar(detalhe, opcoes) {
    const op = opcoes || {};
    const itens = (detalhe.itens || []).slice();
    const resultados = detalhe.resultados || [];

    const porItem = new Map();
    for (const r of resultados) {
      if (!porItem.has(r.item)) porItem.set(r.item, []);
      porItem.get(r.item).push(r);
    }
    for (const lista of porItem.values()) {
      lista.sort((a, b) =>
        (a.ordem || 9999) - (b.ordem || 9999) ||
        (a.sequencial || 9999) - (b.sequencial || 9999));
    }

    // sem lista de itens, monta a partir dos próprios resultados
    let base = itens;
    if (!base.length && resultados.length) {
      const vistos = new Set();
      base = [];
      for (const r of resultados) {
        if (vistos.has(r.item)) continue;
        vistos.add(r.item);
        base.push({
          id: r.item, numero: r.numero, grupo: 0,
          descricao: "", unidade: "", quantidade: 0,
        });
      }
    }

    base.sort((a, b) => ordemItem(a.numero) - ordemItem(b.numero) ||
                        String(a.id).localeCompare(String(b.id)));

    const linhas = [];
    for (const it of base) {
      const n = ordemItem(it.numero);
      const num = n === 1e9 ? "" : n;
      const lote = numero(it.grupo) || "";
      const und = op.extras ? (it.unidade || "") : "";
      const desc = op.extras ? (it.descricao || "") : "";

      let vencedores = porItem.get(it.id) || [];
      if (!op.todosClassificados) vencedores = vencedores.slice(0, 1);

      if (!vencedores.length) {
        linhas.push([lote, num, "", SEM_RESULTADO, "", 0, und,
                     0, 0, null, desc, "", "", "", ""]);
        continue;
      }

      for (const v of vencedores) {
        const qtd = numero(v.quantidade);
        const unit = numero(v.unitario);
        let total = numero(v.total);
        if (!total && qtd && unit) total = Math.round(qtd * unit * 1e4) / 1e4;
        linhas.push([
          lote, num, "", documento(v.ni), v.empresa || "",
          qtd, und, unit, total, PRAZO_PADRAO, desc,
          op.extras ? (v.situacao || "") : "", "", "", "",
        ]);
      }
    }

    return linhas;
  }

  /** Nome de arquivo seguro, a partir do título do certame. */
  function nomeArquivo(titulo) {
    const limpo = String(titulo || "resultado")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${limpo || "resultado"}.xlsx`;
  }

  /**
   * Gera e baixa o arquivo.
   *
   * Nota honesta sobre a biblioteca: a edição comunitária do SheetJS escreve
   * valores, formato numérico, largura de coluna e filtro, mas não escreve
   * estilo de célula. O cabeçalho sai sem negrito e sem fundo cinza. Para a
   * importação no SILOMS isso é indiferente -- o que importa é a posição e o
   * valor de cada coluna, e esses saem idênticos ao modelo.
   */
  function gerar(detalhe, opcoes) {
    if (!global.XLSX) {
      throw new Error(
        "A biblioteca de planilhas não carregou. Se a rede daqui bloqueia " +
        "CDN, veja a observação no topo do index.html sobre a cópia local.");
    }

    const linhas = montar(detalhe, opcoes);
    if (!linhas.length) {
      throw new Error("Este certame não tem itens publicados na base de dados abertos.");
    }

    const ws = global.XLSX.utils.aoa_to_sheet([COLUNAS, ...linhas]);

    // formato por célula
    for (let i = 0; i < linhas.length; i++) {
      const linha = i + 2;                       // 1 é o cabeçalho
      for (const c of COL_VALOR) {
        const ref = global.XLSX.utils.encode_cell({ r: linha - 1, c });
        if (ws[ref]) ws[ref].z = "0.0000";
      }
      // o CNPJ já vai como texto (t:"s"), o que garante o zero à esquerda
      // mesmo se o formato de célula não for aplicado
      const refCnpj = global.XLSX.utils.encode_cell({ r: linha - 1, c: COL_CNPJ });
      if (ws[refCnpj]) { ws[refCnpj].t = "s"; ws[refCnpj].z = "@"; }
    }

    ws["!cols"] = LARGURAS.map((wch) => ({ wch }));
    ws["!autofilter"] = {
      ref: global.XLSX.utils.encode_range(
        { s: { r: 0, c: 0 }, e: { r: linhas.length, c: COLUNAS.length - 1 } }),
    };

    const wb = global.XLSX.utils.book_new();
    global.XLSX.utils.book_append_sheet(wb, ws, "Sheet0");
    global.XLSX.writeFile(wb, nomeArquivo(detalhe.titulo));

    return resumo(linhas);
  }

  function resumo(linhas) {
    let com = 0, sem = 0, valor = 0;
    const itens = new Set();
    for (const l of linhas) {
      itens.add(l[1]);
      if (l[3] === SEM_RESULTADO) { sem++; } else { com++; valor += numero(l[8]); }
    }
    return { itens: itens.size, com, sem, valor };
  }

  global.SILOMS = { gerar, montar, nomeArquivo, SEM_RESULTADO, COLUNAS };
})(window);
