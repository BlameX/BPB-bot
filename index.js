const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error("FATAL ERROR: BOT_TOKEN environment variable is not set.");
    process.exit(1);
}

// Cloudflare API base URL
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// Create bot instance
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Store user sessions (in memory - for production use Redis)
// We will use this to manage the conversation state for each user
const userSessions = new Map();

// --- HELPER FUNCTIONS (No changes from your original code) ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function cleanupSession(userId) { userSessions.delete(userId); }
const getHeaders = (apiToken) => ({ 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' });
const getHeadersWithGlobalKey = (email, globalKey) => ({ 'X-Auth-Email': email, 'X-Auth-Key': globalKey, 'Content-Type': 'application/json' });

// --- DEPLOYMENT LOGIC (No major changes, this is the core automation) ---
async function deployBPBWorker(chatId) {
    const session = userSessions.get(chatId);
    if (!session || !session.accountId || (!session.apiToken && !session.globalKey)) {
        bot.sendMessage(chatId, "❌ Critical error: Session data is missing. Please start over with /automation.");
        return;
    }

    const { accountId, apiToken, email, globalKey } = session;

    try {
        await bot.sendMessage(chatId, "🔍 Verifying your Cloudflare credentials...");
        const verification = await verifyCloudflareCredentials(apiToken, accountId, email, globalKey);
        if (!verification.valid) {
            throw new Error(`Credential verification failed: ${verification.error}`);
        }
        await bot.sendMessage(chatId, "✅ Credentials verified! Starting BPB Worker deployment...");

        // Step 1: Generate worker name
        const timestamp = Date.now();
        const workerName = `bpb-worker-${timestamp}`.toLowerCase();
        await bot.sendMessage(chatId, `📝 Worker name: ${workerName}`);

        // Step 2: Download worker.js code
        await bot.sendMessage(chatId, "📥 Downloading worker.js code...");
        const workerCodeResponse = await axios.get('https://github.com/bia-pain-bache/BPB-Worker-Panel/releases/download/v3.5.6/worker.js');
        const workerCode = workerCodeResponse.data;
        if (!workerCode || workerCode.length < 100) throw new Error('Downloaded worker code is invalid.');

        // Step 3: Create the worker
        await bot.sendMessage(chatId, "⚡ Creating Cloudflare Worker...");
        let createHeaders = apiToken
            ? { 'Authorization': `Bearer ${apiToken}` }
            : { 'X-Auth-Email': email, 'X-Auth-Key': globalKey };

        try {
            await axios.put(`${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`, workerCode, { headers: { ...createHeaders, 'Content-Type': 'application/javascript+module' } });
        } catch (e) {
            await axios.put(`${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`, workerCode, { headers: { ...createHeaders, 'Content-Type': 'application/javascript' } });
        }
        await bot.sendMessage(chatId, "✅ Worker created successfully!");

        // Step 4: Enable workers.dev subdomain (best effort)
        try {
            await bot.sendMessage(chatId, "🌐 Enabling workers.dev subdomain...");
            await axios.put(`${CF_API_BASE}/accounts/${accountId}/workers/subdomain`, { enabled: true }, { headers: getHeaders(apiToken) || getHeadersWithGlobalKey(email, globalKey) });
            await bot.sendMessage(chatId, "✅ Workers.dev subdomain enabled!");
        } catch (subdomainError) {
            await bot.sendMessage(chatId, "⚠️ Subdomain configuration failed - please enable workers.dev manually.");
        }

        // Step 5: Create KV namespace
        await bot.sendMessage(chatId, "🗄️ Creating KV namespace...");
        const kvResponse = await axios.post(`${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces`, { title: `${workerName}-kv` }, { headers: getHeaders(apiToken) || getHeadersWithGlobalKey(email, globalKey) });
        if (!kvResponse.data.success) throw new Error('Failed to create KV namespace.');
        const kvNamespaceId = kvResponse.data.result.id;
        await bot.sendMessage(chatId, "✅ KV namespace created!");

        // Step 6: Get worker URL and wait
        const workerUrl = `https://${workerName}.${accountId.slice(0, 8)}.workers.dev`;
        await bot.sendMessage(chatId, `🔗 Worker URL: ${workerUrl}\n⏳ Waiting for worker to initialize...`);
        await sleep(30000);

        // Step 7: Fetch credentials from the panel's secret generator
        await bot.sendMessage(chatId, "🔍 Fetching credentials from BPB panel's secret generator...");
        const secretsResponse = await axios.get(`${workerUrl}/secrets`, { timeout: 15000 });
        const uuidMatch = secretsResponse.data.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        const trojanMatch = secretsResponse.data.match(/Random Trojan Password<[^>]+>([^<]+)/);
        if (!uuidMatch || !trojanMatch) throw new Error("Could not parse credentials from the panel's /secrets page.");
        const uuid = uuidMatch[0];
        const trojanPass = trojanMatch[1].trim();
        await bot.sendMessage(chatId, `✅ Fetched credentials from panel:\n🆔 UUID: \`${uuid}\`\n🔒 Trojan Pass: \`${trojanPass}\``, { parse_mode: 'Markdown' });

        // Step 8: Set Secrets and Bindings
        await bot.sendMessage(chatId, "⚙️ Setting secrets and binding KV namespace...");
        const settingsPayload = {
            "bindings": [{ "type": "kv_namespace", "name": "kv", "namespace_id": kvNamespaceId }],
            "secrets": [{ "name": "UUID", "text": uuid, "type": "secret_text" }, { "name": "TR_PASS", "text": trojanPass, "type": "secret_text" }]
        };
        const form = new FormData();
        form.append('metadata', JSON.stringify(settingsPayload), { contentType: 'application/json' });
        const settingsResponse = await axios.put(`${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`, form, { headers: { ...createHeaders, ...form.getHeaders() } });
        if (!settingsResponse.data.success) throw new Error('Failed to set secrets and bindings.');
        await bot.sendMessage(chatId, "✅ Secrets and bindings configured successfully!");

        // Step 9: Final wait and result
        await bot.sendMessage(chatId, "⏳ Final wait for BPB panel to be fully configured...");
        await sleep(30000);

        const panelUrl = `${workerUrl}/panel`;
        const escapedUuid = uuid.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
        const escapedTrojanPass = trojanPass.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
        const escapedWorkerName = workerName.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
        const successMessage = `🎉 *BPB Worker Panel Deployed Successfully\\!*
🌐 *Panel URL:* ${panelUrl}
🔧 *Credentials:*
🆔 UUID: \`${escapedUuid}\`
🔒 Trojan Pass: \`${escapedTrojanPass}\`
📋 *Worker Info:*
📛 Name: \`${escapedWorkerName}\`
🔗 Worker URL: ${workerUrl}
🗄️ KV Namespace: \`${escapedWorkerName}-kv\`
✅ *Setup Complete\\!* Your BPB Worker Panel is ready to use\\.
🔒 *Security Note:* Your Cloudflare credentials have been deleted from memory for security\\.`;
        await bot.sendMessage(chatId, successMessage, { parse_mode: 'MarkdownV2' });

    } catch (error) {
        console.error('Deployment error:', error);
        let errorDetails = error.message;
        if (error.response?.data) {
            errorDetails += `\nCloudflare API: ${JSON.stringify(error.response.data.errors || error.response.data)}`;
        }
        await bot.sendMessage(chatId, `❌ **Deployment failed:**\n\`${errorDetails}\`\n\nPlease check your credentials and permissions, then start over with /automation.`, { parse_mode: 'Markdown' });
    } finally {
        cleanupSession(chatId);
    }
}

// --- NEW CONVERSATIONAL WIZARD LOGIC ---

// Start the automation wizard
bot.onText(/\/automation/, (msg) => {
    const chatId = msg.chat.id;
    userSessions.set(chatId, { state: 'awaiting_auth_method' });
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔑 Use API Token (Recommended)", callback_data: "auth_token" }],
            [{ text: "✉️ Use Global Key & Email", callback_data: "auth_global_key" }]
        ]
    };
    bot.sendMessage(chatId, "🔧 **BPB Worker Panel Deployment**\n\nHow would you like to authenticate with Cloudflare?", { reply_markup: keyboard });
});

// Handle button presses from the inline keyboard
bot.on('callback_query', (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const session = userSessions.get(chatId) || {};

    // Acknowledge the button press
    bot.answerCallbackQuery(callbackQuery.id);
    
    // Clear the buttons from the previous message
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: callbackQuery.message.message_id });

    if (data === 'auth_token') {
        session.state = 'awaiting_account_id';
        session.authMethod = 'token';
        userSessions.set(chatId, session);
        bot.sendMessage(chatId, "Ok, you chose API Token.\n\nFirst, please send me your **Cloudflare Account ID**.");
    } else if (data === 'auth_global_key') {
        session.state = 'awaiting_account_id';
        session.authMethod = 'global_key';
        userSessions.set(chatId, session);
        bot.sendMessage(chatId, "Ok, you chose Global Key.\n\nFirst, please send me your **Cloudflare Account ID**.");
    } else if (data === 'confirm_deploy') {
        bot.sendMessage(chatId, "✅ Confirmation received! Starting the deployment process now...");
        deployBPBWorker(chatId);
    } else if (data === 'cancel_deploy') {
        cleanupSession(chatId);
        bot.sendMessage(chatId, "Deployment cancelled. You can start over anytime with /automation.");
    }
});

// Handle text messages based on the user's current state
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return; // Ignore commands

    const session = userSessions.get(chatId);
    if (!session || !session.state) return; // Ignore messages if not in a session

    // Delete the user's message containing sensitive info
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    switch (session.state) {
        case 'awaiting_account_id':
            session.accountId = text.trim();
            if (session.authMethod === 'token') {
                session.state = 'awaiting_api_token';
                bot.sendMessage(chatId, "✅ Account ID received.\n\nNow, please send me your **Cloudflare API Token**.");
            } else {
                session.state = 'awaiting_email';
                bot.sendMessage(chatId, "✅ Account ID received.\n\nNow, please send me your **Cloudflare Email Address**.");
            }
            userSessions.set(chatId, session);
            break;

        case 'awaiting_api_token':
            session.apiToken = text.trim();
            session.state = 'ready_to_deploy';
            userSessions.set(chatId, session);
            askForConfirmation(chatId);
            break;

        case 'awaiting_email':
            session.email = text.trim();
            session.state = 'awaiting_global_key';
            userSessions.set(chatId, session);
            bot.sendMessage(chatId, "✅ Email received.\n\nFinally, please send me your **Global API Key**.");
            break;

        case 'awaiting_global_key':
            session.globalKey = text.trim();
            session.state = 'ready_to_deploy';
            userSessions.set(chatId, session);
            askForConfirmation(chatId);
            break;
    }
});

// Final confirmation function
function askForConfirmation(chatId) {
    const session = userSessions.get(chatId);
    if (!session) return;

    const keyboard = {
        inline_keyboard: [
            [{ text: "🚀 Yes, Deploy Now!", callback_data: "confirm_deploy" }],
            [{ text: "❌ Cancel", callback_data: "cancel_deploy" }]
        ]
    };

    bot.sendMessage(chatId, `**Ready to Deploy?**\n\nI will now deploy a BPB Worker to your Cloudflare account (\`${session.accountId}\`).\n\nPlease confirm to proceed.`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
}


// --- EXISTING COMMANDS & VERIFICATION (No changes needed) ---

async function verifyCloudflareCredentials(apiToken, accountId, email = null, globalKey = null) {
    try {
        let headers;
        if (email && globalKey) {
            headers = getHeadersWithGlobalKey(email, globalKey);
        } else {
            headers = getHeaders(apiToken);
            const tokenResponse = await axios.get(`${CF_API_BASE}/user/tokens/verify`, { headers });
            if (!tokenResponse.data.success) return { valid: false, error: 'Invalid API token' };
        }
        const accountResponse = await axios.get(`${CF_API_BASE}/accounts/${accountId}`, { headers });
        if (!accountResponse.data.success) return { valid: false, error: 'Invalid Account ID or no access' };
        return { valid: true };
    } catch (error) {
        return { valid: false, error: error.response?.data?.errors?.[0]?.message || 'API verification failed' };
    }
}

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `🤖 **BPB Worker Automation Bot**\n\nWelcome! This bot helps you automatically deploy BPB Worker Panel on your Cloudflare account.\n\n🚀 **Ready to start?** Use the /automation command!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `📖 **Help & Setup Instructions**\n\nThis bot will guide you through the setup process when you use the /automation command. It will ask for your Cloudflare credentials step-by-step.\n\n**Required Permissions for API Token:**\n• Account: Workers Scripts - Edit\n• Account: Workers KV Storage - Edit\n• Account: Account Settings - Edit\n• Account: Workers Subdomain - Edit`, { parse_mode: 'Markdown' });
});

bot.on('polling_error', (error) => console.error('Polling error:', error.code));

console.log('🤖 BPB Automation Bot is running...');