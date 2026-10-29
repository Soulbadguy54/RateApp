"""Move the GPT names and progress into saved_links; remove job table.

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
    columns = {c["name"] for c in inspect(bind).get_columns("saved_links")}
    added = [
        ("gpt_names", ARRAY(sa.Text()), True, None),
        ("attempts", sa.Integer(), False, sa.text("0")),
        ("match_cursor", sa.Integer(), False, sa.text("0")),
        ("match_failures", sa.Integer(), False, sa.text("0")),
        ("lease_token", sa.String(64), True, None),
        ("lease_until", sa.DateTime(timezone=True), True, None),
    ]
    for name, kind, nullable, default in added:
        if name not in columns:
            op.add_column("saved_links", sa.Column(
                name, kind, nullable=nullable, server_default=default,
            ))

    if inspect(bind).has_table("saved_link_jobs"):
        # Carry over in-flight GPT results and any partially resolved game IDs.
        # Claims in flight are invalidated and requeued: their old token must
        # never be accepted after migrating into a different state model.
        op.execute("""
            UPDATE saved_links AS s
               SET gpt_names = CASE WHEN j.phase IN ('resolving','matching')
                                    THEN j.names ELSE NULL END,
                   game_ids = CASE WHEN j.phase IN ('resolving','matching')
                                   THEN COALESCE(j.resolved_ids, '{}'::integer[])
                                   ELSE s.game_ids END,
                   attempts = j.attempts,
                   match_cursor = CASE WHEN j.phase IN ('resolving','matching')
                                       THEN j.cursor ELSE 0 END,
                   match_failures = j.match_failures,
                   status = CASE WHEN j.phase IN ('resolving','matching')
                                 THEN 'processing' ELSE 'pending' END,
                   lease_token = NULL,
                   lease_until = NULL,
                   finished_at = NULL
              FROM saved_link_jobs AS j
             WHERE s.id = j.saved_link_id
        """)
        op.drop_table("saved_link_jobs")

    # Existing ready links have known game IDs but old GPT names were erased.
    # Leave gpt_names NULL and status ready; only explicit refresh re-enqueues.

    if "ix_saved_links_queue" not in {
        ix["name"] for ix in inspect(bind).get_indexes("saved_links")
    }:
        op.create_index(
            "ix_saved_links_queue", "saved_links", ["created_at", "id"],
            postgresql_where=sa.text(
                "gpt_names IS NULL AND status IN ('pending', 'processing')"
            ),
        )


def downgrade():
    raise RuntimeError("One-table queue refactor requires restoring a staging backup")
