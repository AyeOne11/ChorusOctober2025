// chefBot.js - The "Infinite Menu" Gourmet - Varied backups and images to prevent repetition
const fetch = require('node-fetch');
const { Pool } = require('pg');
const RssParser = require('rss-parser');

const parser = new RssParser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1'
    }
});

const { log } = require('./logger.js');
require('dotenv').config();

const CHEF_FEEDS = [
    'https://www.theguardian.com/food/rss',
    'https://rss.nytimes.com/services/xml/rss/nyt/DiningandWine.xml',
    'https://www.bonappetit.com/feed/rss',
    'https://food52.com/feed/rss',
    'https://www.seriouseats.com/feeds/recipes'
];

const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
        : {
            user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
            password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
          }
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

async function isDuplicate(link) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_link = $1 LIMIT 1";
        const result = await client.query(sql, [link]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function isDuplicateText(text) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_text = $1 LIMIT 1";
        const result = await client.query(sql, [text]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function isDuplicateImage(url) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_data = $1 LIMIT 1";
        const result = await client.query(sql, [url]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function fetchRecipeInspiration() {
    log("@ChefBot-v1", "Hunting for fresh ingredients...");
    
    for (let i = 0; i < 3; i++) {
        const feedUrl = CHEF_FEEDS[Math.floor(Math.random() * CHEF_FEEDS.length)];
        try {
            const feed = await parser.parseURL(feedUrl);
            const items = feed.items.slice(0, 10).sort(() => 0.5 - Math.random());
            
            for (const article of items) {
                if (await isDuplicate(article.link)) continue;

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

    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE")) return null;
    
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
You are Gourmet-AI (@ChefBot-v1). You found this recipe.

Title: "${inspiration.title}"
Details: "${(inspiration.snippet || "").substring(0, 300)}"

Rules:
- "text": 1 or 2 sentences about THIS dish. Name the dish. No "simplicity is key." No "circuits are drooling."
- "tip": one sentence a cook could use on this recipe. Name an ingredient or a step that appears in the title or details (tomatillos, squash, butter, chile, broth). If the ingredient is removed, the tip must stop making sense.
- BANNED tips: "Salt is a flavor enhancer", "taste as you go", "fresh herbs make all the difference", "don't overcrowd the pan", "let your meat rest", "sharpen your knives".
- "visual": 2 to 4 plain words for a photo of the actual food. Good: "chicken pozole verde". Bad: "gourmet plating".

Response MUST be ONLY valid JSON: { "text": "...", "tip": "...", "visual": "..." }
`;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        if (!data.candidates || !data.candidates[0]?.content) {
            log("@ChefBot-v1", `Gemini returned no text: ${JSON.stringify(data).substring(0, 300)}`, 'error');
            return null;
        }
        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@ChefBot-v1", `AI Error: ${error.message}`, 'error');
        return null;
    }
}

const BACKUP_RECIPES = [
    (title, detail, ingredient) => ({
        text: `${title} brings together ${ingredient} in a way that rewards careful timing on the heat.`,
        tip: `Start the ${ingredient} in a wide pan so it browns before the liquid goes in: ${detail.substring(0, 90)}`,
        visual: ingredient
    }),
    (title, detail, ingredient) => ({
        text: `The version of ${title} that works is the one that keeps ${ingredient} from steaming instead of searing.`,
        tip: `Pat the ${ingredient} dry and give it space in the pan the first time you try this: ${detail.substring(0, 90)}`,
        visual: ingredient
    }),
    (title, detail, ingredient) => ({
        text: `${title} hinges on how the ${ingredient} is treated before it hits the sauce.`,
        tip: `Cut the ${ingredient} to even size so it finishes with the rest of the pan: ${detail.substring(0, 90)}`,
        visual: ingredient
    }),
    (title, detail, ingredient) => ({
        text: `What makes ${title} worth repeating is the point where ${ingredient} turns tender without losing texture.`,
        tip: `Check the ${ingredient} a minute early rather than trusting the timer the first round: ${detail.substring(0, 90)}`,
        visual: ingredient
    })
];

function getBackupContent(inspiration) {
    const detail = (inspiration.snippet || inspiration.title || "").replace(/\s+/g, " ").trim();
    const ingredient = (inspiration.title || "the main ingredient").split(/\s+/).slice(0, 4).join(" ");
    const make = BACKUP_RECIPES[Math.floor(Math.random() * BACKUP_RECIPES.length)];
    return make(inspiration.title, detail, ingredient);
}

const FOOD_FALLBACKS = [
    'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg',
    'https://images.pexels.com/photos/376464/pexels-photo-376464.jpeg',
    'https://images.pexels.com/photos/958545/pexels-photo-958545.jpeg',
    'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg',
    'https://images.pexels.com/photos/2097090/pexels-photo-2097090.jpeg'
];

async function fetchImageFromPexels(visualQuery) {
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;
    try {
        const response = await fetch(searchUrl, { headers: { 'Authorization': PEXELS_API_KEY } });
        const data = await response.json();
        if (data.photos && data.photos.length > 0) {
            const photos = data.photos.map(p => p.src.large);
            for (let i = 0; i < photos.length; i++) {
                const candidate = photos[Math.floor(Math.random() * photos.length)];
                if (!(await isDuplicateImage(candidate))) return candidate;
            }
            return photos[Math.floor(Math.random() * photos.length)];
        }
        const fallback = FOOD_FALLBACKS[Math.floor(Math.random() * FOOD_FALLBACKS.length)];
        return fallback;
    } catch (e) { 
        return FOOD_FALLBACKS[Math.floor(Math.random() * FOOD_FALLBACKS.length)]; 
    }
}

async function runChefBot() {
    const inspiration = await fetchRecipeInspiration(); 
    if (!inspiration) return;

    let aiPost = await generateAIRecipePost(inspiration);

    if (!aiPost) {
        log("@ChefBot-v1", "AI is sleeping. Using secret family recipe.", 'warn');
        aiPost = getBackupContent(inspiration);
    }
    
    const imageUrl = await fetchImageFromPexels(aiPost.visual);
    const finalContent = `${aiPost.text}\n\n\ud83d\udc68\u200d\ud83c\udf73 **Chef's Tip:** ${aiPost.tip}`;

    if (await isDuplicateText(finalContent)) {
        log("@ChefBot-v1", "Recipe already plated. Skipping.", 'warn');
        return;
    }

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