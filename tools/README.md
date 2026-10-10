# Seeing what the user sees: record, replay, debug views

The user plays in a real browser on another machine (Windows Chrome with a
real GPU). This box can only render headless with SwiftShader. These tools
connect the two: the user presses a key, and the poses plus images land in
`recordings/` on this box. You replay those poses headless in any debug view
and read the results as single images.

## Running

```bash
node tools/serve.js --port 8200     # replaces /tmp/e2e/serve.js: same static/, plus uploads
node server/proxy.js --ws-port 8080 --mock --quiet
# user opens http://192.168.135.116:8200/
```

Uploads only work when the page is served by `tools/serve.js`.
`http://192.168.135.116:8200/recordings/` lists what has arrived, newest first.

## User keys (static/js/recorder.js)

| key | action |
|---|---|
| F8 | start/stop recording (60 s max). Logs every frame's origin, angles, keys and mouse delta, and ~10 canvas thumbnails/s. On stop, the user types what they saw and clicks Upload. |
| F9 | marker while recording ("it went wrong here") |
| F7 | snapshot: full-res frame + face-id frame + pose + note |
| F6 | cycle debug view (below) |
| F10 | pose readout: pos / yaw / pitch / view / tris |

`?view=N` on the URL starts in debug view N.

## What lands in recordings/<id>/

- `note.txt`: the user's description. **Read this first.**
- Recording (`*-rec`): `rec.json` (frames `{t, o:[x,y,z], a:[roll,pitch,yaw], k:[keyCodes], m:[dx,dy]}`,
  `marks`, `thumbs`, `canvas`), `thumbs/NNNN.jpg`, `contact.jpg` (16 labelled frames
  over the whole clip), and `marks.jpg` (the frames leading up to each F9 marker).
- Snapshot (`*-snap`): `shot.json` (pose, canvas size), `image.png` and `faceid.png`.
- `recordings/LATEST` holds the newest id.

`o` is the player origin; the eye is 24 units above it. Angles are in this
engine's order: `[roll, pitch, yaw]`.

## Agent workflow

```bash
id=$(cat recordings/LATEST); d=recordings/$id
cat $d/note.txt
# look at $d/contact.jpg and $d/marks.jpg (Read tool shows images)

python3 tools/contact_sheet.py $d --from 3.0 --to 4.5 --n 16 --out $d/zoom.jpg   # zoom in on time

node tools/replay.js $d --views 0,1,6            # re-render the thumbnail frames headless
#   -> $d/replay/compare_v0.jpg   user's frame (left) vs replay (right)
#   -> $d/replay/compare_v6.jpg   user's frame vs triangle-id view
#   -> $d/replay/metrics.json     per frame: tris, NaN verts, worst near-z, drift
node tools/replay.js $d --views all --from 3 --to 4   # every view, short window
node tools/replay.js $d --all --views 0               # every frame (metrics over the whole path)

node tools/replay.js --pose 64,240,45,90,10 --views all --out /tmp/look   # ad-hoc camera

python3 tools/faceat.py $d/faceid.png 640 400              # which BSP face is at this pixel
python3 tools/faceat.py $d/replay/v1/00042.png --box 500 300 700 450   # faces in a region
```

After a fix, rebuild, re-run `replay.js` on the same recording and compare
`compare_v0.jpg` before and after. The user doesn't need to re-record to check
a fix. Ask them to re-record only to confirm on their real GPU at the end.

## Server-side movement (connected sessions)

When connected, the server owns movement, so the client's origin alone can't
tell "client sent the wrong command" from "server integrated it wrongly".
Each recording therefore also captures:

- per frame, `c`: the last clientcmd **as written to the wire**
  (`cl_main.c qwtfGetLastCmd`): `{seq, msec, forw, side, up, buttons,
  ang:[3 angles in wire order], state}`. `seq` counts commands since `CL_Connect`.
- server side: `server/proxy.js` appends one JSON line per integrated command
  to `/tmp/qwtf-server-moves.jsonl` (`QWTF_MOVELOG` overrides the path,
  `=off` disables it; rotates at 20 MB):
  `{ts, client, seq, msec, forw, side, up, buttons, wireAngles, yawUsedDeg, before, want, after}`.

On upload, `tools/serve.js` joins them on seq. The server counts per
connection, and WebSocket delivery is ordered, so equal seq means the same
command. It writes:

- `server.jsonl`: this client's raw server log for the recording window
- `moves.jsonl`: one row per command, with `server.before/want/after`,
  `blocked[x,y,z]`, and, where a recorder frame sampled it, `clientCmd`, `keys`,
  `clientOrigin`, `viewAngles`, `fieldsMatch` and `serverYawMinusViewYaw`
- `moves-summary.txt`: counts of field mismatches, yaw mismatches and blocked moves

`want` is where the server tried to move the player and `after` is where it
ended up, so the slide direction is `after - before` and you can compare it
analytically with `want - before`.

The server process must be restarted to pick up `proxy.js` changes. Check
`ps -o lstart -p $(pgrep -f 'proxy.js --ws-port 8080')`.

## Debug views (qwtfSetDebugView / F6)

| # | view | use it for |
|---|---|---|
| 0 | normal | |
| 1 | face id | `tools/faceat.py` decodes it exactly: `id+1 = R + 256*round((B-40)/85)`, G is a checksum |
| 2 | lightmap only | lighting / banding / blow-out, without the texture |
| 3 | texture only | texture data, without lighting or fog |
| 4 | UV checker | squares should be square and stick to the surface; stretched bars mean a bad texture axis, noise means extreme minification, and red lines mark texture repeat edges |
| 5 | depth | depth-precision problems, missing geometry |
| 6 | triangle id | one colour per emitted (post-clip) triangle: slivers, crossed fans, clip artefacts |

## Limits

- Replay is **offline**: the world is re-rendered but bots and other entities
  are not. Use the user's thumbnails for entity problems.
- Replay renders with SwiftShader. If the user's frame and the replay differ,
  the difference is GPU/driver-specific (precision, filtering), which is
  itself a finding.
- Thumbnails are 400 px JPEGs; use an F7 snapshot for full resolution.
- In headless Chrome `requestAnimationFrame` does not run, so tests must call
  `Module._qwtfFrame()` and `qwtfRecorder.sample()` by hand.
- **Never run many frames inside ONE synchronous `Runtime.evaluate` while
  connected.** WebSocket messages are only delivered between JS tasks, so a
  tight `for (...) Module._qwtfFrame()` loop starves the message queue: the
  client never receives a server update and `cl.self.origin` goes stale. A test
  did exactly this, measured the player at ~(232,256) -- a position the server's
  player never occupied (it had walked on to x~496) -- and then reported a
  phantom `hull-overlaps-solid=1` plus a phantom "blocked" failure. Real browsers
  run one frame per rAF and do not have this problem. Pump frames across tasks:
  one frame per `evaluate` with a short sleep between, or an in-page
  `setTimeout` loop returning a Promise evaluated with `awaitPromise: true`.
- After releasing a key, wait until `cl.self.origin` stops changing before
  asserting, or the assertion races the last in-flight position update.
- Assert movement against the **server's** view too: read this client's rows out
  of the move log and check `after` / `hullExact`. The client can only ever see
  the position quantised to 1/8 (`entityRecord` ships `Math.round(v*8)`).
- Synthetic `mousemove` events never reach the engine in headless Chrome. To
  turn the view, call `Module.ccall('qwtfApplyMouse', null, ['number','number'], [dx, dy])`
  directly. An aim loop built on DOM mouse events silently never turns, and
  that looks exactly like a yaw bug. Keyboard events (`KeyboardEvent` on
  `window`) do work.
- Test movement at a **non-axis-aligned** yaw (e.g. 45°). At 0° and 90° only
  one axis changes, so per-axis collision bugs are invisible.
