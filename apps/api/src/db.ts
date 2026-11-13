import mysql from 'mysql2/promise';

export const pool = mysql.createPool(
  process.env.DATABASE_URL ?? 'mysql://simsam:simsam@localhost:3306/simsam',
);

// Minimal schema setup on startup. Swap for a migration tool once the schema grows.
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS explorations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      question VARCHAR(500) NOT NULL,
      focus_title VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Follow-up questions and dives, in order. Rows saved before this existed have NULL.
  await pool.query('ALTER TABLE explorations ADD COLUMN IF NOT EXISTS steps JSON NULL');
}
