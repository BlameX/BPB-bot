const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;

// Cloudflare API base URL
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// Create bot instance
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Store user sessions (in memory - for production use Redis)
const userSessions = new Map();

// Generate random UUID
function generateUUID() {
    return crypto.randomUUID();
}

// Generate random Trojan password
function generateTrojanPassword() {
    return crypto.randomBytes(16).toString('hex');
}

// Sleep function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Clean up user session
function cleanupSession(userId) {
    if (userSessions.has(userId)) {
        userSessions.delete(userId);
    }
}

// Headers for Cloudflare API
const getHeaders = (apiToken) => ({
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json'
});

// Headers for Cloudflare API using Global API Key
const getHeadersWithGlobalKey = (email, globalKey) => ({
    'X-Auth-Email': email,
    'X-Auth-Key': globalKey,
    'Content-Type': 'application/json'
});

// Verify Cloudflare credentials
async function verifyCloudflareCredentials(apiToken, accountId, email = null, globalKey = null) {
    try {
        let headers;
        if (email && globalKey) {
            headers = getHeadersWithGlobalKey(email, globalKey);
        } else {
            headers = getHeaders(apiToken);
            // Test API token validity
            const tokenResponse = await axios.get(
                `${CF_API_BASE}/user/tokens/verify`,
                { headers }
            );

            if (!tokenResponse.data.success) {
                return { valid: false, error: 'Invalid API token' };
            }
        }

        // Test account access
        const accountResponse = await axios.get(
            `${CF_API_BASE}/accounts/${accountId}`,
            { headers }
        );

        if (!accountResponse.data.success) {
            return { valid: false, error: 'Invalid Account ID or no access' };
        }

        return { valid: true };
    } catch (error) {
        return { valid: false, error: error.response?.data?.errors?.[0]?.message || 'API verification failed' };
    }
}

// Main automation function
async function deployBPBWorker(chatId, accountId, apiToken = null, email = null, globalKey = null) {
    try {
        await bot.sendMessage(chatId, "🔍 Verifying your Cloudflare credentials...");
        
        const verification = await verifyCloudflareCredentials(apiToken, accountId, email, globalKey);
        if (!verification.valid) {
            throw new Error(`Credential verification failed: ${verification.error}`);
        }

        await bot.sendMessage(chatId, "✅ Credentials verified! Starting BPB Worker deployment...");

        // Step 1: Generate worker name (Cloudflare requires lowercase and hyphens only)
        const timestamp = Date.now();
        const workerName = `bpb-worker-${timestamp}`.toLowerCase();
        await bot.sendMessage(chatId, `📝 Worker name: ${workerName}`);

        // Step 2: Download worker.js code
        await bot.sendMessage(chatId, "📥 Downloading worker.js code...");
        const workerCodeResponse = await axios.get('https://github.com/bia-pain-bache/BPB-Worker-Panel/releases/download/v3.5.6/worker.js');
        const workerCode = workerCodeResponse.data;
        
        // Validate downloaded code
        if (!workerCode || workerCode.length < 100) {
            throw new Error('Downloaded worker code is invalid or too short');
        }
        
        console.log('Downloaded worker code:', {
            length: workerCode.length,
            startsWithExport: workerCode.includes('export'),
            startsWithFunction: workerCode.includes('function'),
            preview: workerCode.substring(0, 200) + '...'
        });

        // Step 3: Create the worker using multipart form data
        await bot.sendMessage(chatId, "⚡ Creating Cloudflare Worker...");
        
        const form = new FormData();
        // Add metadata
        form.append('metadata', JSON.stringify({
            main_module: 'worker.js',
            compatibility_date: '2023-05-18'
        }), {
            contentType: 'application/json'
        });
        
        // Add the worker code
        form.append('worker.js', workerCode, {
            contentType: 'application/javascript+module'
        });
        
        let headers;
        if (email && globalKey) {
            headers = {
                'X-Auth-Email': email,
                'X-Auth-Key': globalKey,
                ...form.getHeaders()
            };
        } else {
            headers = {
                'Authorization': `Bearer ${apiToken}`,
                ...form.getHeaders()
            };
        }

        try {
            const createWorkerResponse = await axios.put(
                `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`,
                form,
                { headers }
            );

            if (!createWorkerResponse.data.success) {
                console.log('Worker creation failed:', createWorkerResponse.data);
                throw new Error('Failed to create worker: ' + JSON.stringify(createWorkerResponse.data.errors));
            }
        } catch (workerError) {
            console.log('Worker creation error:', workerError.message);
            if (workerError.response) {
                console.log('Worker creation error response:', workerError.response.data);
                console.log('Worker creation error status:', workerError.response.status);
            }
            throw new Error('Failed to create worker: ' + workerError.message);
        }

        await bot.sendMessage(chatId, "✅ Worker created successfully!");

        // Step 4: Enable workers.dev subdomain
        await bot.sendMessage(chatId, "🌐 Enabling workers.dev subdomain...");
        
        try {
            const subdomainResponse = await axios.put(
                `${CF_API_BASE}/accounts/${accountId}/workers/subdomain`,
                { enabled: true },
                { headers: (email && globalKey) ? getHeadersWithGlobalKey(email, globalKey) : getHeaders(apiToken) }
            );

            if (subdomainResponse.data.success) {
                await bot.sendMessage(chatId, "✅ Workers.dev subdomain enabled!");
            } else {
                console.log('Subdomain enable failed:', subdomainResponse.data.errors);
                await bot.sendMessage(chatId, "⚠️ Subdomain API failed - please enable workers.dev manually in Cloudflare dashboard");
            }
        } catch (subdomainError) {
            console.log('Subdomain enable error:', {
                message: subdomainError.message,
                response: subdomainError.response?.data,
                status: subdomainError.response?.status
            });
            await bot.sendMessage(chatId, "⚠️ Subdomain configuration failed - please enable workers.dev manually in Cloudflare dashboard");
        }

        // Step 5: Create KV namespace
        await bot.sendMessage(chatId, "🗄️ Creating KV namespace...");
        const kvResponse = await axios.post(
            `${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces`,
            { title: `${workerName}-kv` },
            { headers: (email && globalKey) ? getHeadersWithGlobalKey(email, globalKey) : getHeaders(apiToken) }
        );

        if (!kvResponse.data.success) {
            throw new Error('Failed to create KV namespace: ' + JSON.stringify(kvResponse.data.errors));
        }

        const kvNamespaceId = kvResponse.data.result.id;
        await bot.sendMessage(chatId, "✅ KV namespace created!");

        // Step 6: Generate credentials that the worker will use
        await bot.sendMessage(chatId, "🔐 Generating credentials for BPB panel...");
        
        const uuid = generateUUID();
        const trojanPass = generateTrojanPassword();
        
        await bot.sendMessage(chatId, `🔐 Generated credentials:\n🆔 UUID: \`${uuid}\`\n🔒 Trojan Pass: \`${trojanPass}\``, { parse_mode: 'Markdown' });

        // Step 7: Set Secrets and Bindings using the "Wizard Method" - single multipart request
        await bot.sendMessage(chatId, "⚙️ Setting secrets and binding KV namespace...");
        
        try {
            const settingsPayload = {
                "body_part": "script_settings",
                "bindings": [
                    {
                        "type": "kv_namespace",
                        "name": "kv",
                        "namespace_id": kvNamespaceId
                    }
                ],
                "secrets": [
                    {
                        "name": "UUID",
                        "text": uuid,
                        "type": "secret_text"
                    },
                    {
                        "name": "TR_PASS",
                        "text": trojanPass,
                        "type": "secret_text"
                    }
                ]
            };

            const multiPartHeaders = (email && globalKey) ? {
                'X-Auth-Email': email,
                'X-Auth-Key': globalKey,
            } : {
                'Authorization': `Bearer ${apiToken}`,
            };

            const settingsForm = new FormData();
            settingsForm.append('script_settings', JSON.stringify(settingsPayload), { contentType: 'application/json' });
            
            const settingsResponse = await axios.put(
                `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`,
                settingsForm,
                { headers: { ...multiPartHeaders, ...settingsForm.getHeaders() } }
            );

            if (!settingsResponse.data.success) {
                throw new Error('Failed to set secrets and bindings: ' + JSON.stringify(settingsResponse.data.errors));
            }

            await bot.sendMessage(chatId, "✅ Secrets and bindings configured successfully!");

        } catch (settingsError) {
            console.log('Settings configuration failed:', settingsError.message);
            if (settingsError.response) {
                console.log('Settings error response:', settingsError.response.data);
            }
            await bot.sendMessage(chatId, `❌ Automatic configuration failed. Please set manually:\n🆔 UUID: \`${uuid}\`\n🔒 TR_PASS: \`${trojanPass}\``, { parse_mode: 'Markdown' });
        }

        // Step 9: Get worker URL and wait for it to be ready
        const workerUrl = `https://${workerName}.${accountId.slice(0, 8)}.workers.dev`;
        const panelUrl = `${workerUrl}/panel`;
        
        await bot.sendMessage(chatId, `🔗 Worker URL: ${workerUrl}`);
        await bot.sendMessage(chatId, "⏳ Waiting for worker to initialize...");
        await sleep(30000); // Wait 30 seconds

        // Step 10: Send final result (escape special characters for Telegram)
        const escapedUuid = uuid.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        const escapedTrojanPass = trojanPass.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        const escapedWorkerName = workerName.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        
        const successMessage = `
🎉 *BPB Worker Panel Deployed Successfully\\!*

🌐 *Panel URL:* ${panelUrl}

🔧 *Credentials:*
🆔 UUID: \`${escapedUuid}\`
🔒 Trojan Pass: \`${escapedTrojanPass}\`

📋 *Worker Info:*
📛 Name: ${escapedWorkerName}
🔗 Worker URL: ${workerUrl}
🗄️ KV Namespace: ${escapedWorkerName}\\-kv

⚠️ *Important Notes:*
• The panel may take 2\\-3 minutes to fully initialize
• If the panel shows an error initially, wait a few minutes and refresh
• Save your credentials securely \\- I won't store them
• You can access the panel anytime using the Panel URL

✅ *Setup Complete\\!* Your BPB Worker Panel is ready to use\\.

🔒 *Security Note:* Your Cloudflare credentials have been deleted from memory for security\\.
        `;

        await bot.sendMessage(chatId, successMessage, { parse_mode: 'MarkdownV2' });

    } catch (error) {
        console.error('Deployment error:', error);
        
        // Get more detailed error information
        let errorDetails = error.message;
        if (error.response?.data) {
            errorDetails += '\n\nCloudflare API Response: ' + JSON.stringify(error.response.data, null, 2);
        }
        if (error.response?.status) {
            errorDetails += '\n\nHTTP Status: ' + error.response.status;
        }
        
        console.error('Full error details:', errorDetails);
        await bot.sendMessage(chatId, `❌ **Deployment failed:** ${error.message}\n\nPlease check your Cloudflare API token and account ID.`, { parse_mode: 'Markdown' });
    } finally {
        // Always clean up credentials
        cleanupSession(chatId);
    }
}

// Handle /automation command
bot.onText(/\/automation/, (msg) => {
    const chatId = msg.chat.id;
    
    const instructionsMessage = `
🔧 **BPB Worker Panel Deployment**

To deploy your BPB Worker Panel, you can use either an API Token or your Global API Key.

***METHOD 1: API Token (Recommended)***
Please send your credentials in this format:
\`\`\`
API_TOKEN: your_token_here
ACCOUNT_ID: your_account_id_here
\`\`\`

***METHOD 2: Global API Key (Easier)***
Please send your credentials in this format:
\`\`\`
EMAIL: your_cloudflare_email
GLOBAL_KEY: your_global_api_key
ACCOUNT_ID: your_account_id_here
\`\`\`

📋 **Required API Token Permissions:**
1️⃣ **Workers Scripts**: Edit
2️⃣ **Workers KV Storage**: Edit
3️⃣ **Account Settings**: Edit
4️⃣ **Workers Sub/Pub**: Edit
5️⃣ **Zone**: DNS - Edit

📝 **How to get your credentials:**
1. Go to dash.cloudflare.com
2. Find your Account ID on the right sidebar.
3. For an API Token, go to My Profile -> API Tokens.
4. For the Global Key, find it at the bottom of the API Tokens page.

⚡ **Ready?** Please send your full credentials in one message.
    `;
    
    bot.sendMessage(chatId, instructionsMessage, { parse_mode: 'Markdown' });
    
    // Set user in waiting state
    userSessions.set(chatId, { 
        state: 'waiting_credentials',
        timestamp: Date.now()
    });
});

// Handle credential input
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!text || text.startsWith('/')) return;
    
    const session = userSessions.get(chatId);
    if (!session || session.state !== 'waiting_credentials') return;
    
    try {
        // Parse credentials
        let apiToken = null;
        let accountId = null;
        let email = null;
        let globalKey = null;

        const lines = text.split('\n');
        for (const line of lines) {
            if (line.includes('API_TOKEN:')) {
                apiToken = line.split('API_TOKEN:')[1].trim();
            }
            if (line.includes('ACCOUNT_ID:')) {
                accountId = line.split('ACCOUNT_ID:')[1].trim();
            }
            if (line.includes('EMAIL:')) {
                email = line.split('EMAIL:')[1].trim();
            }
            if (line.includes('GLOBAL_KEY:')) {
                globalKey = line.split('GLOBAL_KEY:')[1].trim();
            }
        }
        
        if (accountId && (apiToken || (email && globalKey))) {
            // Delete the user's message containing credentials
            bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            
            bot.sendMessage(chatId, "🔒 Credentials received and deleted from chat for security. Starting deployment...");
            deployBPBWorker(chatId, accountId, apiToken, email, globalKey);
        } else {
            bot.sendMessage(chatId, "❌ Please send all required credentials in the correct format.", { parse_mode: 'Markdown' });
        }
        
    } catch (error) {
        bot.sendMessage(chatId, "❌ Error parsing credentials. Please try again with the correct format.");
    }
});

// Handle /start command
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `
🤖 **BPB Worker Automation Bot**

Welcome! This bot helps you automatically deploy BPB Worker Panel on your Cloudflare account.

📋 **Available Commands:**
/automation - Deploy a new BPB Worker Panel
/help - Show help and setup instructions

⚡ **What this bot does:**
• Creates a Cloudflare Worker in YOUR account
• Downloads and deploys BPB Worker Panel code
• Creates and binds KV namespace
• Generates UUID and Trojan password
• Sets up environment variables
• Provides you with the final panel URL

🔒 **Privacy & Security:**
• Your Cloudflare credentials are used only during deployment
• Credentials are immediately deleted after use
• Never stored or logged anywhere
• Only you get access to your panel

🚀 **Ready to start?** Use /automation command!
    `;
    
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// Handle /help command
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
📖 **Help & Setup Instructions**

🔧 **Before using /automation, you need:**

1️⃣ **Cloudflare API Token:**
   • Go to: https://dash.cloudflare.com/profile/api-tokens
   • Click "Create Token"
   • Use "Custom token"
   • Add permissions:
     - Account: Workers Scripts - Edit
     - Account: Workers KV Storage - Edit
     - Account: Account Settings - Read
     - Account: Workers Sub/Pub - Edit
   • Include: All accounts

2️⃣ **Cloudflare Account ID:**
   • Go to your Cloudflare dashboard
   • Account ID is shown in the right sidebar
   • Copy the ID (looks like: a1b2c3d4e5f6...)

🚀 **Commands:**
/start - Welcome message
/automation - Start BPB deployment
/help - This help message

⚠️ **Important:**
• Free Cloudflare accounts work perfectly
• Your credentials are never stored
• Each deployment creates a new worker
• The panel takes 2-3 minutes to fully load

❓ **Troubleshooting:**
• Make sure API token has correct permissions
• Account ID should be from the same account as the token
• Wait a few minutes for panel to initialize after deployment

🔒 **Security:** This bot never stores your credentials. They're used once and immediately deleted.
    `;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Clean up old sessions every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [chatId, session] of userSessions.entries()) {
        // Remove sessions older than 10 minutes
        if (now - session.timestamp > 10 * 60 * 1000) {
            userSessions.delete(chatId);
        }
    }
}, 10 * 60 * 1000);

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

console.log('🤖 BPB Automation Bot is running...');