# Rootless pip bootstrap: pinned wheel and SHA-256, never modifies system site-packages.
import urllib.request,hashlib,os,sys,subprocess
url='https://files.pythonhosted.org/packages/c9/bc/b7db44f5f39f9d0494071bddae6880eb645970366d0a200022a1a93d57f5/pip-25.0.1-py3-none-any.whl'
with urllib.request.urlopen(url,timeout=30) as response:data=response.read()
if hashlib.sha256(data).hexdigest()!='c46efd13b6aa8279f33f2864459c8ce587ea6a1a59ee20de055868d8f7688f7f':raise ValueError('pip bootstrap checksum mismatch')
wheel='/workspace/bench-pip.whl'
with open(wheel,'wb') as f:f.write(data)
packages=['requests==2.32.3','numpy==2.3.5','certifi==2025.1.31','charset-normalizer==3.4.1','idna==3.10','urllib3==2.3.0']
subprocess.run([sys.executable,'-m','pip','install','--disable-pip-version-check','--no-cache-dir','--only-binary=:all:','--target','/workspace/bench-python',*packages],env={**os.environ,'PYTHONPATH':wheel},check=True)
subprocess.run([sys.executable,'-c','import numpy,requests; assert numpy.__version__=="2.3.5"; assert requests.__version__=="2.32.3"'],env={**os.environ,'PYTHONPATH':'/workspace/bench-python'},check=True)
