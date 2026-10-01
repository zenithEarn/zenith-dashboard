// Cloudflare Worker for Zenivora Telegram Task Verification
// Production Worker URL: https://zenith-backend.hamidalipq.workers.dev

const TASK_CHANNELS = {
  task_channel: '@ZenivoraUpdate',
  task_group: '@ZenivoraCommunity',
  task_payout: '@ZenivoraWithdraw'
};

// In-memory fallback cache (used if env.ZENIVORA_KV is not yet bound in local/dev)
const memoryUserCache = new Map();

function createDefaultUserState() {
  return {
    balance: 0.00,
    wallet: null,
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

  if (env && env.ZENIVORA_KV) {
    try {
      const data = await env.ZENIVORA_KV.get(kvKey, 'json');
      if (data && typeof data === 'object') {
        return {
          balance: typeof data.balance === 'number' ? data.balance : 0.00,
          wallet: data.wallet || null,
          tasks: {
            task_channel: {
              verified: Boolean(data.tasks?.task_channel?.verified),
              claimed: Boolean(data.tasks?.task_channel?.claimed)
            },
            task_group: {
              verified: Boolean(data.tasks?.task_group?.verified),
              claimed: Boolean(data.tasks?.task_group?.claimed)
            },
            task_payout: {
              verified: Boolean(data.tasks?.task_payout?.verified),
              claimed: Boolean(data.tasks?.task_payout?.claimed)
            }
          }
        };
      }
    } catch (kvErr) {
      console.warn('[ZENIVORA_KV Read Warning]:', kvErr.message);
    }
  }

  // Graceful fallback to memory cache if KV is not bound
  if (!memoryUserCache.has(cleanId)) {
    memoryUserCache.set(cleanId, createDefaultUserState());
  }
  return memoryUserCache.get(cleanId);
}

// Persistent user state writer via Cloudflare KV (ZENIVORA_KV)
async function saveWorkerUserState(userId, state, env) {
  const cleanId = String(userId || 'anonymous').trim().replace(/^tg_/, '').replace(/_tg$/, '');
  const kvKey = `zenivora:user:${cleanId}`;

  // Keep memory cache in sync
  memoryUserCache.set(cleanId, state);

  if (env && env.ZENIVORA_KV) {
    try {
      await env.ZENIVORA_KV.put(kvKey, JSON.stringify(state));
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
          tasks: state.tasks,
          balance: state.balance,
          wallet: state.wallet || null
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
        if (state.tasks[targetKey].verified || state.tasks[targetKey].claimed) {
          return jsonResponse({
            success: true,
            joined: true,
            ok: true,
            verified: true,
            claimed: state.tasks[targetKey].claimed
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
            claimed: state.tasks[targetKey].claimed
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
        if (!state.tasks[targetKey].verified && !state.tasks[targetKey].claimed) {
          return jsonResponse({
            success: false,
            claimed: false,
            error: 'NOT_VERIFIED',
            message: 'Please verify Telegram channel membership before claiming reward.'
          }, 400);
        }

        if (state.tasks[targetKey].claimed) {
          return jsonResponse({
            success: true,
            claimed: true,
            alreadyClaimed: true,
            newBalance: state.balance
          }, 200);
        }

        state.tasks[targetKey].claimed = true;
        state.tasks[targetKey].verified = true;
        state.balance = parseFloat((state.balance + 0.01).toFixed(2));
        await saveWorkerUserState(userId, state, env);

        return jsonResponse({
          success: true,
          claimed: true,
          newBalance: state.balance
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
