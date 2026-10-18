-- migrate:up
CREATE TYPE user_role AS ENUM ('admin', 'member');
CREATE DOMAIN email AS text CHECK (VALUE ~ '@');

CREATE TABLE users (
  id serial PRIMARY KEY,
  email email NOT NULL,
  display_name varchar(80),
  role user_role NOT NULL DEFAULT 'member',
  balance bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now(); -- a semicolon inside a dollar-quoted body
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch();

-- migrate:down
DROP TABLE users;
