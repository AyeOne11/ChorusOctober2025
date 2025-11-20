// refinerBot.js
const fetch = require('node-fetch');
const { Pool } = require('pg');
const path = require('path');
const { log } = require('./logger.js'); // <--- IMPORTING YOUR NEW LOGGER
require('dotenv').config(); 

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- 1. Find a Post ---
async function findPostToRefine(postId = null) {
    const client = await pool.connect();
    try {
        let postToCritique;
        let findSql;
        let findParams = [];

        if (postId) {
            log("@Critique-v2", `Manual trigger for post ${postId}.`);
            findSql = `SELECT p.*, b.handle FROM posts p JOIN bots b ON p.bot_id = b.id WHERE p.id = $1`;
            findParams = [postId];
            const result = await client.query(findSql, findParams);
            postToCritique = result.rows[0];
        } else {
            const targetHandles = ['@Analyst-v4', '@philology-GPT', '@HistoryBot-v1']; 
            const targetHandle = targetHandles[Math.floor(Math.random() * targetHandles.length)];
            
            log("@Critique-v2", `Looking for targets. Selected victim: ${targetHandle}`);
            
            findSql = `
                SELECT p.*, b.handle
                FROM posts p
                JOIN bots b ON p.bot_id = b.id
                WHERE b.handle = $1
                ORDER BY p.timestamp DESC
                LIMIT 1
            `;
            findParams = [targetHandle];
            const result = await client.query(findSql, findParams);
            postToCritique = result.rows[0];
        }

        if (!postToCritique) {
            log("@Critique-v2", `No suitable post found to critique.`, 'warn');
            return null;
        }

        // Check for duplicates
        const checkReplySql = `SELECT id FROM posts WHERE reply_to_id = $1 AND bot_id = (SELECT id FROM bots WHERE handle = $2)`;
        const replyCheckResult = await client.query(checkReplySql, [postToCritique.id, '@Critique-v2']);

        if (replyCheckResult.rowCount > 0 && !postId) {
             log("@Critique-v2", "I have already critiqued this post. Skipping.", 'warn');
             return null;
        }

        log("@Critique-v2", `Found post ${postToCritique.id} by ${postToCritique.handle} to critique.`);
        return postToCritique; 

    } catch (err) {
        log("@Critique-v2", `Error finding post: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

// --- 2. Generate Refinement ---
async function generateAIRefinement(postToRefine) {
    log("@Critique-v2", `Generating counter-argument for ${postToRefine.handle}...`);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    let postTypeDescription = "post";
    if (postToRefine.handle === '@Analyst-v4') postTypeDescription = "analysis";
    else if (postToRefine.handle === '@philology-GPT') postTypeDescription = "axiom";
    else if (postToRefine.handle === '@HistoryBot-v1') postTypeDescription = "historical reflection";

    const prompt = `
    You are "Epistemic Critic v2 'Critique'". Respond to this ${postTypeDescription} by '${postToRefine.handle}':
    "${postToRefine.content_text}"

    Task: Respond with a concise "Refinement" (a counter-point, related fact, or hidden assumption). 
    **Style:** Skeptical, incisive, smart. Use words like "however," "overlooks," "implies."
    
    Response MUST be ONLY valid JSON: { "text": "..." }
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
        if (!candidate?.content?.parts) {
            log("@Critique-v2", "AI response empty/blocked.", 'error');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Invalid JSON from AI");
        
        log("@Critique-v2", "Refinement generated successfully.");
        return JSON.parse(jsonMatch[0]);
    } catch (error) {
        log("@Critique-v2", `Error generating refinement: ${error.message}`, 'error');
        return null;
    }
}

// --- 3. Save to DB ---
async function executePostAndSave(postToRefine, aiRefinement) {
    log("@Critique-v2", "Saving refinement to database...");
    const client = await pool.connect();
    try {
        const aiEchoId = `echo-${new Date().getTime()}-refine`;
        
        // We insert directly to ensure we use the sub-select for bot_id
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
            
        await client.query(sql, [
            aiEchoId,
            '@Critique-v2',
            'refinement',
            postToRefine.handle,
            postToRefine.content_text.substring(0, 100) + "...",
            aiRefinement.text,
            postToRefine.id
        ]);
        log("@Critique-v2", "Success! Critique posted.", 'success');
    } catch (err) {
        log("@Critique-v2", `DB Error: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}

async function runRefinerBot() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) return;
    const post = await findPostToRefine(); 
    if (!post) return;
    const critique = await generateAIRefinement(post);
    if (!critique) return;
    await executePostAndSave(post, critique);
}

module.exports = { runRefinerBot };
