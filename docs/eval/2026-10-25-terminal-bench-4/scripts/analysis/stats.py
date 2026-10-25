import json,statistics as st,collections,re
R=json.load(open('/home/user/bench/deep/runs.json'))
M=[r for r in R if r['phase']=='full']
def med(x): return st.median(x) if x else 0
def pct(x,q):
    x=sorted(x); return x[min(len(x)-1,int(q*len(x)))] if x else 0
S={}
allsteps=[s for r in M for s in r['steps']]
S['runs']=len(M); S['steps']=len(allsteps)
S['steps_per_run_med']=med([len(r['steps']) for r in M]); S['steps_per_run_max']=max(len(r['steps']) for r in M)
P=sum(s['prompt'] for s in allsteps); C=sum(s['cached'] for s in allsteps); O=sum(s['out'] for s in allsteps); RS=sum(s['reason'] for s in allsteps)
S.update(prompt=P,cached=C,uncached=P-C,out=O,reason=RS,visible=O-RS)
# visible output split: tool args vs text, by chars
arg=sum(s['argchars'] for s in allsteps); txt=sum(s['text'] for s in allsteps)
S['vis_arg_share']=arg/(arg+txt)
# tool args by tool (chars)
ac=collections.Counter()
for r in M:
    pass
# context growth by step index
grow=collections.defaultdict(list)
for r in M:
    for i,s in enumerate(r['steps']): grow[i+1].append(s['prompt'])
S['ctx_at']={k:med(grow[k]) for k in (1,5,10,25,50,100,150,200) if grow[k]}
S['ctx_n_at']={k:len(grow[k]) for k in (1,5,10,25,50,100,150,200)}
# per-step prompt growth
d=[]
for r in M:
    ps=[s['prompt'] for s in r['steps']]
    d+= [b-a for a,b in zip(ps,ps[1:])]
S['growth_per_step_med']=med(d); S['growth_p90']=pct(d,0.9)
# cache miss per step
S['uncached_per_step_med']=med([s['prompt']-s['cached'] for s in allsteps])
# output per step
S['out_per_step_med']=med([s['out'] for s in allsteps]); S['out_p90']=pct([s['out'] for s in allsteps],.9); S['out_max']=max(s['out'] for s in allsteps)
S['reason_per_step_med']=med([s['reason'] for s in allsteps])
S['steps_with_reasoning']=sum(1 for s in allsteps if s['reason']>0)/len(allsteps)
# header
h=[r['header'] for r in M if r['header']]
S['system_chars']=med([x['system'] for x in h]); S['tools_chars']=med([x['tools'] for x in h]); S['n_tools']=med([x['n_tools'] for x in h])
S['first_prompt_med']=med([r['steps'][0]['prompt'] for r in M if r['steps']])
# tool results feeding context, by tool
tc=collections.Counter(); tn=collections.Counter(); tms=collections.Counter()
for r in M:
    for t in r['tools']: tc[t['name']]+=t['chars']; tn[t['name']]+=1; tms[t['name']]+=t['ms']
S['result_chars']=dict(tc.most_common()); S['result_n']=dict(tn); S['tool_ms']=dict(tms)
S['result_chars_med_shell']=med([t['chars'] for r in M for t in r['tools'] if t['name']=='shell'])
S['result_chars_p90_shell']=pct([t['chars'] for r in M for t in r['tools'] if t['name']=='shell'],.9)
S['result_chars_max_shell']=max([t['chars'] for r in M for t in r['tools'] if t['name']=='shell'])
# write_file analysis
wf=[t for r in M for t in r['tools'] if t['name']=='write_file']
S['wf_n']=len(wf); S['wf_content_med']=med([t['contentlen'] for t in wf]); S['wf_content_total']=sum(t['contentlen'] for t in wf)
rew=collections.Counter()
for r in M:
    c=collections.Counter(t['path'] for t in r['tools'] if t['name']=='write_file')
    for p,n in c.items():
        if n>1: rew['rewrites']+=n-1; rew['files']+=1
S['wf_rewrites']=dict(rew)
# shell commands that edit (sed -i, cat > , python - heredoc)
sh=[t for r in M for t in r['tools'] if t['name']=='shell' and t['cmd']]
S['shell_n']=len(sh)
S['shell_sed_i']=sum(1 for t in sh if re.search(r'sed\s+-i',t['cmd']))
S['shell_heredoc_write']=sum(1 for t in sh if re.search(r"cat\s*>+\s*\S+\s*<<|tee\s+\S+\s*<<",t['cmd']))
S['shell_python_inline']=sum(1 for t in sh if re.search(r"python3?\s+(-c|-\s*<<)",t['cmd']))
S['shell_nonzero']=sum(1 for t in sh if t['exit'] not in (0,None)); S['shell_timeout']=sum(1 for t in sh if t['timedout'])
S['shell_grep_find']=sum(1 for t in sh if re.match(r'\s*(cd [^;&]+(&&|;)\s*)?(grep|rg|find|ls|cat|head|tail|wc)\b',t['cmd']))
S['shell_test']=sum(1 for t in sh if re.search(r'\b(pytest|cargo test|go test|npm (run )?test|make (test|check)|jest|vitest|ctest)\b',t['cmd']))
# errors kinds
ek=collections.Counter()
for r in M:
    for t in r['tools']:
        if t['ok'] is False:
            e=t['err'] or ''
            k='path fence' if 'outside' in e.lower() or 'workspace' in e.lower() else ('timeout' if 'time' in e.lower() else e[:60])
            ek[(t['name'],k)]+=1
S['tool_errors']=[(f'{a}: {b}',n) for (a,b),n in ek.most_common(10)]
# time
llm=sum(s['ms'] for s in allsteps)/1000; tool=sum(t['ms'] for r in M for t in r['tools'])/1000; wall=sum(r['wall'] for r in M)
S.update(llm_s=llm,tool_s=tool,wall_s=wall)
S['llm_ms_med']=med([s['ms'] for s in allsteps]); S['llm_ms_p90']=pct([s['ms'] for s in allsteps],.9); S['llm_ms_max']=max(s['ms'] for s in allsteps)
tps=[s['out']/(s['ms']/1000) for s in allsteps if s['ms']>2000 and s['out']>200]
S['tok_per_s_med']=med(tps)
S['shell_ms_med']=med([t['ms'] for t in sh]); S['shell_ms_p90']=pct([t['ms'] for t in sh],.9)
S['shell_over_10s']=sum(1 for t in sh if t['ms']>10000)
# parallel tool calls per step
S['steps_multi_calls']=sum(1 for s in allsteps if s['ntc']>1); S['steps_no_calls']=sum(1 for s in allsteps if s['ntc']==0)
# jobs
S['job_start']=sum(1 for r in M for t in r['tools'] if t['name']=='job_start')
json.dump(S,open('/home/user/bench/deep/stats.json','w'),indent=1)
for k,v in S.items(): print(k,':',v)
