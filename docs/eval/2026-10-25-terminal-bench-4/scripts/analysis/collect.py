"""Per-step and per-run facts from every tnega session, for the deep-dive report."""
import json, glob, re, statistics, collections, os
BENCH='/home/user/bench'
main={r['task']:r for r in json.load(open(f'{BENCH}/results/tasks.json'))}
TEST_RE=re.compile(r'\b(pytest|unittest|cargo test|go test|npm (run )?test|make (test|check)|ctest|jest|vitest|mvn test|gradle test|tox|bats|tests?/|run_tests|check\.py|verify)\b',re.I)
def runs():
    for f in sorted(glob.glob(f'{BENCH}/jobs/*/*/*/agent/session.jsonl')):
        parts=f.split('/'); phase=parts[-5]; task=parts[-4]
        if phase in('aborted','regrade'): continue
        yield phase,task,f
out=[]
for phase,task,f in runs():
    tdir=os.path.dirname(os.path.dirname(f))
    steps=[]; calls={}; tools=[]; first_ts=last_ts=None; text_chars=0; reasoning_chars=0
    header=None; turn_end=None; last_content=''
    for line in open(f):
        if line.startswith('{"type":"assistant/chunk"') or '"assistant/chunk"' in line[:60]: 
            continue
        try: e=json.loads(line)
        except Exception: continue
        t=e.get('type'); p=e.get('payload') or {}; ts=e.get('ts')
        if ts: first_ts=first_ts or ts; last_ts=ts
        if t=='request/header': header={'system':len(p.get('system','')),'tools':len(json.dumps(p.get('tools',[]))),'n_tools':len(p.get('tools',[]))}
        elif t=='assistant/message':
            u=p.get('usage') or {}
            tc=p.get('toolCalls') or []
            argchars=sum(len(json.dumps(c.get('arguments'))) for c in tc)
            steps.append({'ts':ts,'prompt':u.get('promptTokens',0),'cached':u.get('cachedTokens',0),'out':u.get('completionTokens',0),
                          'reason':u.get('reasoningTokens',0),'ms':p.get('durationMs') or 0,'ntc':len(tc),
                          'text':len(p.get('content') or ''),'rchars':len(p.get('reasoning') or ''),'argchars':argchars,
                          'tools':[c.get('name') for c in tc]})
            if p.get('content'): last_content=p.get('content')
            for c in tc: calls[c.get('id')]={'name':c.get('name'),'args':c.get('arguments'),'step':len(steps)}
        elif t=='tool/result':
            c=calls.get(p.get('toolCallId'),{})
            o=p.get('output'); s=json.dumps(o) if o is not None else json.dumps(p.get('error'))
            cmd=(c.get('args') or {}).get('command') if isinstance(c.get('args'),dict) else None
            path=(c.get('args') or {}).get('path') if isinstance(c.get('args'),dict) else None
            exitc=o.get('exitCode') if isinstance(o,dict) else None
            tools.append({'name':p.get('name'),'ok':p.get('ok'),'ms':p.get('durationMs') or 0,'chars':len(s),'cmd':cmd,'path':path,
                          'exit':exitc,'timedout':bool(isinstance(o,dict) and (o.get('timedOut') or 'timed out' in s[:400].lower())),
                          'err':(json.dumps(p.get('error'))[:200] if p.get('ok') is False else None),'step':c.get('step'),
                          'contentlen':len((c.get('args') or {}).get('content','')) if isinstance(c.get('args'),dict) else 0})
        elif t=='turn/end': turn_end={'finish':p.get('finishReason'),'reason':(p.get('reason') or {}).get('kind'),'steps':p.get('steps')}
    run={}
    try: run=json.load(open(f'{tdir}/agent/bench-run.json'))
    except Exception: pass
    reward=None
    for rf in ('verifier/reward.txt',):
        if os.path.exists(f'{tdir}/{rf}'):
            try: reward=float(open(f'{tdir}/{rf}').read().strip())
            except: pass
    if reward is None and os.path.exists(f'{tdir}/verifier/reward.json'):
        try: reward=float(json.load(open(f'{tdir}/verifier/reward.json')).get('reward'))
        except: pass
    vt=''
    if os.path.exists(f'{tdir}/verifier/test-stdout.txt'):
        vt=open(f'{tdir}/verifier/test-stdout.txt',errors='replace').read()
    m=re.findall(r'=+ (.*?(?:passed|failed|error).*?) in [\d.]+s',vt)
    failed_tests=re.findall(r'^FAILED (\S+)',vt,re.M)
    last_text=''
    for s in steps[::-1]:
        pass
    out.append({'phase':phase,'task':task,'header':header,'steps':steps,'tools':tools,'turn_end':turn_end,'run':run,
                'wall':(last_ts-first_ts)/1000 if first_ts else 0,'reward':reward,'verifier_summary':m[-1] if m else None,
                'failed_tests':failed_tests[:12],'final':last_content[:1500],'verifier_tail':vt[-3000:],'category':(main.get(task) or {}).get('category')})
json.dump(out,open(f'{BENCH}/deep/runs.json','w'))
print(len(out))
