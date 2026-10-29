"""Reconcile the two names for saved-link arrays after the 07 migration.

Revision ID: 20261029_08
Revises: 20261029_07
Preserve existing names, game IDs and cursor during column naming fix.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import ARRAY

revision = "20261029_08"
down_revision = "20261029_07"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("saved_links")}

    indexes = {i["name"] for i in inspect(bind).get_indexes("saved_links")}
    if "ix_saved_links_pending_created" in indexes:
        op.drop_index("ix_saved_links_pending_created", table_name="saved_links")

    if "game_names" in cols and "gpt_names" in cols:
        op.execute("""
            UPDATE saved_links SET gpt_names = game_names
             WHERE gpt_names IS NULL AND game_names IS NOT NULL
        """)
        op.drop_column("saved_links", "game_names")
    elif "game_names" in cols:
        op.alter_column("saved_links", "game_names", new_column_name="gpt_names")
    elif "gpt_names" not in cols:
        op.add_column("saved_links", sa.Column("gpt_names", ARRAY(sa.Text()), nullable=True))

    if "resolve_cursor" in cols and "match_cursor" in cols:
        op.execute("""
            UPDATE saved_links SET match_cursor = resolve_cursor
             WHERE match_cursor = 0 AND resolve_cursor <> 0
        """)
        op.drop_column("saved_links", "resolve_cursor")
    elif "resolve_cursor" in cols:
        op.alter_column("saved_links", "resolve_cursor", new_column_name="match_cursor")
    elif "match_cursor" not in cols:
        op.add_column("saved_links", sa.Column(
            "match_cursor", sa.Integer(), nullable=False, server_default=sa.text("0")))

    # Existing ready links have known game IDs but old GPT names were erased.
    # Leave gpt_names NULL and status ready; only explicit refresh re-enqueues.

    indexes = {i["name"] for i in inspect(bind).get_indexes("saved_links")}
    if "ix_saved_links_queue" not in indexes:
        op.create_index("ix_saved_links_queue", "saved_links", ["created_at", "id"],
                        postgresql_where=sa.text(
                            "gpt_names IS NULL AND status IN ('pending', 'processing')"))


def downgrade():
    raise RuntimeError("Restore the pre-migration backup to revert saved links")
