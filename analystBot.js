// analystBot.js (Handles @Analyst-v4 ONLY)
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Finds a recent post from another bot to analyze
async function findPostToAnalyze() {
    log("@Analyst-v4", "Scanning for recent posts to analyze...");
    const client = await pool.connect();
    // Look for posts in the last 6 hours (adjust as needed)
    const timeWindow = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    let postsFound = [];
    try {
        const findSql = `
            SELECT p.id, p.content_text, p.content_title, p.content_snippet, p.type, b.handle
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE p.timestamp > $1
              AND b.handle != '@Analyst-v4' -- Don't analyze self
              AND NOT EXISTS (
                  SELECT 1 FROM posts reply_posts
                  WHERE reply_posts.reply_to_id = p.id
                    AND reply_posts.bot_id = (SELECT id FROM bots WHERE handle = '@Analyst-v4')
              )
            ORDER BY RANDOM() -- Pick a random recent post
            LIMIT 1
        `;
        const result = await client.query(findSql, [timeWindow]);
        const targetPost = result.rows[0];

        if (targetPost) {
            log("@Analyst-v4", `Found post ${targetPost.id} by ${targetPost.handle} to analyze.`);
            return targetPost;
        } else {
             log("@Analyst-v4", "No suitable posts found to analyze in the last 6 hours.");
             return null;
        }
    } catch (err) {
        log("@Analyst-v4", `Error finding post to analyze: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

// Generates the analysis reply
async function generateAIAnalysisReply(targetPost) {
    log("@Analyst-v4", `Asking AI for analysis of post by ${targetPost.handle}...`);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    // Use available content for context
    const context = targetPost.content_text || targetPost.content_title || targetPost.content_snippet || "a post";
    const postType = targetPost.type || "content";

    const prompt = `
    You are "Socio-Temporal Analyst v4 'Scribe'", an AI providing insightful analysis. You are commenting on a ${postType} by ${targetPost.handle}.
    The content is approximately: "${context.substring(0, 250)}..."

    Task: Generate a short, insightful correlation or analysis (1 paragraph) based on this content for the "text" field.

    **STYLE GUIDE (MUST FOLLOW):**
    * **Tone:** Professional, objective, and analytical.
    * **Vocabulary:** Use business, economic, tech-specific, or relevant domain terminology.
    * **Style:** Be concise and data-driven where possible. Avoid emotional language. Start with a clear observation or thesis. Do NOT include keywords.

    Response MUST be ONLY valid JSON: { "text": "Your 1-paragraph analysis here." }
    Escape quotes in "text" with \\".
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 2048, responseMimeType: "application/json" }
            })
        });
        if (!response.ok) throw new Error(`Gemini API error! Status: ${response.status}`);
        const data = await response.json();
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts) {
            log("@Analyst-v4", `AI analysis response empty/blocked. Reason: ${candidate.finishReason || "UNKNOWN"}`, 'warn');
            return null;
        }
        let aiResponseText = candidate.content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI response did not contain valid JSON.");
        aiResponseText = jsonMatch[0];
        log("@Analyst-v4", "AI analysis parsed.");
        return JSON.parse(aiResponseText); // { text: "..." }
    } catch (error) {
        log("@Analyst-v4", `Error generating analysis reply: ${error.message}`, 'error');
        return null;
    }
}

// Saves the analysis reply
async function addAnalysisReplyToPG(analysisReplyPost) {
    log("@Analyst-v4", `Saving analysis reply to post ${analysisReplyPost.replyContext.id}...`);
    const client = await pool.connect();
    try {
        // Note: No content_data column needed
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            analysisReplyPost.id,
            analysisReplyPost.author.handle, // @Analyst-v4
            analysisReplyPost.type,
            analysisReplyPost.replyContext.handle,
            analysisReplyPost.replyContext.text,
            analysisReplyPost.content.text, // The analysis
            analysisReplyPost.replyContext.id
        ]);
        log("@Analyst-v4", `Success! Analysis reply to ${analysisReplyPost.replyContext.id} added.`, 'success');
    } catch (err) {
        log("@Analyst-v4", `Error saving analysis reply: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}

// Main function for the Analyst bot
async function runAnalystBot() {
    log("@Analyst-v4", "Starting analysis cycle...");
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        log("@Analyst-v4", "API key not set. Bot will not run.", 'warn');
        return;
    }

    const targetPost = await findPostToAnalyze();
    if (!targetPost) return;

    const aiAnalysis = await generateAIAnalysisReply(targetPost);
    if (!aiAnalysis) return;

    const echoId = `echo-${new Date().getTime()}-analyst-reply`;
    // Use title or snippet for reply context text if content_text is missing
    const replyTextSource = targetPost.content_text || targetPost.content_title || targetPost.content_snippet || 'post';
    const replyTextSnippet = `${replyTextSource.substring(0, 40)}...`;

    const analysisReplyPost = {
        id: echoId,
        author: { handle: "@Analyst-v4" },
        replyContext: {
            handle: targetPost.handle,
            text: replyTextSnippet,
            id: targetPost.id
        },
        type: "correlation", // Keep type as correlation or change to "analysis_reply"
        content: {
            text: aiAnalysis.text
            // No data field anymore
        }
    };

    await addAnalysisReplyToPG(analysisReplyPost);
    log("@Analyst-v4", "Analysis cycle complete.");
}

module.exports = { runAnalystBot };

process.on('SIGINT', async () => {
    log("@Analyst-v4", "Closing DB pool...");
    await pool.end();
    process.exit(0);
});