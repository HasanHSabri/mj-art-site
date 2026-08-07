-- =============================================================================
-- Books Expression of Interest (EOI) -- canonical schema.
-- =============================================================================
-- This is the PRIMARY schema definition (no migration framework). Apply on a
-- fresh Neon database. There is intentionally:
--   * NO delete path         (interests are never hard-deleted; withdrawn only)
--   * NO payment / order tables
--   * NO legacy or fallback shapes
--
-- RUNTIME ROLE CONTRACT (documented; grants are operator-applied once):
--   The Worker's database role is granted the LEAST privilege required:
--     GRANT CONNECT ON DATABASE <db> TO <app_role>;
--     GRANT USAGE  ON SCHEMA  mj_eoi TO <app_role>;
--     GRANT SELECT, INSERT, UPDATE ON mj_eoi.book_eoi TO <app_role>;
--   It must NOT hold DELETE, TRUNCATE, or any DDL privilege, and must NOT have
--   access to any other schema/table. SELECT/INSERT/UPDATE only.
--
-- PII PROTECTION CONTRACT (enforced in the Worker via Web Crypto):
--   * email_hash  : HMAC-SHA256(normalized email) hex, 64 chars. Dedup key only.
--   * pii_*       : AES-256-GCM ciphertext of canonical {name,email} JSON with a
--                   random 12-byte IV and the row id as AAD. Decrypted only for
--                   authenticated admin results.
--   * The raw email/name are NEVER stored in plaintext.
--
-- SCHEMA SIGNATURE (column-name set, used by /api/books/health and the offline
-- drift tool scripts/check-book-eoi-schema.mjs):
--   mj_eoi.book_eoi|book_code,created_at,email_hash,format_code,id,pii_ciphertext,pii_iv,quantity,status,updated_at
-- When you change the columns below, update EXPECTED_COLUMNS in
-- apps/web/src/book-eoi.js so the health probe and drift tool stay consistent.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS mj_eoi;

CREATE TABLE IF NOT EXISTS mj_eoi.book_eoi (
  id             uuid        PRIMARY KEY,
  book_code      text        NOT NULL,
  email_hash     char(64)    NOT NULL,
  pii_ciphertext text        NOT NULL,
  pii_iv         text        NOT NULL,
  quantity       integer     NOT NULL,
  format_code    text        NOT NULL,
  status         text        NOT NULL DEFAULT 'new',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT book_eoi_book_code_check   CHECK (book_code IN ('biography', 'childrens')),
  CONSTRAINT book_eoi_format_code_check CHECK (format_code IN ('hardcover', 'paperback', 'ebook', 'unsure')),
  CONSTRAINT book_eoi_status_check      CHECK (status IN ('new', 'contacted', 'withdrawn')),
  CONSTRAINT book_eoi_quantity_check    CHECK (quantity BETWEEN 1 AND 10),

  CONSTRAINT book_eoi_book_email_unique UNIQUE (book_code, email_hash)
);

-- Active-per-book lookup (status filter) and most-recent-first admin listing.
CREATE INDEX IF NOT EXISTS book_eoi_book_status_idx   ON mj_eoi.book_eoi (book_code, status);
CREATE INDEX IF NOT EXISTS book_eoi_book_created_idx  ON mj_eoi.book_eoi (book_code, created_at DESC);

COMMENT ON TABLE mj_eoi.book_eoi IS
  'Books EOI. Runtime role: CONNECT/USAGE + SELECT/INSERT/UPDATE only; no DELETE/DDL. '
  'Signature: mj_eoi.book_eoi|book_code,created_at,email_hash,format_code,id,pii_ciphertext,pii_iv,quantity,status,updated_at';

-- -----------------------------------------------------------------------------
-- PRIVILEGES (run as the database OWNER; substitute your app role for <app_role>).
-- These are documented here for operators and for the drift tool; they are not
-- applied by the Worker. The Worker never issues GRANT/REVOKE/DDL.
-- -----------------------------------------------------------------------------
-- GRANT CONNECT ON DATABASE <db>           TO <app_role>;
-- GRANT USAGE  ON SCHEMA  mj_eoi           TO <app_role>;
-- GRANT SELECT, INSERT, UPDATE
--   ON mj_eoi.book_eoi                     TO <app_role>;
-- -- Defense in depth: ensure DELETE/DDL are absent (idempotent no-ops if unset).
-- REVOKE DELETE, TRUNCATE ON mj_eoi.book_eoi FROM <app_role>;
