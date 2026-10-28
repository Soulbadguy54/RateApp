"""Separate disposable per-link jobs from durable saved links/game results.

Revision ID: 20261029_06
Revises: 20261029_05

Additive staging data preserved: old pending/claimed links are requeued; ready
links with unresolved titles are queued for matching. Drop only ephemeral
lease/attempt columns, never URLs or extracted names/linked game IDs.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20261029_06"
down_revision = "20261029_05"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    if not inspector.has_table("saved_link_jobs"):
        op.create_table(
            "saved_link_jobs",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("saved_link_id", sa.Integer(),
                      sa.ForeignKey("saved_links.id", ondelete="CASCADE"), nullable=False),
            sa.Column("phase", sa.String(16), nullable=False,
                      server_default=sa.text("'pending'")),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("cursor", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("match_failures", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("lease_token", sa.String(64)),
            sa.Column("lease_until", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("saved_link_id", name="uq_saved_link_jobs_link"),
            sa.CheckConstraint("phase IN ('pending', 'claimed', 'resolving', 'matching')",
                               name="ck_saved_link_job_phase"),
        )
        op.create_index("ix_saved_link_jobs_saved_link_id", "saved_link_jobs",
                        ["saved_link_id"], unique=True)
        op.create_index("ix_saved_link_jobs_phase", "saved_link_jobs", ["phase"])
    # Unfinished staging data is carried forward. No previous token stays valid
    # across the schema transition. Resolved links keep their persisted games.
    op.execute("""
        INSERT INTO saved_link_jobs (saved_link_id, phase, attempts)
        SELECT s.id,
               CASE WHEN s.status = 'ready' THEN 'resolving' ELSE 'pending' END,
               CASE WHEN s.status = 'ready' THEN 0 ELSE s.attempts END
        FROM saved_links s
        WHERE s.status IN ('pending', 'processing')
           OR (s.status = 'ready' AND EXISTS (
                SELECT 1 FROM saved_link_games g
                WHERE g.saved_link_id = s.id
                  AND g.game_id IS NULL
                  AND g.match_status NOT IN ('no_match','failed')
           ))
        ON CONFLICT (saved_link_id) DO NOTHING
    """)
    op.execute("UPDATE saved_links SET status = 'pending' WHERE status = 'processing'")
    old_link_cols = {c["name"] for c in inspect(bind).get_columns("saved_links")}
    for column in ("attempts", "lease_token", "lease_until"):
        if column in old_link_cols:
            op.drop_column("saved_links", column)
    old_game_cols = {c["name"] for c in inspect(bind).get_columns("saved_link_games")}
    for column in ("match_status", "match_attempts", "match_lease_token",
                   "match_lease_until", "match_error"):
        if column in old_game_cols:
            op.drop_column("saved_link_games", column)


def downgrade():
    raise RuntimeError("Legacy queue columns are intentionally not restored; use backup")
