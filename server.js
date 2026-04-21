// ═══════════════════════════════════════════════════════════
// PesaKrash — Backend Server
// Stack  : Node.js + Express + MongoDB + JWT
// Mode   : Sandbox (Daraja)
// Port   : 3000
// ═══════════════════════════════════════════════════════════

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'https://pesakrash.infinityfreeapp.com',
    'http://localhost'   // keep for local testing
  ]
}));

// ═══════════════════════════════════════════════════════════
// MONGODB CONNECTION
// ═══════════════════════════════════════════════════════════
const MONGO_URI  = process.env.MONGO_URI  || 'mongodb+srv://frankojunior981_db_user:66iLY6z072x9q4F8@cluster0.3hogvwx.mongodb.net/pesakrash?retryWrites=true&w=majority&appName=Cluster0';
const JWT_SECRET = process.env.JWT_SECRET || 'pesakrash_jwt_super_secret_2026';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected — pesakrash'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ═══════════════════════════════════════════════════════════
// USER MODEL
// ═══════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  username  : { type: String, required: true, trim: true },
  email     : { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone     : { type: String, required: true, trim: true },
  password  : { type: String, required: true },
  balance   : { type: Number, default: 0 },
  createdAt : { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ═══════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token. Please log in.' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token. Please log in again.' });
  }
}

// ═══════════════════════════════════════════════════════════
// DARAJA CREDENTIALS — Sandbox
// ═══════════════════════════════════════════════════════════
const CONSUMER_KEY    = process.env.CONSUMER_KEY    || 'UQlYctKzJgQqRT64atWvKRz6tp8brGf6tTWf9OA54IoVrxw5';
const CONSUMER_SECRET = process.env.CONSUMER_SECRET || 'O262GVn2ODNwgQsqDjgRmfwOGI4fPZIvnPMbyL5dvOqPUI6A2pFElGTmugDc7tuj';
const SHORTCODE       = '174379';
const PASSKEY         = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const CALLBACK_URL    = 'https://morning-forest-72309.herokuapp.com/callback_url.php';
const DARAJA_BASE     = 'https://sandbox.safaricom.co.ke';

async function getToken() {
  const creds = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res   = await axios.get(`${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` }
  });
  return res.data.access_token;
}
function getTimestamp() {
  const d = new Date(), pad = n => String(n).padStart(2,'0');
  return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds());
}
function getPassword(ts) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');
}

// ═══════════════════════════════════════════════════════════
// ROUTES — Auth
// ═══════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'PesaKrash server running ✅', port: 3000 }));

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
    const user   = await User.create({ username, email, phone, password: hashed, balance: 0 });
    const token  = jwt.sign({ id: user._id }, JWT_SECRET);
    return res.status(201).json({
      success: true, message: 'Account created!', token,
      user: { id: user._id, username: user.username, email: user.email, phone: user.phone, balance: user.balance }
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
    return res.json({
      success: true, message: 'Login successful!', token,
      user: { id: user._id, username: user.username, email: user.email, phone: user.phone, balance: user.balance }
    });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET ME (protected)
app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// SET BALANCE DIRECTLY (protected) — used by game after bet/win/loss
app.post('/auth/balance/set', authMiddleware, async (req, res) => {
  const { balance } = req.body;
  if (balance === undefined || balance === null)
    return res.status(400).json({ success: false, message: 'balance required.' });
  if (isNaN(Number(balance)) || Number(balance) < 0)
    return res.status(400).json({ success: false, message: 'Invalid balance value.' });
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.balance = Math.round(Number(balance) * 100) / 100;
    await user.save();
    return res.json({ success: true, balance: user.balance });
  } catch (err) {
    console.error('[BALANCE SET]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// UPDATE BALANCE (protected) — used by withdraw
app.post('/auth/balance', authMiddleware, async (req, res) => {
  const { amount, type } = req.body;
  if (!amount || !type)
    return res.status(400).json({ success: false, message: 'amount and type required.' });
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (type === 'credit') {
      user.balance = Math.round((user.balance + Number(amount)) * 100) / 100;
    } else if (type === 'debit') {
      if (user.balance < Number(amount))
        return res.status(400).json({ success: false, message: 'Insufficient balance.' });
      user.balance = Math.round((user.balance - Number(amount)) * 100) / 100;
    } else {
      return res.status(400).json({ success: false, message: 'type must be credit or debit.' });
    }
    await user.save();
    return res.json({ success: true, balance: user.balance });
  } catch (err) {
    console.error('[BALANCE]', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE — STK Push (protected)
// ═══════════════════════════════════════════════════════════
app.post('/stk-push', authMiddleware, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount)
    return res.status(400).json({ success: false, message: 'phone and amount are required.' });

  let msisdn = String(phone).replace(/[\s\-]/g, '');
  if (msisdn.startsWith('+'))       msisdn = msisdn.slice(1);
  if (msisdn.startsWith('254'))     { /* good */ }
  else if (msisdn.startsWith('0'))  msisdn = '254' + msisdn.slice(1);
  else if (msisdn.length === 9)     msisdn = '254' + msisdn;
  else if (msisdn.length === 8)     msisdn = '2547' + msisdn;
  if (!/^254(7|1)\d{8}$/.test(msisdn))
    return res.status(400).json({ success: false, message: 'Invalid Safaricom number. Use 07XX XXX XXX.' });

  const amountInt = Math.ceil(Number(amount));
  if (isNaN(amountInt) || amountInt < 1)
    return res.status(400).json({ success: false, message: 'Amount must be at least 1.' });

  try {
    const token = await getToken();
    const ts    = getTimestamp();
    const stkRes = await axios.post(
      `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode : SHORTCODE, Password: getPassword(ts), Timestamp: ts,
        TransactionType   : 'CustomerPayBillOnline', Amount: amountInt,
        PartyA: msisdn, PartyB: SHORTCODE, PhoneNumber: msisdn,
        CallBackURL: CALLBACK_URL, AccountReference: 'PesaKrash', TransactionDesc: 'PesaKrash Deposit'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = stkRes.data;
    console.log('[STK PUSH SENT]', data);

    if (data.ResponseCode === '0') {
      // Credit user balance in MongoDB
      const user = await User.findById(req.userId);
      if (user) { user.balance = Math.round((user.balance + amountInt)*100)/100; await user.save(); }
      return res.json({
        success: true, checkoutRequestID: data.CheckoutRequestID,
        message: data.CustomerMessage || 'Prompt sent to phone',
        balance: user ? user.balance : null
      });
    } else {
      return res.status(400).json({ success: false, message: data.ResponseDescription || 'STK push failed.' });
    }
  } catch (err) {
    const msg = err.response?.data?.errorMessage || err.message || 'Server error';
    console.error('[STK ERROR]', err.response?.data || err.message);
    return res.status(500).json({ success: false, message: msg });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTE — M-Pesa Callback
// ═══════════════════════════════════════════════════════════
app.post('/mpesa/callback', (req, res) => {
  const body = req.body;
  console.log('[MPESA CALLBACK]', JSON.stringify(body, null, 2));
  const cb = body?.Body?.stkCallback;
  if (!cb) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const items = cb.CallbackMetadata?.Item || [];
  const get   = n => items.find(i => i.Name === n)?.Value;
  if (cb.ResultCode === 0) {
    console.log('[PAYMENT SUCCESS]', { amount: get('Amount'), phone: get('PhoneNumber'), receipt: get('MpesaReceiptNumber') });
  } else {
    console.log('[PAYMENT FAILED]', cb.ResultDesc);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
const API = 'https://pesakrash-backend.onrender.com';
app.listen(PORT, () => {
  console.log(`\n🚀 PesaKrash server on http://localhost:${PORT}`);
  console.log(`   POST /auth/register  → create account`);
  console.log(`   POST /auth/login     → login`);
  console.log(`   GET  /auth/me        → get current user`);
  console.log(`   POST /auth/balance   → update balance`);
  console.log(`   POST /stk-push       → M-Pesa STK push\n`);
});