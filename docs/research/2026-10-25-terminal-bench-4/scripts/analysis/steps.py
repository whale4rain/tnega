import json,re,collections,statistics as st
exec(open('/home/user/bench/deep/tools.py').read().split("rows=collections.defaultdict")[0])
def pyedit(c):
    return bool(re.search(r"\.read\(\)",c) and re.search(r"\.replace\(|\.index\(|re\.sub\(",c) and re.search(r"open\([^)]*['\"]w['\"]\)\.write|\.write_text\(|open\([^)]*,\s*['\"]w",c))
def group(t):
    n=t['name']
    if n=='shell':
        c=cat(t['cmd'])
        if c=='inline python': return 'edit file (python)' if pyedit(t['cmd'] or '') else 'probe with inline python'
        return {'read/inspect':'look around','search/list':'look around','write file via shell':'write file (shell)','edit in place (sed -i)':'edit file (sed)',
                'run script/program':'run code','build/compile':'run code','run tests':'run tests','other':'run code','system/network':'wait/process/network',
                'install packages':'install','git':'look around'}[c]
    return {'read_file':'look around','list_dir':'look around','write_file':'write file (write_file)','job_start':'background job','job_output':'background job','job_kill':'background job','job_list':'background job'}.get(n,'other tool')
G=collections.defaultdict(lambda: collections.Counter()); GT=collections.defaultdict(list)
phase=collections.defaultdict(collections.Counter)
nochunks=collections.Counter()
for r in M:
    n=len(r['steps'])
    by_step=collections.defaultdict(list)
    for t in r['tools']: by_step[t['step']].append(t)
    for i,s in enumerate(r['steps'],1):
        ts=by_step.get(i,[])
        g=group(ts[0]) if ts else 'reply without tools'
        G[g]['steps']+=1; G[g]['reason']+=s['reason']; G[g]['out']+=s['out']; G[g]['model_ms']+=s['ms']
        G[g]['tool_ms']+=sum(t['ms'] for t in ts); G[g]['res_chars']+=sum(t['chars'] for t in ts); G[g]['calls']+=len(ts)
        G[g]['bad']+=sum(1 for t in ts if t['ok'] is False or (t['name']=='shell' and t['exit'] not in (0,None)))
        G[g]['carry']+=(sum(t['chars'] for t in ts)/3+ (s['argchars'])/3)*(n-i)
        GT[g].append(s['ms']+sum(t['ms'] for t in ts))
        phase[min(int((i-1)/n*5),4)][g]+=1
out=[]
TP=sum(s['prompt'] for r in M for s in r['steps'])
for g,c in G.items():
    out.append({'group':g,'steps':c['steps'],'calls':c['calls'],'reason_per_step':c['reason']/c['steps'],'vis_per_step':(c['out']-c['reason'])/c['steps'],
      'model_s_per_step':c['model_ms']/c['steps']/1000,'tool_s_per_step':c['tool_ms']/c['steps']/1000,'res_tok_per_step':c['res_chars']/3/c['steps'],
      'bad_rate':c['bad']/max(c['calls'],1),'out_share':c['out'],'carry_share':c['carry']/TP,'model_h':c['model_ms']/3.6e6,'tool_h':c['tool_ms']/3.6e6,
      'step_s_med':st.median(GT[g])/1000})
tot_out=sum(x['out_share'] for x in out)
for x in out: x['out_share']/=tot_out
out.sort(key=lambda x:-x['steps'])
json.dump({'groups':out,'phase':{k:dict(v) for k,v in phase.items()}},open('/home/user/bench/deep/steps.json','w'),indent=1)
for x in out: print(f"{x['group']:26} steps {x['steps']:5} reason {x['reason_per_step']:6.0f} vis {x['vis_per_step']:6.0f} model {x['model_s_per_step']:5.1f}s tool {x['tool_s_per_step']:5.1f}s res {x['res_tok_per_step']:6.0f} bad {x['bad_rate']*100:3.0f}% out {x['out_share']*100:4.1f}% ctx {x['carry_share']*100:4.1f}% model_h {x['model_h']:.1f} tool_h {x['tool_h']:.1f}")
for k in sorted(phase): 
    tot=sum(phase[k].values()); print(k, {g:round(v/tot*100) for g,v in phase[k].most_common(7)})
