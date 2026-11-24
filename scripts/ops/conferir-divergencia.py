#!/usr/bin/env python3
"""
CONFERÊNCIA OBRIGATÓRIA ANTES DE QUALQUER PUBLICAÇÃO — Repositório × Produção (SOMENTE LEITURA).
Regra permanente (docs/ops/PROCEDIMENTO-PUBLICACAO-OBRIGATORIO.md): se houver divergência, INTERROMPER, achar a origem e reconciliar.
Cobre: Firestore Rules, Functions, Hosting, workflows do GitHub e configurações (WIF, Auth, chaves de API, Scheduler, Secrets).
Não grava nada em lugar nenhum de produção (só GET/describe/list). Saída: tabela; código 0 = alinhado; 1 = divergência; 2 = não foi possível verificar.
Uso:  python3 scripts/ops/conferir-divergencia.py [--projeto mr4-ponto] [--repo dono/repo] [--so rules,functions,workflows,config,hosting]
"""
import argparse, hashlib, json, os, re, subprocess, sys, tempfile

PROJETO_PADRAO = 'mr4-ponto'; REGIAO = 'southamerica-east1'
RAIZ = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip() or os.getcwd()
RES = []   # (area, item, estado, detalhe)   estado ∈ OK | DIVERGE | INFO | NAO_VERIFICADO


def reg(area, item, estado, detalhe=''): RES.append((area, item, estado, detalhe))
def sh(*a, entrada=None):
    p = subprocess.run(list(a), capture_output=True, text=True, input=entrada); return p.returncode, p.stdout, p.stderr
def sha(b): return hashlib.sha256(b).hexdigest()
def token():
    rc, o, _ = sh('gcloud', 'auth', 'print-access-token'); return o.strip() if rc == 0 else None
def get_json(url, tok, projeto):
    """SOMENTE GET, via curl (usa o repositório de certificados do sistema)."""
    rc, o, e = sh('curl', '-sS', '--fail', '-H', 'Authorization: Bearer ' + tok, '-H', 'x-goog-user-project: ' + projeto, url)
    if rc != 0: raise RuntimeError('GET falhou')
    return json.loads(o)


def comparar_texto(local, remoto):
    """Pura (testável): igualdade byte a byte; devolve (igual, nº de linhas diferentes)."""
    if local == remoto: return True, 0
    a, b = local.splitlines(), remoto.splitlines(); import difflib
    return False, sum(1 for l in difflib.unified_diff(a, b, lineterm='', n=0) if l[:1] in '+-' and not l.startswith(('+++', '---')))


# ── 1. Firestore Rules ────────────────────────────────────────────────────────
def conferir_rules(projeto, tok):
    try:
        rel = get_json(f'https://firebaserules.googleapis.com/v1/projects/{projeto}/releases/cloud.firestore', tok, projeto)
        rs = get_json('https://firebaserules.googleapis.com/v1/' + rel['rulesetName'], tok, projeto)
        remoto = rs['source']['files'][0]['content']
    except Exception as e:
        reg('rules', 'conjunto publicado', 'NAO_VERIFICADO', type(e).__name__); return
    local = open(os.path.join(RAIZ, 'modulos/firestore.rules'), encoding='utf-8').read()
    igual, n = comparar_texto(local, remoto)
    info = f"ruleset {rel['rulesetName'].split('/')[-1]} · publicado {rel.get('updateTime','?')[:19]}Z · sha256 {sha(remoto.encode())[:12]}"
    reg('rules', 'modulos/firestore.rules × publicado', 'OK' if igual else 'DIVERGE', info if igual else f'{n} linha(s) diferem — {info}')


# ── 2. Functions ──────────────────────────────────────────────────────────────
def exports_do_index():
    s = open(os.path.join(RAIZ, 'functions/index.js'), encoding='utf-8').read()
    return sorted({m for m in re.findall(r'^exports\.(\w+)\s*=', s, re.M) if not m.startswith('_')})


def conferir_functions(projeto, so_funcoes):
    rc, o, e = sh('gcloud', 'functions', 'list', '--project=' + projeto, '--format=json(name,updateTime,state)')
    if rc != 0: reg('functions', 'lista implantada', 'NAO_VERIFICADO', e.strip()[:80]); return
    impl = {f['name'].split('/')[-1]: f for f in json.loads(o)}
    ex = exports_do_index(); ex_l = {n.lower(): n for n in ex}
    impl_l = {k.lower() for k in impl}; ex_lower = {n.lower() for n in ex}
    so_impl = sorted(k for k in impl_l if k not in ex_lower and k != 'mr4-catalogo-dispatch')   # esta pertence a outro serviço do projeto
    so_repo = sorted(n for n in ex if n.lower() not in impl_l)
    reg('functions', 'implantadas × exportadas no index.js', 'OK' if not so_impl and not so_repo else 'DIVERGE',
        f'{len(impl)} implantadas; só em produção: {so_impl or "—"}; só no repositório: {so_repo or "—"}')
    for fn in so_funcoes:
        rc, o, e = sh('gcloud', 'functions', 'describe', fn, '--region=' + REGIAO, '--project=' + projeto, '--gen2', '--format=json(updateTime,buildConfig.source.storageSource,serviceConfig.revision)')
        if rc != 0: reg('functions', fn, 'NAO_VERIFICADO', e.strip()[:80]); continue
        d = json.loads(o); st = d['buildConfig']['source']['storageSource']; upd = d['updateTime']
        tmp = tempfile.mkdtemp()
        rc, _, e = sh('gcloud', 'storage', 'cp', f"gs://{st['bucket']}/{st['object']}", tmp + '/s.zip', '-q')
        if rc != 0: reg('functions', fn, 'NAO_VERIFICADO', 'fonte não baixada'); continue
        sh('unzip', '-q', '-o', tmp + '/s.zip', '-d', tmp + '/src')
        rc, log, _ = sh('git', '-C', RAIZ, 'log', '--since=' + upd, '--format=%h %s', '--', 'functions/')
        pend = [l for l in log.splitlines() if l.strip()]
        # o handler de FATO implantado × o do repositório (texto da função)
        nome_h = fn[0].lower() + fn[1:] + 'Handler'
        def trecho(path):
            try: s = open(path, encoding='utf-8').read()
            except Exception: return None
            m = re.search(r'async function ' + re.escape(nome_h) + r'\b', s)
            if not m: return None
            j = s.find('\n}\n', m.start()); return s[m.start(): j + 3] if j > 0 else None
        a, b = trecho(os.path.join(RAIZ, 'functions/index.js')), trecho(tmp + '/src/index.js')
        if a is None or b is None: reg('functions', f'{fn}: handler', 'INFO', 'handler não localizado pelo nome padrão — comparar manualmente'); 
        else:
            igual, n = comparar_texto(a, b); reg('functions', f'{fn}: handler repositório × implantado', 'OK' if igual else 'DIVERGE', f'revisão {d.get("serviceConfig",{}).get("revision","?")} · implantada {upd[:19]}Z' + ('' if igual else f' · {n} linha(s) diferem'))
        # comparação de ARQUIVOS: lib/ implantado × repositório (a fonte implantada é um instantâneo do código no momento do deploy)
        dif, ausentes = [], []
        for raiz, _, fs in os.walk(os.path.join(tmp, 'src', 'lib')):
            for f in fs:
                rel = os.path.relpath(os.path.join(raiz, f), os.path.join(tmp, 'src')); loc = os.path.join(RAIZ, 'functions', rel)
                if not os.path.exists(loc): ausentes.append(rel)
                elif sha(open(loc, 'rb').read()) != sha(open(os.path.join(tmp, 'src', rel), 'rb').read()): dif.append(rel)
        reg('functions', f'{fn}: lib/ implantado × repositório', 'OK' if not dif and not ausentes else 'INFO',
            'idêntico' if not dif and not ausentes else f'{len(dif)} arquivo(s) diferem, {len(ausentes)} só no implantado' + (': ' + ', '.join((dif + ausentes)[:6]) if dif or ausentes else '') + ' — explicar (código implantado a partir de outra linha? commits pendentes?)')
        reg('functions', f'{fn}: commits em functions/ após a implantação', 'INFO' if pend else 'OK', f'{len(pend)} pendente(s) de implantar' + (': ' + '; '.join(pend[:3]) if pend else ''))


# ── 3. Workflows ──────────────────────────────────────────────────────────────
def conferir_workflows(repo):
    rc, o, e = sh('gh', 'api', f'repos/{repo}/contents/.github/workflows?ref=main')
    if rc != 0: reg('workflows', 'remoto', 'NAO_VERIFICADO', e.strip()[:80]); return
    remotos = {f['name']: f['sha'] for f in json.loads(o)}
    pasta = os.path.join(RAIZ, '.github/workflows'); locais = {}
    for n in sorted(os.listdir(pasta)):
        b = open(os.path.join(pasta, n), 'rb').read(); locais[n] = hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest()
    dif = sorted(n for n in set(locais) | set(remotos) if locais.get(n) != remotos.get(n))
    reg('workflows', 'workflows locais × main remoto', 'OK' if not dif else 'DIVERGE', 'idênticos' if not dif else 'diferem: ' + ', '.join(dif))
    rc, o, _ = sh('gh', 'workflow', 'list', '-R', repo, '--all', '--json', 'name,state')
    if rc == 0:
        est = {w['name']: w['state'] for w in json.loads(o)}; reg('workflows', 'estado (ativo/desativado)', 'INFO', ', '.join(f'{k}={v}' for k, v in est.items()))


# ── 4. Configuração (baseline versionado) ─────────────────────────────────────
def snapshot_config(projeto, tok):
    s = {}
    try:
        rc, o, _ = sh('gcloud', 'iam', 'workload-identity-pools', 'providers', 'list', '--workload-identity-pool=github-actions-pool', '--location=global', '--project=' + projeto, '--format=json(name,attributeCondition,state)')
        s['wif_providers'] = sorted([{'nome': p['name'].split('/')[-1], 'condicao': p.get('attributeCondition'), 'estado': p.get('state')} for p in json.loads(o)], key=lambda x: x['nome'])
    except Exception: s['wif_providers'] = 'NAO_VERIFICADO'
    try: s['auth_dominios_autorizados'] = sorted(get_json(f'https://identitytoolkit.googleapis.com/admin/v2/projects/{projeto}/config', tok, projeto).get('authorizedDomains', []))
    except Exception: s['auth_dominios_autorizados'] = 'NAO_VERIFICADO'
    try:
        rc, o, _ = sh('gcloud', 'services', 'api-keys', 'list', '--project=' + projeto, '--format=json(displayName,restrictions.browserKeyRestrictions,restrictions.apiTargets)')
        s['chaves_api'] = sorted([{'nome': k.get('displayName'), 'referenciadores': (k.get('restrictions') or {}).get('browserKeyRestrictions') or {}, 'apis': len((k.get('restrictions') or {}).get('apiTargets') or [])} for k in json.loads(o)], key=lambda x: str(x['nome']))
    except Exception: s['chaves_api'] = 'NAO_VERIFICADO'
    try:
        rc, o, _ = sh('gcloud', 'scheduler', 'jobs', 'list', '--project=' + projeto, '--location=' + REGIAO, '--format=json(name,schedule,state)')
        s['scheduler'] = sorted([{'job': j['name'].split('/')[-1], 'cron': j.get('schedule'), 'estado': j.get('state')} for j in json.loads(o)], key=lambda x: x['job'])
    except Exception: s['scheduler'] = 'NAO_VERIFICADO'
    try:
        rc, o, _ = sh('gcloud', 'secrets', 'list', '--project=' + projeto, '--format=json(name)'); s['secrets_nomes'] = sorted(x['name'].split('/')[-1] for x in json.loads(o))
    except Exception: s['secrets_nomes'] = 'NAO_VERIFICADO'
    return s


def conferir_config(projeto, tok, atualizar, baseline=None):
    caminho = baseline or os.environ.get('MR4_BASELINE') or os.path.join(RAIZ, 'docs/ops/estado-esperado-producao.json'); atual = snapshot_config(projeto, tok)
    if atualizar:
        open(caminho, 'w', encoding='utf-8').write(json.dumps(atual, indent=1, ensure_ascii=False, sort_keys=True) + '\n'); reg('config', 'baseline', 'INFO', caminho + ' REGRAVADO — revisar o diff e guardar junto da mudança que o motivou'); return
    if not os.path.exists(caminho): reg('config', 'baseline', 'NAO_VERIFICADO', caminho + ' inexistente'); return
    esperado = json.load(open(caminho, encoding='utf-8'))
    for k in sorted(set(esperado) | set(atual)):
        if atual.get(k) == 'NAO_VERIFICADO': reg('config', k, 'NAO_VERIFICADO', 'sem permissão/erro de leitura'); continue
        reg('config', k, 'OK' if esperado.get(k) == atual.get(k) else 'DIVERGE', 'igual ao baseline' if esperado.get(k) == atual.get(k) else 'difere do baseline versionado — achar a origem antes de publicar')


# ── 5. Hosting ────────────────────────────────────────────────────────────────
def conferir_hosting():
    try: fb = json.load(open(os.path.join(RAIZ, 'firebase.json')))
    except Exception: fb = {}
    if 'hosting' not in fb: reg('hosting', 'firebase.json', 'INFO', 'sem seção hosting (site ainda no GitHub Pages) — conferir o Pages: gh api repos/<repo>/pages'); return
    reg('hosting', 'versão no ar × dist/', 'NAO_VERIFICADO', 'implementar com a migração: comparar hashes da versão live (API firebasehosting) com os de dist/')


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--projeto', default=PROJETO_PADRAO); ap.add_argument('--repo', default='')
    ap.add_argument('--so', default='rules,functions,workflows,config,hosting'); ap.add_argument('--funcoes', default='', help='funções a comparar em detalhe (separadas por vírgula)')
    ap.add_argument('--baseline', default='', help='arquivo do estado esperado das configurações (padrão: $MR4_BASELINE ou docs/ops/estado-esperado-producao.json)')
    ap.add_argument('--atualizar-baseline', action='store_true', help='regrava docs/ops/estado-esperado-producao.json (uso consciente, junto de uma mudança aprovada)')
    a = ap.parse_args(); so = set(a.so.split(',')); tok = token()
    if not tok: print('gcloud sem credencial: não foi possível verificar'); return 2
    repo = a.repo or re.sub(r'.*github\.com[:/]|\.git$', '', sh('git', '-C', RAIZ, 'remote', 'get-url', 'origin')[1].strip())
    if 'rules' in so: conferir_rules(a.projeto, tok)
    if 'functions' in so: conferir_functions(a.projeto, [f for f in a.funcoes.split(',') if f])
    if 'workflows' in so: conferir_workflows(repo)
    if 'config' in so: conferir_config(a.projeto, tok, a.atualizar_baseline, a.baseline)
    if 'hosting' in so: conferir_hosting()
    for ar, it, es, de in RES: print(f'{es:15s} {ar:10s} {it}' + (f'\n{"":27s}↳ {de}' if de else ''))
    div = [r for r in RES if r[2] == 'DIVERGE']; nv = [r for r in RES if r[2] == 'NAO_VERIFICADO']
    print('\n' + ('DIVERGÊNCIA(S): ' + str(len(div)) + ' — INTERROMPER A PUBLICAÇÃO, identificar a origem e reconciliar.' if div else 'Sem divergências nas áreas verificadas.') + (f'  [{len(nv)} item(ns) não verificado(s)]' if nv else ''))
    return 1 if div else (2 if nv else 0)


if __name__ == '__main__': sys.exit(main())
