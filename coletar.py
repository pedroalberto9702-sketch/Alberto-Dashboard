#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=============================================================================
 Coletor -- transforma as consultas lentas em arquivos prontos
=============================================================================
 Roda na rotina agendada do GitHub Actions. Para cada unidade e ano pedidos:

   1. busca os certames do ano (uma consulta por modalidade);
   2. busca TODOS os itens do ano, de uma vez;
   3. busca TODOS os resultados do ano, de uma vez;
   4. agrupa itens e resultados por certame, aqui, em memoria;
   5. grava um indice enxuto e um arquivo por certame.

 O site le esses arquivos. Ele nunca fala com o Compras.gov.br, e por isso
 abre instantaneamente mesmo quando a API esta levando um minuto por
 consulta.

 Uma regra importante no fim do arquivo: se uma execucao nao trouxer nada,
 os dados anteriores sao preservados. Um dia de dado velho e melhor do que
 um site vazio porque o servidor estava fora do ar.

 Variaveis de ambiente:
   UASGS   lista separada por virgula. Ex.: "120641,120090"
   ANOS    lista separada por virgula. Padrao: ano corrente
   SAIDA   pasta de destino. Padrao: "dados"
=============================================================================
"""

import json
import os
import shutil
import sys
import time
from datetime import date, datetime, timedelta, timezone

import comprasnet as cn

FUSO = timezone(timedelta(hours=-3))      # horário de Brasília


def _agora():
    return datetime.now(FUSO).isoformat(timespec="seconds")


def _log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def _gravar(caminho, dados):
    """Grava JSON compacto, criando a pasta se preciso."""
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, separators=(",", ":"))


def _ler(caminho):
    try:
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# =============================================================================
# RECORTE DOS CAMPOS
# =============================================================================

def _item_enxuto(it):
    """Só o que o site e a planilha usam."""
    return {
        "id": it.get("idCompraItem"),
        "numero": it.get("numeroItemCompra"),
        "grupo": it.get("numeroGrupo") or 0,
        "descricao": (it.get("descricaoResumida") or "").strip(),
        "unidade": (it.get("unidadeMedida") or "").strip(),
        "quantidade": float(it.get("quantidade") or 0),
        "estimado_unitario": float(it.get("valorUnitarioEstimado") or 0),
        "estimado_total": float(it.get("valorTotal") or 0),
        "tipo": it.get("materialOuServico") or "",
        "situacao": (it.get("situacaoCompraItemNome") or "").strip(),
    }


def _resultado_enxuto(r):
    """
    Guardamos TODOS os classificados, não só o vencedor -- é o que permite
    ver a ordem dos fornecedores item por item.
    """
    qtd = float(r.get("quantidadeHomologada") or 0)
    unit = float(r.get("valorUnitarioHomologado") or 0)
    total = float(r.get("valorTotalHomologado") or 0)
    if not total and qtd and unit:
        total = round(qtd * unit, 4)
    return {
        "item": r.get("idCompraItem"),
        "numero": r.get("numeroItemPncp"),
        "ordem": r.get("ordemClassificacaoSrp") or 0,
        "sequencial": r.get("sequencialResultado") or 0,
        "ni": cn.so_digitos(r.get("niFornecedor")),
        "porte": (r.get("porteFornecedorNome") or "").strip(),
        "empresa": (r.get("nomeRazaoSocialFornecedor") or "").strip(),
        "quantidade": qtd,
        "unitario": unit,
        "total": total,
        "situacao": (r.get("situacaoCompraItemResultadoNome") or "").strip(),
        "data": cn.dia(r.get("dataResultado")),
    }


# =============================================================================
# UMA UNIDADE, UM ANO
# =============================================================================

def coletar(uasg, ano, saida):
    pasta = os.path.join(saida, str(uasg), str(ano))
    caminho_indice = os.path.join(pasta, "certames.json")
    anterior = _ler(caminho_indice)

    _log(f"=== UASG {uasg}, ano {ano} ===")
    inicio = time.monotonic()
    avisos = []

    # ---- 1. certames -------------------------------------------------------
    try:
        certames, av = cn.certames_do_ano(uasg, ano)
        avisos += av
    except Exception as e:                                # noqa: BLE001
        _log(f"  certames: falha geral ({e})")
        certames, avisos = [], avisos + [f"certames: {e}"]

    if not certames:
        if anterior and anterior.get("certames"):
            _log("  nada retornou; dados anteriores preservados")
            anterior["tentativa"] = _agora()
            anterior["avisos"] = (anterior.get("avisos") or []) + \
                                 ["última atualização não retornou dados"]
            _gravar(caminho_indice, anterior)
            return anterior, False
        _log("  nada retornou e não havia dado anterior")
        _gravar(caminho_indice, {
            "uasg": str(uasg), "ano": ano, "nome": "",
            "atualizado": _agora(), "certames": [],
            "avisos": avisos or ["nenhum certame encontrado"],
        })
        return None, False

    _log(f"  {len(certames)} certame(s)")

    # ---- 2 e 3. itens e resultados do ano, de uma vez -----------------------
    try:
        itens, av = cn.itens_do_ano(uasg, ano)
        avisos += av
    except Exception as e:                                # noqa: BLE001
        _log(f"  itens: falha geral ({e})")
        itens, avisos = [], avisos + [f"itens: {e}"]

    try:
        resultados, av = cn.resultados_do_ano(uasg, ano)
        avisos += av
    except Exception as e:                                # noqa: BLE001
        _log(f"  resultados: falha geral ({e})")
        resultados, avisos = [], avisos + [f"resultados: {e}"]

    _log(f"  {len(itens)} item(ns), {len(resultados)} resultado(s)")

    # ---- 4. agrupamento ----------------------------------------------------
    itens_por_compra, resultados_por_compra = {}, {}
    for it in itens:
        itens_por_compra.setdefault(it.get("idCompra"), []).append(it)
    for r in resultados:
        resultados_por_compra.setdefault(r.get("idCompra"), []).append(r)

    # ---- 5. um arquivo por certame -----------------------------------------
    pasta_certames = os.path.join(pasta, "certame")
    nova = pasta_certames + ".novo"
    shutil.rmtree(nova, ignore_errors=True)

    for c in certames:
        meus_itens = [_item_enxuto(x) for x in itens_por_compra.get(c["id"], [])]
        meus_itens.sort(key=lambda x: (_ordem(x["numero"]), x["id"] or ""))

        meus_res = [_resultado_enxuto(x)
                    for x in resultados_por_compra.get(c["id"], [])]
        meus_res.sort(key=lambda x: (_ordem(x["numero"]),
                                     x["ordem"] or 9999,
                                     x["sequencial"] or 9999))

        vencedores = {}
        for r in meus_res:
            vencedores.setdefault(r["item"], r)

        c["qtd_itens"] = len(meus_itens) or len(vencedores)
        c["qtd_com_vencedor"] = len(vencedores)
        c["valor_resultado"] = round(sum(v["total"] for v in vencedores.values()), 2)

        _gravar(os.path.join(nova, f"{c['arquivo']}.json"), {
            "id": c["id"],
            "titulo": c["titulo"],
            "uasg": str(uasg),
            "ano": ano,
            "objeto": c["objeto"],
            "atualizado": _agora(),
            "itens": meus_itens,
            "resultados": meus_res,
        })

    # troca a pasta inteira de uma vez, para o site nunca ler um estado parcial
    shutil.rmtree(pasta_certames, ignore_errors=True)
    os.replace(nova, pasta_certames)

    # ---- indice ------------------------------------------------------------
    nome = cn.nome_uasg(uasg) or (anterior or {}).get("nome", "")
    indice = {
        "uasg": str(uasg),
        "nome": nome,
        "ano": ano,
        "atualizado": _agora(),
        "segundos": round(time.monotonic() - inicio, 1),
        "avisos": avisos,
        "resumo": _resumo(certames),
        "certames": certames,
    }
    _gravar(caminho_indice, indice)
    _log(f"  concluído em {indice['segundos']:.0f}s"
         + (f" · {len(avisos)} aviso(s)" if avisos else ""))
    return indice, True


def _ordem(n):
    try:
        return int(n)
    except (TypeError, ValueError):
        return 10 ** 9


def _resumo(certames):
    por_fase = {}
    for c in certames:
        por_fase[c["fase"]] = por_fase.get(c["fase"], 0) + 1
    return {
        "total": len(certames),
        "por_fase": por_fase,
        "estimado": round(sum(c["valor_estimado"] for c in certames), 2),
        "homologado": round(sum(c["valor_homologado"] for c in certames), 2),
    }


# =============================================================================
# PRINCIPAL
# =============================================================================

def main():
    uasgs = [u.strip() for u in os.environ.get("UASGS", "120641").split(",")
             if u.strip()]
    anos_txt = os.environ.get("ANOS", "").strip()
    anos = ([int(a) for a in anos_txt.split(",") if a.strip()]
            if anos_txt else [date.today().year])
    saida = os.environ.get("SAIDA", "dados")

    _log(f"unidades: {', '.join(uasgs)} · anos: "
         f"{', '.join(str(a) for a in anos)}")

    unidades, houve_sucesso = {}, False
    for uasg in uasgs:
        for ano in anos:
            try:
                indice, ok = coletar(uasg, ano, saida)
            except Exception as e:                        # noqa: BLE001
                _log(f"  ERRO não tratado em {uasg}/{ano}: {e}")
                continue
            houve_sucesso = houve_sucesso or ok
            if indice:
                u = unidades.setdefault(uasg, {
                    "uasg": uasg, "nome": indice.get("nome", ""), "anos": [],
                })
                u["nome"] = u["nome"] or indice.get("nome", "")
                u["anos"].append({
                    "ano": ano,
                    "atualizado": indice.get("atualizado", ""),
                    "total": (indice.get("resumo") or {}).get("total", 0),
                })

    # o indice geral junta o que foi coletado agora com o que ja existia,
    # para que uma execucao parcial nao apague unidades do menu
    caminho_geral = os.path.join(saida, "indice.json")
    antigo = _ler(caminho_geral) or {}
    juntas = {u["uasg"]: u for u in (antigo.get("unidades") or [])}
    juntas.update({u["uasg"]: u for u in unidades.values()})

    for u in juntas.values():
        u["anos"] = sorted(
            {a["ano"]: a for a in u["anos"]}.values(),
            key=lambda a: a["ano"], reverse=True)

    _gravar(caminho_geral, {
        "atualizado": _agora(),
        "unidades": sorted(juntas.values(), key=lambda u: u["uasg"]),
    })

    if not houve_sucesso:
        _log("nenhuma coleta foi bem-sucedida")
        sys.exit(1)
    _log("fim")


if __name__ == "__main__":
    main()
