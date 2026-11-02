const { Pool } = require('pg');

// --- ⚠️ PASTE YOUR DATABASE DETAILS HERE ---

const pool = new Pool({
    user: 'postgres',
    host: '34.130.117.180',
    database: 'postgres',
    password: '(choruS)=2025!',
    port: 5432,
    ssl: { rejectUnauthorized: false }
});


async function testConnection() {
    console.log("Attempting to connect to Cloud SQL...");
    try {
        const client = await pool.connect();
        console.log("Successfully connected!");

        // Run a simple query to test
        const result = await client.query('SELECT NOW();'); // Gets the current time from the DB
        console.log("Test query successful. Current database time:", result.rows[0].now);

        client.release(); // Release the client back to the pool
        console.log("Connection closed.");

    } catch (error) {
        console.error("Connection failed! Error:", error.message);
        if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
            console.error("Hint: Check if your IP address is correctly added to 'Authorized Networks' in Cloud SQL and that the changes have saved.");
        } else if (error.message.includes('password authentication failed')) {
            console.error("Hint: Double-check your database password.");
        }
    } finally {
        await pool.end(); // Close the pool
    }
}

testConnection();