"""Freeze public, outcome-independent Automation splits (Python standard library)."""
import argparse
import hashlib
import json
import random
import re
from collections import Counter
from pathlib import Path

PROTOCOL = 'automationbench-balanced-public-v2'
SEED = 20261118
SOURCE_HASHES = ['926b0d17a075f71a4851f505bc23c02fb982bb6e01e12506db8a605f40033354',
                 'fdc0c83b9c1275d8809d28d5c3300e0f38a8b0a8ae2e23eb7700c7195f323331']
RULES = {
    'policy': r'polic|guideline|rule|compliance|authoritative',
    'recency': r'latest|recent|newest|updated|conflict|current',
    'conditional': r'\bif\b|unless|except|otherwise|threshold|priority|exclude',
    'calculation': r'calculat|convert|currency|exchange|total|sum|weighted|average|amount',
    'temporal': r'calendar|schedule|meeting|timezone|time zone|deadline|duration|available',
    'evidence': r'email|inbox|spreadsheet|sheet|document|lookup|look up|find|search',
    'entity': r'contact|account|customer|employee|candidate|vendor|record',
    'write': r'update|create|send|post|mark|assign|delete|write|add|move',
    'verification': r'confirm|verify|ensure|check|reconcil|duplicate',
    'cross_app': r'crm|salesforce|hubspot|gmail|slack|spreadsheet|calendar|asana|notion|jira|stripe',
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def public_text(row):
    return row['prompt'].split('USER:', 1)[-1].lower()

def tokens(row):
    return set(re.findall(r'[a-z]+', public_text(row)))

def generate(source, destination):
    rows = []
    for name, expected in zip(('search', 'test'), SOURCE_HASHES):
        data = (source / f'{name}.jsonl').read_bytes()
        assert sha(data) == expected, 'Input is not the pinned historical export'
        rows.extend(json.loads(line) for line in data.decode().splitlines() if line.strip())
    assert len(rows) == len({r['id'] for r in rows}) == 800
    rows.sort(key=lambda r: r['id'])
    labels = {}
    parent = {r['id']: r['id'] for r in rows}
    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k
    def union(a, b):
        a, b = find(a), find(b)
        parent[max(a,b)] = min(a,b)
    for r in rows:
        text = public_text(r)
        tags = [k for k, pattern in RULES.items() if re.search(pattern, text)]
        score = len(text.split()) / 50 + sum(k in tags for k in ('policy','recency','conditional','calculation','temporal','verification'))
        labels[r['id']] = {'domain': r['reference']['automationTaskId'].split('.')[0],
                           'capabilities': tags, 'complexityProxy': round(score, 4)}
    # Conservative lexical template families, independent of scores and runs.
    ts = {r['id']: tokens(r) for r in rows}
    explicit_families = {}
    for r in rows:
        task_id = r['reference']['automationTaskId']
        # Field-only variants of the same email -> Salesforce contact update.
        if task_id.startswith('simple.email_sf_contact_') and task_id.endswith('_update'):
            explicit_families.setdefault('simple.email_sf_contact_field_update', []).append(r['id'])
    for family in explicit_families.values():
        for k in family[1:]:
            union(family[0], k)
    for i, a in enumerate(rows):
        for b in rows[i+1:]:
            ta, tb = ts[a['id']], ts[b['id']]
            similarity = len(ta & tb) / max(1, len(ta | tb))
            if similarity >= .70:
                union(a['id'], b['id'])
    groups = {}
    for r in rows:
        groups.setdefault(find(r['id']), []).append(r['id'])
    # Cross-domain lexical families must remain intact; refuse ambiguous quotas.
    for ids in groups.values():
        assert len({labels[k]['domain'] for k in ids}) == 1, 'Cross-domain family requires explicit review'
    search = set()
    audits = {}
    for domain in sorted({v['domain'] for v in labels.values()}):
        ids = sorted(k for k,v in labels.items() if v['domain']==domain)
        assert len(ids) == (200 if domain=='simple' else 100)
        # Relative complexity thirds within a domain, not validated human difficulty.
        ranked = sorted(ids, key=lambda k:(labels[k]['complexityProxy'],k))
        for rank,k in enumerate(ranked):
            labels[k]['difficultyProxy'] = ('low','medium','high')[min(2,rank*3//len(ids))]
            labels[k]['family'] = find(k)
        feature = lambda k: [labels[k]['difficultyProxy']] + labels[k]['capabilities']
        total = Counter(t for k in ids for t in feature(k))
        target = len(ids)//4
        candidates = [v for v in groups.values() if v[0] in ids]
        rng = random.Random(f'{SEED}:{domain}')
        best = None
        for _ in range(512):
            order = candidates.copy()
            rng.shuffle(order)
            dp = {0:[]}
            for group in order:
                for size, chosen in sorted(list(dp.items()), reverse=True):
                    n = size+len(group)
                    if n <= target and n not in dp:
                        dp[n] = chosen+group
            if target not in dp:
                continue
            chosen = dp[target]
            observed = Counter(t for k in chosen for t in feature(k))
            cost = sum((observed[t]-.25*n)**2/max(1,.25*n) for t,n in total.items())
            # Missing capability coverage matters where at least 4 examples exist.
            cost += sum(20 for t,n in total.items() if n>=4 and (observed[t]==0 or observed[t]==n))
            key = (cost, sorted(chosen))
            if best is None or key < best:
                best = key
        assert best is not None, f'Cannot satisfy exact quota while preserving {domain} families'
        search.update(best[1])
        audits[domain] = {'total':len(ids),'search':target,'test':len(ids)-target,
                          'familyCount':len(candidates),'balanceCost':best[0],
                          'features':{t:{'search':sum(t in feature(k) for k in best[1]),
                                         'test':sum(t in feature(k) for k in ids if k not in best[1])} for t in sorted(total)}}
    assert len(search)==200
    destination.mkdir(parents=True,exist_ok=True)
    hashes = {}
    for split in ('search','test'):
        selected = [r for r in rows if (r['id'] in search)==(split=='search')]
        exported = [dict(r,dataset={'protocol':PROTOCOL,'split':split}) for r in selected]
        data = ''.join(json.dumps(r,ensure_ascii=False,separators=(',',':'))+'\n' for r in exported).encode()
        (destination/f'{split}.jsonl').write_bytes(data)
        hashes[split] = sha(data)
    for family in groups.values():
        assert len({k in search for k in family})==1
    (destination/'annotations.json').write_text(json.dumps(labels,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    manifest = {'protocol':PROTOCOL,'seed':SEED,'upstreamRevision':'4a8e1061254004d9dac807054eed33fad7d1ff14',
                'sourceHashes':SOURCE_HASHES,'splitHashes':hashes,'counts':{'search':200,'test':600},
                'domains':audits,'annotationMethod':'public-prompt lexical complexity proxy; within-domain thirds; not empirical or expert-validated difficulty',
                'groupMethod':'explicit simple.email_sf_contact_*_update family plus connected components of public user-prompt token-set Jaccard >= 0.70; no family crosses splits',
                'limitations':['Semantic paraphrase leakage is not ruled out by lexical grouping.',
                               'Public tasks have prior execution and manual-review exposure; not a fresh blind test.',
                               'Simple is included in this custom protocol; blended score is not the official benchmark score.'],
                'usesOutcomes':False,'historicalCheckpointsReusable':False}
    (destination/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'counts':manifest['counts'],'hashes':hashes,'groups':len(groups)}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'protocols/automationbench-balanced-public-v2')
    args = parser.parse_args()
    generate(args.source,args.output)
