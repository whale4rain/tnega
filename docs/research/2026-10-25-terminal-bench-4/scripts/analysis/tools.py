import json,re,collections,statistics as st
R=json.load(open('/home/user/bench/deep/runs.json')); M=[r for r in R if r['phase']=='full' and r['steps']]
CPT=3.0
def strip(c):
    c=c.strip()
    c=re.sub(r'^(cd\s+[^;&|]+\s*(&&|;)\s*)+','',c)
    c=re.sub(r'^(export\s+\S+\s*(&&|;)\s*|source\s+\S+\s*(&&|;)\s*|set\s+-\S+\s*(&&|;|\n)\s*)+','',c)
    c=re.sub(r'^(timeout\s+\S+\s+)','',c)
    return c
def cat(cmd):
    c=strip(cmd or '')
    if re.search(r'\b(pip3?|uv pip|apt(-get)?|npm|pnpm|yarn|cargo|conda|gem|go)\s+(install|add|i)\b',c): return 'install packages'
    if re.search(r'\b(pytest|cargo test|go test|npm (run )?test|pnpm test|make (test|check)|ctest|jest|vitest|unittest|bats)\b',c): return 'run tests'
    if re.search(r'\b(make|cmake|gcc|g\+\+|clang|cargo build|go build|tsc|npm run build|pnpm build|javac|rustc|coqc|lake build|ninja)\b',c) and not c.startswith(('cat','grep','ls','find')): return 'build/compile'
    if re.search(r"\bsed\s+-i|\bperl\s+-p?i",c): return 'edit in place (sed -i)'
    if re.search(r"(cat|tee)\s*>{1,2}\s*\S+\s*<<|<<\s*'?EOF'?\s*>\s*\S+|(echo|printf)\s.*>\s*\S+\.\w+",c) and not re.match(r'python',c): return 'write file via shell'
    if re.match(r"python3?\s+(-c|-\s*<<|<<)",c) or re.match(r"python3?\s*-\s",c): return 'inline python'
    if re.match(r"(python3?|node|bash|sh|\./|ruby|java |go run|cargo run|Rscript|julia|freecadcmd|octave)",c): return 'run script/program'
    if re.match(r"(grep|rg|find|ls|tree|which|whereis|locate|du|df)\b",c): return 'search/list'
    if re.match(r"(cat|head|tail|sed\s+-n|less|wc|file|stat|xxd|od|strings|diff|cmp|jq|awk)\b",c): return 'read/inspect'
    if re.match(r"git\b",c): return 'git'
    if re.match(r"(ps|kill|pkill|sleep|nohup|jobs|curl|wget|nc|ss|netstat|lsof|free|nproc|uname|env|echo)\b",c): return 'system/network'
    return 'other'
rows=collections.defaultdict(lambda: collections.Counter()); times=collections.defaultdict(list); runs=collections.defaultdict(set)
tool_rows=collections.defaultdict(lambda: collections.Counter()); tool_times=collections.defaultdict(list); tool_runs=collections.defaultdict(set)
dup=collections.Counter(); reread=collections.Counter(); examples=collections.defaultdict(list)
cycles=[];phases=collections.defaultdict(lambda: collections.Counter())
TOTAL_PROMPT=sum(s['prompt'] for r in M for s in r['steps'])
jobs=[]
for ri,r in enumerate(M):
    n=len(r['steps']); seen=collections.Counter(); reads=collections.Counter()
    # arg chars per call: approximate from step argchars split equally
    for t in r['tools']:
        i=t['step'] or n; remain=max(n-i,0)
        s=r['steps'][i-1] if 0<i<=n else None
        argc=(s['argchars']/max(s['ntc'],1)) if s else 0
        name=t['name']
        res_tok=t['chars']/CPT; arg_tok=argc/CPT
        bad = t['ok'] is False or (name=='shell' and t['exit'] not in (0,None))
        for K,store,tm,rn in ((name,tool_rows,tool_times,tool_runs),):
            store[K]['calls']+=1; store[K]['arg_tok']+=arg_tok; store[K]['res_tok']+=res_tok
            store[K]['carry']+=(res_tok+arg_tok)*remain; store[K]['ms']+=t['ms']; store[K]['bad']+=bad
            store[K]['timeout']+= (t['ms']>=14500 and t['ms']<16000 and name=='shell') or ('timed out' in (t['err'] or '').lower())
            tm[K].append(t['ms']); rn[K].add(ri)
        if name=='shell':
            c=cat(t['cmd']); rows[c]['calls']+=1; rows[c]['arg_tok']+=arg_tok; rows[c]['res_tok']+=res_tok
            rows[c]['carry']+=(res_tok+arg_tok)*remain; rows[c]['ms']+=t['ms']; rows[c]['bad']+=bad
            rows[c]['timeout']+= (14500<=t['ms']<16000) or ('timed out' in (t['err'] or '').lower())
            times[c].append(t['ms']); runs[c].add(ri)
            if len(examples[c])<4 and t['cmd'] and len(t['cmd'])<140: examples[c].append(strip(t['cmd'])[:110])
            key=t['cmd']; seen[key]+=1
            if seen[key]>1: dup[c]+=1
            m=re.match(r"(cat|head|tail|sed -n)\s.*?(\S+\.\w+)\s*$",strip(t['cmd'] or ''))
            if m: reads[m.group(2)]+=1
        if name=='read_file' and t['path']: reads[t['path']]+=1
        # phase
        frac=(i-1)/max(n,1); ph=min(int(frac*5),4)
        k='shell: '+cat(t['cmd']) if name=='shell' else name
        phases[ph][k]+=1
    reread['files']+=sum(1 for v in reads.values() if v>1); reread['extra']+=sum(v-1 for v in reads.values() if v>1)
    # write->run->fail cycles
    seq=[]
    for t in r['tools']:
        if t['name']=='write_file' or (t['name']=='shell' and cat(t['cmd']) in('edit in place (sed -i)','write file via shell')): seq.append('W')
        elif t['name']=='shell' and cat(t['cmd']) in('run script/program','inline python','run tests','build/compile'):
            seq.append('F' if (t['exit'] not in (0,None) or t['ok'] is False) else 'R')
    s=''.join(seq); cycles.append((s.count('WF'),s.count('WR'),len(s)))
def summarize(store,tm,rn):
    out=[]
    for k,c in store.items():
        out.append({'name':k,'calls':c['calls'],'runs':len(rn[k]),'arg_tok':c['arg_tok'],'res_tok':c['res_tok'],'carry':c['carry'],
                    'carry_share':c['carry']/TOTAL_PROMPT,'time_h':c['ms']/3.6e6,'med_s':st.median(tm[k])/1000,'p90_s':sorted(tm[k])[int(.9*len(tm[k]))]/1000,
                    'bad':c['bad'],'bad_rate':c['bad']/c['calls'],'timeouts':c['timeout'],'res_med_tok':0})
    return sorted(out,key=lambda x:-x['carry'])
T=summarize(tool_rows,tool_times,tool_runs); SH=summarize(rows,times,runs)
for x in SH: x['dups']=dup[x['name']]; x['examples']=examples[x['name']]
wf=sum(a for a,b,c in cycles); wr=sum(b for a,b,c in cycles)
ph={k:dict(v) for k,v in phases.items()}
json.dump({'tools':T,'shell':SH,'reread':dict(reread),'cycles':{'write_then_fail':wf,'write_then_ok':wr},'phases':ph,'total_prompt':TOTAL_PROMPT},open('/home/user/bench/deep/tools.json','w'),indent=1)
print('TOTAL prompt',TOTAL_PROMPT)
for x in T: print(f"{x['name']:15} calls {x['calls']:5} runs {x['runs']:3} out {x['arg_tok']/1e3:7.0f}k res {x['res_tok']/1e3:7.0f}k carry {x['carry_share']*100:5.1f}% time {x['time_h']:5.2f}h med {x['med_s']:6.2f}s bad {x['bad_rate']*100:4.0f}% to {x['timeouts']}")
print()
for x in SH: print(f"{x['name']:26} calls {x['calls']:5} runs {x['runs']:3} out {x['arg_tok']/1e3:6.0f}k res {x['res_tok']/1e3:6.0f}k carry {x['carry_share']*100:5.1f}% time {x['time_h']:5.2f}h med {x['med_s']:5.2f}s bad {x['bad_rate']*100:3.0f}% to {x['timeouts']:3} dup {x['dups']}")
print(reread, wf, wr)
