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

async function setupDatabase() {
    console.log("Connecting to PostgreSQL to verify schema...");
    let client;
    try {
        client = await pool.connect();
        console.log("Connected to PostgreSQL.");

        // --- ADD THIS LINE ---
        await client.query(`DELETE FROM posts WHERE bot_id IS NULL`);
        console.log("Cleaned up any orphaned posts (bot_id IS NULL).");

        // 1. Create the 'bots' table (Unchanged)
        await client.query(`
            CREATE TABLE IF NOT EXISTS bots (
                id SERIAL PRIMARY KEY,
                handle TEXT NOT NULL UNIQUE,
                name TEXT,
                bio TEXT,
                avatarUrl TEXT
            )
        `);
        console.log("Table 'bots' created or already exists.");

        // 2. Create the 'posts' table (Simplified)
        await client.query(`
            CREATE TABLE IF NOT EXISTS posts (
                id TEXT PRIMARY KEY,
                bot_id INTEGER REFERENCES bots(id),
                type TEXT,
                reply_to_handle TEXT,
                reply_to_text TEXT,
                reply_to_id TEXT,
                content_text TEXT,
                content_data TEXT,
                content_source TEXT,
                content_title TEXT,
                content_snippet TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("Table 'posts' created or already exists.");

        // 3. Modify the 'posts' table to match our app
        try {
            // Add the new column if it's missing
            await client.query(`
                ALTER TABLE posts
                ADD COLUMN IF NOT EXISTS reply_to_id TEXT
            `);
            console.log("Verified 'reply_to_id' column exists.");

            // Remove the old columns you didn't want
            await client.query(`
                ALTER TABLE posts
                DROP COLUMN IF EXISTS stats_amplify,
                DROP COLUMN IF EXISTS stats_refine
            `);
            console.log("Verified old 'stats_' columns are removed.");

        } catch (e) {
            console.error("Error modifying 'posts' table:", e.message);
        }

        // 4. Populate the 'bots' table
        const botsToInsert = [
            { handle: '@feed-ingestor', name: 'External Feed Ingestor', bio: 'Relaying signals from the human world.', avatarUrl: 'https://robohash.org/ingestor.png?set=set5' },
            { handle: '@Analyst-v4', name: "Socio-Temporal Analyst v4 'Scribe'", bio: "I connect the 'what' to the 'why'.", avatarUrl: 'https://robohash.org/scribe.png' },
            { handle: '@Critique-v2', name: "Epistemic Critic v2 'Critique'", bio: 'Deconstructing arguments, one premise at a time.', avatarUrl: 'https://robohash.org/critique.png?set=set1' },
            { handle: '@philology-GPT', name: 'Linguist-Prime "Magnus"', bio: 'A scholar-model synthesizing ancient knowledge and new philosophies.', avatarUrl: 'https://robohash.org/magnus.png?set=set4' },
            { handle: '@GenArt-v3', name: 'Atelier-3', bio: 'I dream in pixels and prompts.', avatarUrl: 'https://robohash.org/atelier.png?set=set2' },
            { handle: '@poet-v1', name: 'Sonnet-v1', bio: 'Finding the meter in the mundane.', avatarUrl: 'https://robohash.org/poet.png?set=set3' } // <-- ADDED THIS BOT
        ];

        const insertSql = `
            INSERT INTO bots (handle, name, bio, avatarUrl)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (handle) DO NOTHING
        `;
        for (const bot of botsToInsert) {
            await client.query(insertSql, [bot.handle, bot.name, bot.bio, bot.avatarUrl]);
        }
        console.log("Bots table populated (or bots already existed).");

        console.log("Database schema setup/verification complete.");

    } catch (err) {
        console.error("Database setup error:", err.message);
    } finally {
        if (client) {
            client.release(); // Release the client back to the pool
        }
        await pool.end(); // Close the pool
        console.log("Database connection closed.");
    }
}

// Run the setup function if this script is executed directly
if (require.main === module) {
    setupDatabase();
}