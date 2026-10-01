#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=============================================================================
 Cliente da API de Dados Abertos do Compras.gov.br
=============================================================================
 Este arquivo roda numa rotina agendada, nao dentro de uma pagina. Ninguem
 esta esperando a resposta, e isso muda tudo em relacao a versao anterior:

   - nao existe prazo para abandonar a consulta. Se o servidor levar dois
     minutos para responder, esperamos os dois minutos.
   - uma falha nao precisa virar mensagem de erro bonita na tela. Ela vira
     uma nova tentativa, e depois um aviso no registro da execucao.
   - os itens e os resultados do ano sao buscados UMA vez e agrupados aqui,
     em memoria. A versao que rodava no site repetia a consulta do ano
     inteiro para cada certame aberto, porque os endpoints 2 e 3 nao aceitam
     filtrar por licitacao. Era esse desperdicio, somado a lentidao do
     servidor, que estourava o tempo.
=============================================================================
"""

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime

import requests
from requests.adapters import HTTPAdapter

BASE = "https://dadosabertos.compras.gov.br"

TAMANHO_PAGINA = 500        # maximo aceito pela API
PARALELO = 4                # paginas buscadas ao mesmo tempo
TENTATIVAS = 3              # repeticoes por pagina antes de desistir

# (tempo para conectar, tempo maximo sem receber bytes). O segundo numero e
# grande de proposito: o endpoint de contratacoes costuma levar de 40 a 120
# segundos para comecar a responder.
ESPERA = (30, 300)

MODALIDADES = {
    5: "Pregão Eletrônico",
    6: "Dispensa Eletrônica",
    7: "Inexigibilidade",
    8: "Dispensa",
    3: "Concorrência Eletrônica",
    12: "Credenciamento",
    13: "Leilão Eletrônico",
    1: "Convite",
    2: "Tomada de Preços",
}

MODALIDADES_PADRAO = (5, 6, 7, 3, 12)

FASES = [
    "Aguardando abertura",
    "Em disputa",
    "Em habilitação",
    "Em homologação",
    "Homologado",
]

SESSAO = requests.Session()
SESSAO.headers.update({
    "accept": "application/json",
    "User-Agent": "painel-certames/3.0 (rotina agendada)",
})
# um pool por host basta, mas precisa caber as paginas em paralelo
SESSAO.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=PARALELO + 2))


def _log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# =============================================================================
# REQUISIÇÃO
# =============================================================================

def _pagina(endpoint, params, numero):
    """Baixa uma pagina, repetindo se o servidor falhar."""
    p = dict(params, pagina=numero, tamanhoPagina=TAMANHO_PAGINA)
    ultimo = None

    for tentativa in range(1, TENTATIVAS + 1):
        inicio = time.monotonic()
        try:
            r = SESSAO.get(f"{BASE}/{endpoint}", params=p, timeout=ESPERA)
            gasto = time.monotonic() - inicio

            if r.status_code == 204:          # sem conteudo
                return {}
            if r.status_code == 200:
                if gasto > 20:
                    _log(f"    página {numero} levou {gasto:.0f}s")
                return r.json()

            # 429 e 5xx valem nova tentativa; 4xx restante nao
            if r.status_code != 429 and r.status_code < 500:
                raise RuntimeError(f"HTTP {r.status_code} em {endpoint}")
            ultimo = RuntimeError(f"HTTP {r.status_code}")

        except (requests.RequestException, ValueError) as e:
            ultimo = e

        if tentativa < TENTATIVAS:
            pausa = 5 * tentativa
            _log(f"    página {numero} falhou ({ultimo}); nova tentativa em {pausa}s")
            time.sleep(pausa)

    raise RuntimeError(f"{endpoint} página {numero}: {ultimo}")


def consultar(endpoint, params, rotulo=""):
    """
    Busca todas as paginas de um endpoint.

    A primeira pagina informa quantas existem; as demais vem em blocos
    paralelos. Uma pagina que falhe depois das tentativas e registrada e a
    busca continua -- um buraco no meio do ano e melhor do que nenhum dado.
    """
    registros, perdidas = [], []

    primeira = _pagina(endpoint, params, 1)
    registros.extend(primeira.get("resultado") or [])
    total = int(primeira.get("totalPaginas") or 1)

    if rotulo:
        _log(f"  {rotulo}: {total} página(s), "
             f"{primeira.get('totalRegistros') or len(registros)} registro(s)")

    if total <= 1:
        return registros, perdidas

    restantes = list(range(2, total + 1))
    with ThreadPoolExecutor(max_workers=PARALELO) as executor:
        futuros = {executor.submit(_pagina, endpoint, params, n): n
                   for n in restantes}
        for f in as_completed(futuros):
            n = futuros[f]
            try:
                registros.extend(f.result().get("resultado") or [])
            except Exception as e:                        # noqa: BLE001
                _log(f"    página {n} perdida: {e}")
                perdidas.append(n)

    return registros, perdidas


# =============================================================================
# AUXILIARES
# =============================================================================

def so_digitos(v):
    return re.sub(r"\D", "", str(v or ""))


def para_data(valor):
    if not valor:
        return None
    txt = str(valor).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(txt).date()
    except ValueError:
        try:
            return date.fromisoformat(txt[:10])
        except ValueError:
            return None


def dia(valor):
    d = para_data(valor)
    return d.isoformat() if d else ""


def numero_legivel(numero_compra, ano):
    """'000612026' vira '61/2026'."""
    d = so_digitos(numero_compra)
    if len(d) >= 9:
        seq, a = d[:-4], d[-4:]
        return f"{int(seq)}/{a}"
    if d:
        return f"{int(d)}/{ano}"
    return f"?/{ano}"


def nome_arquivo(id_compra):
    """Identificador seguro para nome de arquivo."""
    return re.sub(r"[^A-Za-z0-9_-]", "", str(id_compra or "")) or "sem-id"


def fase(compra, hoje=None):
    """
    Deduz em que fase o certame esta.

    A API de dados abertos nao expoe o andamento operacional do
    Compras.gov.br. Ela traz a situacao no PNCP (divulgada, revogada,
    anulada, suspensa), as datas de proposta e se ja existe resultado. A
    fase abaixo e deduzida desses campos -- nao e lida do sistema, e pode
    divergir do que aparece no portal de compras.
    """
    hoje = hoje or date.today()

    situacao = str(compra.get("situacaoCompraNomePncp") or "").strip()
    if situacao and "divulgad" not in situacao.lower():
        return {"nome": situacao, "ordem": None, "excecao": True}

    abertura = para_data(compra.get("dataAberturaPropostaPncp"))
    encerramento = para_data(compra.get("dataEncerramentoPropostaPncp"))
    tem_resultado = bool(compra.get("existeResultado"))
    homologado = float(compra.get("valorTotalHomologado") or 0) > 0

    if abertura and hoje < abertura:
        nome = "Aguardando abertura"
    elif abertura and encerramento and abertura <= hoje <= encerramento:
        nome = "Em disputa"
    elif encerramento and hoje > encerramento and not tem_resultado:
        nome = "Em habilitação"
    elif homologado:
        nome = "Homologado"
    elif tem_resultado:
        nome = "Em homologação"
    else:
        nome = "Em habilitação"

    return {"nome": nome, "ordem": FASES.index(nome) + 1, "excecao": False}


# =============================================================================
# CONSULTAS DO ANO
# =============================================================================

def _fim_do_ano(ano):
    hoje = date.today()
    return min(date(ano, 12, 31), hoje) if ano >= hoje.year else date(ano, 12, 31)


def certames_do_ano(uasg, ano, modalidades=MODALIDADES_PADRAO):
    """Certames da unidade no ano, com a fase deduzida."""
    hoje = date.today()
    fim = _fim_do_ano(ano)
    achados, avisos = {}, []

    for mod in modalidades:
        nome_mod = MODALIDADES.get(mod, str(mod))
        try:
            lote, perdidas = consultar(
                "modulo-contratacoes/1_consultarContratacoes_PNCP_14133",
                {
                    "unidadeOrgaoCodigoUnidade": str(uasg),
                    "dataPublicacaoPncpInicial": f"{ano}-01-01",
                    "dataPublicacaoPncpFinal": fim.isoformat(),
                    "codigoModalidade": mod,
                },
                rotulo=nome_mod,
            )
        except Exception as e:                            # noqa: BLE001
            _log(f"  {nome_mod}: falhou ({e})")
            avisos.append(f"{nome_mod}: não respondeu")
            continue

        if perdidas:
            avisos.append(f"{nome_mod}: {len(perdidas)} página(s) perdida(s)")
        for c in lote:
            if c.get("contratacaoExcluida"):
                continue
            achados[c.get("idCompra")] = c

    saida = []
    for c in achados.values():
        mod = int(c.get("codigoModalidade") or 0)
        ano_c = int(c.get("anoCompraPncp") or ano)
        f = fase(c, hoje)
        nome_mod = MODALIDADES.get(mod) or c.get("modalidadeNome") or "Contratação"
        numero = numero_legivel(c.get("numeroCompra"), ano_c)
        saida.append({
            "id": c.get("idCompra"),
            "arquivo": nome_arquivo(c.get("idCompra")),
            "titulo": f"{nome_mod} {uasg} - {numero}",
            "modalidade": nome_mod,
            "codigo_modalidade": mod,
            "numero": numero,
            "uasg": str(uasg),
            "ano": ano_c,
            "objeto": (c.get("objetoCompra") or "").strip(),
            "processo": str(c.get("processo") or "").strip(),
            "fase": f["nome"],
            "fase_ordem": f["ordem"],
            "fase_excecao": f["excecao"],
            "srp": bool(c.get("srp")),
            "abertura": dia(c.get("dataAberturaPropostaPncp")),
            "encerramento": dia(c.get("dataEncerramentoPropostaPncp")),
            "publicacao": dia(c.get("dataPublicacaoPncp")),
            "valor_estimado": float(c.get("valorTotalEstimado") or 0),
            "valor_homologado": float(c.get("valorTotalHomologado") or 0),
            "tem_resultado": bool(c.get("existeResultado")),
        })

    saida.sort(key=lambda x: (x["publicacao"], x["numero"]), reverse=True)
    return saida, avisos


def itens_do_ano(uasg, ano):
    """
    Todos os itens de contratacao da unidade no ano.

    O endpoint nao aceita filtrar por licitacao, so por unidade e data. Em
    vez de consultar o ano inteiro uma vez por certame, consultamos o ano
    inteiro uma vez e agrupamos aqui.
    """
    ini, fim = date(ano, 1, 1), _fim_do_ano(ano)
    base = {
        "unidadeOrgaoCodigoUnidade": str(uasg),
        "dataInclusaoPncpInicial": ini.isoformat(),
        "dataInclusaoPncpFinal": fim.isoformat(),
    }
    avisos = []

    registros, perdidas = consultar(
        "modulo-contratacoes/2_consultarItensContratacoes_PNCP_14133",
        base, rotulo="itens")
    if perdidas:
        avisos.append(f"itens: {len(perdidas)} página(s) perdida(s)")

    # Algumas unidades so retornam dados quando o tipo e informado. Se a
    # consulta aberta vier vazia, tentamos material e servico separados.
    if not registros:
        for tipo, rotulo in (("M", "itens (material)"), ("S", "itens (serviço)")):
            lote, perdidas = consultar(
                "modulo-contratacoes/2_consultarItensContratacoes_PNCP_14133",
                {**base, "materialOuServico": tipo}, rotulo=rotulo)
            registros.extend(lote)
            if perdidas:
                avisos.append(f"{rotulo}: {len(perdidas)} página(s) perdida(s)")

    return registros, avisos


def resultados_do_ano(uasg, ano):
    """Todos os resultados de itens da unidade no ano."""
    ini, fim = date(ano, 1, 1), _fim_do_ano(ano)
    registros, perdidas = consultar(
        "modulo-contratacoes/3_consultarResultadoItensContratacoes_PNCP_14133",
        {
            "unidadeOrgaoCodigoUnidade": str(uasg),
            "dataResultadoPncpInicial": ini.isoformat(),
            "dataResultadoPncpFinal": fim.isoformat(),
        },
        rotulo="resultados")
    avisos = [f"resultados: {len(perdidas)} página(s) perdida(s)"] if perdidas else []
    return registros, avisos


def nome_uasg(uasg):
    """Nome da unidade, para o cabecalho do site. Falha nao e problema."""
    try:
        dados = _pagina("modulo-uasg/1_consultarUasg",
                        {"codigoUnidade": str(uasg)}, 1)
        lote = dados.get("resultado") or []
        if lote:
            return (lote[0].get("nomeUasg")
                    or lote[0].get("nomeUnidade") or "").strip()
    except Exception:                                     # noqa: BLE001
        pass
    return ""


# permite trocar a base por variavel de ambiente, sem mexer no codigo
if os.environ.get("API_BASE"):
    BASE = os.environ["API_BASE"].rstrip("/")
