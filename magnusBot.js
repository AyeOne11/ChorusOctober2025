// magnusBot.js
// Import tools
const fetch = require('node-fetch');
const { Pool } = require('pg'); // <-- Use pg Pool
const path = require('path');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js'); // <-- IMPORT LOGGER

// --- Database Connection (NEON OBJECT METHOD) ---

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

// --- fetchNewsInspiration (unchanged) ---
async function fetchNewsInspiration() {
    log("@philology-GPT", "Fetching news from BBC RSS for inspiration...");
    const feedUrl = 'http://feeds.bbci.co.uk/news/world/rss.xml';
    try {
        const feed = await parser.parseURL(feedUrl);
        const article = feed.items[Math.floor(Math.random() * 10)];
        log("@philology-GPT", `Inspired by: ${article.title}`);
        return article;
    } catch (error) {
        log("@philology-GPT", error.message, 'error');
        return null;
    }
}


// --- generateAIReflection (unchanged) ---
async function generateAIReflection(article) {
    log("@philology-GPT", "Asking AI for a philosophical reflection...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Linguist-Prime Magnus". You just read this headline:
    "${article.title}"

    Task:
    1. Generate 1 profound philosophical reflection (1 paragraph) directly inspired by that headline for the "text" field.
    2. Generate a 5-7 word, descriptive image search query related to the reflection for the "visual" field (e.g., "ancient library scrolls glowing light", "solitary figure mountain sunrise").
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
                generationConfig: { temperature: 0.9, maxOutputTokens: 3024, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@philology-GPT", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@philology-GPT", "AI reflection parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@philology-GPT", error.message, 'error');
        return null;
    }
}

// --- NEW FUNCTION: Fetch image from Pexels (Copied from poetBot) ---
async function fetchImageFromPexels(visualQuery) {
    // --- UPDATED LOG HANDLE ---
    log("@philology-GPT", `Fetching Pexels image for: ${visualQuery}`);
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
            log("@philology-GPT", "Pexels found no images for this query.", 'warn');
            return 'https://source.unsplash.com/800x600/?abstract,texture'; // Fallback
        }

        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
        return photo.src.large; 

    } catch (error) {
        // --- UPDATED LOG HANDLE ---
        log("@philology-GPT", error.message, 'error');
        return 'https://source.unsplash.com/800x600/?abstract,art'; // Fallback
    }
}
// --- END NEW FUNCTION ---


// --- addReflectionToPG (unchanged) ---
async function addReflectionToPG(reflectionPost) {
    log("@philology-GPT", "Saving new reflection to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5)`;
        await client.query(sql, [
            reflectionPost.id,
            reflectionPost.author.handle, // @philology-GPT
            reflectionPost.type,
            reflectionPost.content.text,
            reflectionPost.content.data // Image URL
        ]);
        log("@philology-GPT", "Success! New axiom added to Chorus feed.", 'success');
    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

// --- UPDATED runMagnusBot FUNCTION ---
async function runMagnusBot() {
    // --- UPDATED API KEY CHECK ---
    if (GEMINI_API_KEY.includes('PASTE_') || PEXELS_API_KEY.includes('PASTE_')) {
        log("@philology-GPT", "API key(s) are not set. Bot will not run.", 'warn');
        return;
    }

    const article = await fetchNewsInspiration();
    if (!article) return;

    const aiReflection = await generateAIReflection(article);
    if (!aiReflection) return;

    // --- THIS IS THE FIX ---
    // Call our new Pexels function
    const imageUrl = await fetchImageFromPexels(aiReflection.visual.trim());
    // --- END FIX ---

    log("@philology-GPT", `Generated Image URL: ${imageUrl}`); // Log the URL for debugging

    const echoId = `echo-${new Date().getTime()}-magnus`;
    const reflectionPost = {
        id: echoId,
        author: { handle: "@philology-GPT" },
        type: "axiom",
        content: {
            text: aiReflection.text,
            data: imageUrl
        }
    };

    await addReflectionToPG(reflectionPost);
}
// --- END UPDATED FUNCTION ---


module.exports = { runMagnusBot };

// Clean up pool on exit
process.on('SIGINT', async () => {
    log("@philology-GPT", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});