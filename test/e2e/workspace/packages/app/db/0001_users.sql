CREATE TABLE users (
    id              BIGINT PRIMARY KEY, -- snowflake
    username        TEXT NOT NULL,
    display_name    TEXT,
    avatar_file_id  BIGINT, -- files table does not exist yet
    kind            SMALLINT NOT NULL, -- core.v1.UserKind
    flags           INTEGER NOT NULL DEFAULT 0, -- core.v1.UserFlag bitfield
    email           TEXT,
    owner_id        BIGINT REFERENCES users (id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_username_length CHECK (char_length(username) BETWEEN 1 AND 32),
    CONSTRAINT users_display_name_length CHECK (display_name IS NULL OR char_length(display_name) <= 32),
    CONSTRAINT users_kind_valid CHECK (kind BETWEEN 1 AND 4),
    CONSTRAINT users_flags_nonnegative CHECK (flags >= 0),
    CONSTRAINT users_owner_not_self CHECK (owner_id IS NULL OR owner_id <> id)
);

CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_owner_id_idx ON users (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE user_external_refs (
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    platform     SMALLINT NOT NULL, -- core.v1.Platform
    external_id  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, platform),
    CONSTRAINT user_external_refs_platform_valid CHECK (platform >= 1),
    CONSTRAINT user_external_refs_platform_external_id_key UNIQUE (platform, external_id)
);

CREATE TABLE user_presence (
    user_id     BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    status      SMALLINT NOT NULL DEFAULT 4, -- core.v1.PresenceStatus
    activity    TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT user_presence_status_valid CHECK (status BETWEEN 1 AND 4),
    CONSTRAINT user_presence_activity_length CHECK (activity IS NULL OR char_length(activity) <= 128)
);

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
