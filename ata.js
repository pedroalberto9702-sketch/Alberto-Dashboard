/* =============================================================================
   Gerador da Ata de Registro de Preços
   =============================================================================
   Monta o PDF inteiro dentro do navegador, a partir do modelo em
   ata-modelo.js e dos dados já coletados do Compras.gov.br. Nada é enviado
   para servidor nenhum.

   Uma ATA por fornecedor, como manda o modelo: a tabela traz apenas os itens
   que aquela empresa venceu, e os itens desertos simplesmente não aparecem.

   DUAS CORREÇÕES EM RELAÇÃO AO .docm DE ORIGEM, ambas deliberadas:

   1. No modelo, a cláusula 1.1 terminava com "edital de Licitação nº
      90054/2026" escrito à mão, e não como campo. Toda ATA gerada sairia
      citando aquele pregão, qualquer que fosse o certame. Aqui o número vem
      do próprio certame.

   2. A mesma cláusula dizia "para a eventual contratação de  conforme
      <<OBJETO>> especificado itens no Termo de Referência" -- o objeto caía
      no lugar errado da frase. Ficou "para a eventual contratação de
      <<OBJETO>>, conforme especificado no Termo de Referência", que é como
      o modelo da AGU se lê.

   Se preferir manter o texto exatamente como estava, é só avisar.
   ========================================================================== */

(function (global) {
  "use strict";

  const M = () => global.ATA_MODELO;

  /* ======================================================================
     formatação
     =================================================================== */

  const moeda = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  const quantidade = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 4,
  });

  function reais(v) {
    return "R$ " + moeda.format(Number(v) || 0);
  }

  function documento(ni) {
    const d = String(ni || "").replace(/\D/g, "").padStart(14, "0");
    if (d.length === 14) {
      return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    }
    return String(ni || "");
  }

  /**
   * Número do processo no formato do protocolo.
   *
   * A base devolve ora formatado ("67293.008737/2025-60"), ora só os
   * dígitos ("67293001631202616"). Na ata precisa sair sempre igual.
   */
  function processo(valor) {
    const txt = String(valor || "").trim();
    if (!txt) return "";
    if (/[./-]/.test(txt)) return txt;              // já veio formatado
    const d = txt.replace(/\D/g, "");
    if (d.length === 17) {
      return d.replace(/^(\d{5})(\d{6})(\d{4})(\d{2})$/, "$1.$2/$3-$4");
    }
    return txt;
  }

  /** Objeto sem o ponto final, que entraria no meio da frase da cláusula 1.1. */
  function objetoLimpo(texto) {
    return String(texto || "").trim().replace(/[.;,\s]+$/, "");
  }

  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
                 "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

  /** "2025-11-28" ou "28/11/2025" -> "28 de novembro de 2025" */
  function dataPorExtenso(valor) {
    const txt = String(valor || "").trim();
    if (!txt) return "";
    let a, m, d;
    let p = txt.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (p) { [, a, m, d] = p; } else {
      p = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!p) return txt;
      [, d, m, a] = p;
    }
    const mi = parseInt(m, 10) - 1;
    if (mi < 0 || mi > 11) return txt;
    return `${parseInt(d, 10)} de ${MESES[mi]} de ${a}`;
  }

  /** "Pregão Eletrônico" -> "pregão" (o modelo já diz "na forma eletrônica") */
  function modalidadeCurta(nome) {
    const n = String(nome || "").toLowerCase();
    if (n.includes("pregão")) return "pregão";
    if (n.includes("concorrência")) return "concorrência";
    if (n.includes("credenciamento")) return "credenciamento";
    if (n.includes("dispensa")) return "dispensa de licitação";
    if (n.includes("inexigibilidade")) return "inexigibilidade de licitação";
    return n || "licitação";
  }

  function trocar(texto, campos) {
    return String(texto).replace(/<<([A-Z_]+)>>/g, (todo, nome) =>
      campos[nome] !== undefined && campos[nome] !== null && campos[nome] !== ""
        ? String(campos[nome])
        : "____________");
  }

  function nomeArquivo(numeroAta, empresa) {
    const limpo = (s) => String(s || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ").trim();
    const n = limpo(numeroAta).replace(/\s+/g, "-") || "SEM-NUMERO";
    return `ATA ${n} - ${limpo(empresa) || "FORNECEDOR"}.pdf`;
  }

  /* ======================================================================
     agrupamento dos vencedores
     =================================================================== */

  /**
   * Devolve os fornecedores que venceram itens do certame, cada um com os
   * seus itens já casados com a descrição e a unidade.
   *
   * Só entram os primeiros colocados: a ATA registra o preço do adjudicatário,
   * não do cadastro de reserva.
   */
  function vencedores(detalhe) {
    const itens = global.SILOMS
      ? global.SILOMS.semRepetidos(detalhe.itens)
      : (detalhe.itens || []);
    const porId = new Map(itens.map((i) => [i.id, i]));

    const primeiros = new Map();      // idCompraItem -> melhor resultado
    for (const r of (detalhe.resultados || [])) {
      const atual = primeiros.get(r.item);
      const melhor = (a, b) =>
        ((a.ordem || 9999) - (b.ordem || 9999)) ||
        ((a.sequencial || 9999) - (b.sequencial || 9999));
      if (!atual || melhor(r, atual) < 0) primeiros.set(r.item, r);
    }

    const empresas = new Map();
    for (const r of primeiros.values()) {
      const ni = String(r.ni || "").replace(/\D/g, "");
      if (!ni) continue;
      if (!empresas.has(ni)) {
        empresas.set(ni, { ni, nome: r.empresa || "", itens: [], total: 0 });
      }
      const e = empresas.get(ni);
      const it = porId.get(r.item) || {};
      const total = r.total || (r.quantidade * r.unitario) || 0;
      e.itens.push({
        numero: it.numero ?? r.numero,
        descricao: it.descricao || "",
        quantidade: r.quantidade || it.quantidade || 0,
        unidade: it.unidade || "",
        unitario: r.unitario || 0,
        total,
      });
      e.total += total;
    }

    const saida = [...empresas.values()];
    for (const e of saida) {
      e.itens.sort((a, b) => (parseInt(a.numero, 10) || 1e9) -
                             (parseInt(b.numero, 10) || 1e9));
      e.total = Math.round(e.total * 100) / 100;
    }
    saida.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return saida;
  }

  /* ======================================================================
     montagem do documento
     =================================================================== */

  function corpo(dados) {
    const m = M();
    const { certame, fornecedor, numeroAta, douNum, douData } = dados;

    const campos = {
      PROCESSO: processo(certame.processo) || "____________",
      NUMERO_DA_ATA: numeroAta || "",
      MODALIDADE: modalidadeCurta(certame.modalidade),
      NUM_PREGAO: certame.numero || "",
      DOU_NUM: douNum || "",
      DOU_DATA: dataPorExtenso(douData),
      OBJETO: objetoLimpo(certame.objeto),
      EMPRESA: fornecedor.nome,
      CNPJ: documento(fornecedor.ni),
    };

    const conteudo = [];

    /* ---- cabeçalho ---- */
    conteudo.push({ text: m.orgao.lei, style: "lei" });
    conteudo.push({ image: m.brasao, width: 52, alignment: "center",
                    margin: [0, 6, 0, 6] });
    for (const l of m.orgao.linhas) {
      conteudo.push({ text: l, style: "orgao" });
    }
    conteudo.push({ text: `Processo Administrativo n° ${campos.PROCESSO}`,
                    style: "titulo", margin: [0, 14, 0, 0] });
    conteudo.push({ text: `Ata de Registro de Preços nº ${campos.NUMERO_DA_ATA ||
                    "____________"}`, style: "titulo", margin: [0, 2, 0, 14] });

    /* ---- parágrafo de abertura ---- */
    conteudo.push({ text: trocar(m.abertura, campos), style: "corpo" });

    /* ---- cláusulas, com a tabela encaixada depois da 2.1 ---- */
    for (const c of m.clausulas) {
      conteudo.push(clausula(c, campos));
      if (c.num === m.apos) {
        conteudo.push(...blocoDaEmpresa(campos, fornecedor));
      }
    }

    /* ---- fecho e assinaturas ---- */
    // Tudo num bloco só: o fecho e as assinaturas nunca se separam, e uma
    // assinatura não fica sozinha numa página.
    const bloco = [
      { text: m.fecho[0], style: "corpo", margin: [0, 16, 0, 0],
        alignment: "center" },
      { text: m.fecho[1], style: "assinaturaTitulo", margin: [0, 24, 0, 0] },
    ];
    for (const papel of m.fecho.slice(2)) {
      bloco.push({
        stack: [
          { canvas: [{ type: "line", x1: 0, y1: 0, x2: 200, y2: 0,
                       lineWidth: 0.6, lineColor: "#555555" }],
            alignment: "center", margin: [0, 26, 0, 3] },
          { text: papel, style: "assinatura" },
        ],
      });
    }
    conteudo.push({ stack: bloco, unbreakable: true });

    return conteudo;
  }

  function clausula(c, campos) {
    let texto = trocar(c.t, campos);

    // correção 2: o objeto no lugar certo da frase (ver cabeçalho do arquivo)
    if (c.num === "1.1.") {
      texto = `A presente Ata tem por objeto o registro de preços para a ` +
              `eventual contratação de ${campos.OBJETO}, conforme especificado ` +
              `no Termo de Referência, anexo do edital de Licitação nº ` +
              `${campos.NUM_PREGAO}, que é parte integrante desta Ata, assim ` +
              `como as propostas cujos preços tenham sido registrados, ` +
              `independentemente de transcrição.`;
    }

    if (c.n === 1) {
      return { text: `${c.num} ${texto}`, style: "secao" };
    }
    if (c.n === 0) {
      return { text: texto, style: "subtitulo" };
    }
    return {
      text: `${c.num} ${texto}`,
      style: "corpo",
      margin: [(c.n - 2) * 14, 3, 0, 3],
    };
  }

  function blocoDaEmpresa(campos, fornecedor) {
    const linhas = [[
      { text: "ITEM", style: "th" },
      { text: "DESCRIÇÃO", style: "th" },
      { text: "QTDE", style: "th" },
      { text: "UNIDADE DE MEDIDA", style: "th" },
      { text: "VALOR UNITÁRIO (R$)", style: "th" },
      { text: "VALOR TOTAL (R$)", style: "th" },
    ]];

    for (const it of fornecedor.itens) {
      linhas.push([
        { text: String(it.numero ?? ""), style: "td", alignment: "center" },
        { text: it.descricao || "", style: "tdDesc" },
        { text: quantidade.format(it.quantidade || 0), style: "td",
          alignment: "center" },
        { text: it.unidade || "", style: "td", alignment: "center" },
        { text: reais(it.unitario), style: "td", alignment: "right" },
        { text: reais(it.total), style: "td", alignment: "right" },
      ]);
    }

    linhas.push([
      { text: "TOTAL", style: "th", colSpan: 5, alignment: "right" },
      {}, {}, {}, {},
      { text: reais(fornecedor.total), style: "th", alignment: "right" },
    ]);

    return [
      { text: `EMPRESA:  ${campos.EMPRESA}`, style: "empresa",
        margin: [0, 10, 0, 0] },
      { text: `CNPJ:  ${campos.CNPJ}`, style: "empresa", margin: [0, 0, 0, 8] },
      {
        table: { headerRows: 1, dontBreakRows: true,
                 widths: [26, "*", 40, 52, 58, 62], body: linhas },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => "#999999",
          vLineColor: () => "#999999",
          paddingTop: () => 3, paddingBottom: () => 3,
          paddingLeft: () => 4, paddingRight: () => 4,
        },
        margin: [0, 0, 0, 10],
      },
    ];
  }

  function documentoPdf(dados) {
    const m = M();
    return {
      pageSize: "A4",
      pageMargins: [60, 50, 50, 56],
      info: {
        title: `Ata de Registro de Preços ${dados.numeroAta || ""}`.trim(),
        author: "Base Aérea de Porto Velho",
        subject: dados.certame.objeto || "",
      },
      content: corpo(dados),
      footer: (pagina, total) => ({
        margin: [60, 10, 50, 0],
        stack: [
          { text: `Página ${pagina} | ${total}`, style: "rodape",
            alignment: "right" },
          { text: m.rodape, style: "rodapeFonte" },
        ],
      }),
      defaultStyle: { font: "Roboto", fontSize: 9.5, lineHeight: 1.18 },
      styles: {
        lei: { fontSize: 8, alignment: "center", color: "#444444" },
        orgao: { fontSize: 9.5, bold: true, alignment: "center" },
        titulo: { fontSize: 10.5, bold: true, alignment: "center" },
        corpo: { fontSize: 9.5, alignment: "justify", margin: [0, 3, 0, 3] },
        secao: { fontSize: 10, bold: true, margin: [0, 12, 0, 4] },
        subtitulo: { fontSize: 9.5, bold: true, italics: true,
                     margin: [0, 8, 0, 2] },
        empresa: { fontSize: 10, bold: true },
        th: { fontSize: 8, bold: true, fillColor: "#EEEEEE" },
        td: { fontSize: 8 },
        tdDesc: { fontSize: 7.5, alignment: "justify" },
        assinaturaTitulo: { fontSize: 10, bold: true, alignment: "center" },
        assinatura: { fontSize: 9, alignment: "center" },
        rodape: { fontSize: 7.5, color: "#666666" },
        rodapeFonte: { fontSize: 6.5, color: "#888888", alignment: "center" },
      },
    };
  }

  /* ======================================================================
     interface pública
     =================================================================== */

  function conferir() {
    if (!global.pdfMake) {
      throw new Error(
        "A biblioteca de PDF não carregou. Se a rede bloqueia CDN, veja a " +
        "observação no index da página de ATAs sobre a cópia local.");
    }
    if (!M()) throw new Error("O modelo da ATA não carregou (ata-modelo.js).");
  }

  /** Gera e baixa um PDF. Devolve o nome do arquivo. */
  function gerar(dados) {
    conferir();
    if (!dados.fornecedor.itens.length) {
      throw new Error(`${dados.fornecedor.nome} não tem itens vencidos neste certame.`);
    }
    const nome = nomeArquivo(dados.numeroAta, dados.fornecedor.nome);
    global.pdfMake.createPdf(documentoPdf(dados)).download(nome);
    return nome;
  }

  function pdfEmBlob(dados) {
    return new Promise((ok, falha) => {
      try {
        global.pdfMake.createPdf(documentoPdf(dados)).getBlob(ok);
      } catch (e) { falha(e); }
    });
  }

  /**
   * Gera todas as atas e entrega num único .zip.
   *
   * Um download só, em vez de uma rajada de PDFs que o navegador estranha e
   * bloqueia. Dentro do zip cada arquivo tem o mesmo nome que teria se fosse
   * gerado sozinho.
   */
  async function gerarZip(lista, nomeZip, aoProgredir) {
    conferir();
    if (!global.JSZip) {
      throw new Error(
        "A biblioteca de ZIP não carregou. Se a rede bloqueia CDN, coloque " +
        "vendor/jszip.min.js no repositório.");
    }
    const zip = new global.JSZip();
    const usados = new Set();
    const nomes = [];
    for (let i = 0; i < lista.length; i++) {
      const d = lista[i];
      if (!d.fornecedor.itens.length) continue;
      if (aoProgredir) aoProgredir(i + 1, lista.length, d);
      let nome = nomeArquivo(d.numeroAta, d.fornecedor.nome);
      // dois fornecedores com o mesmo nome/número não podem se sobrescrever
      for (let k = 2; usados.has(nome.toLowerCase()); k++) {
        nome = nomeArquivo(d.numeroAta, d.fornecedor.nome).replace(/\.pdf$/i, ` (${k}).pdf`);
      }
      usados.add(nome.toLowerCase());
      zip.file(nome, await pdfEmBlob(d));
      nomes.push(nome);
      // deixa a tela respirar entre um PDF e outro
      await new Promise((r) => setTimeout(r, 0));
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nomeZip;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return nomes;
  }

  global.ATA = { gerar, gerarZip, vencedores, nomeArquivo,
                 documento, dataPorExtenso, modalidadeCurta };
})(window);
