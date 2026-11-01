"""Steam OpenID identity binding only; no game import.

Revision ID: 20261101_11
Revises: 20261101_10
"""
from alembic import op
import sqlalchemy as sa

revision = "20261101_11"
down_revision = "20261101_10"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("steam_connections",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("steam_id64", sa.String(length=20), nullable=False, unique=True),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table("steam_link_states",
        sa.Column("state_hash", sa.String(length=64), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("auth_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_steam_link_states_expires_at", "steam_link_states", ["expires_at"])


def downgrade():
    op.drop_index("ix_steam_link_states_expires_at", table_name="steam_link_states")
    op.drop_table("steam_link_states")
    op.drop_table("steam_connections")
