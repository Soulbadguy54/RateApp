"""User-owned avatar and optional liquid-glass tint.

Revision ID: 20261101_09
Revises: 20261029_08
No historical profile data is rewritten.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20261101_09"
down_revision = "20261029_08"
branch_labels = None
depends_on = None


def upgrade():
    # The legacy empty-DB bootstrap builds current ORM columns. Avoid
    # adding them twice; existing production/staging schemas remain unchanged.
    existing = {column["name"] for column in inspect(op.get_bind()).get_columns("users")}
    if "profile_tint" not in existing:
        op.add_column("users", sa.Column(
            "profile_tint", sa.String(length=16), nullable=False,
            server_default=sa.text("'default'")))
    if "avatar_data" not in existing:
        op.add_column("users", sa.Column("avatar_data", sa.LargeBinary(), nullable=True))
    if "avatar_version" not in existing:
        op.add_column("users", sa.Column(
            "avatar_version", sa.Integer(), nullable=False, server_default=sa.text("0")))


def downgrade():
    op.drop_column("users", "avatar_version")
    op.drop_column("users", "avatar_data")
    op.drop_column("users", "profile_tint")
