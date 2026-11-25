# Fixed-work CPU probe for cpu-sustained and cpu-burst. It runs the same CPython 32-bit LCG kernel
# as perf.py (cpu-single/cpu-all), from a seed the harness picks fresh for every run, for SEGMENTS
# segments of STEPS steps, once on one process and then on CORES forked processes at once.
# The LCG state carries across segments, so the final checksum is the harness's own value only if
# the guest computed it from this run's seed. The harness also checks that the timings agree.
# Neither proves the guest did the work: the LCG has a closed form, and a provider controls its
# guest and its output. No root, native extensions or package installs.
# Workers are plain fork() children reporting over pipes, so no /dev/shm or semaphores are needed
# (perf.py's process pool needs both). Worker startup counts in the all-core time, as in perf.py.
#
#   python3 cpu.py clock                          print the guest clock (epoch seconds)
#   python3 cpu.py run SEGMENTS STEPS CORES SEED  run the probe, print JSON
import os,sys,time,json,platform

def segment(x,steps):
 for i in range(steps):x=(1664525*x+1013904223)&0xffffffff
 return x

def run(args):
 seed,segments,steps=args;x=seed;rates=[];started=time.time();start=time.perf_counter()
 for s in range(segments):
  t=time.perf_counter();x=segment(x,steps);rates.append(steps/(time.perf_counter()-t))
 return {'checksum':x,'seconds':time.perf_counter()-start,'rates':rates,'startedAt':started,'endedAt':time.time()}

def fanout(n,args):
 children=[];started=time.time();start=time.perf_counter()
 for i in range(n):
  r,w=os.pipe();pid=os.fork()
  if pid==0:
   status=1
   try:
    os.close(r);data=json.dumps(run(args)).encode()
    while data:data=data[os.write(w,data):]
    status=0
   finally:os._exit(status)
  os.close(w);children.append((pid,r))
 workers=[]
 for pid,r in children:
  chunks=[]
  while True:
   chunk=os.read(r,65536)
   if not chunk:break
   chunks.append(chunk)
  os.close(r);_,status=os.waitpid(pid,0)
  if status!=0:raise RuntimeError('CPU worker exited with status '+str(status))
  workers.append(json.loads(b''.join(chunks)))
 return {'workers':workers,'wallSeconds':time.perf_counter()-start,'startedAt':started,'endedAt':time.time()}

def quota():
 try:
  quota,period=open('/sys/fs/cgroup/cpu.max').read().split()[:2]
  return None if quota=='max' else int(quota)/int(period)
 except Exception:pass
 try:
  quota=int(open('/sys/fs/cgroup/cpu/cpu.cfs_quota_us').read());period=int(open('/sys/fs/cgroup/cpu/cpu.cfs_period_us').read())
  return None if quota<=0 else quota/period
 except Exception:return None

def main():
 if sys.argv[1]=='clock':
  print(repr(time.time()));return
 segments,steps,cores,seed=(int(v) for v in sys.argv[2:6])
 n=max(1,min(cores,64));args=(seed&0xffffffff,segments,steps)
 single=run(args);every=fanout(n,args)
 print(json.dumps({'seed':seed,'segments':segments,'steps':steps,'single':single,'all':every,'cpus':{'visible':os.cpu_count(),'affinity':len(os.sched_getaffinity(0)),'quota':quota()},'python':platform.python_version()}))

if __name__=='__main__':main()
