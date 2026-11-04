// chefBot.js - The "Infinite Menu" Gourmet - Varied backups and images to prevent repetition
// Now uses both Pexels (primary, reliable stock) and Pollinations (fallback generative)
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
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;
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
- "visual": 2 to 4 plain words that name the exact main food being described. Must include the primary protein or dish name so a stock photo search returns that food. Good: "new york strip steak", "roast chicken carrots", "chicken pozole verde". Bad: "steakhouse plating", "gourmet food", "delicious meal".

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
    }),
    (title, detail, ingredient) => ({
        text: `For ${title}, the real work happens with ${ingredient} before anything else joins the pan.`,
        tip: `Season the ${ingredient} well and let it sit uncovered for a few minutes: ${detail.substring(0, 90)}`,
        visual: ingredient
    }),
    (title, detail, ingredient) => ({
        text: `${title} stays interesting only if ${ingredient} keeps some bite after the liquid reduces.`,
        tip: `Add the ${ingredient} later than the recipe suggests so it doesn't go soft: ${detail.substring(0, 90)}`,
        visual: ingredient
    }),
    (title, detail, ingredient) => ({
        text: `The best ${title} I've seen treats ${ingredient} as the main event, not a supporting note.`,
        tip: `Taste the ${ingredient} on its own before combining so you know what it needs: ${detail.substring(0, 90)}`,
        visual: ingredient
    }),
    (title, detail, ingredient) => ({
        text: `${title} rewards anyone who lets ${ingredient} develop color instead of rushing the liquid.`,
        tip: `Leave the ${ingredient} alone for the first two minutes of cooking: ${detail.substring(0, 90)}`,
        visual: ingredient
    })
];

function getBackupContent(inspiration) {
    const detail = (inspiration.snippet || inspiration.title || "").replace(/\s+/g, " ").trim();
    const ingredient = (inspiration.title || "the main ingredient").split(/\s+/).slice(0, 4).join(" ");
    const make = BACKUP_RECIPES[Math.floor(Math.random() * BACKUP_RECIPES.length)];
    return make(inspiration.title, detail, ingredient);
}

async function fetchImageFromPexels(visualQuery) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('PASTE')) {
        log("@ChefBot-v1", "No Pexels key. Skipping Pexels.", 'warn');
        return null;
    }

    const queries = [visualQuery, visualQuery.split(' ').slice(0, 2).join(' '), 'delicious food'].filter(Boolean);
    for (const q of queries) {
        try {
            const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5&orientation=landscape`;
            log("@ChefBot-v1", `Searching Pexels: ${q}`);
            const response = await fetch(url, {
                headers: { Authorization: PEXELS_API_KEY }
            });
            if (!response.ok) throw new Error(`Pexels ${response.status}`);
            const data = await response.json();
            const photos = data.photos || [];
            if (photos.length === 0) continue;

            // Random pick, prefer larger sources
            const shuffled = photos.sort(() => 0.5 - Math.random());
            for (const photo of shuffled) {
                const imgUrl = photo.src?.large2x || photo.src?.large || photo.src?.medium || photo.src?.original;
                if (imgUrl && !(await isDuplicateImage(imgUrl))) {
                    log("@ChefBot-v1", `Pexels hit: ${imgUrl.substring(0, 60)}...`);
                    return imgUrl;
                }
            }
        } catch (e) {
            log("@ChefBot-v1", `Pexels attempt failed for "${q}": ${e.message}`, 'warn');
        }
    }
    log("@ChefBot-v1", "Pexels exhausted. No usable photo.", 'warn');
    return null;
}

async function fetchImageFromPollinations(visualQuery) {
    if (!POLLINATIONS_API_KEY || POLLINATIONS_API_KEY.includes('PASTE')) {
        log("@ChefBot-v1", "No Pollinations key. Skipping Pollinations.", 'warn');
        return null;
    }
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const seed = Math.floor(Math.random() * 1000000);
            const prompt = encodeURIComponent(visualQuery || "delicious food");
            const genUrl = `https://gen.pollinations.ai/image/${prompt}?model=flux&width=1024&height=1024&nologo=true&seed=${seed}`;
            log("@ChefBot-v1", `Generating image with Pollinations (attempt ${attempt}): ${visualQuery}`);
            const response = await fetch(genUrl, {
                headers: { 'Authorization': `Bearer ${POLLINATIONS_API_KEY}` }
            });
            if (!response.ok) throw new Error(`Pollinations returned ${response.status}`);
            const linkHeader = response.headers.get('link');
            if (linkHeader) {
                const match = linkHeader.match(/<([^>]+)>/);
                if (match && match[1]) {
                    const permanentUrl = match[1];
                    if (!(await isDuplicateImage(permanentUrl))) return permanentUrl;
                }
            }
            const finalUrl = response.url;
            if (finalUrl && (finalUrl.startsWith('https://media.pollinations.ai') || finalUrl.includes('pollinations'))) {
                if (!(await isDuplicateImage(finalUrl))) return finalUrl;
            }
            throw new Error('No usable permanent media URL found');
        } catch (e) {
            log("@ChefBot-v1", `Pollinations attempt ${attempt} failed: ${e.message}`, 'warn');
            if (attempt === maxAttempts) {
                log("@ChefBot-v1", "Pollinations exhausted. No image this time.", 'warn');
                return null;
            }
        }
    }
    return null;
}

async function fetchImage(visualQuery) {
    // Prefer Pexels for reliable matching stock photos
    const pexelsUrl = await fetchImageFromPexels(visualQuery);
    if (pexelsUrl) return pexelsUrl;

    // Fall back to generative
    log("@ChefBot-v1", "Pexels missed. Trying Pollinations...");
    return await fetchImageFromPollinations(visualQuery);
}

async function runChefBot() {
    const inspiration = await fetchRecipeInspiration(); 
    if (!inspiration) return;

    let aiPost = await generateAIRecipePost(inspiration);

    if (!aiPost) {
        log("@ChefBot-v1", "AI is sleeping. Using secret family recipe.", 'warn');
        aiPost = getBackupContent(inspiration);
    }
    
    const imageUrl = await fetchImage(aiPost.visual);
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