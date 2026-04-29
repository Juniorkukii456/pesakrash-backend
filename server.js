// ═══════════════════════════════════════════════════════════
// PesaKrash — Backend Server
// Stack  : Node.js + Express + MongoDB + JWT + Socket.io
// Port   : 5000
// ═══════════════════════════════════════════════════════════

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const axios        = require('axios');
const cors         = require('cors');
const mongoose     = require('mongoose');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);

// ═══════════════════════════════════════════════════════════
// CORS
// ═══════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://pesakrash.site',
  'https://www.pesakrash.site',
  'https://pesakrash.netlify.app',
  'http://localhost',
  'http://localhost:5678',
  'null'
];

app.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'], credentials: true }));
app.options('*', cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET','POST'], credentials: true },
  transports: ['websocket', 'polling']
});

// ═══════════════════════════════════════════════════════════
// MONGODB
// ═══════════════════════════════════════════════════════════
const MONGO_URI  = process.env.MONGO_URI  || 'mongodb+srv://frankojunior981_db_user:PesaKrash2026@cluster0.3hogvwx.mongodb.net/pesakrash?retryWrites=true&w=majority&appName=Cluster0';
const JWT_SECRET = process.env.JWT_SECRET || 'pesakrash_jwt_super_secret_2026';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected — pesakrash'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ═══════════════════════════════════════════════════════════
// USER MODEL
// ═══════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  username      : { type: String, required: true, trim: true },
  email         : { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone         : { type: String, required: true, trim: true },
  password      : { type: String, required: true },
  balance       : { type: Number, default: 0 },
  bonusBalance  : { type: Number, default: 0 },  // welcome bonus — not withdrawable
  bonusUsed     : { type: Boolean, default: false }, // track if bonus was already given
  createdAt     : { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ═══════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'No token. Please log in.' });
  try {
    req.userId = jwt.verify(header.split(' ')[1], JWT_SECRET).id;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token. Please log in again.' });
  }
}

// ═══════════════════════════════════════════════════════════
// ADMIN PASSWORD
// ═══════════════════════════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Frankie123@#';

// ═══════════════════════════════════════════════════════════
// GAME ENGINE — runs on server, broadcasts to all clients
// ═══════════════════════════════════════════════════════════
const WAIT_SECS       = 5;
const SHOW_CRASH_SECS = 3;
const TICK_MS         = 50; // 20fps server tick

let phase      = 'waiting';
let roundId    = 0;
let crashPt    = 1.0;
let mult       = 1.0;
let flyStart   = 0;
let phaseStart = Date.now();
let history    = [];
let pts        = [];
let customNext = null;
let forceFlag  = false;
let skipFlag   = false;

// House stats
const house = { profit: 0, totalBets: 0, rounds: 0, crashSum: 0 };

// Active bets this round: { socketId: { userId, username, bet, settled, cashedOut, cashOutAt } }
let roundBets = {};

// Connected players: { socketId: { username, userId } }
let connectedPlayers = {};

function genCrash() {
  if (customNext !== null) { const v = customNext; customNext = null; return Math.max(1.0, v); }
  const r = Math.random();
  if (r < 0.01) return 1.0;
  return Math.max(1.0, Math.min(Math.round((0.99 / (1 - r)) * 100) / 100, 200));
}
function calcMult(t) { return Math.round(Math.pow(Math.E, 0.07 * t) * 100) / 100; }
function mColor(m)   { return m >= 10 ? '#8b5cf6' : m >= 5 ? '#06b6d4' : m >= 2 ? '#10b981' : '#94a3b8'; }

function startWaiting() {
  crashPt    = genCrash();
  roundId++;
  phase      = 'waiting';
  phaseStart = Date.now();
  mult       = 1.0;
  pts        = [];
  roundBets  = {};
  broadcast();
}

function startFlying() {
  phase      = 'flying';
  flyStart   = Date.now();
  phaseStart = Date.now();
  mult       = 1.0;
  pts        = [];
  broadcast();
}

async function startCrashed() {
  phase      = 'crashed';
  phaseStart = Date.now();
  mult       = crashPt;
  pts.push({ t: Math.round(((Date.now() - flyStart) / 1000) * 100) / 100, m: crashPt });
  history    = [crashPt, ...history].slice(0, 25);
  house.rounds++;
  house.crashSum += crashPt;

  // Settle all unsettled bets as losses
  const lossPromises = [];
  Object.entries(roundBets).forEach(([sid, p]) => {
    if (!p.settled) {
      p.settled = true;
      house.profit += p.bet;
      house.totalBets++;
      // Balance already deducted on bet placement — no further deduction needed
      // Just notify the player
      io.to(sid).emit('round_result', { won: false, amount: p.bet, multiplier: crashPt });
    }
  });
  await Promise.all(lossPromises);
  broadcast();
  broadcastAdmin();
}

function broadcast() {
  const payload = {
    phase,
    roundId,
    multiplier : mult,
    crashPoint : phase === 'crashed' ? crashPt : null,
    countdown  : phase === 'waiting' ? Math.max(0, WAIT_SECS - Math.floor((Date.now() - phaseStart) / 1000)) : 0,
    pts        : pts.slice(-120),
    history,
    ts         : Date.now(),
    flyStart   : phase === 'flying' ? flyStart : 0,
  };
  io.to('players').emit('game_state', payload);
}

function broadcastAdmin() {
  const players = Object.entries(roundBets).map(([sid, p]) => ({
    name      : p.username,
    bet       : p.bet,
    settled   : p.settled,
    cashedOut : p.cashedOut,
    cashOutAt : p.cashOutAt
  }));
  io.to('admins').emit('admin_state', {
    phase, roundId, multiplier: mult,
    crashPoint : crashPt,
    countdown  : phase === 'waiting' ? Math.max(0, WAIT_SECS - Math.floor((Date.now() - phaseStart) / 1000)) : 0,
    history, pts: pts.slice(-120), ts: Date.now(), flyStart: phase === 'flying' ? flyStart : 0,
    house, players,
    playerCount: Object.keys(connectedPlayers).length
  });
}

// ── Main game loop ──────────────────────────────────────────
let tickInterval = null;
function startGameLoop() {
  if (tickInterval) clearInterval(tickInterval);
  startWaiting();

  tickInterval = setInterval(async () => {
    const now = Date.now();

    if (phase === 'waiting') {
      const elapsed = (now - phaseStart) / 1000;
      if (skipFlag || elapsed >= WAIT_SECS) { skipFlag = false; startFlying(); return; }
      broadcast();
      broadcastAdmin();
    }
    else if (phase === 'flying') {
      const t = (now - flyStart) / 1000;
      mult = calcMult(t);
      if (!pts.length || t - pts[pts.length - 1].t >= 0.05)
        pts.push({ t: Math.round(t * 100) / 100, m: mult });
      broadcast();
      broadcastAdmin();
      if (forceFlag || mult >= crashPt) { forceFlag = false; await startCrashed(); }
    }
    else if (phase === 'crashed') {
      broadcastAdmin();
      if ((now - phaseStart) / 1000 >= SHOW_CRASH_SECS) startWaiting();
    }
  }, TICK_MS);
}

// ═══════════════════════════════════════════════════════════
// SOCKET.IO EVENTS
// ═══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  // ── Admin auth ─────────────────────────────────────────
  socket.on('admin_auth', (data) => {
    if (data.password === ADMIN_PASSWORD) {
      socket.join('admins');
      socket.emit('admin_auth_result', { success: true });
      console.log(`[ADMIN] Authenticated: ${socket.id}`);
      broadcastAdmin();
    } else {
      socket.emit('admin_auth_result', { success: false, message: 'Wrong password.' });
    }
  });

  // ── Player join ────────────────────────────────────────
  socket.on('player_join', (data) => {
    // data: { token }
    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      socket.userId = decoded.id;
      socket.join('players');
      connectedPlayers[socket.id] = { userId: decoded.id };
      // Send current game state immediately
      socket.emit('game_state', {
        phase, roundId, multiplier: mult,
        crashPoint: phase === 'crashed' ? crashPt : null,
        countdown: phase === 'waiting' ? Math.max(0, WAIT_SECS - Math.floor((Date.now() - phaseStart) / 1000)) : 0,
        pts: pts.slice(-120), history, ts: Date.now(),
        flyStart: phase === 'flying' ? flyStart : 0
      });
      console.log(`[PLAYER] Joined: ${socket.id}`);
    } catch {
      socket.emit('error', { message: 'Invalid token. Please log in again.' });
    }
  });

  // ── Place bet ──────────────────────────────────────────
  socket.on('place_bet', async (data) => {
    // data: { token, amount }
    if (phase !== 'waiting') return socket.emit('bet_result', { success: false, message: 'Bets closed.' });
    if (roundBets[socket.id]) return socket.emit('bet_result', { success: false, message: 'Bet already placed.' });

    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      const amount  = Math.round(Number(data.amount) * 100) / 100;
      if (isNaN(amount) || amount < 10) return socket.emit('bet_result', { success: false, message: 'Min bet is KES 10.' });

      const user = await User.findById(decoded.id);
      if (!user) return socket.emit('bet_result', { success: false, message: 'User not found.' });

      const realBal  = user.balance || 0;
      const bonusBal = user.bonusBalance || 0;
      const totalAvail = Math.round((realBal + bonusBal) * 100) / 100;

      if (totalAvail < amount) return socket.emit('bet_result', { success: false, message: 'Insufficient balance.' });

      // Use bonus first, then real balance
      let bonusUsed = 0, realUsed = 0;
      if (bonusBal >= amount) {
        bonusUsed = amount;
      } else {
        bonusUsed = bonusBal;
        realUsed  = Math.round((amount - bonusBal) * 100) / 100;
      }
      user.bonusBalance = Math.round((bonusBal - bonusUsed) * 100) / 100;
      user.balance      = Math.round((realBal  - realUsed)  * 100) / 100;
      await user.save();

      roundBets[socket.id] = {
        userId: decoded.id, username: user.username,
        bet: amount, bonusUsed, realUsed,
        settled: false, cashedOut: false, cashOutAt: null
      };
      house.totalBets++;

      socket.emit('bet_result', {
        success: true, balance: user.balance,
        bonusBalance: user.bonusBalance, amount
      });
      broadcastAdmin();
    } catch (err) {
      socket.emit('bet_result', { success: false, message: 'Server error.' });
    }
  });

  // ── Cash out ───────────────────────────────────────────
  socket.on('cash_out', async (data) => {
    if (phase !== 'flying') return socket.emit('cashout_result', { success: false, message: 'Not flying.' });
    const p = roundBets[socket.id];
    if (!p || p.settled) return socket.emit('cashout_result', { success: false, message: 'No active bet.' });

    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      const m       = mult;
      const winAmt  = Math.round(p.bet * m * 100) / 100;

      p.settled   = true;
      p.cashedOut = true;
      p.cashOutAt = m;
      house.profit -= (winAmt - p.bet);

      const user = await User.findById(decoded.id);
      if (user) {
        // Winnings always go to real balance regardless of bonus used
        user.balance = Math.round((user.balance + winAmt) * 100) / 100;
        await user.save();
        socket.emit('cashout_result', {
          success: true, multiplier: m, winAmount: winAmt,
          balance: user.balance, bonusBalance: user.bonusBalance || 0
        });
      }
      socket.emit('round_result', { won: true, amount: winAmt, multiplier: m });
      broadcastAdmin();
    } catch {
      socket.emit('cashout_result', { success: false, message: 'Server error.' });
    }
  });

  // ── Admin commands ─────────────────────────────────────
  socket.on('admin_force_crash', () => {
    if (!socket.rooms.has('admins')) return;
    if (phase === 'flying') { forceFlag = true; console.log('[ADMIN] Force crash'); }
  });

  socket.on('admin_skip_wait', () => {
    if (!socket.rooms.has('admins')) return;
    if (phase === 'waiting') { skipFlag = true; console.log('[ADMIN] Skip wait'); }
  });

  socket.on('admin_set_custom', (data) => {
    if (!socket.rooms.has('admins')) return;
    const v = parseFloat(data.value);
    if (!isNaN(v) && v >= 1) {
      customNext = Math.round(v * 100) / 100;
      console.log(`[ADMIN] Custom crash set: ${customNext}`);
      io.to('admins').emit('custom_crash_set', { value: customNext });
    }
  });

  socket.on('admin_clear_custom', () => {
    if (!socket.rooms.has('admins')) return;
    customNext = null;
    io.to('admins').emit('custom_crash_cleared');
  });

  // ── Disconnect ─────────────────────────────────────────
  socket.on('disconnect', () => {
    delete connectedPlayers[socket.id];
    console.log(`[SOCKET] Disconnected: ${socket.id}`);
  });
});

// ═══════════════════════════════════════════════════════════
// DARAJA CREDENTIALS
// ═══════════════════════════════════════════════════════════
const CONSUMER_KEY    = process.env.CONSUMER_KEY    || 'UQlYctKzJgQqRT64atWvKRz6tp8brGf6tTWf9OA54IoVrxw5';
const CONSUMER_SECRET = process.env.CONSUMER_SECRET || 'O262GVn2ODNwgQsqDjgRmfwOGI4fPZIvnPMbyL5dvOqPUI6A2pFElGTmugDc7tuj';
const SHORTCODE       = '174379';
const PASSKEY         = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const CALLBACK_URL    = 'https://morning-forest-72309.herokuapp.com/callback_url.php';
const DARAJA_BASE     = 'https://sandbox.safaricom.co.ke';

// ── B2C CREDENTIALS — Sandbox ───────────────────────────────
const B2C_CONSUMER_KEY    = process.env.B2C_CONSUMER_KEY    || 'gGqhgrm2UT3BSyeeiUz9ZUhtVMnQX5FP3cjhmZEloQ8Apl8I';
const B2C_CONSUMER_SECRET = process.env.B2C_CONSUMER_SECRET || 'CB5ZnmtfH398fkNDa08TPKkg5rgALAPLQG7IPQt6rEpdXgIr13FpX2b7R3VdJ6BC';
const B2C_SHORTCODE       = process.env.B2C_SHORTCODE       || '600986';
const B2C_INITIATOR_NAME  = process.env.B2C_INITIATOR_NAME  || 'testapi';
const B2C_INITIATOR_PASS  = process.env.B2C_INITIATOR_PASS  || 'Safaricom999!';
const RENDER_URL          = process.env.RENDER_EXTERNAL_URL || 'https://pesakrash-backend.onrender.com';

// Generate B2C security credential (encrypt initiator password with Safaricom public cert)
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

function getSecurityCredential() {
  // Use pre-computed security credential from environment variable
  // Generate it at: https://developer.safaricom.co.ke/test_credentials
  // Under "Security Credential Generator" — use testapi / Safaricom999!
  const envCred = process.env.B2C_SECURITY_CREDENTIAL;
  if (envCred) return envCred;

  // Fallback: compute dynamically using Safaricom sandbox certificate
  try {
    const cert = fs.readFileSync(path.join(__dirname, 'sandbox.cer'));
    const buffer = Buffer.from(B2C_INITIATOR_PASS, 'utf8');
    return crypto.publicEncrypt(
      { key: cert, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
      buffer
    ).toString('base64');
  } catch (e) {
    console.error('[B2C] Security credential error — set B2C_SECURITY_CREDENTIAL env var:', e.message);
    return '';
  }
}

async function getDarajaToken() {
  const creds = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res   = await axios.get(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${creds}` } });
  return res.data.access_token;
}

async function getB2CToken() {
  const creds = Buffer.from(`${B2C_CONSUMER_KEY}:${B2C_CONSUMER_SECRET}`).toString('base64');
  const res   = await axios.get(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${creds}` } });
  return res.data.access_token;
}
function getTimestamp() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function getPassword(ts) { return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64'); }

// ═══════════════════════════════════════════════════════════
// HTTP ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'PesaKrash server running ✅', port: 5000 }));

// REGISTER
app.post('/auth/register', async (req, res) => {
  const { username, email, phone, password } = req.body;
  if (!username || !email || !phone || !password)
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  try {
    if (await User.findOne({ email }))
      return res.status(400).json({ success: false, message: 'Email already registered. Please log in.' });
    const hashed = await bcrypt.hash(password, 12);
    const user   = await User.create({
      username, email, phone, password: hashed,
      balance: 0, bonusBalance: 50, bonusUsed: false  // KES 50 welcome bonus
    });
    const token  = jwt.sign({ id: user._id }, JWT_SECRET);
    return res.status(201).json({
      success: true, message: 'Account created! You received a KES 50 welcome bonus!', token,
      user: { id: user._id, username: user.username, email: user.email, phone: user.phone, balance: user.balance, bonusBalance: user.bonusBalance }
    });
  } catch (err) {
    console.error('[REGISTER]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// LOGIN
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  try {
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    const token = jwt.sign({ id: user._id }, JWT_SECRET);
    return res.json({ success: true, message: 'Login successful!', token, user: { id: user._id, username: user.username, email: user.email, phone: user.phone, balance: user.balance, bonusBalance: user.bonusBalance || 0 } });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET ME
app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, user: {
      id: user._id, username: user.username, email: user.email,
      phone: user.phone, balance: user.balance, bonusBalance: user.bonusBalance || 0
    }});
  } catch { return res.status(500).json({ success: false, message: 'Server error.' }); }
});

// SET BALANCE
app.post('/auth/balance/set', authMiddleware, async (req, res) => {
  const { balance } = req.body;
  if (balance === undefined || isNaN(Number(balance)) || Number(balance) < 0)
    return res.status(400).json({ success: false, message: 'Invalid balance.' });
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.balance = Math.round(Number(balance) * 100) / 100;
    await user.save();
    return res.json({ success: true, balance: user.balance });
  } catch { return res.status(500).json({ success: false, message: 'Server error.' }); }
});

// UPDATE BALANCE
app.post('/auth/balance', authMiddleware, async (req, res) => {
  const { amount, type } = req.body;
  if (!amount || !type) return res.status(400).json({ success: false, message: 'amount and type required.' });
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (type === 'credit') user.balance = Math.round((user.balance + Number(amount)) * 100) / 100;
    else if (type === 'debit') {
      if (user.balance < Number(amount)) return res.status(400).json({ success: false, message: 'Insufficient balance.' });
      user.balance = Math.round((user.balance - Number(amount)) * 100) / 100;
    }
    await user.save();
    return res.json({ success: true, balance: user.balance });
  } catch { return res.status(500).json({ success: false, message: 'Server error.' }); }
});

// STK PUSH
app.post('/stk-push', authMiddleware, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ success: false, message: 'phone and amount required.' });
  let msisdn = String(phone).replace(/[\s\-]/g, '');
  if (msisdn.startsWith('+'))      msisdn = msisdn.slice(1);
  if (!msisdn.startsWith('254')) {
    if (msisdn.startsWith('0'))    msisdn = '254' + msisdn.slice(1);
    else if (msisdn.length === 9)  msisdn = '254' + msisdn;
    else if (msisdn.length === 8)  msisdn = '2547' + msisdn;
  }
  if (!/^254(7|1)\d{8}$/.test(msisdn)) return res.status(400).json({ success: false, message: 'Invalid Safaricom number.' });
  const amountInt = Math.ceil(Number(amount));
  if (isNaN(amountInt) || amountInt < 1) return res.status(400).json({ success: false, message: 'Amount must be at least 1.' });
  try {
    const token = await getDarajaToken();
    const ts    = getTimestamp();
    const stkRes = await axios.post(`${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: SHORTCODE, Password: getPassword(ts), Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline', Amount: amountInt,
      PartyA: msisdn, PartyB: SHORTCODE, PhoneNumber: msisdn,
      CallBackURL: CALLBACK_URL, AccountReference: 'PesaKrash', TransactionDesc: 'PesaKrash Deposit'
    }, { headers: { Authorization: `Bearer ${token}` } });
    const data = stkRes.data;
    if (data.ResponseCode === '0') {
      const user = await User.findById(req.userId);
      if (user) { user.balance = Math.round((user.balance + amountInt) * 100) / 100; await user.save(); }
      return res.json({ success: true, checkoutRequestID: data.CheckoutRequestID, message: data.CustomerMessage || 'Prompt sent', balance: user ? user.balance : null });
    }
    return res.status(400).json({ success: false, message: data.ResponseDescription || 'STK push failed.' });
  } catch (err) {
    console.error('[STK ERROR]', err.response?.data || err.message);
    return res.status(500).json({ success: false, message: err.response?.data?.errorMessage || err.message });
  }
});

// MPESA CALLBACK
app.post('/mpesa/callback', (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (!cb) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const items = cb.CallbackMetadata?.Item || [];
  const get   = n => items.find(i => i.Name === n)?.Value;
  if (cb.ResultCode === 0) console.log('[PAYMENT SUCCESS]', { amount: get('Amount'), phone: get('PhoneNumber'), receipt: get('MpesaReceiptNumber') });
  else console.log('[PAYMENT FAILED]', cb.ResultDesc);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ═══════════════════════════════════════════════════════════
// ROUTE — B2C Withdrawal (protected)
// POST /b2c/withdraw
// Body : { phone, amount }
// ═══════════════════════════════════════════════════════════
app.post('/b2c/withdraw', authMiddleware, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount)
    return res.status(400).json({ success: false, message: 'phone and amount are required.' });

  // Normalize phone
  let msisdn = String(phone).replace(/[\s\-]/g, '');
  if (msisdn.startsWith('+'))      msisdn = msisdn.slice(1);
  if (!msisdn.startsWith('254')) {
    if (msisdn.startsWith('0'))    msisdn = '254' + msisdn.slice(1);
    else if (msisdn.length === 9)  msisdn = '254' + msisdn;
    else if (msisdn.length === 8)  msisdn = '2547' + msisdn;
  }
  if (!/^254(7|1)\d{8}$/.test(msisdn))
    return res.status(400).json({ success: false, message: 'Invalid Safaricom number.' });

  const amountInt = Math.floor(Number(amount));
  if (isNaN(amountInt) || amountInt < 10)
    return res.status(400).json({ success: false, message: 'Minimum withdrawal is KES 10.' });

  try {
    // Check user balance first
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.balance < amountInt)
      return res.status(400).json({ success: false, message: 'Insufficient real balance. Bonus funds cannot be withdrawn.' });

    // Get B2C token
    const token = await getB2CToken();
    const secCred = getSecurityCredential();

    // Generate unique OriginatorConversationID
    const originatorConvID = 'PKR-' + Date.now() + '-' + Math.random().toString(36).slice(2,8).toUpperCase();

    const payload = {
      OriginatorConversationID : originatorConvID,
      InitiatorName            : B2C_INITIATOR_NAME,
      SecurityCredential       : secCred,
      CommandID                : 'BusinessPayment',
      Amount                   : amountInt,
      PartyA                   : B2C_SHORTCODE,
      PartyB                   : msisdn,
      Remarks                  : 'PesaKrash Withdrawal',
      QueueTimeOutURL          : `${RENDER_URL}/b2c/timeout`,
      ResultURL                : `${RENDER_URL}/b2c/result`,
      Occasion                 : 'PesaKrash Withdraw'
    };

    const b2cRes = await axios.post(
      `${DARAJA_BASE}/mpesa/b2c/v3/paymentrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    const data = b2cRes.data;
    console.log('[B2C REQUEST]', data);

    if (data.ResponseCode === '0') {
      // Deduct balance immediately — refund if callback fails
      user.balance = Math.round((user.balance - amountInt) * 100) / 100;
      await user.save();

      return res.json({
        success             : true,
        message             : data.ResponseDescription || 'Withdrawal initiated. Funds will arrive shortly.',
        conversationID      : data.ConversationID,
        originatorConvID    : data.OriginatorConversationID,
        balance             : user.balance
      });
    } else {
      return res.status(400).json({
        success : false,
        message : data.ResponseDescription || 'B2C request failed.'
      });
    }
  } catch (err) {
    console.error('[B2C ERROR]', err.response?.data || err.message);
    return res.status(500).json({
      success : false,
      message : err.response?.data?.errorMessage || err.message || 'Server error.'
    });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE — B2C Result Callback (Safaricom POSTs here)
// POST /b2c/result
// ═══════════════════════════════════════════════════════════
app.post('/b2c/result', async (req, res) => {
  console.log('[B2C RESULT]', JSON.stringify(req.body, null, 2));
  const result = req.body?.Result;
  if (!result) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const code    = result.ResultCode;
  const params  = result.ResultParameters?.ResultParameter || [];
  const get     = name => params.find(p => p.Key === name)?.Value;

  if (code === 0) {
    // Success
    console.log('[B2C SUCCESS]', {
      amount          : get('TransactionAmount'),
      phone           : get('ReceiverPartyPublicName'),
      receipt         : get('TransactionReceipt'),
      completedTime   : get('TransactionCompletedDateTime'),
      charges         : get('B2CChargesPaidAccountAvailableFunds'),
      utilityBalance  : get('B2CUtilityAccountAvailableFunds')
    });
  } else {
    // Failed — may need to refund user balance
    console.log('[B2C FAILED]', result.ResultDesc, 'Code:', code);
    // TODO: implement refund logic using OriginatorConversationID to find the user
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ═══════════════════════════════════════════════════════════
// ROUTE — B2C Timeout Callback
// POST /b2c/timeout
// ═══════════════════════════════════════════════════════════
app.post('/b2c/timeout', (req, res) => {
  console.log('[B2C TIMEOUT]', JSON.stringify(req.body, null, 2));
  // Safaricom timed out — log for manual review
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n🚀 PesaKrash server on http://localhost:${PORT}`);
  console.log(`   Socket.io enabled — real-time multiplayer ✅\n`);

  // Start game engine
  startGameLoop();

  // Keep-alive ping
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try { await axios.get(SELF_URL); console.log(`[KEEP-ALIVE] Pinged`); }
    catch (e) { console.warn('[KEEP-ALIVE] Failed:', e.message); }
  }, 10 * 60 * 1000);
});