import json,statistics as st,collections,re,os,glob
B='/home/user/bench'
R=json.load(open(f'{B}/deep/runs.json')); S=json.load(open(f'{B}/deep/stats.json'))
E_=json.load(open(f'{B}/deep/endings.json'))
M=[r for r in R if r['phase']=='full' and r['steps']]
D={}
# pass rates
def rate(sel):
    xs=[x for x in E_ if sel(x)]; p=sum(1 for x in xs if x[3]==1); return p,len(xs)
D['pr_main_uncapped']=rate(lambda x:x[0]=='full' and x[2] not in('cost_cap','wall_cap') and x[3] is not None)
D['pr_main_answer']=rate(lambda x:x[0]=='full' and x[2]=='final answer' and x[3] is not None)
D['pr_all_answer']=rate(lambda x:x[2]=='final answer' and x[3] is not None)
# best per task over all attempts, uncapped & graded
best={}
for p,t,e,w in E_:
    if e in('cost_cap','wall_cap') or w is None: continue
    best[t]=max(best.get(t,0),w==1)
D['pr_all_uncapped_tasks']=(sum(best.values()),len(best))
D['endings_main']=collections.Counter(f'{e}|{"pass" if w==1 else "fail" if w is not None else "nograde"}' for p,t,e,w in E_ if p=='full')
# closeness of final-answer failures
close=[]
for r in R:
    if r['phase']!='full': continue
    e=[x for x in E_ if x[0]=='full' and x[1]==r['task']][0]
    if e[2]!='final answer' or e[3]!=0: continue
    tdir=glob.glob(f'{B}/jobs/full/{r["task"]}/*/verifier')[0]
    share=None; label=None
    rd=os.path.join(tdir,'reward_details.json')
    if os.path.exists(rd):
        d=json.load(open(rd)); ch=d.get('checks') or []
        if ch: share=sum(c.get('weight',0) for c in ch if c.get('passed'))/max(1e-9,sum(c.get('weight',0) for c in ch)); label=f'{sum(1 for c in ch if c.get("passed"))} of {len(ch)} checks'
        elif 'passed_cases' in d: share=d['passed_cases']/d['total_cases']; label=f"{d['passed_cases']} of {d['total_cases']} cases"
    if share is None and r['verifier_summary']:
        f=re.search(r'(\d+) failed',r['verifier_summary']); pz=re.search(r'(\d+) passed',r['verifier_summary'])
        f=int(f.group(1)) if f else 0; pz=int(pz.group(1)) if pz else 0
        if f+pz: share=pz/(f+pz); label=f'{pz} of {f+pz} tests'
    if share is None:
        vt=r['verifier_tail']
        m=re.search(r'(\d+) failed.*?(\d+) passed',vt,re.S)
        if m: f,pz=int(m.group(1)),int(m.group(2)); share=pz/(f+pz); label=f'{pz} of {f+pz} tests'
    close.append({'task':r['task'],'share':share,'label':label,'failed':[t.split('::')[-1] for t in r['failed_tests'][:3]],'claim':r['final'][:160]})
D['close']=close
# context growth series
grow=collections.defaultdict(list)
for r in M:
    for i,s in enumerate(r['steps']): grow[i+1].append(s['prompt'])
D['growth']=[(k,st.median(v),len(v)) for k,v in sorted(grow.items()) if len(v)>=8]
D['stats']=S
json.dump(D,open(f'{B}/deep/report_data.json','w'),indent=1,default=list)
print(D['pr_main_uncapped'],D['pr_main_answer'],D['pr_all_answer'],D['pr_all_uncapped_tasks'])
for c in close: print(c['task'],c['label'],round(c['share'] or -1,2))
print(D['growth'][-3:])
