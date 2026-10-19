import os,subprocess,json,time,urllib.request,shutil

def read(p):
 try:
  with open(p) as f:return f.read().strip()
 except OSError:return ''
def run(s):
 try:return subprocess.run(s,shell=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5,text=True).stdout.strip()
 except Exception:return ''
def stat():
 a=read('/proc/stat').splitlines()[0].split()[1:];return [int(x) for x in a]
a=stat();time.sleep(1);b=stat();delta=sum(b[:8])-sum(a[:8]);cpu=read('/proc/cpuinfo');model=next((x.split(':',1)[1].strip() for x in cpu.splitlines() if x.startswith(('model name','Hardware'))),'unknown')
flags=next((x.split(':',1)[1].split() for x in cpu.splitlines() if x.startswith(('flags','Features'))),[])
quota=read('/sys/fs/cgroup/cpu.max');q=quota.split();qc=float(q[0])/float(q[1]) if len(q)==2 and q[0]!='max' else None
if not quota:
 c=read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');p=read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');quota=c+' '+p;qc=float(c)/float(p) if c and p and float(c)>0 else None
mem=next((int(x.split()[1])*1024 for x in read('/proc/meminfo').splitlines() if x.startswith('MemTotal:')),0);mm=read('/sys/fs/cgroup/memory.max') or read('/sys/fs/cgroup/memory/memory.limit_in_bytes');mb=min(mem,int(mm)) if mm.isdigit() else mem
try:
 with urllib.request.urlopen('https://ipinfo.io/json',timeout=5) as response:egress=json.load(response)
except Exception:egress=None
print(json.dumps(dict(cpuModel=model,flags=flags,nproc=int(run('nproc') or os.cpu_count() or 1),cpuMax=quota,quotaCpus=qc,memoryMax=mm,memTotalBytes=mem,memoryBytes=mb,diskBytes=shutil.disk_usage('/workspace').total,df=run('df -PT /workspace'),lsblk=run('lsblk -d -o NAME,SIZE,ROTA,TYPE,MODEL'),virtualization=run('systemd-detect-virt'),hypervisor='hypervisor' in flags,dmi=read('/sys/class/dmi/id/product_name'),kernel=run('uname -a'),distro=read('/etc/os-release'),user=run('id -un'),uid=os.getuid(),sudo=run('sudo -n true && echo yes')=='yes',stealPercent=100*(b[7]-a[7])/delta if delta else None,egress=egress,tools={x:run('command -v '+x) for x in ['python3','git','node','bun','gcc','npm','pip3']},runtime=run('python3 --version'))))
