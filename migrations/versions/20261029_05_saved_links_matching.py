"""Independent, bounded matching of extracted titles to cached/IGDB games.

Revision ID: 20261029_05
Revises: 20261029_04
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20261029_05"
down_revision = "20261029_04"
branch_labels = None
depends_on = None


def upgrade():
    # The baseline creates the up-to-date ORM schema on fresh CI databases.
    inspector = inspect(op.get_bind())
    columns = {c["name"] for c in inspector.get_columns("saved_link_games")}
    new = [
        ("match_status", sa.String(16), False, sa.text("'pending'")),
        ("match_attempts", sa.Integer(), False, sa.text("0")),
        ("match_lease_token", sa.String(64), True, None),
        ("match_lease_until", sa.DateTime(timezone=True), True, None),
        ("match_error", sa.String(200), True, None),
    ]
    for name, kind, nullable, default in new:
        if name not in columns:
            op.add_column("saved_link_games", sa.Column(
                name, kind, nullable=nullable, server_default=default,
            ))
    # Previously manually verified matches should not be reprocessed.
    op.execute("UPDATE saved_link_games SET match_status = 'matched' "
               "WHERE game_id IS NOT NULL AND match_status = 'pending'")


def downgrade():
    # Rolling back a release's images does not downgrade the live schema.
    for col in ("match_error", "match_lease_until", "match_lease_token",
                "match_attempts", "match_status"):
        op.drop_column("saved_link_games", col)
