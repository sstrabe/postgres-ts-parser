CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id int NOT NULL REFERENCES users(id),
  title text NOT NULL,
  body text,
  tags text[] NOT NULL DEFAULT '{}',
  meta jsonb
);
COMMENT ON COLUMN posts.title IS 'Shown in the feed';
