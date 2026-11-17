// ring.js — the datagram seam, now with a real socket.
//
// The engine's RakNet is complete: it selects the transport, parses the join
// script, calls Connect, builds RUPP, retransmits and replicates. What it does
// not have is a socket, because a browser has none. tools/patch.py splices the
// syscalls into two rings in linear memory; this file moves bytes between those
// rings and one UDPSocket. Nothing here knows about RakNet.
//
// It works because the engine is a pthread build: Emscripten creates its memory
// with `shared: true`, so page and workers already share one SharedArrayBuffer.
// Wrapping WebAssembly.Memory at load time is enough.
(() => {
  if (globalThis.__rkRing) return;

  const ABI = globalThis.__rkAbi;
  if (!ABI) throw new Error("ring ABI missing: /abi.js did not load");
  const at = (off) => ABI.base + off;
  const MAGIC = at(ABI.magic);
  const TX_HEAD = at(ABI.txHead);
  const TX_TAIL = at(ABI.txTail);
  const RX_HEAD = at(ABI.rxHead);
  const RX_TAIL = at(ABI.rxTail);
  const WAKE = at(ABI.wake); // futex word: page notifies, recv waits
  const SLOT = ABI.slot;
  const NSLOT = ABI.slots;
  const TX0 = at(ABI.tx0);
  const RX0 = at(ABI.rx0);
  const MAX_DATAGRAM = ABI.maxDatagram;
  const MAGIC_VALUE = 0x4b52414e; // 'RAKN'

  let mem = null, i32 = null, u8 = null, u32 = null;
  let socket = null, writer = null, reader = null;
  let rupp = null;
  let running = false;

  const stats = { tx: 0, rx: 0, dropRx: 0, txBytes: 0, rxBytes: 0, errors: 0, started: 0 };
  const log = (...a) => console.log("[rkring]", ...a);

  // ---------------------------------------------------------------- memory ---
  // The heap is fixed: the engine asks for 32768 pages — 2 GiB — and the ring
  // ABI lives at the top of it, so the size cannot be trimmed without moving
  // the seam (tools/patch.py). If the allocation fails there is no client at
  // all, and the usual reason is a second app window holding the same 2 GiB.
  const RealMemory = WebAssembly.Memory;
  function Memory(desc) {
    let m;
    try {
      m = new RealMemory(desc);
    } catch (e) {
      if (!globalThis.__rkMemAlerted) {
        globalThis.__rkMemAlerted = true;
        window.alert(
          "Roblox could not get the memory it needs (about 2 GB).\n\n" +
            "Close any other Roblox window, then reload."
        );
      }
      throw e;
    }
    if (desc && desc.shared) attach(m);
    return m;
  }
  Memory.prototype = RealMemory.prototype;
  Object.setPrototypeOf(Memory, RealMemory);
  WebAssembly.Memory = Memory;

  function attach(m) {
    if (mem) return;
    mem = m;
    i32 = new Int32Array(m.buffer);
    u8 = new Uint8Array(m.buffer);
    u32 = new Uint32Array(m.buffer);
    Atomics.store(i32, MAGIC >> 2, MAGIC_VALUE);
    log("shared memory captured, " + m.buffer.byteLength + " B");
    pumpLoop();
  }

  // ----------------------------------------------------------------- guest ---
  /**
   * Point the ring at the game server. `script` is the join script object.
   *
   * One socket owns the source port for the whole session: RakNet sends from
   * several wasm pthreads, and an import-per-send would open a new local port
   * per JS context, which the RCC reads as the session jumping hosts. Hence the
   * TX ring and one pump here.
   */
  async function start({ host, port, script }) {
    if (running) return snapshot();
    if (!host || !port) throw new Error("ring.start needs host and port");
    rupp = new Rupp().setJoinScript(script);

    // IWA uses Direct Sockets. The site installs a WebSocket factory with the
    // same opened/readable/writable contract, so the engine does not change.
    socket = globalThis.__webloxSocketFactory
      ? globalThis.__webloxSocketFactory({ remoteAddress: host, remotePort: port })
      : new UDPSocket({ remoteAddress: host, remotePort: port });
    const opened = await socket.opened;
    writer = opened.writable.getWriter();
    reader = opened.readable.getReader();
    running = true;
    stats.started++;
    log(`socket open -> ${host}:${port} local ${opened.localPort}`);

    stats.localPort = opened.localPort;
    readLoop();
    return snapshot();
  }

  function snapshot() {
    return { running, tx: stats.tx, rx: stats.rx, txBytes: stats.txBytes, rxBytes: stats.rxBytes, localPort: stats.localPort };
  }

  // ------------------------------------------------------------- tx pump -----
  let pumpDelay = 2;
  let pumping = false;

  function pumpLoop() {
    if (!pumping) {
      pumping = true;
      (running ? pumpOut() : Promise.resolve(0))
        .catch((e) => {
          stats.errors++;
          log("tx: " + e);
          return 0;
        })
        .then((sent) => {
          pumping = false;
          // Polling costs a wakeup per tick, so back off when idle and snap
          // back the moment a datagram appears.
          pumpDelay = sent ? 2 : Math.min(10, pumpDelay + 1);
          setTimeout(pumpLoop, pumpDelay);
        });
      return;
    }
    setTimeout(pumpLoop, pumpDelay);
  }

  /**
   * One await per datagram, in ring order. Awaiting keeps the stream queue at
   * depth 1: without it the engine can enqueue hundreds of writes and the
   * page spends its main thread on microtasks.
   */
  async function pumpOut() {
    let tail = Atomics.load(i32, TX_TAIL >> 2);
    const head = Atomics.load(i32, TX_HEAD >> 2);
    let sent = 0;
    while (tail !== head) {
      const base = TX0 + (tail & (NSLOT - 1)) * SLOT;
      const len = u32[base >> 2];
      if (len === 0 || len > MAX_DATAGRAM) break;
      // Copy out of shared memory: the writer holds the buffer across a task.
      const dgram = u8.slice(base + 4, base + 4 + len);
      rupp.stamp(dgram);
      await writer.write({ data: dgram });
      stats.tx++;
      stats.txBytes += len;
      sent++;
      tail++;
      Atomics.store(i32, TX_TAIL >> 2, tail);
    }
    return sent;
  }

  // ------------------------------------------------------------- rx path -----
  async function readLoop() {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        stats.errors++;
        log("rx error: " + e);
        break;
      }
      if (chunk.done) break;
      const msg = chunk.value;
      const data = new Uint8Array(msg.data || msg);
      rupp.learn(data);
      enqueue(data);
    }
    running = false;
    log("socket closed");
  }

  function enqueue(data) {
    if (!data.length) return;
    const len = Math.min(data.length, MAX_DATAGRAM);
    const head = Atomics.load(i32, RX_HEAD >> 2);
    const tail = Atomics.load(i32, RX_TAIL >> 2);
    if (head - tail >= NSLOT) {
      stats.dropRx++;
      return;
    }
    const base = RX0 + (head & (NSLOT - 1)) * SLOT;
    u8.set(data.subarray(0, len), base + 4);
    u32[base >> 2] = len;
    Atomics.store(i32, RX_HEAD >> 2, head + 1);
    Atomics.notify(i32, WAKE >> 2, 1); // wake the engine's recv thread
    stats.rx++;
    stats.rxBytes += len;
  }

  globalThis.__rkRing = Object.assign(
    () => snapshot(),
    { start, stats, get rupp() { return rupp; }, get running() { return running; } }
  );
  log("ring seam installed");
})();
