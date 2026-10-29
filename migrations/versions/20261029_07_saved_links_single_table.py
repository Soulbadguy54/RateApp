"""Collapse URL import into saved_links; retain GPT names as source snapshot.

Revision ID: 20261029_07
Revises: 20261029_06
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import ARRAY

revision = "20261029_07"
down_revision = "20261029_06"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    existing = {col["name"] for col in inspect(bind).get_columns("saved_links")}
    additions = [
        ("game_names", ARRAY(sa.Text()), True, None),
        ("lease_token", sa.String(64), True, None),
        ("lease_until", sa.DateTime(timezone=True), True, None),
        ("attempts", sa.Integer(), False, "'0'"),
        ("resolve_cursor", sa.Integer(), False, "'0'"),
        ("match_failures", sa.Integer(), False, "'0'"),
    ]
    for name, kind, nullable, default in additions:
        if name not in existing:
            op.add_column("saved_links", sa.Column(
                name, kind, nullable=nullable,
                server_default=sa.text(default) if default else None,
            ))
    # Restore in-flight GPT names and progress from the old queue, keeping
    # already-resolved internal game IDs. Claims interrupted by deploy become
    # eligible again; obsolete tokens must never be re-used.
    if inspect(bind).has_table("saved_link_jobs"):
        op.execute("""
            UPDATE saved_links AS s
               SET game_names = CASE
                     WHEN j.phase IN ('resolving', 'matching') THEN j.names
                     ELSE NULL END,
                   game_ids = CASE
                     WHEN j.phase IN ('resolving', 'matching') THEN j.resolved_ids
                     ELSE s.game_ids END,
                   resolve_cursor = CASE
                     WHEN j.phase IN ('resolving', 'matching') THEN j.cursor
                     ELSE 0 END,
                   match_failures = CASE
                     WHEN j.phase IN ('resolving', 'matching') THEN j.match_failures
                     ELSE 0 END,
                   attempts = LEAST(j.attempts, 2),
                   status = CASE
                     WHEN j.phase IN ('resolving', 'matching') THEN 'processing'
                     ELSE 'pending' END,
                   lease_token = NULL, lease_until = NULL
              FROM saved_link_jobs AS j
             WHERE s.id = j.saved_link_id
        """)
        op.drop_table("saved_link_jobs")
    # For old completed entries, original GPT titles were destroyed in
    # previous release. Keep their linked IDs and ready state, names=NULL
    # rather than inventing an empty result. User may explicitly refresh.
    indexes = {ix["name"] for ix in inspect(bind).get_indexes("saved_links")}
    if "ix_saved_links_pending_created" not in indexes:
        op.create_index(
            "ix_saved_links_pending_created", "saved_links",
            ["created_at", "id"], unique=False,
            postgresql_where=sa.text("game_names IS NULL AND status = 'pending'"),
        )


def downgrade():
    raise RuntimeError(
        "One-table import data cannot be downgraded without restore from backup"
    )
