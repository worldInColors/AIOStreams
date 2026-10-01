#!/usr/bin/env python3
"""Head-piece fetcher that joins the swarm for one torrent wanting ONLY the
selected file's opening pieces (plus its last piece), with time-critical
deadlines, then retreats to a handoff-only peer set and dials qBittorrent's
own listener so it can pull the verified pieces from us while it builds its
own copy.

Protocol (JSON lines on stdout):
  {"event": "metadata", "info_hash": H, "files": [{"name": N, "size": S}, ...]}  (magnet mode only)
  {"event": "listening", "port": N, "lt": V}
  {"event": "head_piece", "piece": P, "t": S, "done": K}
  {"event": "head_ready", "bytes": B}                  (register now, playback can start)
  {"event": "tail_ready", "tail_bytes": T}             (seek index at EOF available)
  {"event": "head_complete", "of": K, "seconds": S, "port": N, "bytes": B, "tail_bytes": T}
      (then idles seeding until the parent's sweeper reaps us)
  {"event": "budget_exceeded", ...} / errors exit non-zero

Args: source file-index want-bytes budget-s [qb-endpoint] [save-dir]
  source:     a .torrent file path, or a magnet: URI. In magnet mode the
              de-padded file list is emitted on stdout and the selected
              index + want bytes arrive as one JSON line on stdin
              ({"index": I, "want": N}); fetching the metadata ourselves
              beats waiting for qBittorrent to do it, and the .torrent we
              write back lets the parent add qBittorrent with metadata
              already in place.
  file-index: index into the DE-PADDED file list (qBittorrent 4.4+ hides
              BEP47 pad files and renumbers, so its indices skip them).
  qb-endpoint: qBittorrent's listen ip:port (for the background seed link)
  save-dir:   parent-owned directory; we never delete it (only a temp dir
               we created ourselves is cleaned on exit)
"""
import ipaddress
import json
import os
import shutil
import signal
import sys
import tempfile
import time

import libtorrent as lt

SOURCE = sys.argv[1]
FILE_ARG = sys.argv[2] if len(sys.argv) > 2 else ""
WANT_BYTES = int(sys.argv[3]) if len(sys.argv) > 3 else 16 * 1024 * 1024
BUDGET_S = float(sys.argv[4]) if len(sys.argv) > 4 else 30.0
QB_ENDPOINT = sys.argv[5] if len(sys.argv) > 5 else ""  # qB listen ip:port
SAVE_PATH = sys.argv[6] if len(sys.argv) > 6 else ""    # parent-owned save dir

sp = lt.default_settings()
# All-out sprint for a handful of pieces. TCP only, a uTP teardown is
# invisible to remotes for minutes and a FIN is not.
#
# Bind the same interface qBittorrent uses, the default route would leak
# the host IP on VPN-bound deployments.
qb_endpoint_parsed = ""
if len(sys.argv) > 5 and ":" in sys.argv[5]:
    qb_endpoint_parsed = sys.argv[5]
_bind_ip = qb_endpoint_parsed.rsplit(":", 1)[0].strip("[]")
# IPv6 literals need bracketing in listen_interfaces.
_listen_host = f"[{_bind_ip}]" if ":" in _bind_ip else _bind_ip
sp["listen_interfaces"] = f"{_listen_host}:0" if _bind_ip else "0.0.0.0:0"
if _bind_ip:
    sp["outgoing_interfaces"] = _bind_ip
sp["enable_outgoing_utp"] = False
sp["enable_incoming_utp"] = False
sp["enable_dht"] = True
# A persisted DHT routing table skips most of the bootstrap delay on every
# run after the first, replaced atomically.
DHT_STATE = os.path.join(
    os.path.dirname(SAVE_PATH) if SAVE_PATH else tempfile.gettempdir(),
    "dht-state",
)
try:
    with open(DHT_STATE, "rb") as fh:
        sp["dht_state"] = fh.read()
except Exception:
    pass
# error|status|peer covers everything we read (piece_finished, peer connect/
# disconnect/blocked), the full mask also enables peer_log/torrent_log,
# which libtorrent documents as expensive at high connection counts.
try:
    sp["alert_mask"] = (
        lt.alert_categories.error
        | lt.alert_categories.status
        | lt.alert_categories.peer
    )
except Exception:
    sp["alert_mask"] = 0x7FFFFFFF
sp["connections_limit"] = 800
sp["connection_speed"] = 200
sp["torrent_connect_boost"] = 80
sp["max_out_request_queue"] = 1500
sp["request_queue_time"] = 5
sp["peer_connect_timeout"] = 5
sp["unchoke_interval"] = 3
ses = lt.session(sp)

tmp = SAVE_PATH if SAVE_PATH else tempfile.mkdtemp(prefix="qbit-head-")
t_boot = time.time()
if SOURCE.startswith("magnet:"):
    params = lt.parse_magnet_uri(SOURCE)
    params.save_path = tmp
    h = ses.add_torrent(params)
    while not h.has_metadata():
        if time.time() - t_boot > BUDGET_S:
            print(json.dumps({"event": "metadata_timeout"}), flush=True)
            sys.exit(4)
        time.sleep(0.2)
    info = h.torrent_file()
    # Nothing is wanted until the parent names the file, default priority
    # would burn the peer slots on pieces nobody asked for.
    h.prioritize_pieces([0] * info.num_pieces())
else:
    info = lt.torrent_info(SOURCE)
    h = ses.add_torrent({"ti": info, "save_path": tmp})
    h.prioritize_pieces([0] * info.num_pieces())

# Never announce a private torrent from this second client, a second peer
# id from the same IP is what whitelists punish.
if info.priv():
    print(json.dumps({"event": "private_refused"}), flush=True)
    sys.exit(6)

expected_hash = str(h.info_hash()) if SOURCE.startswith("magnet:") else str(info.info_hash())

# Enumerate the file table with byte offsets. Pad files occupy space in the
# layout (offsets must include them) but are hidden from qBittorrent's file
# list (4.4+ renumbers), so the EMITTED list skips them and its indices
# match qBittorrent's.
nonpad = []
offset = 0
for fe in info.files():
    path = fe.path if hasattr(fe, "path") else ""
    is_pad = bool(getattr(fe, "pad_file", False)) or (
        hasattr(fe, "flags") and hasattr(lt, "file_storage")
        and bool(fe.flags & lt.file_storage.flag_pad_file)
    )
    if not is_pad:
        nonpad.append((path, offset, fe.size))
    offset += fe.size

if SOURCE.startswith("magnet:"):
    print(json.dumps({"event": "metadata", "info_hash": expected_hash,
                      "files": [{"name": p, "size": s} for p, _, s in nonpad]}), flush=True)
    line = sys.stdin.readline()
    if not line.strip():
        sys.exit(5)
    req = json.loads(line)
    selected = nonpad[int(req.get("index", -1))]
    WANT_BYTES = int(req.get("want", WANT_BYTES))
else:
    selected = nonpad[int(FILE_ARG)] if FILE_ARG.lstrip("-").isdigit() and int(FILE_ARG) < len(nonpad) else None
    if selected is None:
        print(json.dumps({"event": "file_not_found", "arg": FILE_ARG}), flush=True)
        sys.exit(3)

sel_path, file_offset, file_size = selected

# The .torrent for the parent's add, written before the fetch so metadata
# and download overlap. It must hash to the same infohash, on mismatch the
# parent falls back to the magnet add.
if SOURCE.startswith("magnet:"):
    try:
        t = lt.create_torrent(info)
        torrent_bytes = lt.bencode(t.generate())
        regen = lt.torrent_info(lt.bdecode(torrent_bytes))
        print(json.dumps({"event": "torrent_hash_ok" if str(regen.info_hash()) == expected_hash
                          else "torrent_hash_mismatch"}), flush=True)
        with open(os.path.join(tmp, "head.torrent"), "wb") as fh:
            fh.write(torrent_bytes)
    except Exception as e:
        print(json.dumps({"event": "torrent_write_error", "err": str(e)[:120]}), flush=True)

piece_size = info.piece_length()
n = info.num_pieces()
lo = file_offset // piece_size
hi = min((file_offset + file_size + piece_size - 1) // piece_size - 1, n - 1)
skew = file_offset - lo * piece_size
head_count = max(1, min((WANT_BYTES + skew + piece_size - 1) // piece_size, hi - lo + 1))
head_pieces = list(range(lo, lo + head_count))
# Matroska players read the seek index at the END of the file before the
# first frame, fetch the last piece too. Its deadline sits behind the
# head's so it never competes with the pieces playback waits on.
tail_start = lo + head_count
tail_pieces = [hi] if hi >= tail_start else []

prios = [0] * n
for p in head_pieces:
    prios[p] = 7
    h.set_piece_deadline(p, 0)
for p in tail_pieces:
    prios[p] = 7
    h.set_piece_deadline(p, 1500)
h.prioritize_pieces(prios)
h.force_reannounce()
h.force_dht_announce()

verified_bytes = min(head_count * piece_size - skew, file_size)
tail_bytes = min(file_size, file_offset + file_size - hi * piece_size) if tail_pieces else 0

port = ses.listen_port()
print(json.dumps({"event": "listening", "port": port,
                  "lt": getattr(lt, "__version__", "?")}), flush=True)

t0 = time.time()
done = set()
head_set = set(head_pieces)
want_set = head_set | set(tail_pieces)
while not head_set <= done:
    if time.time() - t0 > BUDGET_S:
        print(json.dumps({"event": "budget_exceeded", "done": len(done & head_set),
                          "of": len(head_set),
                          "seconds": round(time.time() - t0, 1)}), flush=True)
        sys.exit(2)
    for a in ses.pop_alerts():
        if a.__class__.__name__ == "piece_finished_alert" and a.piece_index in want_set:
            done.add(a.piece_index)
            if a.piece_index in head_set:
                print(json.dumps({"event": "head_piece", "piece": a.piece_index,
                                  "t": round(time.time() - t0, 1),
                                  "done": len(done & head_set)}), flush=True)
    done |= {p for p in want_set if h.have_piece(p)}
    time.sleep(0.1)
print(json.dumps({"event": "head_ready", "bytes": verified_bytes}), flush=True)
if not tail_pieces or set(tail_pieces) <= done:
    print(json.dumps({"event": "tail_ready", "tail_bytes": tail_bytes}), flush=True)

# libtorrent 2.x serves mmap-coherent reads, the flush is belt and braces
# for the write-cached 1.x backend.
try:
    h.flush_cache()
except Exception:
    pass

# Head secured, retreat to handoff-only. Filter rules are OR'd per address,
# an exclusion must be a GAP between block ranges, never an allow rule.
qb_ip, qb_port_s = (QB_ENDPOINT.rsplit(":", 1) + [""])[:2] if QB_ENDPOINT else ("", "")
QB_PORT = int(qb_port_s) if qb_port_s.isdigit() else 0
try:
    allowed = ["127.0.0.1", "::1"]
    if qb_ip:
        allowed.append(qb_ip.strip("[]"))
    f = lt.ip_filter()
    # ip_address(int) guesses IPv4 for small ints, which would pair a v4
    # bound with a v6 one ("bad address cast"), be family-explicit.
    for version, bottom, top in ((4, "0.0.0.0", "255.255.255.255"),
                                 (6, "::2",
                                  "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")):
        family = ipaddress.IPv4Address if version == 4 else ipaddress.IPv6Address
        keep = sorted({int(ipaddress.ip_address(a)) for a in allowed
                       if ipaddress.ip_address(a).version == version})
        prev = int(family(bottom))
        for a in keep:
            if a > prev:
                f.add_rule(str(family(prev)), str(family(a - 1)), 1)
            prev = max(prev, a + 1)
        if prev <= int(family(top)):
            f.add_rule(str(family(prev)), top, 1)
    ses.set_ip_filter(f)
except Exception as e:
    print(json.dumps({"event": "filter_error", "err": str(e)[:120]}), flush=True)
print(json.dumps({"event": "head_complete", "of": len(done),
                  "seconds": round(time.time() - t0, 1), "port": port,
                  "bytes": verified_bytes, "tail_bytes": tail_bytes}), flush=True)


def _dial_qb():
    # qBittorrent never dials addPeers when interface-bound, so dial qB's
    # own listener instead. connect_peer on a live connection is a no-op,
    # the idle loop retries it.
    if not qb_ip or QB_PORT <= 0:
        return
    try:
        h.connect_peer((qb_ip.strip("[]"), QB_PORT))
    except Exception as e:
        print(json.dumps({"event": "dial_error", "err": str(e)}), flush=True)


_dial_qb()


# Idle seeding until the sweeper reaps us. A parent-owned save dir survives
# our exit, only our own temp dir is cleaned here.
def _term(signum, frame):
    try:
        ses.remove_torrent(h)
    except Exception:
        pass
    try:
        state = ses.save_state()
        if state.get("dht_state"):
            tmp_state = DHT_STATE + ".tmp"
            with open(tmp_state, "wb") as fh:
                fh.write(state["dht_state"])
            os.replace(tmp_state, DHT_STATE)
    except Exception:
        pass
    if not SAVE_PATH:
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(0)


signal.signal(signal.SIGTERM, _term)
signal.signal(signal.SIGINT, _term)
last_dial = time.time()
blocked = 0
logs = 0
tail_sent = not tail_pieces or set(tail_pieces) <= done
while True:
    # Never die on our own, qB depends on this loop. The one fatal case is
    # the parent disappearing, nobody would ever reap us.
    try:
        for a in ses.pop_alerts():
            cn = a.__class__.__name__
            if cn == "peer_connect_alert":
                ep = getattr(a, "endpoint", None) or getattr(a, "ip", None)
                print(json.dumps({"event": "peer_connect", "ep": str(ep)}), flush=True)
            elif cn == "peer_disconnected_alert":
                try:
                    why = a.message()[:140]
                except Exception:
                    why = str(getattr(a, "error", ""))[:140]
                print(json.dumps({"event": "peer_disconnect", "why": why}), flush=True)
            elif cn == "peer_blocked_alert":
                blocked += 1
        if not tail_sent and all(h.have_piece(p) for p in tail_pieces):
            tail_sent = True
            print(json.dumps({"event": "tail_ready", "tail_bytes": tail_bytes}), flush=True)
        st = h.status()
        peers = h.get_peer_info()
        logs += 1
        if logs <= 10 or logs % 10 == 0:
            print(json.dumps({"event": "serving", "t": round(time.time() - t0, 1),
                              "peers": len(peers), "blocked": blocked,
                              "uploaded_mb": round(st.total_payload_upload / 1e6, 1)}), flush=True)
        if time.time() - last_dial >= 5:
            last_dial = time.time()
            _dial_qb()
    except BrokenPipeError:
        sys.exit(0)
    except Exception as e:
        try:
            print(json.dumps({"event": "idle_error", "err": str(e)[:120]}), flush=True)
        except Exception:
            pass
    time.sleep(1)
