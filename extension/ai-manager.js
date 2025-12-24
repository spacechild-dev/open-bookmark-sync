/**
 * AI Manager - Core module for AI-powered bookmark organization
 * Supports multiple AI providers: Claude, OpenAI, Gemini
 */

class AIManager {
    constructor() {
        this.provider = null;
        this.config = null;
    }

    /**
     * Initialize AI manager with stored configuration
     */
    async initialize() {
        const { provider, config } = await this.getConfig();
        if (provider && config) {
            this.provider = provider;
            this.config = config;
            return true;
        }
        return false;
    }

    /**
     * Save AI configuration for a specific provider
     */
    async saveConfig(provider, apiKey, model) {
        // Save current provider
        await chrome.storage.local.set({ aiProvider: provider });

        // Save provider-specific config
        const providerConfigKey = `aiConfig_${provider}`;
        const config = {
            apiKey,
            model,
            savedAt: new Date().toISOString()
        };

        await chrome.storage.local.set({
            [providerConfigKey]: config
        });

        this.provider = provider;
        this.config = config;
    }

    /**
     * Get stored configuration for current or specific provider
     */
    async getConfig(provider = null) {
        const stored = await chrome.storage.local.get(['aiProvider']);
        const currentProvider = provider || stored.aiProvider;

        if (!currentProvider) {
            return { provider: null, config: null };
        }

        const providerConfigKey = `aiConfig_${currentProvider}`;
        const configData = await chrome.storage.local.get([providerConfigKey]);

        return {
            provider: currentProvider,
            config: configData[providerConfigKey] || null
        };
    }

    /**
     * Get all saved provider configs
     */
    async getAllConfigs() {
        const data = await chrome.storage.local.get(null);
        const configs = {};

        for (const key in data) {
            if (key.startsWith('aiConfig_')) {
                const provider = key.replace('aiConfig_', '');
                configs[provider] = data[key];
            }
        }

        return configs;
    }

    /**
     * Test AI connection
     */
    async testConnection() {
        if (!this.provider || !this.config) {
            throw new Error('AI provider not configured');
        }

        const adapter = this.getAdapter();
        return await adapter.test();
    }

    /**
     * Get appropriate adapter for current provider
     */
    getAdapter() {
        switch (this.provider) {
            case 'claude':
                return new ClaudeAdapter(this.config);
            case 'openai':
                return new OpenAIAdapter(this.config);
            case 'gemini':
                return new GeminiAdapter(this.config);
            default:
                throw new Error(`Unknown provider: ${this.provider}`);
        }
    }

    /**
     * Analyze bookmarks with AI
     */
    async analyzeBookmarks(bookmarks, options = {}) {
        if (!this.provider || !this.config) {
            throw new Error('AI provider not configured');
        }

        const adapter = this.getAdapter();
        const results = {
            domains: [],
            topics: [],
            similar: [],
            duplicates: [],
            broken: []
        };

        // Domain grouping (can be done locally, fast)
        if (options.analyzeDomain) {
            results.domains = this.groupByDomain(bookmarks);
        }

        // AI-powered analyses
        const aiAnalyses = [];

        if (options.analyzeTopic) {
            aiAnalyses.push(this.analyzeTopics(bookmarks, adapter));
        }

        if (options.analyzeSimilar) {
            aiAnalyses.push(this.findSimilar(bookmarks, adapter));
        }

        if (options.analyzeDuplicates) {
            results.duplicates = this.findDuplicates(bookmarks);
        }

        if (options.analyzeBroken) {
            aiAnalyses.push(this.checkBrokenLinks(bookmarks));
        }

        // Run AI analyses in parallel where possible
        const aiResults = await Promise.all(aiAnalyses);

        if (options.analyzeTopic) results.topics = aiResults[0];
        if (options.analyzeSimilar) results.similar = aiResults[options.analyzeTopic ? 1 : 0];

        return results;
    }

    /**
     * Group bookmarks by domain (local analysis, no AI needed)
     */
    groupByDomain(bookmarks) {
        const groups = {};

        bookmarks.forEach(bookmark => {
            try {
                const url = new URL(bookmark.url);
                const domain = url.hostname.replace(/^www\./, '');

                if (!groups[domain]) {
                    groups[domain] = {
                        domain,
                        count: 0,
                        bookmarks: []
                    };
                }

                groups[domain].count++;
                groups[domain].bookmarks.push(bookmark);
            } catch (e) {
                // Invalid URL, skip
            }
        });

        // Convert to array and sort by count
        return Object.values(groups)
            .sort((a, b) => b.count - a.count)
            .filter(g => g.count > 1); // Only show domains with multiple bookmarks
    }

    /**
     * Analyze topics using AI
     */
    async analyzeTopics(bookmarks, adapter) {
        // Prepare bookmark data for AI
        const bookmarkData = bookmarks.map(b => ({
            id: b.id,
            title: b.title,
            url: b.url
        }));

        const prompt = `Analyze these bookmarks and categorize them into topics.
Group similar bookmarks together and suggest folder names.
Return a JSON array with this structure:
[
  {
    "topic": "Topic Name",
    "description": "Brief description",
    "bookmarkIds": ["id1", "id2"],
    "suggestedFolder": "Folder/Subfolder"
  }
]

Bookmarks:
${JSON.stringify(bookmarkData, null, 2)}`;

        const response = await adapter.analyze(prompt);
        return this.parseAIResponse(response);
    }

    /**
     * Find similar bookmarks using AI
     */
    async findSimilar(bookmarks, adapter) {
        const bookmarkData = bookmarks.map(b => ({
            id: b.id,
            title: b.title,
            url: b.url
        }));

        const prompt = `Find groups of similar/related bookmarks.
Return a JSON array with this structure:
[
  {
    "groupName": "Group description",
    "reason": "Why these are similar",
    "bookmarkIds": ["id1", "id2", "id3"]
  }
]

Bookmarks:
${JSON.stringify(bookmarkData, null, 2)}`;

        const response = await adapter.analyze(prompt);
        return this.parseAIResponse(response);
    }

    /**
     * Find duplicate bookmarks (local analysis)
     */
    findDuplicates(bookmarks) {
        const urlMap = {};
        const duplicates = [];

        bookmarks.forEach(bookmark => {
            const normalizedUrl = this.normalizeUrl(bookmark.url);

            if (!urlMap[normalizedUrl]) {
                urlMap[normalizedUrl] = [];
            }

            urlMap[normalizedUrl].push(bookmark);
        });

        // Find URLs with multiple bookmarks
        Object.entries(urlMap).forEach(([url, items]) => {
            if (items.length > 1) {
                duplicates.push({
                    url,
                    count: items.length,
                    bookmarks: items
                });
            }
        });

        return duplicates;
    }

    /**
     * Normalize URL for duplicate detection
     */
    normalizeUrl(url) {
        try {
            const parsed = new URL(url);
            // Remove tracking parameters
            const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
            trackingParams.forEach(param => parsed.searchParams.delete(param));

            // Normalize
            let normalized = parsed.origin + parsed.pathname;
            if (parsed.search) normalized += parsed.search;

            // Remove trailing slash
            return normalized.replace(/\/$/, '');
        } catch (e) {
            return url;
        }
    }

    /**
     * Check for broken links
     */
    async checkBrokenLinks(bookmarks) {
        const broken = [];
        const batchSize = 10;

        for (let i = 0; i < bookmarks.length; i += batchSize) {
            const batch = bookmarks.slice(i, i + batchSize);
            const results = await Promise.all(
                batch.map(b => this.checkUrl(b))
            );
            broken.push(...results.filter(r => r.broken));
        }

        return broken;
    }

    /**
     * Check if URL is accessible
     */
    async checkUrl(bookmark) {
        try {
            const response = await fetch(bookmark.url, {
                method: 'HEAD',
                mode: 'no-cors',
                cache: 'no-cache'
            });

            return {
                ...bookmark,
                broken: false,
                status: response.status
            };
        } catch (error) {
            return {
                ...bookmark,
                broken: true,
                error: error.message
            };
        }
    }

    /**
     * Parse AI response and extract JSON
     */
    parseAIResponse(response) {
        try {
            // Try to find JSON in the response
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return [];
        } catch (e) {
            console.error('Failed to parse AI response:', e);
            return [];
        }
    }

    /**
     * Get provider info
     */
    static getProviderInfo(provider) {
        const info = {
            claude: {
                name: 'Claude (Anthropic)',
                website: 'https://console.anthropic.com/',
                models: [
                    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Recommended)' },
                    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Faster, Cheaper)' },
                    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus (Most Capable)' }
                ],
                pricing: 'Pay per use (~$3-15 per million tokens)',
                keyFormat: 'sk-ant-...'
            },
            openai: {
                name: 'OpenAI',
                website: 'https://platform.openai.com/api-keys',
                models: [
                    { value: 'gpt-4o', label: 'GPT-4o (Recommended, Latest)' },
                    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Faster, Cheaper)' },
                    { value: 'gpt-4-turbo-preview', label: 'GPT-4 Turbo Preview' },
                    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (Legacy)' }
                ],
                pricing: 'Pay per use (~$2.50-15 per million tokens)',
                keyFormat: 'sk-...'
            },
            gemini: {
                name: 'Google Gemini',
                website: 'https://aistudio.google.com/app/apikey',
                models: [
                    { value: 'gemini-1.5-flash-latest', label: 'Gemini 1.5 Flash (Recommended, Fast & Free)' },
                    { value: 'gemini-1.5-pro-latest', label: 'Gemini 1.5 Pro (More Capable)' },
                    { value: 'gemini-pro', label: 'Gemini Pro (Legacy)' }
                ],
                pricing: 'Free tier available (15 RPM), then pay per use',
                keyFormat: 'AIza...'
            }
        };

        return info[provider] || null;
    }

    /**
     * Validate API key format for a provider
     */
    static validateApiKey(provider, apiKey) {
        if (!apiKey || typeof apiKey !== 'string') {
            return { valid: false, error: 'API key is required' };
        }

        const trimmedKey = apiKey.trim();

        if (trimmedKey.length < 10) {
            return { valid: false, error: 'API key is too short' };
        }

        switch (provider) {
            case 'claude':
                if (!trimmedKey.startsWith('sk-ant-')) {
                    return {
                        valid: false,
                        error: 'Claude API keys should start with "sk-ant-"'
                    };
                }
                break;

            case 'openai':
                if (!trimmedKey.startsWith('sk-')) {
                    return {
                        valid: false,
                        error: 'OpenAI API keys should start with "sk-"'
                    };
                }
                if (trimmedKey.startsWith('sk-ant-')) {
                    return {
                        valid: false,
                        error: 'This looks like a Claude API key. Please select Claude provider.'
                    };
                }
                break;

            case 'gemini':
                if (!trimmedKey.startsWith('AIza')) {
                    return {
                        valid: false,
                        error: 'Gemini API keys should start with "AIza"'
                    };
                }
                if (trimmedKey.startsWith('sk-')) {
                    return {
                        valid: false,
                        error: 'This looks like an OpenAI/Claude API key. Please select the correct provider.'
                    };
                }
                break;

            default:
                return { valid: false, error: 'Unknown provider' };
        }

        return { valid: true };
    }
}

/**
 * Claude (Anthropic) Adapter
 */
class ClaudeAdapter {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'claude-3-5-sonnet-20241022';
        this.baseUrl = 'https://api.anthropic.com/v1';
    }

    async test() {
        console.log('[Claude] Testing connection...', { model: this.model, baseUrl: this.baseUrl });

        const response = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 100,
                messages: [{
                    role: 'user',
                    content: 'Hello! Just testing the connection. Reply with "OK".'
                }]
            })
        });

        console.log('[Claude] Response status:', response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Claude] API Error:', errorText);
            let errorObj;
            try {
                errorObj = JSON.parse(errorText);
            } catch (e) {
                errorObj = { message: errorText };
            }
            throw new Error(`Claude API error (${response.status}): ${errorObj.error?.message || errorObj.message || errorText}`);
        }

        const data = await response.json();
        console.log('[Claude] Test successful!', data);
        return {
            success: true,
            model: this.model,
            response: data.content[0].text
        };
    }

    async analyze(prompt) {
        const response = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Claude API error: ${error}`);
        }

        const data = await response.json();
        return data.content[0].text;
    }
}

/**
 * OpenAI Adapter
 */
class OpenAIAdapter {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'gpt-4o';
        this.baseUrl = 'https://api.openai.com/v1';
    }

    async test() {
        console.log('[OpenAI] Testing connection...', { model: this.model, baseUrl: this.baseUrl });

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 100,
                messages: [{
                    role: 'user',
                    content: 'Hello! Just testing the connection. Reply with "OK".'
                }]
            })
        });

        console.log('[OpenAI] Response status:', response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[OpenAI] API Error:', errorText);
            let errorObj;
            try {
                errorObj = JSON.parse(errorText);
            } catch (e) {
                errorObj = { message: errorText };
            }

            // Friendly error messages for common issues
            let errorMessage = errorObj.error?.message || errorObj.message || errorText;
            if (response.status === 429) {
                errorMessage = '⚠️ Kredi limiti aşıldı. Lütfen OpenAI hesabınıza kredi ekleyin: https://platform.openai.com/settings/organization/billing';
            } else if (response.status === 401) {
                errorMessage = '🔑 API key geçersiz. Lütfen kontrol edin: https://platform.openai.com/api-keys';
            } else if (response.status === 404) {
                errorMessage = `❌ Model "${this.model}" bulunamadı. Hesabınızda bu modele erişim olmayabilir.`;
            }

            throw new Error(errorMessage);
        }

        const data = await response.json();
        console.log('[OpenAI] Test successful!', data);
        return {
            success: true,
            model: this.model,
            response: data.choices[0].message.content
        };
    }

    async analyze(prompt) {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${error}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }
}

/**
 * Google Gemini Adapter
 */
class GeminiAdapter {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'gemini-1.5-flash-latest';
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1';
    }

    async test() {
        console.log('[Gemini] Testing connection...', { model: this.model, baseUrl: this.baseUrl });

        const response = await fetch(
            `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: 'Hello! Just testing the connection. Reply with "OK".'
                        }]
                    }],
                    generationConfig: {
                        maxOutputTokens: 100
                    }
                })
            }
        );

        console.log('[Gemini] Response status:', response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Gemini] API Error:', errorText);
            let errorObj;
            try {
                errorObj = JSON.parse(errorText);
            } catch (e) {
                errorObj = { message: errorText };
            }

            // Friendly error messages
            let errorMessage = errorObj.error?.message || errorObj.message || errorText;
            if (response.status === 400) {
                errorMessage = `🔑 API key veya model hatası: ${errorMessage}`;
            } else if (response.status === 404) {
                errorMessage = `❌ Model "${this.model}" bulunamadı. API versiyonunu kontrol edin.`;
            } else if (response.status === 429) {
                errorMessage = '⚠️ Rate limit aşıldı. 15 istek/dakika limitine ulaştınız. Biraz bekleyin.';
            }

            throw new Error(errorMessage);
        }

        const data = await response.json();
        console.log('[Gemini] Test successful!', data);
        return {
            success: true,
            model: this.model,
            response: data.candidates[0].content.parts[0].text
        };
    }

    async analyze(prompt) {
        const response = await fetch(
            `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: prompt
                        }]
                    }],
                    generationConfig: {
                        maxOutputTokens: 8192
                    }
                })
            }
        );

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Gemini API error: ${error}`);
        }

        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AIManager, ClaudeAdapter, OpenAIAdapter, GeminiAdapter };
}
