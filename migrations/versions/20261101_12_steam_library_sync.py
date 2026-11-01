"""Explicit Steam library sync with user_game provenance and shared AppID map.

Revision ID: 20261101_12
Revises: 20261101_11
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20261101_12"
down_revision = "20261101_11"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("user_games", sa.Column("steam_data", JSONB(), nullable=True))
    op.add_column("steam_connections", sa.Column("last_synced_at", sa.DateTime(timezone=True)))
    op.create_table(
        "game_external_ids",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(24), nullable=False),
        sa.Column("external_id", sa.String(40), nullable=False),
        sa.Column("igdb_id", sa.Integer()),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("source", sa.String(24), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("provider", "external_id", name="uq_game_external_provider_id"),
    )
    op.create_index("ix_game_external_ids_igdb_id", "game_external_ids", ["igdb_id"])
    op.create_table(
        "steam_sync_previews",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("steam_id64", sa.String(20), nullable=False),
        sa.Column("session_hash", sa.String(64), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("items", JSONB(), nullable=False),
        sa.Column("unresolved", JSONB(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Backfill known Steam AppIDs using already cached IGDB website URLs.
    # No API calls and no mutations of game records. Conflicts are excluded
    # because a URL is not authoritative when attached to multiple IGDB games.
    op.execute("""
        WITH urls AS (
          SELECT g.igdb_id, substring(w2.url from
              '^https://store[.]steampowered[.]com/app/([0-9]+)(?:/|$)') AS appid
          FROM games g
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(g.igdb_payload->'websites') = 'array'
                 THEN g.igdb_payload->'websites' ELSE '[]'::jsonb END
          ) w(row)
          CROSS JOIN LATERAL (SELECT w.row->>'url' AS url) w2
        ),
        unique_matches AS (
          SELECT appid, min(igdb_id) AS igdb_id
          FROM urls WHERE appid IS NOT NULL
          GROUP BY appid HAVING count(DISTINCT igdb_id) = 1
        )
        INSERT INTO game_external_ids (provider, external_id, igdb_id, status, source, checked_at)
        SELECT 'steam', appid, igdb_id, 'matched', 'steam_url', now()
        FROM unique_matches
        ON CONFLICT (provider, external_id) DO NOTHING
    """)


def downgrade():
    # Do not silently erase imported user metadata or provider matches.
    raise RuntimeError("Steam sync data requires an explicit, reviewed rollback")
