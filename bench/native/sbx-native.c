/*
 * sbx-native: one static x86_64 Linux binary for the bench's fairness checks. It has no libc and
 * no dynamic loader, so every provider runs the same machine code no matter which distribution,
 * interpreter or C library its image ships. Built by build.sh for baseline x86-64 (no AVX), so no
 * provider gets a faster code path because its CPU has wider vectors.
 *
 *   sbx-native version
 *   sbx-native cpu  <seed> <workers> <target_ms> <chunk>
 *   sbx-native disk <dir> <seed> <size_mib> <rand_ms>
 *   sbx-native mem  <seed> <mib> <file_path> <file_mib>
 *
 * Every mode prints one JSON line last. `mem` also prints `#phase ...` lines as it goes, so an
 * out-of-memory kill still shows how far it got. The host checks the results (bench/src/fairness).
 */

typedef unsigned long u64;
typedef long i64;
typedef unsigned int u32;
typedef unsigned char u8;

/* ------------------------------------------------------------------------------------------ */
/* Syscalls                                                                                    */

enum {
  SYS_read = 0,
  SYS_write = 1,
  SYS_open = 2,
  SYS_close = 3,
  SYS_mmap = 9,
  SYS_munmap = 11,
  SYS_pread64 = 17,
  SYS_pwrite64 = 18,
  SYS_pipe = 22,
  SYS_fork = 57,
  SYS_wait4 = 61,
  SYS_fdatasync = 75,
  SYS_unlink = 87,
  SYS_statfs = 137,
  SYS_fadvise64 = 221,
  SYS_clock_gettime = 228,
  SYS_exit_group = 231,
};

static i64 sys6(i64 n, i64 a, i64 b, i64 c, i64 d, i64 e, i64 f) {
  i64 ret;
  register i64 r10 __asm__("r10") = d;
  register i64 r8 __asm__("r8") = e;
  register i64 r9 __asm__("r9") = f;
  __asm__ volatile("syscall"
                   : "=a"(ret)
                   : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9)
                   : "rcx", "r11", "memory");
  return ret;
}

#define SYS3(n, a, b, c) sys6((n), (i64)(a), (i64)(b), (i64)(c), 0, 0, 0)
#define SYS4(n, a, b, c, d) sys6((n), (i64)(a), (i64)(b), (i64)(c), (i64)(d), 0, 0)

#define O_RDONLY 0
#define O_WRONLY 1
#define O_CREAT 0100
#define O_TRUNC 01000
#define O_DIRECT 040000
#define EINVAL 22
#define PROT_RW 3
#define MAP_PRIVATE_ANON 0x22
#define FADV_DONTNEED 4
#define CLOCK_MONOTONIC 1

__attribute__((noreturn)) static void exit_now(int code) {
  for (;;) SYS3(SYS_exit_group, code, 0, 0);
}

void *memset(void *dst, int value, u64 n) {
  u8 *d = dst;
  while (n--) *d++ = (u8)value;
  return dst;
}

void *memcpy(void *dst, const void *src, u64 n) {
  u8 *d = dst;
  const u8 *s = src;
  while (n--) *d++ = *s++;
  return dst;
}

static u64 now_ns(void) {
  i64 ts[2];
  SYS3(SYS_clock_gettime, CLOCK_MONOTONIC, ts, 0);
  return (u64)ts[0] * 1000000000ul + (u64)ts[1];
}

static void *map(u64 bytes) {
  i64 p = sys6(SYS_mmap, 0, (i64)bytes, PROT_RW, MAP_PRIVATE_ANON, -1, 0);
  return p < 0 && p > -4096 ? 0 : (void *)p;
}

/* ------------------------------------------------------------------------------------------ */
/* Output                                                                                      */

static char out[1 << 16];
static u64 out_len;

static void put(const char *s) {
  while (*s && out_len < sizeof out - 1) out[out_len++] = *s++;
}

static void put_u64(u64 v) {
  char tmp[24];
  int n = 0;
  do {
    tmp[n++] = (char)('0' + v % 10);
    v /= 10;
  } while (v);
  while (n--) {
    char c[2] = {tmp[n], 0};
    put(c);
  }
}

static void put_i64(i64 v) {
  if (v < 0) {
    put("-");
    put_u64((u64)(-v));
  } else
    put_u64((u64)v);
}

/* Nanoseconds as seconds with nine decimals. */
static void put_secs(u64 ns) {
  u64 frac = ns % 1000000000ul;
  char digits[10];
  put_u64(ns / 1000000000ul);
  put(".");
  for (int i = 8; i >= 0; i--) {
    digits[i] = (char)('0' + frac % 10);
    frac /= 10;
  }
  digits[9] = 0;
  put(digits);
}

static void key(const char *k) {
  put("\"");
  put(k);
  put("\":");
}

static void flush(int fd) {
  u64 done = 0;
  while (done < out_len) {
    i64 n = SYS3(SYS_write, fd, out + done, out_len - done);
    if (n <= 0) break;
    done += (u64)n;
  }
  out_len = 0;
}

static void say(const char *s) {
  put(s);
  flush(1);
}

__attribute__((noreturn)) static void fail(const char *mode, const char *what, i64 err) {
  out_len = 0;
  put("{\"mode\":\"");
  put(mode);
  put("\",\"error\":\"");
  put(what);
  put("\",\"errno\":");
  put_i64(-err);
  put("}\n");
  flush(1);
  exit_now(4);
}

static int parse_u64(const char *s, u64 *value) {
  u64 v = 0;
  if (!*s) return 0;
  for (; *s; s++) {
    if (*s < '0' || *s > '9') return 0;
    v = v * 10 + (u64)(*s - '0');
  }
  *value = v;
  return 1;
}

static int same(const char *a, const char *b) {
  while (*a && *a == *b) a++, b++;
  return *a == *b;
}

/* ------------------------------------------------------------------------------------------ */
/* Arithmetic shared with the host (bench/src/fairness/native.ts)                             */

#define GOLDEN 0x9e3779b9u

static u32 fmix32(u32 h) {
  h ^= h >> 16;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  h *= 0xc2b2ae35u;
  h ^= h >> 16;
  return h;
}

/* Word g of a seeded stream: the memory test's pages and the disk test's pool. */
static u32 stream_word(u32 seed, u64 g) { return fmix32((u32)g * GOLDEN + seed); }

static u32 xorshift32(u32 *state) {
  u32 x = *state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return *state = x;
}

/* ------------------------------------------------------------------------------------------ */
/* cpu: cpu-all's 32-bit LCG, one forked worker per requested core                             */

struct cpu_row {
  u32 index;
  u32 seed;
  u64 steps;
  u32 checksum;
  u32 pad;
  u64 elapsed_ns;
};

/* The empty asm keeps x in a register each step: no unrolled shortcut, one dependent chain. */
__attribute__((noinline)) static u32 lcg_run(u32 x, u64 n) {
  for (u64 i = 0; i < n; i++) {
    x = x * 1664525u + 1013904223u;
    __asm__ volatile("" : "+r"(x));
  }
  return x;
}

static int cmd_cpu(u64 seed, u64 workers, u64 target_ms, u64 chunk) {
  int go[2], res[2];
  struct cpu_row rows[64];
  if (workers < 1 || workers > 64 || chunk < 1) fail("cpu", "bad arguments", -EINVAL);
  if (SYS3(SYS_pipe, go, 0, 0) < 0 || SYS3(SYS_pipe, res, 0, 0) < 0) fail("cpu", "pipe", -1);

  for (u64 i = 0; i < workers; i++) {
    i64 pid = SYS3(SYS_fork, 0, 0, 0);
    if (pid < 0) fail("cpu", "fork", pid);
    if (pid == 0) {
      char token;
      struct cpu_row row;
      u32 x = (u32)seed ^ (u32)((i + 1) * GOLDEN);
      u64 steps = 0, elapsed, start, target = target_ms * 1000000ul;
      row.index = (u32)i;
      row.seed = x;
      SYS3(SYS_close, go[1], 0, 0);
      SYS3(SYS_close, res[0], 0, 0);
      if (SYS3(SYS_read, go[0], &token, 1) != 1) exit_now(5);
      start = now_ns();
      do {
        x = lcg_run(x, chunk);
        steps += chunk;
        elapsed = now_ns() - start;
      } while (elapsed < target);
      row.steps = steps;
      row.checksum = x;
      row.pad = 0;
      row.elapsed_ns = elapsed;
      if (SYS3(SYS_write, res[1], &row, sizeof row) != (i64)sizeof row) exit_now(6);
      exit_now(0);
    }
  }

  /* Only the workers keep the result pipe's write end: a worker that dies before reporting
     closes it, so the read below ends instead of waiting for the exec timeout. */
  SYS3(SYS_close, go[0], 0, 0);
  SYS3(SYS_close, res[1], 0, 0);
  char tokens[64];
  memset(tokens, 'g', sizeof tokens);
  u64 start = now_ns();
  if (SYS3(SYS_write, go[1], tokens, workers) != (i64)workers) fail("cpu", "release", -1);

  for (u64 got = 0; got < workers; got++) {
    struct cpu_row row;
    u64 have = 0;
    while (have < sizeof row) {
      i64 n = SYS3(SYS_read, res[0], (u8 *)&row + have, sizeof row - have);
      if (n <= 0) fail("cpu", "worker result", n);
      have += (u64)n;
    }
    if (row.index >= workers) fail("cpu", "worker index", -1);
    rows[row.index] = row;
  }
  u64 wall = now_ns() - start;

  for (u64 i = 0; i < workers; i++) {
    int status = 0;
    if (SYS4(SYS_wait4, -1, &status, 0, 0) < 0 || status != 0) fail("cpu", "worker exit", -1);
  }

  u64 total = 0;
  for (u64 i = 0; i < workers; i++) total += rows[i].steps;
  put("{\"mode\":\"cpu\",");
  key("wallS");
  put_secs(wall);
  put(",");
  key("totalSteps");
  put_u64(total);
  put(",");
  key("opsPerSec");
  put_u64(wall >= 1000000ul ? total * 1000ul / (wall / 1000000ul) : 0);
  put(",\"workers\":[");
  for (u64 i = 0; i < workers; i++) {
    if (i) put(",");
    put("{");
    key("seed");
    put_u64(rows[i].seed);
    put(",");
    key("steps");
    put_u64(rows[i].steps);
    put(",");
    key("checksum");
    put_u64(rows[i].checksum);
    put(",");
    key("elapsedS");
    put_secs(rows[i].elapsed_ns);
    put("}");
  }
  put("]}\n");
  flush(1);
  return 0;
}

/* ------------------------------------------------------------------------------------------ */
/* disk: direct-I/O sequential and synced 4 KiB random I/O on one file                        */

#define PAGE 4096ul
#define PAGE_WORDS 1024ul
#define BLOCK (1ul << 20)
#define POOL_PAGES 16384ul /* 64 MiB of seeded words, reused with a stamp per page */
#define MAX_RAND_OPS 1000000ul
#define STAMP_MAGIC 0x53425844u /* "SBXD" */
#define REWRITE_MIX 0x5bd1e995u     /* a rewritten page's stamp and content differ from the first */
#define REWRITE_FLIP 0xa5a5a5a5u

static u32 *pool;

/* Page p's stamp word: version 1 as first written, version 2 once a random write rewrote it. */
static u32 page_stamp(u32 seed, u64 p, int version) {
  return fmix32(seed ^ ((u32)p * GOLDEN) ^ (version == 2 ? REWRITE_MIX : 0u));
}

/* Page p of the test file: a 16-byte stamp, then the pool's page p mod POOL_PAGES (flipped in a
   rewritten page, so a rewrite that never reached the disk reads back as version 1). */
static void fill_page(u32 *dst, u32 seed, u64 p, int version) {
  const u32 *src = pool + (p % POOL_PAGES) * PAGE_WORDS;
  u32 flip = version == 2 ? REWRITE_FLIP : 0u;
  for (u64 k = 4; k < PAGE_WORDS; k++) dst[k] = src[k] ^ flip;
  dst[0] = STAMP_MAGIC;
  dst[1] = seed;
  dst[2] = (u32)p;
  dst[3] = page_stamp(seed, p, version);
}

static int page_ok(const u32 *got, u32 seed, u64 p, int version) {
  const u32 *src = pool + (p % POOL_PAGES) * PAGE_WORDS;
  u32 flip = version == 2 ? REWRITE_FLIP : 0u;
  if (got[0] != STAMP_MAGIC || got[1] != seed || got[2] != (u32)p || got[3] != page_stamp(seed, p, version))
    return 0;
  for (u64 k = 4; k < PAGE_WORDS; k++)
    if (got[k] != (src[k] ^ flip)) return 0;
  return 1;
}

static void sort_u64(u64 *a, u64 n) {
  /* Heapsort: no allocation, O(n log n). */
  for (u64 start = n / 2; start-- > 0;) {
    u64 root = start;
    for (;;) {
      u64 child = root * 2 + 1;
      if (child >= n) break;
      if (child + 1 < n && a[child] < a[child + 1]) child++;
      if (a[root] >= a[child]) break;
      u64 t = a[root];
      a[root] = a[child];
      a[child] = t;
      root = child;
    }
  }
  for (u64 end = n; end-- > 1;) {
    u64 t = a[0];
    a[0] = a[end];
    a[end] = t;
    u64 root = 0;
    for (;;) {
      u64 child = root * 2 + 1;
      if (child >= end) break;
      if (child + 1 < end && a[child] < a[child + 1]) child++;
      if (a[root] >= a[child]) break;
      t = a[root];
      a[root] = a[child];
      a[child] = t;
      root = child;
    }
  }
}

static void put_latency(const char *name, u64 *lat, u64 n) {
  sort_u64(lat, n);
  put(",\"");
  put(name);
  put("\":{");
  key("ops");
  put_u64(n);
  put(",");
  /* Nearest rank: the ceil(q * n)-th smallest sample. */
  key("p50Ns");
  put_u64(n ? lat[(n + 1) / 2 - 1] : 0);
  put(",");
  key("p99Ns");
  put_u64(n ? lat[(n * 99 + 99) / 100 - 1] : 0);
  put(",");
  key("maxNs");
  put_u64(n ? lat[n - 1] : 0);
  put("}");
}

static i64 open_file(const char *path, i64 flags, int *direct) {
  i64 fd = -EINVAL;
  if (*direct) fd = SYS3(SYS_open, path, flags | O_DIRECT, 0600);
  if (fd == -EINVAL) {
    *direct = 0;
    fd = SYS3(SYS_open, path, flags, 0600);
  }
  return fd;
}

static void drop_cache(const char *path) {
  i64 fd = SYS3(SYS_open, path, O_RDONLY, 0);
  if (fd >= 0) {
    SYS4(SYS_fadvise64, fd, 0, 0, FADV_DONTNEED);
    SYS3(SYS_close, fd, 0, 0);
  }
}

static int cmd_disk(const char *dir, u64 seed64, u64 size_mib, u64 rand_ms) {
  static char path[4096];
  i64 st[16];
  u32 seed = (u32)seed64;
  u64 pages = size_mib * (BLOCK / PAGE), blocks = size_mib;
  u64 dir_len = 0;
  int direct = 1, write_direct, read_direct;

  while (dir[dir_len]) dir_len++;
  if (size_mib < 1 || dir_len + 32 > sizeof path) fail("disk", "bad arguments", -EINVAL);
  memcpy(path, dir, dir_len);
  memcpy(path + dir_len, "/sbx-native-disk.bin", 21);

  i64 r = SYS3(SYS_statfs, dir, st, 0);
  if (r < 0) fail("disk", "statfs", r);
  u64 fs_type = (u64)st[0], free_bytes = (u64)st[4] * (u64)st[1];
  if (free_bytes < size_mib * BLOCK + (256ul << 20)) {
    put("{\"mode\":\"disk\",\"error\":\"insufficient space\",");
    key("fsType");
    put_u64(fs_type);
    put(",");
    key("freeBytes");
    put_u64(free_bytes);
    put("}\n");
    flush(1);
    exit_now(4);
  }

  pool = map(POOL_PAGES * PAGE);
  u32 *buf = map(BLOCK);
  u64 *lat = map(MAX_RAND_OPS * 8 * 2);
  u8 *touched = map((pages + 7) / 8 + PAGE);
  if (!pool || !buf || !lat || !touched) fail("disk", "mmap", -1);
  for (u64 g = 0; g < POOL_PAGES * PAGE_WORDS; g++) pool[g] = stream_word(seed, g);

  /* Sequential write, 1 MiB at a time, then fdatasync. Only the syscalls are timed. */
  i64 fd = open_file(path, O_WRONLY | O_CREAT | O_TRUNC, &direct);
  if (fd < 0) fail("disk", "open for write", fd);
  u64 write_ns = 0;
  for (u64 b = 0; b < blocks; b++) {
    for (u64 i = 0; i < BLOCK / PAGE; i++) fill_page(buf + i * PAGE_WORDS, seed, b * (BLOCK / PAGE) + i, 1);
    u64 t0 = now_ns();
    i64 n = SYS3(SYS_write, fd, buf, BLOCK);
    write_ns += now_ns() - t0;
    if (n == -EINVAL && direct && b == 0) {
      /* The filesystem took O_DIRECT at open but refuses it on write: start again buffered. */
      SYS3(SYS_close, fd, 0, 0);
      direct = 0;
      fd = SYS3(SYS_open, path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (fd < 0) fail("disk", "reopen for write", fd);
      write_ns = 0;
      b = (u64)-1;
      continue;
    }
    if (n != (i64)BLOCK) {
      SYS3(SYS_unlink, path, 0, 0);
      fail("disk", "sequential write", n < 0 ? n : -1);
    }
  }
  u64 t0 = now_ns();
  r = SYS3(SYS_fdatasync, fd, 0, 0);
  u64 sync_ns = now_ns() - t0;
  SYS3(SYS_close, fd, 0, 0);
  if (r < 0) fail("disk", "fdatasync", r);
  write_direct = direct;

  /* Sequential read of the whole file, every page checked. */
  drop_cache(path);
  direct = 1;
  fd = open_file(path, O_RDONLY, &direct);
  if (fd < 0) fail("disk", "open for read", fd);
  u64 read_ns = 0, bad_pages = 0;
  u32 stamp_digest = 0;
  for (u64 b = 0; b < blocks; b++) {
    t0 = now_ns();
    i64 n = SYS3(SYS_read, fd, buf, BLOCK);
    read_ns += now_ns() - t0;
    if (n == -EINVAL && direct && b == 0) {
      SYS3(SYS_close, fd, 0, 0);
      direct = 0;
      drop_cache(path);
      fd = SYS3(SYS_open, path, O_RDONLY, 0);
      if (fd < 0) fail("disk", "reopen for read", fd);
      read_ns = 0;
      b = (u64)-1;
      continue;
    }
    if (n != (i64)BLOCK) fail("disk", "sequential read", n < 0 ? n : -1);
    for (u64 i = 0; i < BLOCK / PAGE; i++) {
      u64 p = b * (BLOCK / PAGE) + i;
      if (!page_ok(buf + i * PAGE_WORDS, seed, p, 1)) bad_pages++;
      stamp_digest += buf[i * PAGE_WORDS + 3];
    }
  }
  SYS3(SYS_close, fd, 0, 0);
  read_direct = direct;

  /* Random 4 KiB writes, each followed by fdatasync, for rand_ms. Content stays position-true. */
  direct = write_direct;
  fd = open_file(path, O_WRONLY, &direct);
  if (fd < 0) fail("disk", "open for random write", fd);
  u32 state = fmix32(seed ^ 0xa5a5a5a5u) | 1u;
  u64 wops = 0, phase_start = now_ns(), limit = rand_ms * 1000000ul;
  while (wops < MAX_RAND_OPS && now_ns() - phase_start < limit) {
    u64 p = xorshift32(&state) % pages;
    fill_page(buf, seed, p, 2);
    t0 = now_ns();
    i64 n = sys6(SYS_pwrite64, fd, (i64)buf, (i64)PAGE, (i64)(p * PAGE), 0, 0);
    if (n == -EINVAL && direct && wops == 0) {
      /* 1 MiB direct writes worked but 4 KiB ones do not: run this phase buffered. */
      SYS3(SYS_close, fd, 0, 0);
      direct = 0;
      fd = SYS3(SYS_open, path, O_WRONLY, 0600);
      if (fd < 0) fail("disk", "reopen for random write", fd);
      state = fmix32(seed ^ 0xa5a5a5a5u) | 1u;
      phase_start = now_ns();
      continue;
    }
    i64 s = SYS3(SYS_fdatasync, fd, 0, 0);
    lat[wops++] = now_ns() - t0;
    if (n != (i64)PAGE || s < 0) fail("disk", "random write", n < 0 ? n : s);
    touched[p / 8] |= (u8)(1u << (p % 8));
  }
  u64 rand_write_wall = now_ns() - phase_start;
  SYS3(SYS_close, fd, 0, 0);
  int rand_write_direct = direct;

  /* Random 4 KiB reads for rand_ms, every page checked. */
  drop_cache(path);
  direct = read_direct;
  fd = open_file(path, O_RDONLY, &direct);
  if (fd < 0) fail("disk", "open for random read", fd);
  u64 *rlat = lat + MAX_RAND_OPS;
  u32 rstate = fmix32(seed ^ 0x5a5a5a5au) | 1u, read_digest = 0;
  u64 rops = 0, rand_bad = 0;
  phase_start = now_ns();
  while (rops < MAX_RAND_OPS && now_ns() - phase_start < limit) {
    u64 p = xorshift32(&rstate) % pages;
    t0 = now_ns();
    i64 n = sys6(SYS_pread64, fd, (i64)buf, (i64)PAGE, (i64)(p * PAGE), 0, 0);
    if (n == -EINVAL && direct && rops == 0) {
      SYS3(SYS_close, fd, 0, 0);
      direct = 0;
      drop_cache(path);
      fd = SYS3(SYS_open, path, O_RDONLY, 0);
      if (fd < 0) fail("disk", "reopen for random read", fd);
      rstate = fmix32(seed ^ 0x5a5a5a5au) | 1u;
      phase_start = now_ns();
      continue;
    }
    rlat[rops++] = now_ns() - t0;
    if (n != (i64)PAGE) fail("disk", "random read", n < 0 ? n : -1);
    if (!page_ok(buf, seed, p, (touched[p / 8] >> (p % 8)) & 1 ? 2 : 1)) rand_bad++;
    read_digest += buf[3];
  }
  u64 rand_read_wall = now_ns() - phase_start;
  SYS3(SYS_close, fd, 0, 0);
  int rand_read_direct = direct;
  SYS3(SYS_unlink, path, 0, 0);

  put("{\"mode\":\"disk\",");
  key("fsType");
  put_u64(fs_type);
  put(",");
  key("freeBytes");
  put_u64(free_bytes);
  put(",");
  key("sizeMiB");
  put_u64(size_mib);
  put(",");
  key("seqWrite");
  put("{");
  key("direct");
  put(write_direct ? "true" : "false");
  put(",");
  key("writeS");
  put_secs(write_ns);
  put(",");
  key("syncS");
  put_secs(sync_ns);
  put("},");
  key("seqRead");
  put("{");
  key("direct");
  put(read_direct ? "true" : "false");
  put(",");
  key("readS");
  put_secs(read_ns);
  put(",");
  key("badPages");
  put_u64(bad_pages);
  put(",");
  key("stampDigest");
  put_u64(stamp_digest);
  put("},");
  key("randWrite");
  put("{");
  key("direct");
  put(rand_write_direct ? "true" : "false");
  put(",");
  key("wallS");
  put_secs(rand_write_wall);
  put(",");
  key("capped");
  put(wops >= MAX_RAND_OPS ? "true" : "false");
  put("}");
  put_latency("randWriteLatency", lat, wops);
  put(",");
  key("randRead");
  put("{");
  key("direct");
  put(rand_read_direct ? "true" : "false");
  put(",");
  key("wallS");
  put_secs(rand_read_wall);
  put(",");
  key("badPages");
  put_u64(rand_bad);
  put(",");
  key("digest");
  put_u64(read_digest);
  put(",");
  key("capped");
  put(rops >= MAX_RAND_OPS ? "true" : "false");
  put("}");
  put_latency("randReadLatency", rlat, rops);
  put("}\n");
  flush(1);
  return 0;
}

/* ------------------------------------------------------------------------------------------ */
/* mem: dirty anonymous memory with incompressible words, write a file, verify every word     */

static char status_buf[16384];

/* The number after `name` in a /proc file, in kB, or -1 when absent. */
static i64 proc_kb(const char *file, const char *name) {
  i64 fd = SYS3(SYS_open, file, O_RDONLY, 0), n, total = 0;
  if (fd < 0) return -1;
  while ((n = SYS3(SYS_read, fd, status_buf + total, sizeof status_buf - 1 - total)) > 0) total += n;
  SYS3(SYS_close, fd, 0, 0);
  status_buf[total] = 0;
  for (i64 i = 0; i < total; i++) {
    if (i && status_buf[i - 1] != '\n') continue;
    u64 k = 0;
    while (name[k] && status_buf[i + k] == name[k]) k++;
    if (name[k]) continue;
    char *s = status_buf + i + k;
    while (*s == ' ' || *s == '\t' || *s == ':') s++;
    i64 v = 0;
    if (*s < '0' || *s > '9') return -1;
    while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
    return v;
  }
  return -1;
}

static void put_snapshot(const char *name) {
  put(",\"");
  put(name);
  put("\":{");
  key("vmRssKiB");
  put_i64(proc_kb("/proc/self/status", "VmRSS"));
  put(",");
  key("vmSwapKiB");
  put_i64(proc_kb("/proc/self/status", "VmSwap"));
  put(",");
  key("memAvailableKiB");
  put_i64(proc_kb("/proc/meminfo", "MemAvailable"));
  put(",");
  key("swapFreeKiB");
  put_i64(proc_kb("/proc/meminfo", "SwapFree"));
  put("}");
}

static void phase(const char *name, u64 ns) {
  put("#phase ");
  put(name);
  put(" ");
  put_secs(ns);
  put("\n");
  flush(1);
}

static int cmd_mem(u64 seed64, u64 mib, const char *file, u64 file_mib) {
  u32 seed = (u32)seed64;
  u64 words = mib * (BLOCK / 4);
  say("#phase start 0\n");
  u32 *region = map(mib * BLOCK);
  if (!region) fail("mem", "mmap", -1);

  u64 t0 = now_ns();
  for (u64 g = 0; g < words; g++) region[g] = stream_word(seed, g);
  u64 fill_ns = now_ns() - t0;
  phase("filled", fill_ns);

  i64 rss_filled = proc_kb("/proc/self/status", "VmRSS");
  i64 swap_filled = proc_kb("/proc/self/status", "VmSwap");

  u64 file_ns = 0;
  i64 file_error = 0;
  if (file_mib > 0) {
    i64 fd = SYS3(SYS_open, file, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0)
      file_error = fd;
    else {
      t0 = now_ns();
      u64 chunks = mib ? mib : 1;
      for (u64 b = 0; b < file_mib && !file_error; b++) {
        i64 n = SYS3(SYS_write, fd, (u8 *)region + (b % chunks) * BLOCK, BLOCK);
        if (n != (i64)BLOCK) file_error = n < 0 ? n : -1;
      }
      if (!file_error) {
        i64 s = SYS3(SYS_fdatasync, fd, 0, 0);
        if (s < 0) file_error = s;
      }
      file_ns = now_ns() - t0;
      SYS3(SYS_close, fd, 0, 0);
    }
    phase(file_error ? "file-failed" : "file", file_ns);
  }
  i64 rss_file = proc_kb("/proc/self/status", "VmRSS");
  i64 swap_file = proc_kb("/proc/self/status", "VmSwap");

  t0 = now_ns();
  u64 bad = 0;
  u32 digest = 0;
  for (u64 g = 0; g < words; g++)
    if (region[g] != stream_word(seed, g)) bad++;
  for (u64 p = 0; p < words / PAGE_WORDS; p++) digest += region[p * PAGE_WORDS + ((p * 7) & 1023)];
  u64 verify_ns = now_ns() - t0;
  phase("verified", verify_ns);
  if (file_mib > 0) SYS3(SYS_unlink, file, 0, 0);
  SYS3(SYS_munmap, region, mib * BLOCK, 0);

  put("{\"mode\":\"mem\",");
  key("mib");
  put_u64(mib);
  put(",");
  key("fillS");
  put_secs(fill_ns);
  put(",");
  key("fileMiB");
  put_u64(file_mib);
  put(",");
  key("fileS");
  put_secs(file_ns);
  put(",");
  key("fileErrno");
  put_i64(-file_error);
  put(",");
  key("verifyS");
  put_secs(verify_ns);
  put(",");
  key("badWords");
  put_u64(bad);
  put(",");
  key("digest");
  put_u64(digest);
  put(",");
  key("rssFilledKiB");
  put_i64(rss_filled);
  put(",");
  key("swapFilledKiB");
  put_i64(swap_filled);
  put(",");
  key("rssAfterFileKiB");
  put_i64(rss_file);
  put(",");
  key("swapAfterFileKiB");
  put_i64(swap_file);
  put_snapshot("end");
  put("}\n");
  flush(1);
  return 0;
}

/* ------------------------------------------------------------------------------------------ */

static int usage(void) {
  put("{\"mode\":\"usage\",\"error\":\"usage: version | cpu seed workers target_ms chunk | disk dir "
      "seed size_mib rand_ms | mem seed mib file file_mib\"}\n");
  flush(2);
  return 2;
}

static int run(int argc, char **argv) {
  u64 a, b, c, d;
  if (argc >= 2 && same(argv[1], "version")) {
    say("{\"mode\":\"version\",\"name\":\"sbx-native\",\"version\":2}\n");
    return 0;
  }
  if (argc == 6 && same(argv[1], "cpu") && parse_u64(argv[2], &a) && parse_u64(argv[3], &b) &&
      parse_u64(argv[4], &c) && parse_u64(argv[5], &d))
    return cmd_cpu(a, b, c, d);
  if (argc == 6 && same(argv[1], "disk") && parse_u64(argv[3], &a) && parse_u64(argv[4], &b) &&
      parse_u64(argv[5], &c))
    return cmd_disk(argv[2], a, b, c);
  if (argc == 6 && same(argv[1], "mem") && parse_u64(argv[2], &a) && parse_u64(argv[3], &b) &&
      parse_u64(argv[5], &c))
    return cmd_mem(a, b, argv[4], c);
  return usage();
}

__attribute__((used)) void cmain(i64 *sp) {
  int argc = (int)sp[0];
  char **argv = (char **)(sp + 1);
  exit_now(run(argc, argv));
}

__asm__(".text\n"
        ".globl _start\n"
        "_start:\n"
        "  xor %rbp, %rbp\n"
        "  mov %rsp, %rdi\n"
        "  and $-16, %rsp\n"
        "  call cmain\n"
        "  hlt\n");
