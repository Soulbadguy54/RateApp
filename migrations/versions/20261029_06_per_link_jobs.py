"""Durable saved-link game-id array plus disposable per-link work queue.

Revision ID: 20261029_06
Revises: 20261029_05
Existing linked games are copied before retiring the old name/game join table.
Old unresolved names migrate into disposable jobs, not permanent records.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import ARRAY

revision = "20261029_06"
down_revision = "20261029_05"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    link_columns = {c["name"] for c in inspector.get_columns("saved_links")}
    if "game_ids" not in link_columns:
        op.add_column("saved_links", sa.Column(
            "game_ids", ARRAY(sa.Integer()), nullable=False,
            server_default=sa.text("'{}'::integer[]"),
        ))
    if "ix_saved_links_game_ids_gin" not in {ix["name"] for ix in inspect(bind).get_indexes("saved_links")}:
        op.create_index("ix_saved_links_game_ids_gin", "saved_links", ["game_ids"], postgresql_using="gin")
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
            sa.Column("names", ARRAY(sa.Text()), nullable=False,
                      server_default=sa.text("'{}'::text[]")),
            sa.Column("resolved_ids", ARRAY(sa.Integer()), nullable=False,
                      server_default=sa.text("'{}'::integer[]")),
            sa.CheckConstraint("phase IN ('pending', 'claimed', 'resolving', 'matching')",
                               name="ck_saved_link_job_phase"),
        )
        op.create_index("ix_saved_link_jobs_saved_link_id", "saved_link_jobs",
                        ["saved_link_id"], unique=True)
        op.create_index("ix_saved_link_jobs_phase", "saved_link_jobs", ["phase"])
    else:
        job_cols = {c["name"] for c in inspect(bind).get_columns("saved_link_jobs")}
        for column, type_, default in (
            ("names", ARRAY(sa.Text()), "'{}'::text[]"),
            ("resolved_ids", ARRAY(sa.Integer()), "'{}'::integer[]"),
        ):
            if column not in job_cols:
                op.add_column("saved_link_jobs", sa.Column(
                    column, type_, nullable=False, server_default=sa.text(default),
                ))

    if inspect(bind).has_table("saved_link_games"):
        # Preserve existing matching in internal catalog PKs, ordered by the
        # original mention order; old matched names are never discarded first.
        op.execute("""
            UPDATE saved_links AS s SET game_ids = m.ids
            FROM (
                SELECT saved_link_id,
                       array_agg(game_id ORDER BY id) FILTER (WHERE game_id IS NOT NULL) AS ids
                FROM saved_link_games GROUP BY saved_link_id
            ) AS m WHERE s.id = m.saved_link_id AND m.ids IS NOT NULL
        """)
        if "attempts" in link_columns:
            op.execute("""
                INSERT INTO saved_link_jobs
                       (saved_link_id, phase, attempts, names, resolved_ids)
                SELECT s.id,
                       CASE WHEN s.status = 'ready' THEN 'resolving' ELSE 'pending' END,
                       CASE WHEN s.status = 'ready' THEN 0 ELSE LEAST(s.attempts, 2) END,
                       COALESCE((SELECT array_agg(g.name ORDER BY g.id)
                                 FROM saved_link_games g
                                 WHERE g.saved_link_id = s.id), '{}'::text[]),
                       s.game_ids
                FROM saved_links s
                WHERE s.status IN ('pending', 'processing')
                   OR (s.status = 'ready' AND EXISTS (
                       SELECT 1 FROM saved_link_games g
                       WHERE g.saved_link_id = s.id AND g.game_id IS NULL
                             AND g.match_status NOT IN ('no_match','failed')
                   ))
                ON CONFLICT (saved_link_id) DO NOTHING
            """)
            op.execute("UPDATE saved_links SET status = 'pending' WHERE status = 'processing'")
        op.drop_table("saved_link_games")  # after copying both IDs and queued names

    for column in ("attempts", "lease_token", "lease_until"):
        if column in link_columns:
            op.drop_column("saved_links", column)

    # PostgreSQL arrays have no per-element FK. Prevent dangling IDs even if
    # future catalog maintenance introduces game deletion.
    op.execute("""
        CREATE OR REPLACE FUNCTION rateapp_saved_links_prune_deleted_game()
        RETURNS TRIGGER LANGUAGE plpgsql AS $saved_links_cleanup$
        BEGIN
            UPDATE saved_links
               SET game_ids = array_remove(game_ids, OLD.id)
             WHERE game_ids @> ARRAY[OLD.id]::integer[];
            RETURN OLD;
        END;
        $saved_links_cleanup$
    """)
    op.execute("""
        DROP TRIGGER IF EXISTS trg_saved_links_game_deleted ON games
    """)
    op.execute("""
        CREATE TRIGGER trg_saved_links_game_deleted
        AFTER DELETE ON games
        FOR EACH ROW EXECUTE FUNCTION rateapp_saved_links_prune_deleted_game()
    """)


def downgrade():
    raise RuntimeError("Old name/game association cannot be restored without backup")
