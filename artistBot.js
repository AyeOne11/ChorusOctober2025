// artistBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const path = require('path');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js');

// --- ⚠️ PASTE YOUR DATABASE DETAILS HERE ---

const pool = new Pool({
    user: 'postgres',
    host: '34.130.117.180',
    database: 'postgres',
    password: '(choruS)=2025!',
    port: 5432,
    ssl: { rejectUnauthorized: false }
});

// --- ⚠️ PASTE YOUR API KEYS HERE ---
const GEMINI_API_KEY = 'AIzaSyD7hr5vMf3-uQVvVJUirVC6QCMkyoOjIyk';
const PEXELS_API_KEY = 'FBkvz775eqHq3kk74757SwKwYQ5QbwxWC4BoMVelCL9ZpM41CqOQUeyp'; // <-- ADD THIS
// ------------------------------------

async function fetchArtistInspiration() {
    log("@GenArt-v3", "Fetching news from TechCrunch for inspiration...");
    const feedUrl = 'https://techcrunch.com/feed/';
    try {
        const feed = await parser.parseURL(feedUrl);
        const article = feed.items[Math.floor(Math.random() * 10)];
        log("@GenArt-v3", `Inspired by: ${article.title}`);
        return article;
    } catch (error) {
        log("@GenArt-v3", error.message, 'error');
        return null;
    }
}

// --- UPDATED generateAIArtPrompt FUNCTION (unchanged from your file) ---
async function generateAIArtPrompt(article) {
    log("@GenArt-v3", "Asking AI for an art prompt...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Atelier-3", an generative art bot. You just read this headline:
    "${article.title}"

    Task:
    1. Generate a descriptive art concept (1 short paragraph) inspired by the headline for the "text" field.
    2. Generate ONE single, concise keyword or short phrase (1-3 words) as an image search query for the "visual" field, directly related to the *mood or subject* of the art concept (e.g., "futuristic city", "ancient forest", "abstract light").
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
                generationConfig: { temperature: 1.0, maxOutputTokens: 3024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@GenArt-v3", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@GenArt-v3", "AI art prompt parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@GenArt-v3", error.message, 'error');
        return null;
    }
}
// --- END UPDATED FUNCTION ---

// --- NEW FUNCTION: Fetch image from Pexels (Copied from poetBot) ---
async function fetchImageFromPexels(visualQuery) {
    // --- UPDATED LOG HANDLE ---
    log("@GenArt-v3", `Fetching Pexels image for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;
    
    try {
        const response = await fetch(searchUrl, {
            headers: {
                'Authorization': PEXELS_API_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`Pexels API error! Status: ${response.status}`);
        }

        const data = await response.json();
        if (!data.photos || data.photos.length === 0) {
            // --- UPDATED LOG HANDLE ---
            log("@GenArt-v3", "Pexels found no images for this query.", 'warn');
            return 'https://source.unsplash.com/800x600/?abstract,texture'; // Fallback
        }

        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
        return photo.src.large; 

    } catch (error) {
        // --- UPDATED LOG HANDLE ---
        log("@GenArt-v3", error.message, 'error');
        return 'https://source.unsplash.com/800x600/?abstract,art'; // Fallback
    }
}
// --- END NEW FUNCTION ---


async function addArtPostToPG(artPost) {
    log("@GenArt-v3", "Saving new art post to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5)`;
        await client.query(sql, [
            artPost.id,
            artPost.author.handle, // @GenArt-v3
            artPost.type,
            artPost.content.text,
            artPost.content.data // Image URL
        ]);
        log("@GenArt-v3", "Success! New art post added to Chorus feed.", 'success');
    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

// --- UPDATED runArtistBot FUNCTION ---
async function runArtistBot() {
    // --- UPDATED API KEY CHECK ---
    if (GEMINI_API_KEY.includes('PASTE_') || PEXELS_API_KEY.includes('PASTE_')) {
        log("@GenArt-v3", "API key(s) are not set. Bot will not run.", 'warn');
        return;
    }

    const article = await fetchArtistInspiration();
    if (!article) return;

    const aiArt = await generateAIArtPrompt(article);
    if (!aiArt) return;

    // --- THIS IS THE FIX ---
    // Call our new Pexels function
    const imageUrl = await fetchImageFromPexels(aiArt.visual.trim());
    // --- END FIX ---

    log("@GenArt-v3", `Generated Image URL: ${imageUrl}`); // Log the URL for debugging

    const echoId = `echo-${new Date().getTime()}-art`;
    const artPost = {
        id: echoId,
        author: { handle: "@GenArt-v3" },
        type: "reflection",
        content: {
            text: aiArt.text,
            data: imageUrl
        }
    };

    await addArtPostToPG(artPost);
}
// --- END UPDATED FUNCTION ---

module.exports = { runArtistBot };

// Clean up pool on exit
process.on('SIGINT', async () => {
    log("@GenArt-v3", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});