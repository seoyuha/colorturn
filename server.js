/* COLOR TURN ENGLISH — 온라인 대전 서버 (2인·3인 자동 배정, 반별 랭킹) */
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const E = require("./engine");

const PORT = process.env.PORT || 3000;
const PIN = process.env.TEACHER_PIN || "finel9932!";
const DATA = process.env.DATA_FILE || path.join(__dirname, "data.json");
const TURN_GRACE = 30;          // 문제 시간 외에 더 주는 초
const OFFLINE_PASS = 12;        // 차례인데 연결이 끊기면 몇 초 뒤 넘김
const MATCH_WAIT = 6;           // 최근 상대와 겹칠 때 다른 친구를 기다리는 초
const RECENT = 4;               // 최근 상대 몇 명을 피할지

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.send("ok"));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ---------- 저장 ---------- */
const DEF_SETTINGS = { units: [1,2,3,4,5,6,7,8,9,10,11,12], rules: { diff: 1, policy: "retry", first: "random", qtime: 30 } };
let store = { classes: {} };
try { store = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) {}
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(DATA, JSON.stringify(store)); } catch (e) {} }, 800); }
function cls(code) {
  code = String(code || "").trim().slice(0, 12);
  if (!store.classes[code]) store.classes[code] = { settings: JSON.parse(JSON.stringify(DEF_SETTINGS)), scores: {}, recent: {} };
  return store.classes[code];
}

/* ---------- 실행 상태 ---------- */
const players = new Map();   // tok -> {tok,name,cls,sid,size,gid,qAt}
const queues = new Map();    // cls+"|"+size -> [tok]
const games = new Map();     // gid -> game
let gidSeq = 1;

const qkey = (c, s) => c + "|" + s;
function queue(c, s) { const k = qkey(c, s); if (!queues.has(k)) queues.set(k, []); return queues.get(k); }
function unqueue(p) { for (const [k, q] of queues) { const i = q.indexOf(p.tok); if (i >= 0) q.splice(i, 1); } }

function rankOf(code) {
  const C = cls(code);
  return Object.entries(C.scores).map(([name, s]) => ({ name, pts: s.pts, wins: s.wins, games: s.games, acc: s.asked ? Math.round(s.ok / s.asked * 100) : 0 }))
    .sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.acc - a.acc);
}
function score(code, name) { const C = cls(code); return C.scores[name] || (C.scores[name] = { pts: 0, wins: 0, draws: 0, games: 0, asked: 0, ok: 0 }); }

function sendLobby(p) {
  const s = io.sockets.sockets.get(p.sid); if (!s) return;
  const C = cls(p.cls);
  s.emit("lobby", { cls: p.cls, settings: C.settings, rank: rankOf(p.cls), waiting: { 2: queue(p.cls, 2).length, 3: queue(p.cls, 3).length }, inQueue: p.size || 0 });
}
function lobbyAll(code) { for (const p of players.values()) if (p.cls === code && !p.gid) sendLobby(p); monitor(code); }

/* ---------- 짝 짓기 ---------- */
function overlap(code, toks) {
  const C = cls(code); let o = 0;
  for (const a of toks) for (const b of toks) if (a !== b) { const pa = players.get(a), pb = players.get(b); if ((C.recent[pa.name] || []).includes(pb.name)) o++; }
  return o;
}
function tryMatch(code, size) {
  const q = queue(code, size);
  // 연결이 끊긴 대기자 정리
  for (let i = q.length - 1; i >= 0; i--) { const p = players.get(q[i]); if (!p || !io.sockets.sockets.get(p.sid)) q.splice(i, 1); }
  while (q.length >= size) {
    const first = q[0], rest = q.slice(1, 9);
    let best = null, bestO = Infinity;
    const combos = size === 2 ? rest.map(x => [first, x]) : rest.flatMap((x, i) => rest.slice(i + 1).map(y => [first, x, y]));
    for (const c of combos) { const o = overlap(code, c); if (o < bestO) { bestO = o; best = c; } }
    const waited = (Date.now() - players.get(first).qAt) / 1000;
    if (bestO > 0 && waited < MATCH_WAIT) { setTimeout(() => tryMatch(code, size), 1500); break; }
    best.forEach(t => q.splice(q.indexOf(t), 1));
    startGame(code, size, best);
  }
  lobbyAll(code);
}

/* ---------- 게임 ---------- */
function startGame(code, n, toks) {
  const C = cls(code); const R = C.settings.rules;
  const order = toks.slice().sort(() => Math.random() - .5);
  const g = {
    gid: "g" + (gidSeq++), cls: code, n, rules: { ...R }, units: C.settings.units.slice(),
    players: order.map((tok, team) => ({ tok, name: players.get(tok).name, team, asked: 0, ok: 0, pts: 0, acts: 0, flips: 0, left: E.CHIPS, online: true })),
    color: new Array(E.CELLS).fill(-1), ids: new Array(E.CELLS).fill(-1), mines: E.makeMines(R.diff), revealed: new Array(E.CELLS).fill(0),
    lockId: null, nextId: 1, turn: 0, passes: 0, over: false, winner: -1, winCells: null, last: null, seq: 0, startAt: Date.now(), phase: "question"
  };
  g.cur = R.first === "p0" ? 0 : R.first === "p1" ? 1 % n : (Math.random() * n | 0);
  games.set(g.gid, g);
  g.players.forEach(P => { const p = players.get(P.tok); p.gid = g.gid; p.size = 0; const s = io.sockets.sockets.get(p.sid); if (s) s.join(g.gid); });
  beginTurn(g);
}
function view(g) {
  return { gid: g.gid, n: g.n, rules: g.rules, units: g.units, seq: ++g.seq,
    players: g.players.map(P => ({ name: P.name, team: P.team, asked: P.asked, ok: P.ok, pts: P.pts, left: P.left, online: P.online, acts: P.acts, flips: P.flips })),
    color: g.color, ids: g.ids, revealed: g.revealed, lockId: g.lockId, cur: g.cur, turn: g.turn, over: g.over, winner: g.winner, winCells: g.winCells,
    last: g.last, startAt: g.startAt, turnStart: g.turnStart, phase: g.phase, mines: g.over ? g.mines : null };
}
function push(g) { io.to(g.gid).emit("state", view(g)); monitor(g.cls); }
function beginTurn(g) {
  clearTimeout(g.timer);
  if (g.over) return;
  if (g.turn >= 60 * g.n) return endGame(g, -1, "60바퀴가 지나 무승부예요.");
  const P = g.players[g.cur];
  const acts = E.legal(g.color, g.ids, g.cur, g.lockId, 4, g.players.map(x => x.left));
  if (!acts.length) {
    g.passes++;
    if (g.passes >= g.n) return endGame(g, -1, "모두 움직일 수 없어 무승부예요.");
    g.last = { t: "skip", p: g.cur };
    return nextTurn(g, true);
  }
  g.phase = "question"; g.turnStart = Date.now();
  const lim = ((g.rules.policy === "retry" ? 2 : 1) * (g.rules.qtime || 30) + TURN_GRACE) * 1000;
  g.timer = setTimeout(() => { if (!g.over) { g.last = { t: "timeout", p: g.cur }; nextTurn(g); } }, P.online ? lim : OFFLINE_PASS * 1000);
  push(g);
}
function nextTurn(g, keepPasses) {
  if (!keepPasses) g.passes = 0;
  g.lockId = null;
  g.turn++; g.cur = (g.cur + 1) % g.n;
  beginTurn(g);
}
function endGame(g, winner, why) {
  clearTimeout(g.timer);
  if (g.over) return;
  g.over = true; g.winner = winner; g.why = why || ""; g.phase = "over";
  const C = cls(g.cls);
  g.players.forEach(P => {
    const s = score(g.cls, P.name);
    let add = E.PTS.play;
    if (winner === P.team) { add += E.PTS.win; s.wins++; } else if (winner < 0) { add += E.PTS.draw; s.draws++; }
    P.pts += add; s.pts += add; s.games++;
    const others = g.players.filter(x => x !== P).map(x => x.name);
    C.recent[P.name] = [...others, ...(C.recent[P.name] || []).filter(x => !others.includes(x))].slice(0, RECENT);
    const p = players.get(P.tok); if (p && p.gid === g.gid) p.gid = null;
  });
  save();
  const v = view(g); v.why = g.why; v.rank = rankOf(g.cls);
  io.to(g.gid).emit("state", v);
  g.players.forEach(P => { const p = players.get(P.tok); if (p) { const s = io.sockets.sockets.get(p.sid); if (s) s.leave(g.gid); } });
  setTimeout(() => games.delete(g.gid), 60 * 1000);
  lobbyAll(g.cls);
}

/* ---------- 교사 화면 ---------- */
function monitor(code) {
  const room = "T:" + code; if (!io.sockets.adapter.rooms.get(room)) return;
  const name = t => (players.get(t) || {}).name || "?";
  io.to(room).emit("monitor", {
    cls: code, settings: cls(code).settings,
    waiting: { 2: queue(code, 2).map(name), 3: queue(code, 3).map(name) },
    online: [...players.values()].filter(p => p.cls === code && io.sockets.sockets.get(p.sid)).length,
    games: [...games.values()].filter(g => g.cls === code && !g.over).map(g => ({ gid: g.gid, n: g.n, names: g.players.map(P => P.name), cur: g.cur, turn: g.turn, startAt: g.startAt })),
    rank: rankOf(code)
  });
}

/* ---------- 소켓 ---------- */
io.on("connection", sock => {
  let me = null;
  sock.on("hello", (d, ack) => {
    const tok = String(d.tok || "").slice(0, 40), name = String(d.name || "").trim().slice(0, 10), code = String(d.cls || "").trim().slice(0, 12);
    if (!tok || !name || !code) return ack && ack({ ok: false, err: "이름과 반을 확인해 주세요." });
    for (const p of players.values()) if (p.cls === code && p.name === name && p.tok !== tok && io.sockets.sockets.get(p.sid)) return ack && ack({ ok: false, err: "같은 반에 같은 이름이 이미 들어와 있어요. 이름 뒤에 번호를 붙여 주세요." });
    let p = players.get(tok);
    if (p && (p.cls !== code || p.name !== name)) { unqueue(p); p.size = 0; if (p.gid && p.cls !== code) p.gid = null; }
    if (!p) { p = { tok }; players.set(tok, p); }
    Object.assign(p, { name, cls: code, sid: sock.id }); me = p;
    score(code, name); save();
    ack && ack({ ok: true });
    const g = p.gid && games.get(p.gid);
    if (g && !g.over) { sock.join(g.gid); const P = g.players.find(x => x.tok === tok); if (P) P.online = true; push(g); }
    else { p.gid = null; sendLobby(p); }
    monitor(code);
  });
  sock.on("queue", d => {
    if (!me) return; const size = d && d.size === 3 ? 3 : 2;
    if (me.gid && games.get(me.gid) && !games.get(me.gid).over) return;
    unqueue(me); me.size = size; me.qAt = Date.now(); queue(me.cls, size).push(me.tok);
    tryMatch(me.cls, size);
  });
  sock.on("unqueue", () => { if (!me) return; unqueue(me); me.size = 0; lobbyAll(me.cls); });
  const myGame = () => { const g = me && me.gid && games.get(me.gid); if (!g || g.over) return null; const P = g.players.find(x => x.tok === me.tok); return P ? { g, P } : null; };
  sock.on("ans", d => {
    const m = myGame(); if (!m || m.g.cur !== m.P.team) return;
    const ok = !!(d && d.ok);
    if (d && d.first) { m.P.asked++; const s = score(m.g.cls, m.P.name); s.asked++; if (ok) { m.P.ok++; m.P.pts += E.PTS.correct; s.ok++; s.pts += E.PTS.correct; } save(); }
    m.g.phase = ok ? "action" : "retry"; push(m.g);
  });
  sock.on("pass", () => { const m = myGame(); if (!m || m.g.cur !== m.P.team) return; m.g.last = { t: "pass", p: m.P.team }; nextTurn(m.g); });
  sock.on("act", a => {
    const m = myGame(); if (!m) return; const { g, P } = m;
    if (g.cur !== P.team || !a || !["p", "m"].includes(a.t)) return;
    a = { t: a.t, to: a.to | 0, from: a.from | 0 };
    if (!E.isLegal(g.color, g.ids, g.cur, g.lockId, 4, g.players.map(x => x.left), a)) return push(g);
    const s = E.sim(g.color, g.ids, a, g.cur, g.mines, g.nextId, g.n);
    if (a.t === "p") { g.nextId++; P.left--; }
    g.color = s.c2; g.ids = s.i2; P.acts++;
    if (s.flipped) { g.revealed[a.to] = 1; P.flips++; }
    g.lockId = a.t === "m" ? s.id : null;
    g.last = { t: a.t, from: a.from, to: a.to, p: P.team, id: s.id, flipped: s.flipped, oldColor: s.oldColor, newColor: s.newColor };
    const o = E.outcome(g.color, P.team, g.n);
    if (o >= 0) { g.winCells = E.lineOf(g.color, o); return endGame(g, o, o === P.team ? "" : "지뢰 반전으로 다른 팀의 4목이 만들어졌어요!"); }
    g.passes = 0; g.turn++; g.cur = (g.cur + 1) % g.n; beginTurn(g);
  });
  sock.on("leaveGame", () => {
    const m = myGame(); if (!m) return; const { g, P } = m; P.online = false; me.gid = null; sock.leave(g.gid);
    const on = g.players.filter(x => x.online);
    if (on.length === 1) return endGame(g, on[0].team, `${P.name}이(가) 나가서 ${on[0].name}이(가) 이겼어요.`);
    if (g.cur === P.team) { g.last = { t: "skip", p: P.team }; nextTurn(g); } else push(g);
  });
  /* 교사 */
  sock.on("teacher", (d, ack) => {
    if (!d || d.pin !== PIN) return ack && ack({ ok: false, err: "비밀번호가 맞지 않아요." });
    const code = String(d.cls || "").trim().slice(0, 12); if (!code) return ack && ack({ ok: false, err: "반을 골라 주세요." });
    const C = cls(code);
    if (d.settings) {
      const u = (d.settings.units || []).map(Number).filter(x => x >= 1 && x <= 12);
      const r = d.settings.rules || {};
      C.settings = { units: u.length ? u : DEF_SETTINGS.units.slice(), rules: { diff: [0,1,2].includes(r.diff) ? r.diff : 1, policy: r.policy === "hard" ? "hard" : "retry", first: ["random","p0","p1"].includes(r.first) ? r.first : "random", qtime: [15,30,60].includes(r.qtime) ? r.qtime : 30 } };
      save(); lobbyAll(code);
    }
    if (d.resetRank) { C.scores = {}; C.recent = {}; save(); lobbyAll(code); }
    for (const r of sock.rooms) if (r.startsWith("T:")) sock.leave(r);
    sock.join("T:" + code); ack && ack({ ok: true, settings: C.settings }); monitor(code);
  });
  sock.on("disconnect", () => {
    if (!me) return;
    unqueue(me);
    const g = me.gid && games.get(me.gid);
    if (g && !g.over) {
      const P = g.players.find(x => x.tok === me.tok);
      if (P) { P.online = false; push(g);
        setTimeout(() => { if (!g.over && !P.online) { const on = g.players.filter(x => x.online); if (on.length === 1) endGame(g, on[0].team, `${P.name}의 연결이 끊겨 ${on[0].name}이(가) 이겼어요.`); else if (!on.length) endGame(g, -1, "모두 연결이 끊겼어요."); else if (g.cur === P.team) { g.last = { t: "skip", p: P.team }; nextTurn(g); } } }, OFFLINE_PASS * 1000);
      }
    }
    monitor(me.cls); lobbyAll(me.cls);
  });
});

server.listen(PORT, () => console.log("COLOR TURN ENGLISH server on :" + PORT));
