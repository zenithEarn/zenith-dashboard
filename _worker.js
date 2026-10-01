// Cloudflare Worker / Cloudflare Pages Functions for Zenivora
const TASK_CHANNELS = {
  task_channel: '@ZenivoraUpdate',
  task_group: '@ZenivoraCommunity',
  task_payout: '@ZenivoraWithdraw'
};

const workerUserStore = new Map();

function getWorkerUserState(userId) {
  const id = String(userId || 'anonymous');
  if (!workerUserStore.has(id)) {
    workerUserStore.set(id, {
      balance: 0.00,
      wallet: null,
      tasks: {
        task_channel: { verified: false, claimed: false },
        task_group: { verified: false, claimed: false },
        task_payout: { verified: false, claimed: false }
      }
    });
  }
  return workerUserStore.get(id);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Content-Type': 'application/json'
};

async function verifyTelegramMembershipWithBot(channelUsername, userId, botToken) {
  if (!botToken) {
    return {
      status: 'SERVER_ERROR',
      message: 'Verification server is temporarily unavailable (bot token secret not configured).'
    };
  }

  const targetChat = channelUsername.startsWith('@') || channelUsername.startsWith('-')
    ? channelUsername
    : `@${channelUsername}`;

  const cleanUserId = String(userId || '').trim().replace(/^tg_/, '').replace(/_tg$/, '');
  if (!cleanUserId || !/^\d+$/.test(cleanUserId)) {
    return {
      status: 'INVALID_USER',
      message: 'Valid Telegram user ID is required for verification.'
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(targetChat)}&user_id=${encodeURIComponent(cleanUserId)}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const data = await response.json();

    if (data.ok && data.result) {
      const memberStatus = data.result.status;
      const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
      if (validStatuses.includes(memberStatus)) {
        return { status: 'SUCCESS', joined: true };
      } else {
        return {
          status: 'NOT_JOINED',
          joined: false,
          message: 'Please join the Telegram channel first.'
        };
      }
    } else {
      const description = (data.description || '').toLowerCase();
      if (description.includes('user not found') || description.includes('participant') || description.includes('not a member')) {
        return {
          status: 'NOT_JOINED',
          joined: false,
          message: 'Please join the Telegram channel first.'
        };
      }
      return {
        status: 'SERVER_ERROR',
        message: 'Verification server is temporarily unavailable. Please try again.'
      };
    }
  } catch (err) {
    return {
      status: 'SERVER_ERROR',
      message: 'Verification server is temporarily unavailable. Please try again.'
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // GET /api/tasks/status
    if (pathname === '/api/tasks/status' && request.method === 'GET') {
      const userId = url.searchParams.get('userId') || 'anonymous';
      const state = getWorkerUserState(userId);
      return new Response(JSON.stringify({
        success: true,
        ok: true,
        tasks: state.tasks,
        balance: state.balance,
        wallet: state.wallet || null
      }), { status: 200, headers: corsHeaders });
    }

    // POST /api/tasks/verify
    if (pathname === '/api/tasks/verify' && request.method === 'POST') {
      try {
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
          return new Response(JSON.stringify({
            success: false,
            joined: false,
            error: 'INVALID_TASK',
            message: 'Invalid task identifier.'
          }), { status: 400, headers: corsHeaders });
        }

        const state = getWorkerUserState(userId);
        if (state.tasks[targetKey].verified || state.tasks[targetKey].claimed) {
          return new Response(JSON.stringify({
            success: true,
            joined: true,
            ok: true,
            verified: true,
            claimed: state.tasks[targetKey].claimed
          }), { status: 200, headers: corsHeaders });
        }

        const channel = TASK_CHANNELS[targetKey];
        const botToken = env?.TELEGRAM_BOT_TOKEN || env?.BOT_TOKEN;
        const result = await verifyTelegramMembershipWithBot(channel, userId, botToken);

        if (result.status === 'SUCCESS' && result.joined) {
          state.tasks[targetKey].verified = true;
          return new Response(JSON.stringify({
            success: true,
            joined: true,
            ok: true,
            verified: true,
            claimed: state.tasks[targetKey].claimed
          }), { status: 200, headers: corsHeaders });
        }

        if (result.status === 'NOT_JOINED') {
          return new Response(JSON.stringify({
            success: false,
            joined: false,
            error: 'NOT_JOINED',
            message: result.message || 'Please join the Telegram channel first.'
          }), { status: 403, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          success: false,
          joined: false,
          error: result.status || 'SERVER_ERROR',
          message: result.message || 'Verification server is temporarily unavailable. Please try again.'
        }), { status: 503, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          joined: false,
          error: 'SERVER_ERROR',
          message: 'Verification server is temporarily unavailable. Please try again.'
        }), { status: 500, headers: corsHeaders });
      }
    }

    // POST /api/tasks/claim
    if (pathname === '/api/tasks/claim' && request.method === 'POST') {
      try {
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
          return new Response(JSON.stringify({
            success: false,
            claimed: false,
            error: 'INVALID_TASK'
          }), { status: 400, headers: corsHeaders });
        }

        const state = getWorkerUserState(userId);
        if (!state.tasks[targetKey].verified && !state.tasks[targetKey].claimed) {
          return new Response(JSON.stringify({
            success: false,
            claimed: false,
            error: 'NOT_VERIFIED',
            message: 'Please verify Telegram channel membership before claiming reward.'
          }), { status: 400, headers: corsHeaders });
        }

        if (state.tasks[targetKey].claimed) {
          return new Response(JSON.stringify({
            success: true,
            claimed: true,
            alreadyClaimed: true,
            newBalance: state.balance
          }), { status: 200, headers: corsHeaders });
        }

        state.tasks[targetKey].claimed = true;
        state.tasks[targetKey].verified = true;
        state.balance = parseFloat((state.balance + 0.01).toFixed(2));

        return new Response(JSON.stringify({
          success: true,
          claimed: true,
          newBalance: state.balance
        }), { status: 200, headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          claimed: false,
          error: 'SERVER_ERROR'
        }), { status: 500, headers: corsHeaders });
      }
    }

    // Pass through to assets if on Cloudflare Pages
    if (env?.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
