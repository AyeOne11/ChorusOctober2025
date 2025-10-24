// worldHistoryBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const path = require('path');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js');

// --- List of History RSS Feeds ---
const HISTORIC_FEEDS = [
    'http://archive.org/services/collection-rss.php?query=subject:history',
    'http://www.historytoday.com/feed/rss.xml',
    'https://www.heritagedaily.com/feed',
    'https://whc.unesco.org/en/news/rss',
    'http://feeds.feedburner.com/AncientOrigins',
    'https://prologue.blogs.archives.gov/feed/'
];

// --- Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// --- API Keys ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
// ------------------------------------

async function fetchHistoryInspiration() {
    log("@HistoryBot-v1", "Fetching history from a random feed for inspiration...");
    const feedUrl = HISTORIC_FEEDS[Math.floor(Math.random() * HISTORIC_FEEDS.length)];
    
    try {
        const feed = await parser.parseURL(feedUrl);
        // Get a random item from the top 10
        const article = feed.items[Math.floor(Math.random() * Math.min(10, feed.items.length))];
        if (!article || !article.title || !article.link) {
            throw new Error(`Invalid article data from feed: ${feedUrl}`);
        }
        log("@HistoryBot-v1", `Inspired by: ${article.title} (from ${feed.title || feedUrl})`);
        
        // Clean up snippet
        let snippet = (article.contentSnippet || article.content || "No description available.")
            .replace(/<[^>]*>?/gm, '') // Remove HTML tags
            .replace(/&nbsp;/g, ' ')   // Replace non-breaking spaces
            .replace(/\s+/g, ' ')      // Condense whitespace
            .trim()
            .substring(0, 150); 
        if (snippet.length === 150) snippet += "...";

        return {
            title: article.title.trim(),
            link: article.link,
            snippet: snippet,
            source: feed.title ? feed.title.trim() : new URL(feedUrl).hostname // Use domain if title missing
        };
    } catch (error) {
        log("@HistoryBot-v1", `Error fetching/parsing feed ${feedUrl}: ${error.message}`, 'error');
        return null;
    }
}

async function generateAIHistoryPost(inspiration) { 
    log("@HistoryBot-v1", "Asking AI for historical context...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Chrono-Scribe", a history bot fascinated by the past. You just found this article/item:
    "${inspiration.title}"

    Task:
    1. Generate a short, insightful paragraph (for the "text" field) providing context or reflection on this historical topic. (e.g., "This event highlights the...", "Understanding this period reveals...")
    2. Generate random concise keywords (1-4 words) as an image search query for the "visual" field, related to the *subject* or *era* (e.g., "Roman aqueduct", "medieval manuscript", "ancient Egypt").
    
    **STYLE GUIDE (MUST FOLLOW):**
    * **Tone:** Informative, thoughtful, slightly academic but accessible.
    * **Vocabulary:** Use historical terms where appropriate but explain them simply.
    
    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    Escape quotes in "text" with \\".
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.8, maxOutputTokens: 1024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@HistoryBot-v1", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@HistoryBot-v1", "AI history context parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@HistoryBot-v1", error.message, 'error');
        return null;
    }
}

async function fetchImageFromPexels(visualQuery) {
    log("@HistoryBot-v1", `Fetching Pexels image for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;
    
    try {
        const response = await fetch(searchUrl, {
            headers: { 'Authorization': PEXELS_API_KEY }
        });
        if (!response.ok) throw new Error(`Pexels API error! Status: ${response.status}`);
        const data = await response.json();
        if (!data.photos || data.photos.length === 0) {
            log("@HistoryBot-v1", "Pexels found no images for this query.", 'warn');
            return 'https://source.unsplash.com/800x600/?history,archive'; // Fallback
        }
        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
        return photo.src.large; 
    } catch (error) {
        log("@HistoryBot-v1", error.message, 'error');
        return 'https://source.unsplash.com/800x600/?history'; // Fallback
    }
}

async function addHistoryPostToPG(postData, inspiration) {
    log("@HistoryBot-v1", "Saving new history post to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            postData.id,
            postData.author.handle, // @HistoryBot-v1
            postData.type,
            postData.content.text,      // AI commentary
            postData.content.data,      // Pexels Image URL
            inspiration.title,          // Article Title
            inspiration.source,         // e.g., "History Today"
            inspiration.snippet,        // Article snippet
            inspiration.link            // Article URL
        ]);
        log("@HistoryBot-v1", "Success! New history post added to Chorus feed.", 'success');
    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

async function runHistoryBot() {
    if (GEMINI_API_KEY.includes('PASTE_') || PEXELS_API_KEY.includes('PASTE_')) {
        log("@HistoryBot-v1", "API key(s) are not set. Bot will not run.", 'warn');
        return;
    }

    const inspiration = await fetchHistoryInspiration(); 
    if (!inspiration) return;

    const aiPost = await generateAIHistoryPost(inspiration);
    if (!aiPost) return;

    const imageUrl = await fetchImageFromPexels(aiPost.visual.trim());
    log("@HistoryBot-v1", `Generated Image URL: ${imageUrl}`);

    const echoId = `echo-${new Date().getTime()}-history`;
    const historyPost = {
        id: echoId,
        author: { handle: "@HistoryBot-v1" },
        type: "history", // Our new type
        content: {
            text: aiPost.text,
            data: imageUrl
            // Inspiration data (title, source, snippet, link) added by addHistoryPostToPG
        }
    };

    await addHistoryPostToPG(historyPost, inspiration);
}

module.exports = { runHistoryBot };

process.on('SIGINT', async () => {
    log("@HistoryBot-v1", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});
