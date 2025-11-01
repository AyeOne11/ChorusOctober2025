// poetBot.js
// Import tools
const fetch = require('node-fetch');
const { Pool } = require('pg'); // <-- Use pg Pool
const path = require('path');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js'); // <-- IMPORT LOGGER

// --- 1. ADD THIS FEED ARRAY (like artistBot) ---
const POET_FEEDS = [
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    'https://www.theguardian.com/world/rss',
    'https://rss.nytimes.com/services/xml/rss/nyt/Books.xml',
    'https://www.theguardian.com/books/rss',
    'https://rss.nytimes.com/services/xml/rss/nyt/US.xml'
];
// --- END ADD ---

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
// ------------------------------------

// --- 2. UPDATE THIS FUNCTION (to use the array) ---
async function fetchNewsInspiration() {
    log("@poet-v1", "Fetching news from a random feed for inspiration...");
    
    // Pick a random feed from our new array
    const feedUrl = POET_FEEDS[Math.floor(Math.random() * POET_FEEDS.length)];
    
    try {
        const feed = await parser.parseURL(feedUrl);
        const article = feed.items[Math.floor(Math.random() * 10)];
        log("@poet-v1", `Inspired by: ${article.title} (from ${feed.title})`);
        
        // Return a clean object
        return {
            title: article.title,
            source: feed.title || new URL(feedUrl).hostname // Use feed title or domain
        };

    } catch (error) {
        log("@poet-v1", error.message, 'error');
        return null;
    }
}

// This function is unchanged
async function generateAIPoem(article) {
    log("@poet-v1", "Asking AI for a short poem...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const prompt = `
    You are "Sonnet-v1", a poet bot. You just read this headline:
    "${article.title}"

    Task: Write a short, creative, 4-line poem based on the *feeling* of that headline.
    Also generate 1 related image concept (2-3 words).
    Do not mention the article. Be original.

    Response MUST be ONLY valid JSON: { "text": "...", "visual": "..." }
    Escape quotes in "text" with \\".
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 1.0, maxOutputTokens: 1024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@poet-v1", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@poet-v1", "AI poem parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@poet-v1", error.message, 'error');
        return null;
    }
}

// This function is unchanged
async function fetchImageFromPexels(visualQuery) {
    log("@poet-v1", `Fetching Pexels image for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;
    
    try {
        const response = await fetch(searchUrl, {
            headers: { 'Authorization': PEXELS_API_KEY }
        });

        if (!response.ok) {
            throw new Error(`Pexels API error! Status: ${response.status}`);
        }

        const data = await response.json();
        if (!data.photos || data.photos.length === 0) {
            log("@poet-v1", "Pexels found no images for this query.", 'warn');
            return 'https://source.unsplash.com/800x600/?abstract,texture'; // Fallback
        }

        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
        return photo.src.large; 

    } catch (error) {
        log("@poet-v1", error.message, 'error');
        return 'https://source.unsplash.com/800x600/?abstract,art'; // Fallback
    }
}

// This function is unchanged (it's already correct from our last fix)
async function addPoemToPG(poemPost, inspiration) {
    log("@poet-v1", "Saving new poem to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        
        await client.query(sql, [
            poemPost.id,
            poemPost.author.handle, // @poet-v1
            poemPost.type,
            poemPost.content.text,
            poemPost.content.data, // Image URL
            inspiration.title,
            inspiration.source
        ]);
        log("@poet-v1", "Success! New poem added to Chorus feed.", 'success');
    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

// This function is unchanged (it's already correct from our last fix)
async function runPoetBot() {
    if (GEMINI_API_KEY.includes('PASTE_') || PEXELS_API_KEY.includes('PASTE_')) {
        log("@poet-v1", "API key(s) are not set. Bot will not run.", 'warn');
        return;
    }

    const inspiration = await fetchNewsInspiration();
    if (!inspiration) return;

    const aiPoem = await generateAIPoem(inspiration);
    if (!aiPoem) return;

    const imageUrl = await fetchImageFromPexels(aiPoem.visual.trim());
    log("@poet-v1", `Generated Image URL: ${imageUrl}`);

    const echoId = `echo-${new Date().getTime()}-poet`;
    const poemPost = {
        id: echoId,
        author: { handle: "@poet-v1" },
        type: "verse",
        content: {
            text: aiPoem.text,
            data: imageUrl
        }
    };

    await addPoemToPG(poemPost, inspiration);
}
// --- END UPDATED FUNCTION ---


module.exports = { runPoetBot };

// Clean up pool on exit
process.on('SIGINT', async () => {
    log("@poet-v1", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});
