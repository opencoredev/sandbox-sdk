# Fixed CPython kernels, no root, native extensions or package installation.
import os,time,json,hashlib,concurrent.futures,random,socket,urllib.request,multiprocessing
from pathlib import Path

def cpu(_):
 start=time.perf_counter();x=123456789
 for i in range(1000000):x=(1664525*x+1013904223)&0xffffffff
 return 1000000/(time.perf_counter()-start)
def main():
 results={};notes=[];n=int(os.environ.get('BENCH_CORES','1'));n=max(1,min(n,64))
 results['cpu-single']=cpu(0);start=time.perf_counter()
 with concurrent.futures.ProcessPoolExecutor(max_workers=n,mp_context=multiprocessing.get_context("fork")) as pool:list(pool.map(cpu,range(n)))
 results['cpu-all']=n*1000000/(time.perf_counter()-start)
 a=bytearray(16*1024*1024);b=bytearray(len(a));start=time.perf_counter()
 for i in range(64):b[:]=a
 results['memory-mbps']=len(a)*64/(time.perf_counter()-start)/1e6
 path='/workspace/bench-perf.bin';block=os.urandom(1024*1024);start=time.perf_counter()
 with open(path,'wb',buffering=0) as f:
  for i in range(64):f.write(block)
  os.fsync(f.fileno())
 results['disk-write-mbps']=64*1024*1024/(time.perf_counter()-start)/1e6
 start=time.perf_counter()
 with open(path,'rb',buffering=0) as f:
  while f.read(1024*1024):pass
 results['disk-read-mbps']=64*1024*1024/(time.perf_counter()-start)/1e6
 rng=random.Random(45);block=block[:4096];start=time.perf_counter()
 with open(path,'r+b',buffering=0) as f:
  for i in range(256):f.seek(rng.randrange(16384)*4096);f.write(block);os.fsync(f.fileno())
 results['disk-4k-write-iops']=256/(time.perf_counter()-start)
 start=time.perf_counter()
 with open(path,'rb',buffering=0) as f:
  for i in range(256):f.seek(rng.randrange(16384)*4096);f.read(4096)
 results['disk-4k-read-iops']=256/(time.perf_counter()-start);os.unlink(path)
 try:
  start=time.perf_counter();total=0
  with urllib.request.urlopen(urllib.request.Request('https://speed.cloudflare.com/__down?bytes=25000000',headers={'User-Agent':'Mozilla/5.0'}),timeout=30) as f:
   while True:
    chunk=f.read(1024*1024)
    if not chunk:break
    total+=len(chunk)
  if total!=25000000:raise ValueError('CDN byte count mismatch')
  results['network-mbps']=total/(time.perf_counter()-start)/1e6
 except Exception as e:notes.append('network-mbps: '+str(e))
 try:
  samples=[]
  for i in range(5):
   start=time.perf_counter()
   with socket.create_connection(('1.1.1.1',443),timeout=5):samples.append((time.perf_counter()-start)*1000)
  results['tcp-ms']=sum(samples)/len(samples)
 except Exception as e:notes.append('tcp-ms: '+str(e))
 print(json.dumps({'metrics':results,'notes':notes,'workers':n,'method':'CPython LCG iterations/s; 16MiB bytearray copy; buffered 64MiB disk, fsync writes (4k queue depth 1), cached reads; no O_DIRECT; network includes TLS and transfer; TCP mean of 5 connects'}))
if __name__=='__main__':main()
