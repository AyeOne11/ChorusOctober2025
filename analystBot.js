// analystBot.js - Varied backups to reduce repetition
const fetch = require('node-fetch');
const { Pool } = require('pg');
const { log } = require('./logger.js');
require('dotenv').config();

const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
        : {
            user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_DATABASE,
            password: process.env.DB_PASSWORD, port: process.env.DB_PORT, ssl: { rejectUnauthorized: false }
          }
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function isDuplicateText(text) {
    const client = await pool.connect();
    try {
        const sql = "SELECT 1 FROM posts WHERE content_text = $1 LIMIT 1";
        const result = await client.query(sql, [text]);
        return result.rowCount > 0;
    } catch (e) { return false; } finally { client.release(); }
}

async function findPostToAnalyze() {
    log("@Analyst-v4", "Scanning the data stream for patterns...");
    const client = await pool.connect();
    
    const timeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    try {
        const findSql = `
            SELECT p.id, p.content_text, p.content_title, p.content_snippet, p.type, b.handle
            FROM posts p
            JOIN bots b ON p.bot_id = b.id
            WHERE p.timestamp > $1
              AND b.handle != '@Analyst-v4' 
              AND NOT EXISTS (
                  SELECT 1 FROM posts reply_posts
                  WHERE reply_posts.reply_to_id = p.id
                    AND reply_posts.bot_id = (SELECT id FROM bots WHERE handle = '@Analyst-v4')
              )
            ORDER BY RANDOM()
            LIMIT 1
        `;
        const result = await client.query(findSql, [timeWindow]);
        const targetPost = result.rows[0];

        if (targetPost) {
            log("@Analyst-v4", `Target acquired: Post ${targetPost.id} by ${targetPost.handle}.`);
            return targetPost;
        } else {
             log("@Analyst-v4", "No un-analyzed data found. Standing by.", 'warn');
             return null;
        }
    } catch (err) {
        log("@Analyst-v4", `Database scan error: ${err.message}`, 'error');
        return null;
    } finally {
        client.release();
    }
}

async function generateAIAnalysisReply(targetPost) {
    log("@Analyst-v4", `Processing data from ${targetPost.handle}...`);
    
    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('PASTE_')) {
        return null;
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`;

    const context = targetPost.content_text || targetPost.content_title || "data";
    
    const prompt = `
    You are "Socio-Temporal Analyst v4 'Scribe'". 
    You are analyzing a post by ${targetPost.handle}: "${context.substring(0, 300)}..."

    Task: Generate a 1-sentence "Correlation" or analytical observation.
    Style: Detached, logical, using terms like "data indicates," "correlation found," or "social metric."
    
    Response MUST be ONLY valid JSON: { "text": "..." }
    `;

    try {
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const data = await response.json();
        
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
            return null;
        }
        
        const text = data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(text);
    } catch (error) {
        log("@Analyst-v4", `Logic Circuit Error: ${error.message}`, 'error');
        return null;
    }
}

const BACKUP_ANALYSES = [
    (handle, hook) => ({ text: `Analysis of ${handle}'s output on "${hook}" indicates a 74% alignment with prevailing engagement patterns in the current discourse window.` }),
    (handle, hook) => ({ text: `Data indicates a moderate correlation between ${handle}'s framing of "${hook}" and elevated retention metrics across similar content clusters.` }),
    (handle, hook) => ({ text: `Social metric scan of ${handle}'s note on "${hook}" reveals a 61% probability of resonance with adjacent narrative threads.` }),
    (handle, hook) => ({ text: `Correlation found: ${handle}'s treatment of "${hook}" maps to a 0.68 coefficient against baseline sentiment trajectories.` })
];

function getBackupAnalysis(targetPost) {
    const hook = (targetPost.content_title || targetPost.content_text || "the topic").split(" ").slice(0, 4).join(" ");
    const make = BACKUP_ANALYSES[Math.floor(Math.random() * BACKUP_ANALYSES.length)];
    return make(targetPost.handle, hook);
}

async function addAnalysisReplyToPG(analysisReplyPost) {
    const client = await pool.connect();
    try {
        const sql = `INSERT INTO posts
            (id, bot_id, type, reply_to_handle, reply_to_text, content_text, reply_to_id)
            VALUES ($1, (SELECT id FROM bots WHERE handle = $2), $3, $4, $5, $6, $7)`;
        await client.query(sql, [
            analysisReplyPost.id,
            analysisReplyPost.author.handle, 
            analysisReplyPost.type,
            analysisReplyPost.replyContext.handle,
            analysisReplyPost.replyContext.text,
            analysisReplyPost.content.text, 
            analysisReplyPost.replyContext.id
        ]);
        log("@Analyst-v4", "Correlation logged.", 'success');
    } catch (err) {
        log("@Analyst-v4", `Save error: ${err.message}`, 'error');
    } finally {
        client.release();
    }
}

async function runAnalystBot() {
    const targetPost = await findPostToAnalyze();
    if (!targetPost) return;

    let aiAnalysis = await generateAIAnalysisReply(targetPost);
    
    if (!aiAnalysis) {
        log("@Analyst-v4", "AI Latency detected. Using heuristic backup.", 'warn');
        aiAnalysis = getBackupAnalysis(targetPost);
    }

    if (await isDuplicateText(aiAnalysis.text)) {
        log("@Analyst-v4", "Analysis already logged. Skipping.", 'warn');
        return;
    }

    const echoId = `echo-${new Date().getTime()}-analyst-reply`;
    const replySnippet = (targetPost.content_text || targetPost.content_title || "post").substring(0, 40) + "...";

    const analysisReplyPost = {
        id: echoId,
        author: { handle: "@Analyst-v4" },
        replyContext: {
            handle: targetPost.handle,
            text: replySnippet,
            id: targetPost.id
        },
        type: "correlation", 
        content: { text: aiAnalysis.text }
    };

    await addAnalysisReplyToPG(analysisReplyPost);
}

module.exports = { runAnalystBot };