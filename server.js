import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env file automatically in Node.js 22 if present
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (e) {
  // Optional .env file
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS & Preflight middleware for Telegram Mini App / cross-origin webviews
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.static(__dirname));

// The three official Telegram tasks
const TASK_CHANNELS = {
  task_channel: '@ZenivoraUpdate',
  task_group: '@ZenivoraCommunity',
  task_payout: '@ZenivoraWithdraw'
};

async function verifyTelegramMembership(channelUsername, userId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!botToken) {
    console.warn('[Telegram Task] TELEGRAM_BOT_TOKEN not configured on server.');
    return {
      status: 'CONFIG_ERROR',
      error: 'CONFIG_ERROR',
      message: 'Server secret TELEGRAM_BOT_TOKEN is not configured.'
    };
  }

  const cleanUserId = String(userId || '').trim().replace(/^tg_/, '').replace(/_tg$/, '');
  if (!cleanUserId || !/^\d+$/.test(cleanUserId)) {
    return {
      status: 'INVALID_USER',
      error: 'INVALID_USER',
      message: 'Valid Telegram numeric user ID is required for verification.'
    };
  }

  const targetChat = channelUsername.startsWith('@') || channelUsername.startsWith('-')
    ? channelUsername
    : `@${channelUsername}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(targetChat)}&user_id=${encodeURIComponent(cleanUserId)}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      return {
        status: 'TELEGRAM_ERROR',
        error: 'TELEGRAM_ERROR',
        message: 'Telegram verification failed: Invalid response from Telegram',
        details: `HTTP ${response.status}`
      };
    }

    if (data.ok && data.result) {
      const memberStatus = data.result.status;
      const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
      if (validStatuses.includes(memberStatus)) {
        return { status: 'SUCCESS', joined: true };
      } else {
        return {
          status: 'NOT_JOINED',
          joined: false,
          error: 'NOT_JOINED',
          message: 'Please join the Telegram channel first.'
        };
      }
    } else {
      const description = (data.description || '').toLowerCase();
      if (description.includes('user not found') || description.includes('participant') || description.includes('not a member')) {
        return {
          status: 'NOT_JOINED',
          joined: false,
          error: 'NOT_JOINED',
          message: 'Please join the Telegram channel first.'
        };
      }

      const safeDesc = (data.description || 'Unknown Telegram API error').replace(/bot\d+:[a-zA-Z0-9_-]+/gi, 'bot[REDACTED]');
      return {
        status: 'TELEGRAM_ERROR',
        error: 'TELEGRAM_ERROR',
        message: 'Telegram verification failed',
        details: safeDesc
      };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        status: 'TELEGRAM_ERROR',
        error: 'TIMEOUT',
        message: 'Telegram API request timed out. Please try again.',
        details: 'Connection to Telegram API timed out after 8s'
      };
    }
    return {
      status: 'TELEGRAM_ERROR',
      error: 'NETWORK_ERROR',
      message: 'Failed to connect to Telegram API. Please try again.',
      details: err.message || 'Network error'
    };
  }
}

// In-memory user state store (data layer fallback)
const userStore = new Map();

function getUserState(userId) {
  const id = String(userId || 'anonymous');
  if (!userStore.has(id)) {
    userStore.set(id, {
      balance: 0.00,
      wallet: null,
      tasks: {
        task_channel: { verified: false, claimed: false },
        task_group: { verified: false, claimed: false },
        task_payout: { verified: false, claimed: false }
      }
    });
  }
  return userStore.get(id);
}

// Task Status Route
app.get('/api/tasks/status', (req, res) => {
  try {
    const userId = req.query.userId || 'anonymous';
    const state = getUserState(userId);
    res.json({
      ok: true,
      tasks: state.tasks,
      balance: state.balance,
      wallet: state.wallet || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Wallet Address Routes
app.get('/api/user/wallet', (req, res) => {
  try {
    const userId = req.query.userId || 'anonymous';
    const state = getUserState(userId);
    res.json({
      ok: true,
      wallet: state.wallet || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

app.post('/api/user/wallet', (req, res) => {
  try {
    const { userId, wallet } = req.body || {};
    if (!wallet || typeof wallet !== 'string') {
      return res.status(400).json({ ok: false, error: 'Wallet address is required' });
    }
    const trimmed = wallet.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid BEP20 address. Must start with 0x and contain exactly 40 hexadecimal characters (42 total).'
      });
    }
    const state = getUserState(userId);
    state.wallet = trimmed;
    res.json({
      ok: true,
      wallet: state.wallet
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to save wallet address' });
  }
});

// Task Verify Route
app.post('/api/tasks/verify', async (req, res) => {
  try {
    const { taskId, task_id, userId } = req.body || {};
    const key = taskId || (task_id ? String(task_id) : 'task_channel');
    
    // Map numerical or string task ids to valid task keys
    const taskMap = {
      '1': 'task_channel',
      '2': 'task_group',
      '3': 'task_payout',
      'task_channel': 'task_channel',
      'task_group': 'task_group',
      'task_payout': 'task_payout'
    };
    const targetKey = taskMap[key];
    if (!targetKey) {
      return res.status(400).json({
        ok: false,
        success: false,
        verified: false,
        error: 'INVALID_TASK',
        message: 'Invalid task identifier.'
      });
    }

    const state = getUserState(userId);
    if (!state.tasks[targetKey]) {
      state.tasks[targetKey] = { verified: false, claimed: false };
    }

    // If already verified or claimed, return success immediately
    if (state.tasks[targetKey].verified || state.tasks[targetKey].claimed) {
      return res.json({
        ok: true,
        success: true,
        verified: true,
        joined: true,
        claimed: state.tasks[targetKey].claimed
      });
    }

    const channel = TASK_CHANNELS[targetKey];
    const result = await verifyTelegramMembership(channel, userId);

    if (result.status === 'SUCCESS' && result.joined) {
      state.tasks[targetKey].verified = true;
      return res.json({
        ok: true,
        success: true,
        verified: true,
        joined: true,
        claimed: state.tasks[targetKey].claimed
      });
    }

    if (result.status === 'NOT_JOINED') {
      state.tasks[targetKey].verified = false;
      return res.status(403).json({
        ok: false,
        success: false,
        verified: false,
        joined: false,
        error: 'NOT_JOINED',
        message: result.message || 'Please join the Telegram channel first.'
      });
    }

    if (result.status === 'CONFIG_ERROR') {
      return res.status(503).json({
        ok: false,
        success: false,
        verified: false,
        status: 'CONFIG_ERROR',
        error: 'CONFIG_ERROR',
        message: result.message
      });
    }

    if (result.status === 'INVALID_USER') {
      return res.status(400).json({
        ok: false,
        success: false,
        verified: false,
        status: 'INVALID_USER',
        error: 'INVALID_USER',
        message: result.message || 'Valid Telegram numeric user ID is required for verification.'
      });
    }

    // TELEGRAM_ERROR / other failure
    return res.status(502).json({
      ok: false,
      success: false,
      verified: false,
      status: result.status || 'TELEGRAM_ERROR',
      error: result.error || 'TELEGRAM_ERROR',
      message: result.message || 'Telegram verification failed',
      details: result.details || 'Unable to verify membership at this time.'
    });
  } catch (err) {
    console.error('[Verify Route Error]:', err);
    res.status(500).json({
      ok: false,
      success: false,
      verified: false,
      error: 'SERVER_ERROR',
      message: 'Verification server is temporarily unavailable. Please try again.'
    });
  }
});

// Task Claim Route
app.post('/api/tasks/claim', (req, res) => {
  try {
    const { taskId, task_id, userId } = req.body || {};
    const key = taskId || (task_id ? String(task_id) : 'task_channel');

    const taskMap = {
      '1': 'task_channel',
      '2': 'task_group',
      '3': 'task_payout',
      'task_channel': 'task_channel',
      'task_group': 'task_group',
      'task_payout': 'task_payout'
    };
    const targetKey = taskMap[key];
    if (!targetKey) {
      return res.status(400).json({
        ok: false,
        success: false,
        claimed: false,
        error: 'INVALID_TASK',
        message: 'Invalid task identifier.'
      });
    }

    const state = getUserState(userId);
    if (!state.tasks[targetKey]) {
      state.tasks[targetKey] = { verified: false, claimed: false };
    }

    // Must be verified before reward can be claimed!
    if (!state.tasks[targetKey].verified && !state.tasks[targetKey].claimed) {
      return res.status(400).json({
        ok: false,
        success: false,
        claimed: false,
        error: 'NOT_VERIFIED',
        message: 'Please verify Telegram channel membership before claiming reward.'
      });
    }

    // Already claimed -> return current balance without duplicate crediting
    if (state.tasks[targetKey].claimed) {
      return res.json({
        ok: true,
        success: true,
        claimed: true,
        alreadyClaimed: true,
        newBalance: state.balance
      });
    }

    state.tasks[targetKey].claimed = true;
    state.tasks[targetKey].verified = true;
    state.balance = parseFloat((state.balance + 0.01).toFixed(2));

    res.json({
      ok: true,
      success: true,
      claimed: true,
      newBalance: state.balance
    });
  } catch (err) {
    console.error('[Claim Route Error]:', err);
    res.status(500).json({
      ok: false,
      success: false,
      claimed: false,
      error: 'SERVER_ERROR',
      message: 'Failed to claim task reward. Please try again.'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

