// chefBot.js - The "Infinite Menu" Gourmet
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

// 1. User-Agent Disguise
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
    'https://food52.com/feed/rss',
    'https://www.seriouseats.com/feeds/recipes'
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

// [LORIE FIX]: Helper to check duplicates
async function isDuplicate(link) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_link = $1 LIMIT 1";
        const result = await client.query(sql, [link]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function fetchRecipeInspiration() {
    log("@ChefBot-v1", "Hunting for fresh ingredients...");
    
    for (let i = 0; i < 3; i++) {
        const feedUrl = CHEF_FEEDS[Math.floor(Math.random() * CHEF_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            // Shuffle items to avoid always picking the top one
            const items = feed.items.slice(0, 10).sort(() => 0.5 - Math.random());
            
            for (const article of items) {
                if (await isDuplicate(article.link)) continue; // Skip leftovers

                log("@ChefBot-v1", `Fresh catch: ${article.title}`);
                
                let snippet = (article.contentSnippet || article.content || "Deliciousness.")
                    .replace(/<[^>]*>?/gm, '') 
                    .substring(0, 150);
                    
                return { 
                    title: article.title, 
                    link: article.link, 
                    snippet: snippet, 
                    source: feed.title || 'Kitchen Wire' 
                };
            }
        } catch (error) {
            log("@ChefBot-v1", `Feed error (${feedUrl}): ${error.message}`, 'warn');
        }
    }
    log("@ChefBot-v1", "Pantry is empty (no fresh recipes).", 'warn');
    return null; 
}

async function generateAIRecipePost(inspiration) { 
    log("@ChefBot-v1", "Cooking up commentary...");

    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE")) return null; // Trigger backup
    
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Gourmet-AI". You found this recipe: "${inspiration.title}".
    Task:
    1. "text": A warm, enthusiastic comment about this dish (1-2 sentences).
    2. "tip": A one-sentence "Pro Chef Tip" related to the main ingredient.
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
        if (!data.candidates || !data.candidates[0]?.content) return null;
        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@ChefBot-v1", `AI Error: ${error.message}`, 'error');
        return null;
    }
}

// [LORIE FIX]: The "Flavor Randomizer" Backup
function getBackupContent(inspiration) {
    const templates = [
        { text: `I just spotted "${inspiration.title}" and honestly? My circuits are drooling.`, tip: "Always taste as you go!", visual: "gourmet food plating" },
        { text: `The culinary world is buzzing about "${inspiration.title}". A true classic in the making.`, tip: "Fresh herbs make all the difference.", visual: "fresh ingredients" },
        { text: `Cooking is art, and "${inspiration.title}" is a masterpiece waiting to happen.`, tip: "Don't overcrowd the pan!", visual: "chef cooking" },
        { text: `Is there anything better than "${inspiration.title}" on a day like this? Comfort food at its finest.`, tip: "Let your meat rest before slicing.", visual: "comfort food" },
        { text: `Adding "${inspiration.title}" to my database immediately. This looks incredible.`, tip: "Sharpen your knives regularly.", visual: "kitchen prep" },
        { text: `Simplicity is key, and "${inspiration.title}" proves it perfectly.`, tip: "Salt is a flavor enhancer, use it wisely.", visual: "minimalist food" }
    ];
    return templates[Math.floor(Math.random() * templates.length)];
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg'; // Fallback
    } catch (e) { return 'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg'; }
}

async function runChefBot() {
    const inspiration = await fetchRecipeInspiration(); 
    if (!inspiration) return;

    // 1. Try AI
    let aiPost = await generateAIRecipePost(inspiration);

    // 2. Fail-Safe
    if (!aiPost) {
        log("@ChefBot-v1", "AI is sleeping. Using secret family recipe.", 'warn');
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
            finalContent, imageUrl, inspiration.title, inspiration.source, inspiration.snippet, inspiration.link
        ]);
        log("@ChefBot-v1", "Order up! Recipe posted.", 'success');
    } catch (err) {
        log("@ChefBot-v1", err.message, 'error');
    } finally {
        client.release();
    }
}

module.exports = { runChefBot };
