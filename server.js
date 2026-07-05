require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { loadLists, saveLists } = require('./prompts');
const { generateAiAnswer, pickCheckedPrompt } = require('./ai');
const registerDaily = require('./daily');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// ─── Lists (editable via host UI or lists.json) ───────────────────────────────

let activeLang = 'en';

app.get('/api/lists', (req, res) => res.json({ ...loadLists(activeLang), lang: activeLang }));

app.post('/api/lists', (req, res) => {
  const { businesses, products, themes } = req.body;
  if (!Array.isArray(businesses) || !Array.isArray(products)) {
    return res.status(400).json({ error: 'Invalid data' });
  }
  saveLists({ businesses, products, themes: themes || [] }, activeLang);
  res.json({ ok: true });
});

app.post('/api/lang', (req, res) => {
  const { lang } = req.body;
  if (lang === 'en' || lang === 'de') {
    activeLang = lang;
    broadcast();
  }
  res.json({ lang: activeLang });
});

// ─── Game state ───────────────────────────────────────────────────────────────

function freshGame() {
  return {
    state: 'lobby',
    players: {},    // socketId -> { name, score, hasSubmitted, hasVoted, hasPassed }
    prompt: null,
    submissions: {},
    round: 0,
    maxRounds: 5,
    timer: null,
    timeLeft: 0,
    usedPrompts: new Set()
  };
}

let game = freshGame();

// ─── AI players ───────────────────────────────────────────────────────────────

const AI_MODEL = 'claude-haiku-4-5';

const AI_NAME_POOL = {
  en: [
    'Mike Hawk', 'Seymour Butz', 'Hugh Jass', 'Ivana Tinkle', 'Anita Bath',
    'Amanda Hugginkiss', 'Al Coholic', 'Oliver Klozoff', 'Barry McKockiner',
    'Wayne Kerr', 'Dixie Normous', 'Heywood Jablome', 'Ben Dover',
    'Chris P. Bacon', 'Moe Lester', 'Justin Case', 'Phil McCrackin'
  ],
  de: [
    'Anna Nass', 'Peter Silie', 'Rosa Munde', 'Klaus Trophobie', 'Anna Bolika',
    'Elli Fant', 'Mario Nette', 'Justin Zeit', 'Kurt Schluss', 'Uwe Schlüpfrig'
  ]
};

function pickAiName(lang) {
  const pool = AI_NAME_POOL[lang] || AI_NAME_POOL.en;
  const used = new Set(Object.values(game.players).map(p => p.name));
  const available = pool.filter(n => !used.has(n));
  const source = available.length > 0 ? available : pool;
  const base = source[Math.floor(Math.random() * source.length)];
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function triggerAiSubmissions() {
  const round = game.round;
  Object.entries(game.players).forEach(([id, p]) => {
    if (!p.isAI) return;
    const delay = 3000 + Math.random() * 9000;
    setTimeout(async () => {
      if (game.round !== round || game.state !== 'submitting') return;
      if (!game.players[id] || game.players[id].hasSubmitted || game.players[id].hasPassed) return;
      const text = await generateAiAnswer(game.prompt.text, activeLang, AI_MODEL);
      if (game.round !== round || game.state !== 'submitting') return;
      if (!game.players[id] || game.players[id].hasSubmitted || game.players[id].hasPassed) return;
      game.submissions[id] = { text, votes: [] };
      game.players[id].hasSubmitted = true;
      broadcast();
      checkAllSubmitted();
    }, delay);
  });
}

function startTimer(seconds, onEnd) {
  clearInterval(game.timer);
  game.timeLeft = seconds;
  game.timer = setInterval(() => {
    game.timeLeft--;
    io.emit('timer', game.timeLeft);
    if (game.timeLeft <= 0) {
      clearInterval(game.timer);
      onEnd();
    }
  }, 1000);
}

function hostState() {
  const players = Object.entries(game.players).map(([id, p]) => ({
    id, name: p.name, score: p.score, isAI: !!p.isAI,
    hasSubmitted: p.hasSubmitted, hasVoted: p.hasVoted, hasPassed: p.hasPassed
  }));

  const showSubs = ['presenting', 'voting', 'roundResults'].includes(game.state);
  const showNames = ['presenting', 'roundResults'].includes(game.state);
  const submissions = showSubs
    ? Object.entries(game.submissions).map(([id, s]) => ({
        id,
        playerName: showNames ? (game.players[id]?.name ?? '???') : null,
        text: s.text,
        votes: s.votes.length
      })).sort((a, b) => b.votes - a.votes)
    : null;

  const submittedCount = Object.values(game.players).filter(p => p.hasSubmitted).length;
  const passedCount    = Object.values(game.players).filter(p => p.hasPassed).length;

  return {
    state: game.state, players, prompt: game.prompt,
    round: game.round, maxRounds: game.maxRounds, timeLeft: game.timeLeft,
    submissions, submittedCount, passedCount,
    playerCount: Object.keys(game.players).length,
    lang: activeLang
  };
}

function playerState(socketId) {
  const p = game.players[socketId];
  if (!p) return null;

  const submissions = ['voting', 'roundResults'].includes(game.state)
    ? Object.entries(game.submissions).map(([id, s]) => ({
        id, text: s.text,
        votes: s.votes.length,
        isOwn: id === socketId,
        votedFor: s.votes.includes(socketId)
      }))
    : null;

  const allPlayers = Object.values(game.players)
    .map(pl => ({ name: pl.name, score: pl.score }))
    .sort((a, b) => b.score - a.score);

  return {
    state: game.state, name: p.name, score: p.score,
    hasSubmitted: p.hasSubmitted, hasVoted: p.hasVoted, hasPassed: p.hasPassed,
    prompt: game.prompt, round: game.round, maxRounds: game.maxRounds,
    timeLeft: game.timeLeft, submissions, allPlayers,
    lang: activeLang
  };
}

function broadcast() {
  io.to('host').emit('gameState', hostState());
  Object.keys(game.players).forEach(id => {
    io.to(id).emit('playerState', playerState(id));
  });
}

// ─── Game flow ────────────────────────────────────────────────────────────────

async function startRound() {
  game.round++;
  game.prompt = await pickCheckedPrompt(game.usedPrompts, activeLang);
  game.submissions = {};
  Object.values(game.players).forEach(p => {
    p.hasSubmitted = false;
    p.hasVoted = false;
    p.hasPassed = false;
  });
  game.state = 'submitting';
  broadcast();
  startTimer(180, startPresenting);  // 3 minutes
  triggerAiSubmissions();
}

function startPresenting() {
  if (Object.keys(game.submissions).length === 0) {
    endRound();
    return;
  }
  game.state = 'presenting';
  broadcast();
  // No timer — host manually starts voting
}

function startVoting() {
  game.state = 'voting';
  broadcast();
  // No timer — ends when all (non-AI) players have voted or host skips.
  // AI players never vote, only submit — see checkAllVoted.
}

function endRound() {
  clearInterval(game.timer);
  game.state = 'roundResults';

  let maxVotes = Math.max(0, ...Object.values(game.submissions).map(s => s.votes.length));
  Object.entries(game.submissions).forEach(([id, s]) => {
    if (!game.players[id]) return;
    game.players[id].score += s.votes.length * 100;
    if (maxVotes > 0 && s.votes.length === maxVotes) {
      game.players[id].score += 200;
    }
  });

  broadcast();

  setTimeout(() => {
    if (game.round >= game.maxRounds) {
      game.state = 'finalResults';
      broadcast();
    } else {
      startRound();
    }
  }, 8000);
}

function checkAllSubmitted() {
  const total = Object.keys(game.players).length;
  const done = Object.values(game.players).filter(p => p.hasSubmitted || p.hasPassed).length;
  if (done >= total && total > 0) {
    clearInterval(game.timer);
    startPresenting();
  }
}

function checkAllVoted() {
  const humanPlayers = Object.values(game.players).filter(p => !p.isAI);
  const total = humanPlayers.length;
  const done = humanPlayers.filter(p => p.hasVoted).length;
  if (done >= total && total > 0) {
    clearInterval(game.timer);
    endRound();
  }
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', socket => {
  socket.on('joinAsHost', () => {
    socket.join('host');
    socket.emit('gameState', hostState());
  });

  socket.on('joinGame', ({ name }) => {
    if (game.state !== 'lobby') { socket.emit('joinError', 'Game already in progress'); return; }
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) { socket.emit('joinError', 'Enter a name'); return; }
    const taken = Object.values(game.players).some(p => p.name.toLowerCase() === trimmed.toLowerCase());
    if (taken) { socket.emit('joinError', 'Name already taken'); return; }
    game.players[socket.id] = { name: trimmed, score: 0, hasSubmitted: false, hasVoted: false, hasPassed: false };
    socket.emit('joined', { name: trimmed });
    broadcast();
  });

  socket.on('addAiPlayer', () => {
    if (game.state !== 'lobby') return;
    const id = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = pickAiName(activeLang);
    game.players[id] = { name, score: 0, hasSubmitted: false, hasVoted: false, hasPassed: false, isAI: true };
    broadcast();
  });

  socket.on('removeAiPlayer', ({ id }) => {
    if (game.state !== 'lobby') return;
    if (game.players[id]?.isAI) {
      delete game.players[id];
      broadcast();
    }
  });

  socket.on('startGame', ({ rounds }) => {
    if (game.state !== 'lobby') return;
    if (Object.keys(game.players).length < 2) { socket.emit('hostError', 'Need at least 2 players to start'); return; }
    game.maxRounds = Math.min(Math.max(parseInt(rounds) || 5, 1), 10);
    startRound();
  });

  socket.on('submitAnswer', ({ text }) => {
    if (game.state !== 'submitting') return;
    if (!game.players[socket.id] || game.players[socket.id].hasSubmitted || game.players[socket.id].hasPassed) return;
    const trimmed = (text || '').trim().slice(0, 100);
    if (!trimmed) return;
    game.submissions[socket.id] = { text: trimmed, votes: [] };
    game.players[socket.id].hasSubmitted = true;
    broadcast();
    checkAllSubmitted();
  });

  socket.on('passRound', () => {
    if (game.state !== 'submitting') return;
    if (!game.players[socket.id] || game.players[socket.id].hasSubmitted || game.players[socket.id].hasPassed) return;
    game.players[socket.id].hasPassed = true;
    broadcast();
    checkAllSubmitted();
  });

  socket.on('vote', ({ targetId }) => {
    if (game.state !== 'voting') return;
    if (!game.players[socket.id] || game.players[socket.id].hasVoted) return;
    if (targetId === socket.id) return;
    if (!game.submissions[targetId]) return;
    game.submissions[targetId].votes.push(socket.id);
    game.players[socket.id].hasVoted = true;
    broadcast();
    checkAllVoted();
  });

  socket.on('beginVoting', () => {
    if (game.state !== 'presenting') return;
    startVoting();
  });

  socket.on('skipTimer', () => {
    if (game.state === 'submitting') { clearInterval(game.timer); startPresenting(); }
    else if (game.state === 'voting') { clearInterval(game.timer); endRound(); }
  });

  socket.on('resetGame', () => {
    clearInterval(game.timer);
    game = freshGame();
    broadcast();
  });

  socket.on('disconnect', () => {
    if (!game.players[socket.id]) return;
    delete game.players[socket.id];
    if (game.state === 'submitting') checkAllSubmitted();
    if (game.state === 'voting') checkAllVoted();
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;

registerDaily(app).then(() => {
  server.listen(PORT, () => {
    console.log(`\nBranded is running!`);
    console.log(`  Host screen : http://localhost:${PORT}/host`);
    console.log(`  Players join: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to initialize Daily Mode, not starting:', err);
  process.exit(1);
});
