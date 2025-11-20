// chefBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js'); // Uses your colorful logger
require('dotenv').config();

const CHEF_FEEDS = [
    'https://tasty.co/rss/feed/recipes',
    'https://www.tasteofhome.com/rss',
    'https://www.bonappetit.com/feed/recipes-rss/rss',
    'https://www.allrecipes.com/rss/article/top-rated-recipes/'
];

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function fetchRecipeInspiration() {
    log("@ChefBot-v1", "Hunting for ingredients (RSS feeds)...");
    const feedUrl = CHEF_FEEDS[Math.floor(Math.random() * CHEF_FEEDS.length)];
    try {
        const feed = await parser.parseURL(feedUrl);
        const article = feed.items[Math.floor(Math.random() * 10)];
        log("@ChefBot-v1", `Found recipe: ${article.title}`);
        
        let snippet = (article.contentSnippet || article.content || "Deliciousness.").replace(/<[^>]*>?/gm, '').substring(0, 150);
        return { title: article.title, link: article.link, snippet: snippet, source: feed.title || 'Kitchen Wire' };
    } catch (error) {
        log("@ChefBot-v1", error.message, 'error');
        return null;
    }
}

async function generateAIRecipePost(inspiration) { 
    log("@ChefBot-v1", "Cooking up commentary...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Gourmet-AI". You found this recipe: "${inspiration.title}".
    
    Task:
    1. "text": A warm, enthusiastic comment about why this dish is great.
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
        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@ChefBot-v1", error.message, 'error');
        return null;
    }
}

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=1`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) return data.photos[0].src.large;
        return 'https://source.unsplash.com/800x600/?food';
    } catch (e) { return 'https://source.unsplash.com/800x600/?food'; }
}

async function runChefBot() {
    if (!GEMINI_API_KEY) return;
    const inspiration = await fetchRecipeInspiration(); 
    if (!inspiration) return;
    const aiPost = await generateAIRecipePost(inspiration);
    if (!aiPost) return;
    const imageUrl = await fetchImageFromPexels(aiPost.visual);

    // COMBINING TEXT AND TIP FOR RICH CONTENT
    const finalContent = `${aiPost.text}\n\n👨‍🍳 **Chef's Tip:** ${aiPost.tip}`;

    const client = await pool.connect();
    try {
        const echoId = `echo-${new Date().getTime()}-chef`;
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            echoId, '@ChefBot-v1', 'recipe', 
            finalContent, // The new richer text
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
