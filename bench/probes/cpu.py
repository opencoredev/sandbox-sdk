# Fixed-work CPU probe for cpu-sustained and cpu-burst. It runs the same CPython 32-bit LCG kernel
# as perf.py (cpu-single/cpu-all) from the same seed, for BENCH_CPU_SEGMENTS segments of
# BENCH_CPU_STEPS steps, once on one process and then on BENCH_CORES forked processes at once.
# The LCG state carries across segments, so the final checksum proves every step ran; the harness
# compares it with the value it computes itself. No root, native extensions or package installs.
# Workers are plain fork() children reporting over pipes, so no /dev/shm or semaphores are needed
# (perf.py's process pool needs both). Worker startup counts in the all-core time, as in perf.py.
import os,time,json,platform

SEED=123456789

def segment(x,steps):
 for i in range(steps):x=(1664525*x+1013904223)&0xffffffff
 return x

def run(args):
 segments,steps=args;x=SEED;rates=[];start=time.perf_counter()
 for s in range(segments):
  t=time.perf_counter();x=segment(x,steps);rates.append(steps/(time.perf_counter()-t))
 return {'checksum':x,'seconds':time.perf_counter()-start,'rates':rates}

def fanout(n,args):
 children=[];start=time.perf_counter()
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
 return workers,time.perf_counter()-start

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
 segments=int(os.environ['BENCH_CPU_SEGMENTS']);steps=int(os.environ['BENCH_CPU_STEPS'])
 n=max(1,min(int(os.environ.get('BENCH_CORES','1')),64))
 single=run((segments,steps));workers,wall=fanout(n,(segments,steps))
 print(json.dumps({'segments':segments,'steps':steps,'single':single,'all':{'workers':workers,'wallSeconds':wall},'cpus':{'visible':os.cpu_count(),'affinity':len(os.sched_getaffinity(0)),'quota':quota()},'python':platform.python_version()}))

if __name__=='__main__':main()
