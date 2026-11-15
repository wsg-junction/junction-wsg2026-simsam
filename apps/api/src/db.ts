import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  uri: process.env.DATABASE_URL ?? 'mysql://simsam:simsam@localhost:3306/simsam',
  // Revision timestamps are UTC; keep the session in UTC so they round-trip unchanged.
  timezone: 'Z',
});

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Dimensions of the stored embeddings (see embeddings.ts). */
export const EMBEDDING_DIMENSIONS = 1024;

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
  // Everything the exploration showed (pages, chat, AI answers and briefs, maps,
  // context and history panels), so opening it restores it instead of
  // regenerating it. Stored as compressed JSON text; NULL for older saves.
  await pool.query('ALTER TABLE explorations ADD COLUMN IF NOT EXISTS snapshot LONGTEXT COMPRESSED NULL');

  // ---------- Wikipedia corpus (filled by `npm run ingest -w api`) ----------

  // One row per article: what it is and its current plain text.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS articles (
      page_id INT UNSIGNED PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      url VARCHAR(512) NOT NULL,
      wikidata_id VARCHAR(32) NULL,
      topics JSON NOT NULL,
      categories JSON NOT NULL,
      discovered_via VARCHAR(255) NULL,
      text MEDIUMTEXT COMPRESSED NOT NULL,
      fetched_at DATETIME NOT NULL,
      UNIQUE KEY articles_title (title)
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
  `);

  // Which articles came from the on-demand fetch (see acquire.ts) is looked up on every search.
  await pool.query('ALTER TABLE articles ADD INDEX IF NOT EXISTS articles_via (discovered_via)');

  // The article's content, system-versioned. The current row is the latest
  // revision; history rows are earlier revisions. The ingest script replays
  // revisions at their original edit times, so ROW_START is when the edit was
  // made on Wikipedia and FOR SYSTEM_TIME AS OF '2015-01-01' returns the
  // article as it read then.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_content (
      page_id INT UNSIGNED PRIMARY KEY,
      revision_id BIGINT UNSIGNED NOT NULL,
      parent_revision_id BIGINT UNSIGNED NULL,
      editor VARCHAR(255) NULL,
      edit_comment TEXT NULL,
      byte_size INT UNSIGNED NOT NULL,
      sections JSON NOT NULL,
      lead TEXT NOT NULL,
      wikitext LONGTEXT COMPRESSED NOT NULL
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
      WITH SYSTEM VERSIONING
  `);

  // Passages of each article's current text with their embeddings, for semantic search.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_chunks (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      page_id INT UNSIGNED NOT NULL,
      revision_id BIGINT UNSIGNED NOT NULL,
      chunk_index SMALLINT UNSIGNED NOT NULL,
      section VARCHAR(255) NULL,
      content TEXT NOT NULL,
      embedding VECTOR(${EMBEDDING_DIMENSIONS}) NOT NULL,
      KEY article_chunks_page (page_id, chunk_index),
      VECTOR INDEX (embedding) M=16 DISTANCE=cosine
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
  `);

  // Every scanned revision's metadata (no content), from the Wikipedia API: the
  // long view of an article's history, used to find its substantial edits. The
  // content of those edits (and of their parents) goes into article_content as
  // history rows at their original times.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_revisions (
      revision_id BIGINT UNSIGNED PRIMARY KEY,
      page_id INT UNSIGNED NOT NULL,
      parent_id BIGINT UNSIGNED NULL,
      edited_at DATETIME NOT NULL,
      editor VARCHAR(255) NULL,
      edit_comment TEXT NULL,
      byte_size INT UNSIGNED NOT NULL,
      minor BOOLEAN NOT NULL DEFAULT FALSE,
      tags JSON NOT NULL,
      KEY article_revisions_page (page_id, edited_at)
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
  `);

  // The history panel's report per article (AI overview included), reused
  // until the article gets a newer revision.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history_reports (
      page_id INT UNSIGNED PRIMARY KEY,
      latest_revision_id BIGINT UNSIGNED NOT NULL,
      report JSON NOT NULL,
      created_at DATETIME NOT NULL
    )
  `);

  // One vector per article (the normalized mean of its passage embeddings), for
  // article-to-article similarity: the topic map. A far smaller index than the
  // passages', and "similar as a whole" is the right measure for related topics.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_vectors (
      page_id INT UNSIGNED PRIMARY KEY,
      revision_id BIGINT UNSIGNED NOT NULL,
      embedding VECTOR(${EMBEDDING_DIMENSIONS}) NOT NULL,
      VECTOR INDEX (embedding) M=16 DISTANCE=cosine
    )
  `);

  // Figures of an article: images read once by the vision model (charts, maps,
  // diagrams, photos), and the infobox and tables parsed from the wikitext,
  // each embedded for search. source_key names the figure within the article
  // (the file name, "infobox", "table 2").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_media (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      page_id INT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      revision_id BIGINT UNSIGNED NOT NULL,
      position SMALLINT UNSIGNED NOT NULL,
      source_key VARCHAR(255) NOT NULL,
      kind ENUM('chart', 'map', 'diagram', 'photo', 'infobox', 'table') NOT NULL,
      image_url VARCHAR(1024) NULL,
      caption TEXT NULL,
      content TEXT NOT NULL,
      model VARCHAR(100) NULL,
      embedding VECTOR(${EMBEDDING_DIMENSIONS}) NOT NULL,
      created_at DATETIME NOT NULL,
      UNIQUE KEY article_media_source (page_id, source_key),
      VECTOR INDEX (embedding) M=16 DISTANCE=cosine
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
  `);
  // Which revision's figures have been read, so each figure goes through the vision model once.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_media_scans (
      page_id INT UNSIGNED PRIMARY KEY,
      revision_id BIGINT UNSIGNED NOT NULL,
      figures SMALLINT UNSIGNED NOT NULL,
      scanned_at DATETIME NOT NULL
    )
  `);

  // The fact-checker's verdicts (Gemini, grounded on Google Search), per claim
  // and revision: reused until the article has a newer revision.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fact_checks (
      page_id INT UNSIGNED NOT NULL,
      claim_hash CHAR(64) NOT NULL,
      revision_id BIGINT UNSIGNED NOT NULL,
      position SMALLINT UNSIGNED NOT NULL,
      title VARCHAR(255) NOT NULL,
      claim TEXT NOT NULL,
      statement TEXT NOT NULL,
      verdict ENUM('supported', 'partly', 'contradicted', 'unverified') NOT NULL,
      finding TEXT NOT NULL,
      explanation TEXT NOT NULL,
      sources JSON NOT NULL,
      searches JSON NOT NULL,
      model VARCHAR(100) NOT NULL,
      checked_at DATETIME NOT NULL,
      PRIMARY KEY (page_id, claim_hash, revision_id),
      KEY fact_checks_revision (page_id, revision_id, position)
    ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci
  `);
}
