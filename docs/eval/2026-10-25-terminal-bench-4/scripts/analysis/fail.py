import json,re,collections
R=json.load(open('/home/user/bench/deep/runs.json'))
main={r['task']:r for r in json.load(open('/home/user/bench/results/tasks.json'))}
from_main=[r for r in R if r['phase']=='full']
ANN=re.compile(r"(let me|let's|i'll|i will|now i|next,? i)\b[^.!?]{0,160}[.…:]?\s*$",re.I)
DONE=re.compile(r"\b(done|fixed|complete[d]?|finished|written|verified|all .* pass|both .* (are|were)|is at|holds|accepted|submitted)\b",re.I)
def kind(t):
    a=t['name']; c=t['cmd'] or ''
    if a in('read_file','list_dir') or (a=='shell' and re.match(r'\s*(cd [^;&]+(&&|;)\s*)?(grep|rg|find|ls|cat|head|tail|wc|sed -n|file|tree|stat|which|pip (show|list)|python3? -c .import)',c)): return 'look'
    if a=='write_file' or (a=='shell' and re.search(r'sed -i|cat\s*>|tee ',c)): return 'write'
    if a=='shell' and re.search(r'pytest|test|check|verify|diff|cmp',c): return 'test'
    if a=='shell': return 'run'
    return 'other'
rows=[]
for r in from_main:
    m=main[r['task']]
    if m['status']=='not_run': continue
    tools=r['tools']; last=tools[-15:]
    kinds=collections.Counter(kind(t) for t in last)
    alltests=[t for t in tools if kind(t)=='test']
    n=len(tools)
    late_tests=sum(1 for i,t in enumerate(tools) if kind(t)=='test' and i>=0.7*n)
    nonzero_last=sum(1 for t in last if (t['exit'] not in (0,None)) or t['ok'] is False)
    fin=(r['final'] or '').strip()
    if r['run'].get('stopReason') in('cost_cap','wall_cap'): how=r['run']['stopReason']
    elif not fin: how='empty'
    elif ANN.search(fin[-200:]) and not DONE.search(fin[:120]): how='mid-plan'
    else: how='claimed done'
    rows.append({'task':r['task'],'status':m['status'],'how':how,'steps':len(r['steps']),'tools':n,'tests_total':len(alltests),'tests_late':late_tests,
                 'last15':dict(kinds),'nonzero_last15':nonzero_last,'verifier':r['verifier_summary'],'failed_tests':r['failed_tests'][:4],
                 'final':fin[:220],'cat':r['category']})
json.dump(rows,open('/home/user/bench/deep/fail.json','w'),indent=1)
c=collections.Counter((x['how'],x['status']) for x in rows); print(c)
for h in ('claimed done','mid-plan','empty'):
    print('\n##',h)
    for x in rows:
        if x['how']==h and x['status']!='passed': print(x['task'][:26].ljust(26),x['status'],'steps',x['steps'],'tests',x['tests_total'],'late',x['tests_late'],'|',x['verifier'],'|',x['final'][:90].replace('\n',' '))
print('\n## capped failed: last-15 activity')
agg=collections.Counter()
for x in rows:
    if x['how'] in('cost_cap','wall_cap') and x['status']!='passed':
        agg.update(x['last15']); print(x['task'][:26].ljust(26),x['steps'],x['last15'],'nz',x['nonzero_last15'],'tests',x['tests_total'])
print(agg)
