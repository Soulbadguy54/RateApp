"""User-owned avatar and optional liquid-glass tint.

Revision ID: 20261101_09
Revises: 20261029_08
No historical profile data is rewritten.
"""
from alembic import op
import sqlalchemy as sa

revision = "20261101_09"
down_revision = "20261029_08"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column(
        "profile_tint", sa.String(length=16), nullable=False,
        server_default=sa.text("'default'")))
    op.add_column("users", sa.Column("avatar_data", sa.LargeBinary(), nullable=True))
    op.add_column("users", sa.Column(
        "avatar_version", sa.Integer(), nullable=False, server_default=sa.text("0")))


def downgrade():
    op.drop_column("users", "avatar_version")
    op.drop_column("users", "avatar_data")
    op.drop_column("users", "profile_tint")
