import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

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
app.post('/api/tasks/verify', (req, res) => {
  try {
    const { taskId, task_id, userId } = req.body || {};
    const state = getUserState(userId);
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
    const targetKey = taskMap[key] || 'task_channel';

    if (!state.tasks[targetKey]) {
      state.tasks[targetKey] = { verified: false, claimed: false };
    }
    state.tasks[targetKey].verified = true;

    res.json({
      ok: true,
      verified: true,
      claimed: state.tasks[targetKey].claimed
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to verify task' });
  }
});

// Task Claim Route
app.post('/api/tasks/claim', (req, res) => {
  try {
    const { taskId, task_id, userId } = req.body || {};
    const state = getUserState(userId);
    const key = taskId || (task_id ? String(task_id) : 'task_channel');

    const taskMap = {
      '1': 'task_channel',
      '2': 'task_group',
      '3': 'task_payout',
      'task_channel': 'task_channel',
      'task_group': 'task_group',
      'task_payout': 'task_payout'
    };
    const targetKey = taskMap[key] || 'task_channel';

    if (!state.tasks[targetKey]) {
      state.tasks[targetKey] = { verified: true, claimed: false };
    }

    if (state.tasks[targetKey].claimed) {
      return res.json({
        ok: true,
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
      claimed: true,
      newBalance: state.balance
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to claim task reward' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

