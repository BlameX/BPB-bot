// Replace the old deployBPBWorker function in your index.js with this one.
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

        // Step 3: Create the worker using the CORRECT multipart/form-data method for ES Modules
        await bot.sendMessage(chatId, "⚡ Creating Cloudflare Worker...");
        const createHeaders = apiToken
            ? { 'Authorization': `Bearer ${apiToken}` }
            : { 'X-Auth-Email': email, 'X-Auth-Key': globalKey };
        
        const form = new FormData();
        // This metadata tells Cloudflare that the main script file is named 'worker.js'
        const metadata = {
            main_module: 'worker.js'
        };
        form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });
        // This part attaches the actual code
        form.append('worker.js', workerCode, { contentType: 'application/javascript+module' });
        
        const createWorkerResponse = await axios.put(
            `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`,
            form,
            { headers: { ...createHeaders, ...form.getHeaders() } }
        );

        if (!createWorkerResponse.data.success) {
            throw new Error('Failed to create worker: ' + JSON.stringify(createWorkerResponse.data.errors));
        }

        await bot.sendMessage(chatId, "✅ Worker created successfully!");

        // The rest of the function remains the same...
        // Step 4: Enable workers.dev subdomain (best effort)
        try {
            await bot.sendMessage(chatId, "🌐 Enabling workers.dev subdomain...");
            const subdomainHeaders = apiToken ? getHeaders(apiToken) : getHeadersWithGlobalKey(email, globalKey);
            await axios.put(`${CF_API_BASE}/accounts/${accountId}/workers/subdomain`, { enabled: true }, { headers: subdomainHeaders });
            await bot.sendMessage(chatId, "✅ Workers.dev subdomain enabled!");
        } catch (subdomainError) {
            await bot.sendMessage(chatId, "⚠️ Subdomain configuration failed - please enable workers.dev manually.");
        }

        // Step 5: Create KV namespace
        await bot.sendMessage(chatId, "🗄️ Creating KV namespace...");
        const kvHeaders = apiToken ? getHeaders(apiToken) : getHeadersWithGlobalKey(email, globalKey);
        const kvResponse = await axios.post(`${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces`, { title: `${workerName}-kv` }, { headers: kvHeaders });
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
        const settingsForm = new FormData();
        settingsForm.append('metadata', JSON.stringify(settingsPayload), { contentType: 'application/json' });
        const settingsResponse = await axios.put(`${CF_API_BASE}/accounts/${accountId}/workers/scripts/${workerName}`, settingsForm, { headers: { ...createHeaders, ...settingsForm.getHeaders() } });
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