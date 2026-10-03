// Cloudflare Worker for Zenivora Telegram Task Verification
// Production Worker URL: https://zenith-backend.hamidalipq.workers.dev

const TASK_CHANNELS = {
  task_channel: '@ZenivoraUpdate',
  task_group: '@ZenivoraCommunity',
  task_payout: '@ZenivoraWithdraw'
};

// In-memory fallback cache (used if KV is momentarily unavailable)
const memoryUserCache = new Map();

function getKV(env) {
  if (env) {
    if (env.ZENIVORA_KV && typeof env.ZENIVORA_KV.get === 'function') return env.ZENIVORA_KV;
    if (env['zenivora-kv'] && typeof env['zenivora-kv'].get === 'function') return env['zenivora-kv'];
    if (env.zenivora_kv && typeof env.zenivora_kv.get === 'function') return env.zenivora_kv;
    if (env.ZENIVORA && typeof env.ZENIVORA.get === 'function') return env.ZENIVORA;
  }
  if (typeof globalThis !== 'undefined') {
    if (globalThis.ZENIVORA_KV && typeof globalThis.ZENIVORA_KV.get === 'function') return globalThis.ZENIVORA_KV;
    if (globalThis['zenivora-kv'] && typeof globalThis['zenivora-kv'].get === 'function') return globalThis['zenivora-kv'];
    if (globalThis.zenivora_kv && typeof globalThis.zenivora_kv.get === 'function') return globalThis.zenivora_kv;
  }
  return null;
}

function createDefaultUserState(userId) {
  const cleanId = String(userId || 'anonymous').trim().replace(/^tg_/, '').replace(/_tg$/, '');
  return {
    userId: cleanId,
    balance: 0.00,
    totalEarned: 0.00,
    totalReferrals: 0,
    miningPower: 0.00,
    wallet: null,
    createdAt: Date.now(),
    claimedTasks: [],
    rewardHistory: [],
    referralData: {
      referredBy: null,
      referrals: []
    },
    tasks: {
      task_channel: { verified: false, claimed: false },
      task_group: { verified: false, claimed: false },
      task_payout: { verified: false, claimed: false }
    }
  };
}

// Persistent user state reader via Cloudflare KV (ZENIVORA_KV)
async function getWorkerUserState(userId, env) {
  const cleanId = String(userId || 'anonymous').trim().replace(/^tg_/, '').replace(/_tg$/, '');
  const kvKey = `zenivora:user:${cleanId}`;
  const kv = getKV(env);

  if (kv) {
    try {
      const raw = await kv.get(kvKey);
      if (raw) {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (data && typeof data === 'object') {
          const claimedTasks = Array.isArray(data.claimedTasks) ? [...data.claimedTasks] : [];

          const tasks = {
            task_channel: {
              verified: Boolean(data.tasks?.task_channel?.verified || claimedTasks.includes('task_channel')),
              claimed: Boolean(data.tasks?.task_channel?.claimed || claimedTasks.includes('task_channel'))
            },
            task_group: {
              verified: Boolean(data.tasks?.task_group?.verified || claimedTasks.includes('task_group')),
              claimed: Boolean(data.tasks?.task_group?.claimed || claimedTasks.includes('task_group'))
            },
            task_payout: {
              verified: Boolean(data.tasks?.task_payout?.verified || claimedTasks.includes('task_payout')),
              claimed: Boolean(data.tasks?.task_payout?.claimed || claimedTasks.includes('task_payout'))
            }
          };

          ['task_channel', 'task_group', 'task_payout'].forEach(tId => {
            if (tasks[tId].claimed && !claimedTasks.includes(tId)) {
              claimedTasks.push(tId);
            }
          });

          const userState = {
            userId: cleanId,
            balance: typeof data.balance === 'number' ? data.balance : (parseFloat(data.balance) || 0.00),
            totalEarned: typeof data.totalEarned === 'number' ? data.totalEarned : (parseFloat(data.totalEarned) || (typeof data.balance === 'number' ? data.balance : 0.00)),
            totalReferrals: typeof data.totalReferrals === 'number' ? data.totalReferrals : (parseInt(data.totalReferrals) || 0),
            miningPower: typeof data.miningPower === 'number' ? data.miningPower : (parseFloat(data.miningPower) || 0.00),
            wallet: data.wallet || null,
            createdAt: data.createdAt || data.created_at || null,
            claimedTasks: claimedTasks,
            rewardHistory: Array.isArray(data.rewardHistory) ? data.rewardHistory : [],
            referralData: data.referralData || { referredBy: null, referrals: [] },
            tasks: tasks
          };

          memoryUserCache.set(cleanId, userState);
          return userState;
        }
      }
    } catch (kvErr) {
      console.warn('[ZENIVORA_KV Read Warning]:', kvErr.message);
    }
  }

  // Graceful fallback to memory cache if KV has not loaded or is uninitialized
  if (!memoryUserCache.has(cleanId)) {
    memoryUserCache.set(cleanId, createDefaultUserState(cleanId));
  }
  return memoryUserCache.get(cleanId);
}

// Persistent user state writer via Cloudflare KV (ZENIVORA_KV)
async function saveWorkerUserState(userId, state, env) {
  const cleanId = String(userId || 'anonymous').trim().replace(/^tg_/, '').replace(/_tg$/, '');
  const kvKey = `zenivora:user:${cleanId}`;

  if (!state.userId) state.userId = cleanId;
  if (!state.createdAt) state.createdAt = Date.now();
  if (typeof state.balance !== 'number') state.balance = parseFloat(state.balance) || 0.00;
  if (typeof state.totalEarned !== 'number') state.totalEarned = parseFloat(state.totalEarned) || state.balance;
  if (!Array.isArray(state.claimedTasks)) {
    state.claimedTasks = [];
    ['task_channel', 'task_group', 'task_payout'].forEach(tId => {
      if (state.tasks?.[tId]?.claimed) state.claimedTasks.push(tId);
    });
  }

  // Keep memory cache in sync
  memoryUserCache.set(cleanId, state);

  const kv = getKV(env);
  if (kv) {
    try {
      await kv.put(kvKey, JSON.stringify(state));
    } catch (kvErr) {
      console.error('[ZENIVORA_KV Write Error]:', kvErr.message);
    }
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Content-Type': 'application/json'
};

// Safe JSON Response Helper: Guaranteed to ALWAYS return a valid Response instance
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

async function verifyTelegramMembershipWithBot(channelUsername, userId, botToken) {
  // Check secret configuration
  if (!botToken) {
    return {
      status: 'CONFIG_ERROR',
      error: 'CONFIG_ERROR',
      message: 'Worker secret TELEGRAM_BOT_TOKEN is not configured.'
    };
  }

  // Check valid user ID
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
      // Telegram returns "user not found" or "PARTICIPANT_ID_INVALID" when the user has never joined
      if (description.includes('user not found') || description.includes('participant') || description.includes('not a member')) {
        return {
          status: 'NOT_JOINED',
          joined: false,
          error: 'NOT_JOINED',
          message: 'Please join the Telegram channel first.'
        };
      }

      // Safe diagnostic error without exposing bot token
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

export default {
  async fetch(request, env, ctx) {
    try {
      // 1. Guaranteed OPTIONS handling for CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/$/, '') || '/';

      // 2. GET /api/tasks/status
      if (pathname === '/api/tasks/status' && request.method === 'GET') {
        const userId = url.searchParams.get('userId') || 'anonymous';
        const state = await getWorkerUserState(userId, env);
        return jsonResponse({
          success: true,
          ok: true,
          userId: state.userId,
          tasks: state.tasks,
          balance: state.balance,
          totalEarned: state.totalEarned,
          totalReferrals: state.totalReferrals,
          miningPower: state.miningPower,
          wallet: state.wallet || null,
          createdAt: state.createdAt || null,
          claimedTasks: state.claimedTasks || []
        }, 200);
      }

      // 2b. GET /api/user/wallet
      if (pathname === '/api/user/wallet' && request.method === 'GET') {
        const userId = url.searchParams.get('userId') || 'anonymous';
        const state = await getWorkerUserState(userId, env);
        return jsonResponse({
          ok: true,
          wallet: state.wallet || null,
          balance: state.balance,
          totalEarned: state.totalEarned,
          createdAt: state.createdAt || null
        }, 200);
      }

      // 2c. POST /api/user/wallet
      if (pathname === '/api/user/wallet' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { userId, wallet } = body;
        if (!wallet || typeof wallet !== 'string') {
          return jsonResponse({ ok: false, error: 'Invalid wallet address' }, 400);
        }
        const state = await getWorkerUserState(userId, env);
        state.wallet = wallet.trim();
        await saveWorkerUserState(userId, state, env);
        return jsonResponse({
          ok: true,
          wallet: state.wallet,
          balance: state.balance,
          totalEarned: state.totalEarned,
          createdAt: state.createdAt || null
        }, 200);
      }

      // 3. POST /api/tasks/verify
      if (pathname === '/api/tasks/verify' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { taskId, task_id, userId } = body;
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
          return jsonResponse({
            success: false,
            joined: false,
            error: 'INVALID_TASK',
            message: 'Invalid task identifier.'
          }, 400);
        }

        const state = await getWorkerUserState(userId, env);
        // If already verified or claimed, return success immediately
        if (state.tasks[targetKey].verified || state.tasks[targetKey].claimed || (Array.isArray(state.claimedTasks) && state.claimedTasks.includes(targetKey))) {
          return jsonResponse({
            success: true,
            joined: true,
            ok: true,
            verified: true,
            claimed: Boolean(state.tasks[targetKey].claimed || state.claimedTasks?.includes(targetKey))
          }, 200);
        }

        const channel = TASK_CHANNELS[targetKey];
        const botToken = env?.TELEGRAM_BOT_TOKEN || env?.BOT_TOKEN;
        const result = await verifyTelegramMembershipWithBot(channel, userId, botToken);

        if (result.status === 'SUCCESS' && result.joined) {
          state.tasks[targetKey].verified = true;
          await saveWorkerUserState(userId, state, env);
          return jsonResponse({
            success: true,
            joined: true,
            ok: true,
            verified: true,
            claimed: Boolean(state.tasks[targetKey].claimed)
          }, 200);
        }

        if (result.status === 'NOT_JOINED') {
          return jsonResponse({
            success: false,
            joined: false,
            error: 'NOT_JOINED',
            message: result.message || 'Please join the Telegram channel first.'
          }, 403);
        }

        if (result.status === 'CONFIG_ERROR') {
          return jsonResponse({
            success: false,
            joined: false,
            status: 'CONFIG_ERROR',
            error: 'CONFIG_ERROR',
            message: result.message
          }, 503);
        }

        if (result.status === 'INVALID_USER') {
          return jsonResponse({
            success: false,
            joined: false,
            status: 'INVALID_USER',
            error: 'INVALID_USER',
            message: result.message
          }, 400);
        }

        // TELEGRAM_ERROR / other failure
        return jsonResponse({
          success: false,
          joined: false,
          status: result.status || 'TELEGRAM_ERROR',
          error: result.error || 'TELEGRAM_ERROR',
          message: result.message || 'Telegram verification failed',
          details: result.details || 'Unable to verify membership at this time.'
        }, 502);
      }

      // 4. POST /api/tasks/claim
      if (pathname === '/api/tasks/claim' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { taskId, task_id, userId } = body;
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
          return jsonResponse({
            success: false,
            claimed: false,
            error: 'INVALID_TASK',
            message: 'Invalid task identifier.'
          }, 400);
        }

        const state = await getWorkerUserState(userId, env);

        // Strict duplicate claim protection: NEVER allow double claim
        if (state.tasks[targetKey].claimed || (Array.isArray(state.claimedTasks) && state.claimedTasks.includes(targetKey))) {
          return jsonResponse({
            success: true,
            claimed: true,
            alreadyClaimed: true,
            message: 'Task reward has already been claimed.',
            newBalance: state.balance,
            totalEarned: state.totalEarned,
            tasks: state.tasks,
            claimedTasks: state.claimedTasks
          }, 200);
        }

        // Require membership verification before claim
        if (!state.tasks[targetKey].verified) {
          const channel = TASK_CHANNELS[targetKey];
          const botToken = env?.TELEGRAM_BOT_TOKEN || env?.BOT_TOKEN;
          const result = await verifyTelegramMembershipWithBot(channel, userId, botToken);
          if (result.status !== 'SUCCESS' || !result.joined) {
            return jsonResponse({
              success: false,
              claimed: false,
              error: 'NOT_VERIFIED',
              message: 'Please verify Telegram channel membership before claiming reward.'
            }, 400);
          }
          state.tasks[targetKey].verified = true;
        }

        // Atomically grant reward and persist to KV
        state.tasks[targetKey].claimed = true;
        state.tasks[targetKey].verified = true;
        if (!Array.isArray(state.claimedTasks)) state.claimedTasks = [];
        if (!state.claimedTasks.includes(targetKey)) {
          state.claimedTasks.push(targetKey);
        }
        state.balance = parseFloat((state.balance + 0.01).toFixed(2));
        state.totalEarned = parseFloat(((state.totalEarned || 0) + 0.01).toFixed(2));
        if (!Array.isArray(state.rewardHistory)) state.rewardHistory = [];
        state.rewardHistory.push({
          taskId: targetKey,
          amount: 0.01,
          claimedAt: Date.now()
        });

        // Guaranteed persistent write to KV
        await saveWorkerUserState(userId, state, env);

        return jsonResponse({
          success: true,
          claimed: true,
          newBalance: state.balance,
          totalEarned: state.totalEarned,
          tasks: state.tasks,
          claimedTasks: state.claimedTasks
        }, 200);
      }

      // 5. Pass through to assets if on Cloudflare Pages
      if (env?.ASSETS?.fetch) {
        return env.ASSETS.fetch(request);
      }

      // 6. Guaranteed 404 Response for unmatched routes
      return jsonResponse({
        success: false,
        error: 'NOT_FOUND',
        message: 'Endpoint not found'
      }, 404);

    } catch (unhandledError) {
      // 7. Catastrophic catch: ALWAYS returns a Response object!
      return jsonResponse({
        success: false,
        status: 'SERVER_ERROR',
        error: 'SERVER_ERROR',
        message: 'Worker execution error',
        details: String(unhandledError && unhandledError.message ? unhandledError.message : unhandledError)
      }, 500);
    }
  }
};
