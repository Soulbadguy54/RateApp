"""Steam verified account linking only; no game import or mutation.

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
    op.create_table(
        "steam_connections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("steam_id64", sa.String(length=20), nullable=False),
        sa.Column("connected_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", name="uq_steam_connection_user"),
        sa.UniqueConstraint("steam_id64", name="uq_steam_connection_steamid"),
    )
    op.create_index("ix_steam_connections_user_id", "steam_connections", ["user_id"])
    op.create_index("ix_steam_connections_steam_id64", "steam_connections", ["steam_id64"])
    op.create_table(
        "steam_link_challenges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_hash", sa.String(length=64), nullable=False),
        sa.Column("state_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("state_hash", name="uq_steam_link_challenge_state"),
    )
    op.create_index("ix_steam_link_challenges_user_id", "steam_link_challenges", ["user_id"])
    op.create_index("ix_steam_link_challenges_state_hash", "steam_link_challenges", ["state_hash"])


def downgrade():
    # Never unlink user accounts implicitly in a production rollback.
    raise RuntimeError("Steam account links require explicit owner-reviewed rollback")
