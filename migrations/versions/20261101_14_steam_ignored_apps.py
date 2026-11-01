"""User-local exclusions for unresolved Steam games.

Revision ID: 20261101_14
Revises: 20261101_13
"""
from alembic import op
import sqlalchemy as sa

revision = "20261101_14"
down_revision = "20261101_13"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "steam_ignored_apps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("steam_id64", sa.String(20), nullable=False),
        sa.Column("appid", sa.BigInteger(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "steam_id64", "appid", name="uq_steam_ignored_user_account_app"),
    )
    op.create_index("ix_steam_ignored_apps_user_id", "steam_ignored_apps", ["user_id"])


def downgrade():
    op.drop_index("ix_steam_ignored_apps_user_id", table_name="steam_ignored_apps")
    op.drop_table("steam_ignored_apps")
