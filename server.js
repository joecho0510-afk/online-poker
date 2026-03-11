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
const STARTING_CHIPS = 1000;
const ANTE = 25;
const BRING_IN = 25;
const SMALL_BET = 50;
const BIG_BET = 100;

const SUITS = [
  { symbol: "♠", name: "spades", color: "black", suitRank: 4 },
  { symbol: "♥", name: "hearts", color: "red", suitRank: 3 },
  { symbol: "♦", name: "diamonds", color: "red", suitRank: 2 },
  { symbol: "♣", name: "clubs", color: "black", suitRank: 1 }
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

const STAGE_NAMES = ["3rd Street", "4th Street", "5th Street", "6th Street", "7th Street"];
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
        suitRank: suit.suitRank,
        color: suit.color
      });
    }
  }
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
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
    phase: "waiting",
    stage: 0,
    street: 0,
    log: "상대를 기다리는 중입니다.",
    winnerIds: [],
    revealResults: null,
    pot: 0,
    currentBet: 0,
    bringInPlayerId: null,
    actingPlayerId: null,
    actionCount: 0,
    completedPlayers: []
  };
}

function createPlayer(id, name) {
  return {
    id,
    name,
    hand: [],
    folded: false,
    chips: STARTING_CHIPS,
    streetBet: 0,
    totalCommitted: 0,
    hasActed: false,
    isAllIn: false
  };
}

function resetPlayerRoundState(player) {
  player.hand = [];
  player.folded = false;
  player.streetBet = 0;
  player.totalCommitted = 0;
  player.hasActed = false;
  player.isAllIn = false;
}

function getRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((player) => player.id === socketId)) {
      return room;
    }
  }
  return null;
}

function activePlayers(room) {
  return room.players.filter((player) => !player.folded);
}

function bettingPlayers(room) {
  return room.players.filter((player) => !player.folded && !player.isAllIn);
}

function nextActivePlayerId(room, fromId) {
  const players = bettingPlayers(room);
  if (players.length === 0) return null;
  const ids = room.players.map((player) => player.id);
  let index = fromId ? ids.indexOf(fromId) : -1;
  for (let i = 1; i <= ids.length; i += 1) {
    const candidate = room.players[(index + i) % ids.length];
    if (candidate && !candidate.folded && !candidate.isAllIn) {
      return candidate.id;
    }
  }
  return null;
}

function amountToCall(room, player) {
  return Math.max(0, room.currentBet - player.streetBet);
}

function getCurrentLimit(room) {
  return room.street >= 2 ? BIG_BET : SMALL_BET;
}

function takeChips(player, amount) {
  const actual = Math.max(0, Math.min(amount, player.chips));
  player.chips -= actual;
  player.streetBet += actual;
  player.totalCommitted += actual;
  if (player.chips === 0) {
    player.isAllIn = true;
  }
  return actual;
}

function resetStreetState(room) {
  room.currentBet = 0;
  room.actionCount = 0;
  room.completedPlayers = [];
  for (const player of room.players) {
    player.streetBet = 0;
    player.hasActed = false;
  }
}

function visibleCardsForEvaluation(player) {
  return player.hand.map((card) => ({
    rankValue: card.rankValue,
    rankLabel: card.rankLabel,
    suitName: card.suitName,
    suitSymbol: card.suitSymbol,
    color: card.color
  }));
}

function upcards(player) {
  return player.hand.filter((card) => !card.isFaceDown);
}

function bestShowingValue(player) {
  const cards = upcards(player);
  if (cards.length === 0) return null;
  return cards
    .slice()
    .sort((a, b) => {
      if (b.rankValue !== a.rankValue) return b.rankValue - a.rankValue;
      return b.suitRank - a.suitRank;
    })[0];
}

function worstDoorCard(player) {
  const cards = upcards(player);
  if (cards.length === 0) return null;
  return cards
    .slice()
    .sort((a, b) => {
      if (a.rankValue !== b.rankValue) return a.rankValue - b.rankValue;
      return a.suitRank - b.suitRank;
    })[0];
}

function compareShowingHigh(a, b) {
  const ca = bestShowingValue(a);
  const cb = bestShowingValue(b);
  if (!ca && !cb) return 0;
  if (!ca) return -1;
  if (!cb) return 1;
  if (ca.rankValue !== cb.rankValue) return ca.rankValue - cb.rankValue;
  return ca.suitRank - cb.suitRank;
}

function compareDoorLow(a, b) {
  const ca = worstDoorCard(a);
  const cb = worstDoorCard(b);
  if (!ca && !cb) return 0;
  if (!ca) return 1;
  if (!cb) return -1;
  if (ca.rankValue !== cb.rankValue) return cb.rankValue - ca.rankValue;
  return cb.suitRank - ca.suitRank;
}

function combinations(arr, k) {
  const result = [];
  function helper(start, path) {
    if (path.length === k) {
      result.push([...path]);
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      path.push(arr[i]);
      helper(i + 1, path);
      path.pop();
    }
  }
  helper(0, []);
  return result;
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
  for (let i = 0; i < maxLength; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function evaluateFiveCardHand(hand) {
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

  return { rank, handName: HAND_NAMES[rank], tiebreak };
}

function evaluateBestSevenCardHand(cards) {
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const evaluated = evaluateFiveCardHand(combo);
    if (!best) {
      best = { ...evaluated, bestCards: combo };
      continue;
    }
    if (evaluated.rank > best.rank || (evaluated.rank === best.rank && compareArraysDesc(evaluated.tiebreak, best.tiebreak) > 0)) {
      best = { ...evaluated, bestCards: combo };
    }
  }
  return best;
}

function compareHands(cardsA, cardsB) {
  const a = evaluateBestSevenCardHand(cardsA);
  const b = evaluateBestSevenCardHand(cardsB);
  if (a.rank > b.rank) return { winner: 1, a, b };
  if (a.rank < b.rank) return { winner: -1, a, b };
  const tieResult = compareArraysDesc(a.tiebreak, b.tiebreak);
  if (tieResult > 0) return { winner: 1, a, b };
  if (tieResult < 0) return { winner: -1, a, b };
  return { winner: 0, a, b };
}

function dealInitialCards(room) {
  for (const player of room.players) {
    dealCard(room, player, true);
    dealCard(room, player, player.id !== room.bringInPlayerId);
    dealCard(room, player, false);
  }
}

function determineBringInPlayer(room) {
  return room.players
    .slice()
    .sort(compareDoorLow)[0]?.id || null;
}

function determineHighShowingPlayer(room) {
  return activePlayers(room)
    .slice()
    .sort((a, b) => -compareShowingHigh(a, b))[0]?.id || null;
}

function dealNextStreet(room) {
  room.street += 1;
  if (room.street > 4) {
    finishRound(room);
    return;
  }

  for (const player of activePlayers(room)) {
    if (room.street === 4) {
      dealCard(room, player, true);
    } else {
      dealCard(room, player, false);
    }
  }

  resetStreetState(room);
  room.actingPlayerId = determineHighShowingPlayer(room);
  const limit = getCurrentLimit(room);
  room.log = `${STAGE_NAMES[room.street]}: 카드가 지급되었습니다. 선 플레이어부터 체크/베팅하세요. 이번 라운드 베팅 단위는 ${limit}입니다.`;
}

function shouldAdvanceStreet(room) {
  const players = bettingPlayers(room);
  if (players.length <= 1) return true;
  return players.every((player) => player.hasActed && player.streetBet === room.currentBet);
}

function moveTurn(room) {
  if (activePlayers(room).length <= 1) {
    finishRound(room);
    return;
  }

  if (shouldAdvanceStreet(room)) {
    dealNextStreet(room);
    return;
  }

  room.actingPlayerId = nextActivePlayerId(room, room.actingPlayerId);
}

function startRound(room) {
  room.deck = createDeck();
  shuffle(room.deck);
  room.phase = "playing";
  room.stage = 0;
  room.street = 0;
  room.winnerIds = [];
  room.revealResults = null;
  room.pot = 0;
  room.bringInPlayerId = null;
  room.actingPlayerId = null;

  for (const player of room.players) {
    resetPlayerRoundState(player);
  }

  const eligiblePlayers = room.players.filter((player) => player.chips >= ANTE + BRING_IN);
  if (eligiblePlayers.length < 2) {
    room.phase = "waiting";
    room.log = "두 플레이어 모두 충분한 칩이 있어야 게임을 시작할 수 있습니다.";
    return;
  }

  for (const player of room.players) {
    room.pot += takeChips(player, ANTE);
  }

  dealInitialCards(room);
  room.bringInPlayerId = determineBringInPlayer(room);
  resetStreetState(room);

  const bringInPlayer = room.players.find((player) => player.id === room.bringInPlayerId);
  const paid = takeChips(bringInPlayer, BRING_IN);
  room.pot += paid;
  room.currentBet = paid;
  bringInPlayer.hasActed = true;
  room.actingPlayerId = nextActivePlayerId(room, room.bringInPlayerId);
  room.log = `세븐 포커 시작: 앤티 ${ANTE}, 브링인 ${BRING_IN}. ${bringInPlayer.name}님이 브링인을 냈습니다. 다음 플레이어 차례입니다.`;
}

function finishRound(room) {
  room.phase = "reveal";
  const alivePlayers = activePlayers(room);

  if (alivePlayers.length === 1) {
    room.winnerIds = [alivePlayers[0].id];
    room.revealResults = {
      [alivePlayers[0].id]: evaluateBestSevenCardHand(visibleCardsForEvaluation(alivePlayers[0]))
    };
    room.log = `${alivePlayers[0].name} 승리! 상대가 폴드했습니다.`;
    awardPot(room, room.winnerIds);
    return;
  }

  const [p1, p2] = room.players;
  const comparison = compareHands(visibleCardsForEvaluation(p1), visibleCardsForEvaluation(p2));
  room.revealResults = {
    [p1.id]: evaluateBestSevenCardHand(visibleCardsForEvaluation(p1)),
    [p2.id]: evaluateBestSevenCardHand(visibleCardsForEvaluation(p2))
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

  awardPot(room, room.winnerIds);
}

function actionOptions(room, player) {
  if (room.phase !== "playing" || room.actingPlayerId !== player.id || player.folded || player.isAllIn) {
    return { canCheck: false, canCall: false, canBet: false, canRaise: false, canFold: false, toCall: 0, betSize: getCurrentLimit(room) };
  }

  const toCall = amountToCall(room, player);
  const betSize = getCurrentLimit(room);
  return {
    canCheck: toCall === 0,
    canCall: toCall > 0 && player.chips >= toCall,
    canBet: toCall === 0 && player.chips >= betSize,
    canRaise: toCall > 0 && player.chips >= toCall + betSize,
    canFold: true,
    toCall,
    betSize
  };
}

function publicRoomState(room, viewerId) {
  return {
    code: room.code,
    phase: room.phase,
    stage: room.stage,
    street: room.street,
    streetName: STAGE_NAMES[room.street] || "대기",
    log: room.log,
    pot: room.pot || 0,
    ante: ANTE,
    bringIn: BRING_IN,
    currentBet: room.currentBet,
    limitBet: getCurrentLimit(room),
    actingPlayerId: room.actingPlayerId,
    canStart: room.players.length === MAX_PLAYERS && room.phase !== "playing",
    winnerIds: room.winnerIds,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isMe: player.id === viewerId,
      folded: player.folded,
      chips: player.chips,
      streetBet: player.streetBet,
      totalCommitted: player.totalCommitted,
      hand: player.hand.map((card) => {
        const shouldHide = room.phase !== "reveal" && player.id !== viewerId && card.isFaceDown;
        return shouldHide ? { hidden: true } : card;
      }),
      options: actionOptions(room, player),
      result: room.phase === "reveal" && room.revealResults ? room.revealResults[player.id] || null : null
    }))
  };
}

function emitRoomState(room) {
  for (const player of room.players) {
    io.to(player.id).emit("room_state", publicRoomState(room, player.id));
  }
}

function getActingPlayer(room, socket) {
  if (room.phase !== "playing") return null;
  const player = room.players.find((item) => item.id === socket.id);
  if (!player || player.folded || player.isAllIn) return null;
  if (room.actingPlayerId !== socket.id) {
    socket.emit("error_message", "지금은 당신 차례가 아닙니다.");
    return null;
  }
  return player;
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
      room.players.push(createPlayer(socket.id, trimmedName));
    }

    socket.join(trimmedCode);
    room.log = room.players.length < MAX_PLAYERS ? "상대를 기다리는 중입니다." : "2명이 모두 입장했습니다. 방장이 게임을 시작할 수 있습니다.";
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

  socket.on("check", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;
    const player = getActingPlayer(room, socket);
    if (!player) return;
    if (amountToCall(room, player) !== 0) {
      socket.emit("error_message", "체크할 수 없습니다. 콜 또는 폴드를 선택하세요.");
      return;
    }
    player.hasActed = true;
    room.log = `${player.name}님이 체크했습니다.`;
    moveTurn(room);
    emitRoomState(room);
  });

  socket.on("call", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;
    const player = getActingPlayer(room, socket);
    if (!player) return;
    const toCall = amountToCall(room, player);
    if (toCall <= 0) {
      socket.emit("error_message", "콜할 금액이 없습니다. 체크 또는 베팅을 선택하세요.");
      return;
    }
    if (player.chips < toCall) {
      socket.emit("error_message", `콜에 필요한 칩이 부족합니다. 필요 칩: ${toCall}`);
      return;
    }
    room.pot += takeChips(player, toCall);
    player.hasActed = true;
    room.log = `${player.name}님이 콜했습니다. 현재 판돈은 ${room.pot}입니다.`;
    moveTurn(room);
    emitRoomState(room);
  });

  socket.on("bet", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;
    const player = getActingPlayer(room, socket);
    if (!player) return;
    const betSize = getCurrentLimit(room);
    if (amountToCall(room, player) !== 0) {
      socket.emit("error_message", "이미 베팅이 나와 있습니다. 콜/레이즈/폴드를 선택하세요.");
      return;
    }
    if (player.chips < betSize) {
      socket.emit("error_message", `베팅에 필요한 칩이 부족합니다. 필요 칩: ${betSize}`);
      return;
    }
    room.currentBet = betSize;
    room.pot += takeChips(player, betSize);
    player.hasActed = true;
    for (const other of bettingPlayers(room)) {
      if (other.id !== player.id) other.hasActed = false;
    }
    room.log = `${player.name}님이 ${betSize} 베팅했습니다. 현재 판돈은 ${room.pot}입니다.`;
    moveTurn(room);
    emitRoomState(room);
  });

  socket.on("raise", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;
    const player = getActingPlayer(room, socket);
    if (!player) return;
    const toCall = amountToCall(room, player);
    const raiseSize = getCurrentLimit(room);
    if (toCall <= 0) {
      socket.emit("error_message", "레이즈할 베팅이 없습니다.");
      return;
    }
    if (player.chips < toCall + raiseSize) {
      socket.emit("error_message", `레이즈에 필요한 칩이 부족합니다. 필요 칩: ${toCall + raiseSize}`);
      return;
    }
    room.pot += takeChips(player, toCall + raiseSize);
    room.currentBet = player.streetBet;
    player.hasActed = true;
    for (const other of bettingPlayers(room)) {
      if (other.id !== player.id) other.hasActed = false;
    }
    room.log = `${player.name}님이 레이즈했습니다. 현재 판돈은 ${room.pot}입니다.`;
    moveTurn(room);
    emitRoomState(room);
  });

  socket.on("fold", () => {
    const room = getRoomBySocketId(socket.id);
    if (!room) return;
    const player = getActingPlayer(room, socket);
    if (!player) return;
    player.folded = true;
    room.log = `${player.name}님이 폴드했습니다.`;
    if (activePlayers(room).length <= 1) {
      finishRound(room);
    } else {
      room.actingPlayerId = nextActivePlayerId(room, player.id);
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
    room.stage = 0;
    room.street = 0;
    room.winnerIds = [];
    room.revealResults = null;
    room.pot = 0;
    room.currentBet = 0;
    room.bringInPlayerId = null;
    room.actingPlayerId = null;
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
  <title>2인 세븐 포커</title>
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
    button.warn { background: #f59e0b; color: #111827; }
    button.danger { background: #f87171; color: #3f0d12; }
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
    .player.turn { box-shadow: 0 0 0 2px #60a5fa inset; }
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
    }
    .card.hidden {
      background: linear-gradient(135deg, #1d4ed8, #1e3a8a);
      color: white;
      align-items: center;
      justify-content: center;
      font-size: 36px;
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
    <h1>2인 세븐 포커</h1>
    <p>앤티, 브링인, 체크, 베팅, 콜, 레이즈, 폴드가 들어간 간단한 세븐 포커입니다. 3rd/4th는 50, 5th 이후는 100 단위로 베팅합니다.</p>

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
      <div id="potInfo" class="status" style="font-size:16px; color:#bfdbfe;">판돈: 0 / 현재 베팅: 0</div>
      <div id="log">방에 입장해 주세요.</div>
      <div id="notice" class="notice"></div>
    </div>

    <div class="panel">
      <div class="row">
        <button id="checkBtn" class="secondary" disabled>체크</button>
        <button id="callBtn" class="action" disabled>콜</button>
        <button id="betBtn" class="warn" disabled>베팅</button>
        <button id="raiseBtn" class="warn" disabled>레이즈</button>
        <button id="foldBtn" class="danger" disabled>폴드</button>
      </div>
      <div id="actionInfo" class="help" style="margin-top:12px;">당신 차례가 오면 가능한 행동만 활성화됩니다.</div>
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
    const checkBtn = document.getElementById("checkBtn");
    const callBtn = document.getElementById("callBtn");
    const betBtn = document.getElementById("betBtn");
    const raiseBtn = document.getElementById("raiseBtn");
    const foldBtn = document.getElementById("foldBtn");
    const statusEl = document.getElementById("status");
    const potInfoEl = document.getElementById("potInfo");
    const logEl = document.getElementById("log");
    const noticeEl = document.getElementById("notice");
    const actionInfoEl = document.getElementById("actionInfo");
    const playersEl = document.getElementById("players");

    let latestState = null;

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function getMe(state) {
      return state.players.find((player) => player.isMe);
    }

    function hiddenCardHtml() {
      return '<div class="card hidden">🂠</div>';
    }

    function visibleCardHtml(card) {
      return '<div class="card">' +
        '<div class="top ' + card.color + '">' + escapeHtml(card.rankLabel) + '<br>' + escapeHtml(card.suitSymbol) + '</div>' +
        '<div class="center ' + card.color + '">' + escapeHtml(card.suitSymbol) + '</div>' +
        '<div class="bottom ' + card.color + '">' + escapeHtml(card.rankLabel) + '<br>' + escapeHtml(card.suitSymbol) + '</div>' +
      '</div>';
    }

    function renderState(state) {
      latestState = state;
      const amHost = Boolean(state.players[0] && state.players[0].isMe);
      const me = getMe(state);
      const options = me ? me.options : null;

      statusEl.textContent = '방 코드: ' + state.code + ' / 상태: ' + state.phase + ' / 스트리트: ' + state.streetName;
      potInfoEl.textContent = '판돈: ' + state.pot + ' / 현재 베팅: ' + state.currentBet + ' / 앤티: ' + state.ante + ' / 브링인: ' + state.bringIn;
      logEl.textContent = state.log;
      noticeEl.textContent = '';
      startBtn.disabled = !(amHost && state.canStart);

      checkBtn.disabled = !(options && options.canCheck);
      callBtn.disabled = !(options && options.canCall);
      betBtn.disabled = !(options && options.canBet);
      raiseBtn.disabled = !(options && options.canRaise);
      foldBtn.disabled = !(options && options.canFold);

      if (options) {
        actionInfoEl.textContent = '콜 필요 금액: ' + options.toCall + ' / 이번 스트리트 베팅 단위: ' + options.betSize;
      } else {
        actionInfoEl.textContent = '당신 차례가 오면 가능한 행동만 활성화됩니다.';
      }

      playersEl.innerHTML = state.players.map((player) => {
        const cardsHtml = player.hand.map((card) => card.hidden ? hiddenCardHtml() : visibleCardHtml(card)).join('');
        const resultHtml = player.result ? '<div class="result">' + escapeHtml(player.result.handName) + '</div>' : '';
        const stateText = player.folded ? '폴드' : (state.actingPlayerId === player.id && state.phase === 'playing') ? '차례' : '대기';

        return '<div class="player ' + (player.isMe ? 'me' : '') + ' ' + ((state.actingPlayerId === player.id && state.phase === 'playing') ? 'turn' : '') + '">' +
          '<div class="name">' + escapeHtml(player.name) + (player.isMe ? ' (나)' : '') + '</div>' +
          '<div class="meta">' + stateText + ' / 보유 칩: ' + player.chips + ' / 이번 스트리트: ' + player.streetBet + ' / 총 베팅: ' + player.totalCommitted + '</div>' +
          '<div class="cards">' + cardsHtml + '</div>' +
          resultHtml +
        '</div>';
      }).join('');
    }

    joinBtn.addEventListener('click', () => {
      socket.emit('create_or_join', {
        name: nameInput.value,
        roomCode: roomInput.value
      });
    });

    startBtn.addEventListener('click', () => socket.emit('start_game'));
    checkBtn.addEventListener('click', () => socket.emit('check'));
    callBtn.addEventListener('click', () => socket.emit('call'));
    betBtn.addEventListener('click', () => socket.emit('bet'));
    raiseBtn.addEventListener('click', () => socket.emit('raise'));
    foldBtn.addEventListener('click', () => socket.emit('fold'));

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
