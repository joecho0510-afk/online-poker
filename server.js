const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;

const SUITS = [
  { symbol: "♠", name: "spades", color: "black" },
  { symbol: "♥", name: "hearts", color: "red" },
  { symbol: "♦", name: "diamonds", color: "red" },
  { symbol: "♣", name: "clubs", color: "black" }
];

const RANKS = [
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "4", value: 4 },
  { label: "5", value: 5 },
  { label: "6", value: 6 },
  { label: "7", value: 7 },
  { label: "8", value: 8 },
  { label: "9", value: 9 },
  { label: "10", value: 10 },
  { label: "J", value: 11 },
  { label: "Q", value: 12 },
  { label: "K", value: 13 },
  { label: "A", value: 14 }
];

const HAND_NAMES = {
  8: "스트레이트 플러시",
  7: "포카드",
  6: "풀하우스",
  5: "플러시",
  4: "스트레이트",
  3: "트리플",
  2: "투페어",
  1: "원페어",
  0: "하이카드"
};

const rooms = new Map();

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: `${rank.label}-${suit.name}`,
        rankLabel: rank.label,
        rankValue: rank.value,
        suitSymbol: suit.symbol,
        suitName: suit.name,
        color: suit.color
      });
    }
  }
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function createRoom(code) {
  return {
    code,
    hostId: null,
    players: [],
    deck: [],
    phase: "waiting", // waiting | exchange | reveal
    log: "상대를 기다리는 중입니다.",
    winnerIds: [],
    revealResults: null
  };
}

function getRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((player) => player.id === socketId)) {
      return room;
    }
  }
  return null;
}

function dealCard(room, player) {
  const card = room.deck.pop();
  if (!card) return null;
  player.hand.push(card);
  return card;
}

function resetPlayerRoundState(player) {
  player.hand = [];
  player.ready = false;
  player.exchangeDone = false;
  player.selectedIndexes = [];
}

function countByRank(values) {
  const map = new Map();
  for (const value of values) {
    map.set(value, (map.get(value) || 0) + 1);
  }
  return map;
}

function compareArraysDesc(a, b) {
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function evaluateHand(hand) {
  const values = hand.map((card) => card.rankValue).sort((a, b) => b - a);
  const suits = hand.map((card) => card.suitName);
  const isFlush = suits.every((suit) => suit === suits[0]);

  const uniqueAsc = [...new Set(hand.map((card) => card.rankValue))].sort((a, b) => a - b);
  let straightHigh = null;
  if (uniqueAsc.length === 5) {
    const isNormalStraight = uniqueAsc.every((value, index) => index === 0 || value === uniqueAsc[index - 1] + 1);
    const isWheel = JSON.stringify(uniqueAsc) === JSON.stringify([2, 3, 4, 5, 14]);
    if (isNormalStraight) straightHigh = uniqueAsc[4];
    if (isWheel) straightHigh = 5;
  }

  const rankCounts = countByRank(hand.map((card) => card.rankValue));
  const groups = [...rankCounts.entries()]
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.value - a.value;
    });

  let rank = 0;
  let tiebreak = [];

  if (isFlush && straightHigh !== null) {
    rank = 8;
    tiebreak = [straightHigh];
  } else if (groups[0].count === 4) {
    rank = 7;
    const kicker = groups.find((group) => group.count === 1).value;
    tiebreak = [groups[0].value, kicker];
  } else if (groups[0].count === 3 && groups[1].count === 2) {
    rank = 6;
    tiebreak = [groups[0].value, groups[1].value];
  } else if (isFlush) {
    rank = 5;
    tiebreak = values;
  } else if (straightHigh !== null) {
    rank = 4;
    tiebreak = [straightHigh];
  } else if (groups[0].count === 3) {
    rank = 3;
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.value).sort((a, b) => b - a);
    tiebreak = [groups[0].value, ...kickers];
  } else if (groups[0].count === 2 && groups[1].count === 2) {
    rank = 2;
    const pairValues = groups.filter((group) => group.count === 2).map((group) => group.value).sort((a, b) => b - a);
    const kicker = groups.find((group) => group.count === 1).value;
    tiebreak = [...pairValues, kicker];
  } else if (groups[0].count === 2) {
    rank = 1;
    const pairValue = groups[0].value;
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.value).sort((a, b) => b - a);
    tiebreak = [pairValue, ...kickers];
  } else {
    rank = 0;
    tiebreak = values;
  }

  return {
    rank,
    handName: HAND_NAMES[rank],
    tiebreak
  };
}

function compareHands(handA, handB) {
  const a = evaluateHand(handA);
  const b = evaluateHand(handB);

  if (a.rank > b.rank) return { winner: 1, a, b };
  if (a.rank < b.rank) return { winner: -1, a, b };

  const tieResult = compareArraysDesc(a.tiebreak, b.tiebreak);
  if (tieResult > 0) return { winner: 1, a, b };
  if (tieResult < 0) return { winner: -1, a, b };
  return { winner: 0, a, b };
}

function allPlayersExchanged(room) {
  return room.players.length === MAX_PLAYERS && room.players.every((player) => player.exchangeDone);
}

function startRound(room) {
  room.deck = createDeck();
  shuffle(room.deck);
  room.phase = "exchange";
  room.winnerIds = [];
  room.revealResults = null;

  for (const player of room.players) {
    resetPlayerRoundState(player);
  }

  for (let i = 0; i < 5; i++) {
    for (const player of room.players) {
      dealCard(room, player);
    }
  }

  room.log = "카드를 받았습니다. 최대 3장까지 선택해서 교체한 뒤 공개하세요.";
}

function finishRound(room) {
  room.phase = "reveal";

  const [p1, p2] = room.players;
  const comparison = compareHands(p1.hand, p2.hand);

  room.revealResults = {
    [p1.id]: evaluateHand(p1.hand),
    [p2.id]: evaluateHand(p2.hand)
  };

  if (comparison.winner === 1) {
    room.winnerIds = [p1.id];
    room.log = `${p1.name} 승리! ${room.revealResults[p1.id].handName}`;
  } else if (comparison.winner === -1) {
    room.winnerIds = [p2.id];
    room.log = `${p2.name} 승리! ${room.revealResults[p2.id].handName}`;
  } else {
    room.winnerIds = [p1.id, p2.id];
    room.log = `무승부! 둘 다 ${room.revealResults[p1.id].handName}`;
  }
}

function publicRoomState(room, viewerId) {
  return {
    code: room.code,
    phase: room.phase,
    log: room.log,
    canStart: room.players.length === MAX_PLAYERS && room.phase !== "exchange",
    winnerIds: room.winnerIds,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isMe: player.id === viewerId,
      exchangeDone: player.exchangeDone,
      hand: room.phase === "reveal" || player.id === viewerId
        ? player.hand
        : player.hand.map(() => ({ hidden: true })),
      result: room.phase === "reveal" && room.revealResults
        ? room.revealResults[player.id]
        : null
    }))
  };
}

function emitRoomState(room) {
  for (const player of room.players) {
    io.to(player.id).emit("room_state", publicRoomState(room, player.id));
  }
}

io.on("connection", (socket) => {
  socket.on("create_or_join", ({ roomCode, name }) => {
    const trimmedCode = String(roomCode || "").trim().toUpperCase();
    const trimmedName = String(name || "").trim().slice(0, 12) || "플레이어";

    if (!trimmedCode) {
      socket.emit("error_message", "방 코드를 입력해주세요.");
      return;
    }

    let room = rooms.get(trimmedCode);
    if (!room) {
      room = createRoom(trimmedCode);
      rooms.set(trimmedCode, room);
    }

    if (room.players.length >= MAX_PLAYERS && !room.players.some((player) => player.id === socket.id)) {
      socket.emit("error_message", "이 방은 이미 가득 찼습니다.");
      return;
    }

    if (!room.hostId) {
      room.hostId = socket.id;
    }

    if (!room.players.some((player) => player.id === socket.id)) {
      room.players.push({
        id: socket.id,
        name: trimmedName,
        hand: [],
        ready: false,
        exchangeDone: false,
        selectedIndexes: []
      });
    }

    socket.join(trimmedCode);
    room.log = room.players.length < MAX_PLAYERS
      ? "상대를 기다리는 중입니다."
      : "2명이 모두 입장했습니다. 방장이 게임을 시작할 수 있습니다.";

    emitRoomState(room);
  });

  socket.on("start_game", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;

    if (room.hostId !== socket.id) {
      socket.emit("error_message", "방장만 게임을 시작할 수 있습니다.");
      return;
    }

    if (room.players.length !== MAX_PLAYERS) {
      socket.emit("error_message", "2명이 모두 입장해야 합니다.");
      return;
    }

    startRound(room);
    emitRoomState(room);
  });

  socket.on("exchange_cards", ({ indexes }) => {
    const room = getRoomBySocketId(socket.id);
    if (!room || room.phase !== "exchange") return;

    const player = room.players.find((item) => item.id === socket.id);
    if (!player) return;
    if (player.exchangeDone) {
      socket.emit("error_message", "이미 카드 교체를 마쳤습니다.");
      return;
    }

    const uniqueIndexes = [...new Set((indexes || []).filter((index) => Number.isInteger(index) && index >= 0 && index < 5))].sort((a, b) => b - a);

    if (uniqueIndexes.length > 3) {
      socket.emit("error_message", "카드는 최대 3장까지 교체할 수 있습니다.");
      return;
    }

    for (const index of uniqueIndexes) {
      player.hand.splice(index, 1);
    }

    while (player.hand.length < 5) {
      dealCard(room, player);
    }

    player.exchangeDone = true;
    room.log = `${player.name}님이 카드 교체를 완료했습니다.`;

    if (allPlayersExchanged(room)) {
      finishRound(room);
    }

    emitRoomState(room);
  });

  socket.on("stand_pat", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room || room.phase !== "exchange") return;

    const player = room.players.find((item) => item.id === socket.id);
    if (!player) return;
    if (player.exchangeDone) {
      socket.emit("error_message", "이미 선택을 마쳤습니다.");
      return;
    }

    player.exchangeDone = true;
    room.log = `${player.name}님이 패를 유지했습니다.`;

    if (allPlayersExchanged(room)) {
      finishRound(room);
    }

    emitRoomState(room);
  });

  socket.on("disconnect", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;

    room.players = room.players.filter((player) => player.id !== socket.id);

    if (room.hostId === socket.id) {
      room.hostId = room.players[0]?.id || null;
    }

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    room.phase = "waiting";
    room.winnerIds = [];
    room.revealResults = null;
    room.log = "상대가 나갔습니다. 새 플레이어를 기다립니다.";

    for (const player of room.players) {
      resetPlayerRoundState(player);
    }

    emitRoomState(room);
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>멀티 포커</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: radial-gradient(circle at top, #14532d, #052e16 55%, #03170c);
      color: #f8fafc;
      padding: 24px 16px 40px;
    }
    .wrap { max-width: 1100px; margin: 0 auto; }
    h1 { margin: 0 0 8px; }
    p { color: #d1fae5; line-height: 1.6; }
    .panel {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 18px;
      padding: 18px;
      margin-bottom: 18px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18);
    }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    input {
      padding: 12px 14px;
      border-radius: 12px;
      border: none;
      min-width: 180px;
      font-size: 15px;
    }
    button {
      border: none;
      border-radius: 12px;
      padding: 12px 18px;
      font-weight: bold;
      cursor: pointer;
      font-size: 15px;
    }
    button.primary { background: #facc15; color: #111827; }
    button.secondary { background: #e2e8f0; color: #111827; }
    button.action { background: #60a5fa; color: white; }
    button.good { background: #34d399; color: #052e16; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { font-size: 18px; font-weight: bold; color: #fde68a; margin-bottom: 8px; }
    .notice { min-height: 28px; color: #fecaca; font-weight: bold; }
    .players {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
    }
    .player {
      background: rgba(255,255,255,0.06);
      border-radius: 16px;
      padding: 16px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .player.me { outline: 2px solid #facc15; }
    .name { font-size: 20px; font-weight: bold; margin-bottom: 8px; }
    .meta { color: #d1fae5; margin-bottom: 12px; }
    .cards { display: flex; gap: 10px; flex-wrap: wrap; min-height: 112px; }
    .card {
      width: 78px;
      height: 108px;
      background: white;
      color: black;
      border-radius: 12px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 8px 20px rgba(0,0,0,0.22);
      position: relative;
      cursor: pointer;
      user-select: none;
      transition: transform 0.15s ease, outline 0.15s ease;
    }
    .card.selected { transform: translateY(-8px); outline: 3px solid #facc15; }
    .card.hidden {
      background: linear-gradient(135deg, #1d4ed8, #1e3a8a);
      color: white;
      align-items: center;
      justify-content: center;
      font-size: 36px;
      cursor: default;
    }
    .top, .bottom { font-weight: bold; line-height: 1; }
    .bottom { transform: rotate(180deg); text-align: right; }
    .center { text-align: center; font-size: 24px; }
    .red { color: #dc2626; }
    .black { color: #111827; }
    .result {
      display: inline-block;
      margin-top: 10px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: bold;
      background: rgba(250,204,21,0.2);
      color: #fde68a;
    }
    .help { color: #d1fae5; font-size: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>2인 멀티 포커</h1>
    <p>같은 방 코드로 접속해서 플레이하는 간단한 5카드 드로우 포커입니다. 각자 최대 3장까지 한 번 교체한 뒤 승부합니다.</p>

    <div class="panel">
      <div class="row">
        <input id="nameInput" placeholder="이름 입력" maxlength="12" />
        <input id="roomInput" placeholder="방 코드 입력" maxlength="12" />
        <button id="joinBtn" class="primary">방 만들기 / 입장</button>
        <button id="startBtn" class="secondary" disabled>게임 시작</button>
      </div>
      <div class="help" style="margin-top:12px;">같은 방 코드면 같은 게임방에 들어갑니다.</div>
    </div>

    <div class="panel">
      <div id="status" class="status">연결 대기 중</div>
      <div id="log">방에 입장해 주세요.</div>
      <div id="notice" class="notice"></div>
    </div>

    <div class="panel">
      <div class="row">
        <button id="exchangeBtn" class="action" disabled>선택 카드 교체</button>
        <button id="standBtn" class="good" disabled>패 유지</button>
      </div>
      <div class="help" style="margin-top:12px;">내 카드만 클릭해서 선택할 수 있습니다. 최대 3장까지 교체됩니다.</div>
    </div>

    <div id="players" class="players"></div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const nameInput = document.getElementById("nameInput");
    const roomInput = document.getElementById("roomInput");
    const joinBtn = document.getElementById("joinBtn");
    const startBtn = document.getElementById("startBtn");
    const exchangeBtn = document.getElementById("exchangeBtn");
    const standBtn = document.getElementById("standBtn");
    const statusEl = document.getElementById("status");
    const logEl = document.getElementById("log");
    const noticeEl = document.getElementById("notice");
    const playersEl = document.getElementById("players");

    let latestState = null;
    let selectedIndexes = [];

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function isMyTurnToAct() {
      if (!latestState) return false;
      const me = latestState.players.find((player) => player.isMe);
      return Boolean(me && latestState.phase === "exchange" && !me.exchangeDone);
    }

    function hiddenCardHtml() {
      return '<div class="card hidden">🂠</div>';
    }

    function visibleCardHtml(card, index, selectable) {
      const selectedClass = selectedIndexes.includes(index) ? 'selected' : '';
      return '<div class="card ' + selectedClass + '" data-index="' + index + '" ' + (selectable ? '' : 'style="cursor:default;"') + '>' +
        '<div class="top ' + card.color + '">' + escapeHtml(card.rankLabel) + '<br>' + escapeHtml(card.suitSymbol) + '</div>' +
        '<div class="center ' + card.color + '">' + escapeHtml(card.suitSymbol) + '</div>' +
        '<div class="bottom ' + card.color + '">' + escapeHtml(card.rankLabel) + '<br>' + escapeHtml(card.suitSymbol) + '</div>' +
      '</div>';
    }

    function renderState(state) {
      latestState = state;
      const me = state.players.find((player) => player.isMe);
      const amHost = Boolean(state.players[0] && state.players[0].isMe);
      const canAct = isMyTurnToAct();

      statusEl.textContent = '방 코드: ' + state.code + ' / 상태: ' + state.phase;
      logEl.textContent = state.log;
      noticeEl.textContent = '';
      startBtn.disabled = !(amHost && state.canStart);
      exchangeBtn.disabled = !canAct;
      standBtn.disabled = !canAct;

      if (!canAct) {
        selectedIndexes = [];
      }

      playersEl.innerHTML = state.players.map((player) => {
        const canSelect = player.isMe && state.phase === 'exchange' && !player.exchangeDone;
        const cardsHtml = player.hand.map((card, index) => {
          if (card.hidden) return hiddenCardHtml();
          return visibleCardHtml(card, index, canSelect);
        }).join('');

        const resultHtml = player.result
          ? '<div class="result">' + escapeHtml(player.result.handName) + '</div>'
          : '';

        return '<div class="player ' + (player.isMe ? 'me' : '') + '">' +
          '<div class="name">' + escapeHtml(player.name) + (player.isMe ? ' (나)' : '') + '</div>' +
          '<div class="meta">' + (player.exchangeDone ? '선택 완료' : '진행 중') + '</div>' +
          '<div class="cards">' + cardsHtml + '</div>' +
          resultHtml +
        '</div>';
      }).join('');

      document.querySelectorAll('.player.me .card[data-index]').forEach((cardEl) => {
        cardEl.addEventListener('click', () => {
          if (!isMyTurnToAct()) return;
          const index = Number(cardEl.dataset.index);
          const alreadySelected = selectedIndexes.includes(index);

          if (alreadySelected) {
            selectedIndexes = selectedIndexes.filter((item) => item !== index);
          } else {
            if (selectedIndexes.length >= 3) {
              noticeEl.textContent = '최대 3장까지 선택할 수 있습니다.';
              return;
            }
            selectedIndexes.push(index);
          }

          renderState(latestState);
        });
      });
    }

    joinBtn.addEventListener('click', () => {
      socket.emit('create_or_join', {
        name: nameInput.value,
        roomCode: roomInput.value
      });
    });

    startBtn.addEventListener('click', () => {
      selectedIndexes = [];
      socket.emit('start_game');
    });

    exchangeBtn.addEventListener('click', () => {
      socket.emit('exchange_cards', { indexes: selectedIndexes });
      selectedIndexes = [];
    });

    standBtn.addEventListener('click', () => {
      selectedIndexes = [];
      socket.emit('stand_pat');
    });

    socket.on('room_state', renderState);
    socket.on('error_message', (message) => {
      noticeEl.textContent = message;
    });
  </script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
