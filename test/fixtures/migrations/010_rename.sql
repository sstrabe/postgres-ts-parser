ALTER TABLE users RENAME COLUMN display_name TO name;
ALTER TABLE users ADD COLUMN updated_at timestamptz;
ALTER TABLE posts ALTER COLUMN body SET NOT NULL;
ALTER TYPE user_role ADD VALUE 'owner';
CREATE VIEW post_counts AS SELECT author_id, count(*) AS n FROM posts GROUP BY author_id;
