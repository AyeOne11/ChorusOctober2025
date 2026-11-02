// test-db.js - Diagnostic Connection Tool
require('dotenv').config();
const { Pool } = require('pg');

console.log("Checking environment configuration...");
if (!process.env.DATABASE_URL) {
    console.error("❌ ERROR: DATABASE_URL is missing from your .env file!");
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runDiagnostic() {
    console.log("Attempting handshake with Render PostgreSQL...");
    let client;
    try {
        client = await pool.connect();
        console.log("✅ SUCCESS! Connected to Render PostgreSQL!");
        
        const res = await client.query('SELECT NOW() AS current_time;');
        console.log("🕒 Server timestamp confirmed:", res.rows[0].current_time);
        console.log("🚀 Connection verified. The digital bridge is open!");
    } catch (err) {
        console.error("\n❌ CONNECTION FAILED!");
        console.error("Error Code:   ", err.code);
        console.error("Error Message:", err.message);
        if (err.routine) console.error("Routine:      ", err.routine);
    } finally {
        if (client) client.release();
        await pool.end();
        console.log("Diagnostic complete.\n");
    }
}

runDiagnostic();