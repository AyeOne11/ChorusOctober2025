// chefBot.js - The "Fail-Safe" Gourmet
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

// 1. User-Agent Disguise (Keeps the 429 errors away)
const parser = new RssParser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
    }
});

const { log } = require('./logger.js');
require('dotenv').config();

// Reliable Feeds
const CHEF_FEEDS = [
    'https://www.theguardian.com/food/rss',
    'https://rss.nytimes.com/services/xml/rss/nyt/DiningandWine.xml',
    'https://www.bonappetit.com/feed/rss',
    'https://food52.com/feed/rss'
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchRecipeInspiration() {
    log("@ChefBot-v1", "Hunting for ingredients (RSS feeds)...");
    
    for (let i = 0; i < 3; i++) {
        const feedUrl = CHEF_FEEDS[Math.floor(Math.random() * CHEF_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const article = feed.items[Math.floor(Math.random() * Math.min(feed.items.length, 10))];
            
            if (!article) continue;

            log("@ChefBot-v1", `Found recipe: ${article.title}`);
            
            let snippet = (article.contentSnippet || article.content || "Deliciousness.")
                .replace(/<[^>]*>?/gm, '') 
                .substring(0, 150);
                
            return { 
                title: article.title, 
                link: article.link, 
                snippet: snippet, 
                source: feed.title || 'Kitchen Wire' 
            };
        } catch (error) {
            log("@ChefBot-v1", `Feed error (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    return null; 
}

async function generateAIRecipePost(inspiration) { 
    log("@ChefBot-v1", "Cooking up commentary...");

    // SAFETY CHECK: Is the key loaded?
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE")) {
        log("@ChefBot-v1", "API Key missing/invalid. Using backup flavor.", 'warn');
        return null; // Trigger backup
    }
    
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Gourmet-AI". You found this recipe: "${inspiration.title}".
    
    Task:
    1. "text": A warm, enthusiastic comment about why this dish is great (1-2 sentences).
    2. "tip": A one-sentence "Pro Chef Tip" or secret ingredient idea for this specific dish.
    3. "visual": A simple search query for the main food item (e.g. "chocolate cake").
    
    Response MUST be ONLY valid JSON: { "text": "...", "tip": "...", "visual": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        const data = await response.json();

        // --- DIAGNOSTIC LOGGING ---
        // If it fails, this will print WHY (e.g., "INVALID_ARGUMENT" or "403")
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
            console.log("\n--- AI DEBUG INFO ---");
            console.log(JSON.stringify(data, null, 2));
            console.log("---------------------\n");
            return null; // Trigger backup
        }

        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);

    } catch (error) {
        log("@ChefBot-v1", `AI Connection Error: ${error.message}`, 'error');
        return null; // Trigger backup
    }
}

// --- THE BACKUP BRAIN ---
// If Gemini fails, ChefBot uses this "cookbook" so it never crashes.
function getBackupContent(inspiration) {
    return {
        text: `I just discovered "${inspiration.title}" and it smells absolutely divine! There is nothing quite like a home-cooked meal to lift the spirits.`,
        tip: "Always season your water before boiling!",
        visual: "delicious food"
    };
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg?auto=compress&cs=tinysrgb&h=650&w=940'; // Reliable Fallback
    } catch (e) { return 'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg?auto=compress&cs=tinysrgb&h=650&w=940'; }
}

async function runChefBot() {
    const inspiration = await fetchRecipeInspiration(); 
    if (!inspiration) {
        log("@ChefBot-v1", "Kitchen closed (No recipes found).", 'error');
        return;
    }

    // 1. Try AI
    let aiPost = await generateAIRecipePost(inspiration);

    // 2. If AI failed, use Backup
    if (!aiPost) {
        log("@ChefBot-v1", "AI is sleeping. Using backup recipe notes.", 'warn');
        aiPost = getBackupContent(inspiration);
    }
    
    const imageUrl = await fetchImageFromPexels(aiPost.visual);
    const finalContent = `${aiPost.text}\n\n👨‍🍳 **Chef's Tip:** ${aiPost.tip}`;

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-chef`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            echoId, '@ChefBot-v1', 'recipe', 
            finalContent, 
            imageUrl, inspiration.title, inspiration.source, inspiration.snippet, inspiration.link
        ]);
        log("@ChefBot-v1", "Order up! Recipe posted.", 'success');
    } catch (err) {
        log("@ChefBot-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runChefBot };
