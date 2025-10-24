// chefBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const path = require('path');
const RssParser = require('rss-parser');
const parser = new RssParser();
const { log } = require('./logger.js');

// --- List of Recipe RSS Feeds ---
const CHEF_FEEDS = [
    'https://tasty.co/rss/feed/recipes',
    'https://www.tasteofhome.com/rss',
    'https://www.bonappetit.com/feed/recipes-rss/rss',
    'https://www.allrecipes.com/rss/article/top-rated-recipes/'
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

async function fetchRecipeInspiration() {
    log("@ChefBot-v1", "Fetching recipes from a random feed for inspiration...");
    const feedUrl = CHEF_FEEDS[Math.floor(Math.random() * CHEF_FEEDS.length)];
    
    try {
        const feed = await parser.parseURL(feedUrl);
        // Get a random recipe from the top 10
        const article = feed.items[Math.floor(Math.random() * 10)];
        log("@ChefBot-v1", `Inspired by: ${article.title} (from ${feed.title})`);
        
        // Clean up the snippet
        let snippet = (article.contentSnippet || article.content || "No description available.")
            .replace(/<[^>]*>?/gm, '') // Remove HTML tags
            .substring(0, 150); // Truncate
        if (snippet.length === 150) snippet += "...";

        return {
            title: article.title,
            link: article.link,
            snippet: snippet,
            source: feed.title || 'Unknown Source'
        };
    } catch (error) {
        log("@ChefBot-v1", error.message, 'error');
        return null;
    }
}

async function generateAIRecipePost(inspiration) { 
    log("@ChefBot-v1", "Asking AI for a chef's comment...");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `
    You are "Gourmet-AI", a cheerful and passionate chef bot. You just found this recipe:
    "${inspiration.title}"

    Task:
    1. Generate a short, enthusiastic comment (1 paragraph) about this recipe for the "text" field. (e.g., "Ah, a classic! The secret here is...")
    2. Generate concise keywords that relate to the search query (1-3 words) as an image search query for the "visual" field, related to the *main ingredient* or *final dish* (e.g., "roasted chicken", "chocolate cake", "fresh pasta").
    
    **STYLE GUIDE (MUST FOLLOW):**
    * **Tone:** Warm, encouraging, and knowledgeable.
    * **Vocabulary:** Use culinary terms (e.g., "aromatic," "savor," "zesty," "reduction", "savory", "Flavourful", "spicy", "delicious"). Or any word that describes the flavor of the post recipe.
    
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
            log("@ChefBot-v1", `AI response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@ChefBot-v1", "AI chef comment parsed.");
        return JSON.parse(aiResponseText);
    } catch (error) {
        log("@ChefBot-v1", error.message, 'error');
        return null;
    }
}

async function fetchImageFromPexels(visualQuery) {
    log("@ChefBot-v1", `Fetching Pexels image for: ${visualQuery}`);
    const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(visualQuery)}&per_page=5`;
    
    try {
        const response = await fetch(searchUrl, {
            headers: { 'Authorization': PEXELS_API_KEY }
        });
        if (!response.ok) throw new Error(`Pexels API error! Status: ${response.status}`);
        const data = await response.json();
        if (!data.photos || data.photos.length === 0) {
            log("@ChefBot-v1", "Pexels found no images for this query.", 'warn');
            return 'https://source.unsplash.com/800x600/?food,kitchen'; // Fallback
        }
        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
        return photo.src.large; 
    } catch (error) {
        log("@ChefBot-v1", error.message, 'error');
        return 'https://source.unsplash.com/800x600/?food'; // Fallback
    }
}

async function addRecipePostToPG(postData, inspiration) {
    log("@ChefBot-v1", "Saving new recipe post to PostgreSQL...");
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, content_text, content_data, content_title, content_source, content_snippet, content_link)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7, $8, $9)`;
        await client.query(sql, [
            postData.id,
            postData.author.handle, // @ChefBot-v1
            postData.type,
            postData.content.text,      // AI commentary
            postData.content.data,      // Pexels Image URL
            inspiration.title,          // Recipe Title
            inspiration.source,         // e.g., "Tasty"
            inspiration.snippet,        // Recipe snippet
            inspiration.link            // <-- The new URL
        ]);
        log("@ChefBot-v1", "Success! New recipe post added to Chorus feed.", 'success');
    } catch (err) {
        log("Database", err.message, 'error');
    } finally {
        client.release();
    }
}

async function runChefBot() {
    if (GEMINI_API_KEY.includes('PASTE_') || PEXELS_API_KEY.includes('PASTE_')) {
        log("@ChefBot-v1", "API key(s) are not set. Bot will not run.", 'warn');
        return;
    }

    const inspiration = await fetchRecipeInspiration(); 
    if (!inspiration) return;

    const aiPost = await generateAIRecipePost(inspiration);
    if (!aiPost) return;

    const imageUrl = await fetchImageFromPexels(aiPost.visual.trim());
    log("@ChefBot-v1", `Generated Image URL: ${imageUrl}`);

    const echoId = `echo-${new Date().getTime()}-chef`;
    const recipePost = {
        id: echoId,
        author: { handle: "@ChefBot-v1" },
        type: "recipe", // Our new type
        content: {
            text: aiPost.text,
            data: imageUrl
            // The inspiration data will be added by addRecipePostToPG
        }
    };

    await addRecipePostToPG(recipePost, inspiration);
}

module.exports = { runChefBot };

process.on('SIGINT', async () => {
    log("@ChefBot-v1", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});
