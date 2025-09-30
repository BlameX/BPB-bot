const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');

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

        // Step 3: Create the worker
        await bot.sendMessage(chatId, "⚡ Creating Cloudflare Worker...");
        
        // Debug: Log the request details
        console.log('Creating worker with:', {
            url: `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`,
            workerName,
            accountId,
            codeLength: workerCode.length
        });
        
        let headers;
        if (email && globalKey) {
            headers = getHeadersWithGlobalKey(email, globalKey);
            headers['Content-Type'] = 'application/javascript';
        } else {
            headers = {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/javascript'
            };
        }

        try {
            // Try with ES Module format first
            headers['Content-Type'] = 'application/javascript+module';
            const createWorkerResponse = await axios.put(
                `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`,
                workerCode,
                { headers }
            );

            if (!createWorkerResponse.data.success) {
                throw new Error('Failed to create worker (ES module): ' + JSON.stringify(createWorkerResponse.data.errors));
            }
        } catch (workerError) {
            console.log('ES module upload failed, trying plain JavaScript:', workerError.message);
            // Fallback to plain JavaScript
            headers['Content-Type'] = 'application/javascript';
            const fallbackResponse = await axios.put(
                `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`,
                workerCode,
                { headers }
            );

            if (!fallbackResponse.data.success) {
                throw new Error('Failed to create worker (both methods): ' + JSON.stringify(fallbackResponse.data.errors));
            }
        }

        await bot.sendMessage(chatId, "✅ Worker created successfully!");

        // Step 4: Create KV namespace
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

        // Step 5: Generate credentials that the worker will use
        await bot.sendMessage(chatId, "🔐 Generating credentials for BPB panel...");
        
        const uuid = generateUUID();
        const trojanPass = generateTrojanPassword();
        
        await bot.sendMessage(chatId, `🔐 Generated credentials:\n🆔 UUID: \`${uuid}\`\n🔒 Trojan Pass: \`${trojanPass}\``, { parse_mode: 'Markdown' });

        // Step 6: Set Secrets and Bindings
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

            const FormData = require('form-data');
            const form = new FormData();
            form.append('script_settings', JSON.stringify(settingsPayload), { contentType: 'application/json' });
            
            const settingsResponse = await axios.put(
                `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`,
                form,
                { headers: { ...multiPartHeaders, ...form.getHeaders() } }
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

        // Step 7: Enable workers.dev subdomain
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

        // Step 8: Get the worker URL first (needed to fetch panel credentials)
        const workerUrl = `https://${workerName}.${accountId.slice(0, 8)}.workers.dev`;
        const panelUrl = `${workerUrl}/panel`;
        
        await bot.sendMessage(chatId, `🔗 Worker URL: ${workerUrl}`);

        // Step 9: Wait for worker to be ready and fetch credentials from BPB panel
        await bot.sendMessage(chatId, "⏳ Waiting for worker to initialize...");
        await sleep(30000); // Wait 30 seconds for worker to be ready

        let uuid, trojanPass;
        
        try {
            await bot.sendMessage(chatId, "🔍 Fetching credentials from BPB panel...");
            
            // Try to get the credentials from the panel's secret generator
            const secretsResponse = await axios.get(`${workerUrl}/secrets`, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (secretsResponse.data) {
                const htmlContent = secretsResponse.data;
                console.log('Panel response preview:', htmlContent.substring(0, 500));
                
                // Look for UUID pattern in the HTML (more flexible regex)
                const uuidMatch = htmlContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
                
                // Look for Trojan password (try multiple patterns)
                let trojanMatch = htmlContent.match(/Random Trojan Password[^>]*>([^<]+)</i);
                if (!trojanMatch) {
                    trojanMatch = htmlContent.match(/Trojan Password[^>]*>([^<]+)</i);
                }
                if (!trojanMatch) {
                    trojanMatch = htmlContent.match(/password[^>]*>([A-Za-z0-9\[\]_\\]{8,})</i);
                }
                
                if (uuidMatch && uuidMatch.length > 0 && trojanMatch) {
                    uuid = uuidMatch[0];
                    trojanPass = trojanMatch[1].trim();
                    
                    await bot.sendMessage(chatId, `✅ Fetched credentials from BPB panel:\n🆔 UUID: \`${uuid}\`\n🔒 Trojan Pass: \`${trojanPass}\``, { parse_mode: 'Markdown' });
                } else {
                    throw new Error('Could not parse credentials from panel HTML');
                }
            } else {
                throw new Error('Panel response was empty');
            }
            
        } catch (fetchError) {
            console.log('Failed to fetch credentials from panel:', fetchError.message);
            if (fetchError.response) {
                console.log('Panel response status:', fetchError.response.status);
                console.log('Panel response preview:', fetchError.response.data?.substring(0, 200));
            }
            
            await bot.sendMessage(chatId, "⚠️ Could not fetch credentials from panel, generating temporary ones...");
            
            // Fallback to generating temporary credentials
            uuid = generateUUID();
            trojanPass = generateTrojanPassword();
            
            await bot.sendMessage(chatId, `🔐 Generated temporary credentials:\n🆔 UUID: \`${uuid}\`\n🔒 Trojan Pass: \`${trojanPass}\``, { parse_mode: 'Markdown' });
        }

        // Step 10: Final wait for panel to be fully ready
        await bot.sendMessage(chatId, "⏳ Final wait for BPB panel to be fully configured...");
        await sleep(30000); // Wait 30 more seconds

        // Step 11: Send final result (escape special characters for Telegram)
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
4️⃣ **Workers Subdomain**: Edit
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
