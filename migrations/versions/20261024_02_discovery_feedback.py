"""Personal discovery feedback, independent from library ratings.

Revision ID: 20261024_02
Revises: 20261016_01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20261024_02"
down_revision = "20261016_01"
branch_labels = None
depends_on = None


def upgrade():
    # The legacy baseline bootstraps empty CI databases from current ORM models.
    # On an established staging database Alembic creates the new table itself.
    if inspect(op.get_bind()).has_table('discovery_feedback'):
        return
    op.create_table(
        "discovery_feedback",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("game_id", sa.Integer(), sa.ForeignKey("games.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("wishlist_added", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "game_id", name="uq_discovery_feedback_user_game"),
        sa.CheckConstraint("action IN ('like', 'dislike', 'wishlist')", name="ck_discovery_feedback_action"),
    )
    op.create_index("ix_discovery_feedback_user_id", "discovery_feedback", ["user_id"])


def downgrade():
    op.drop_index("ix_discovery_feedback_user_id", table_name="discovery_feedback")
    op.drop_table("discovery_feedback")
