"""Rate-limit expensive Steam library scans per linked account.

Revision ID: 20261101_13
Revises: 20261101_12
"""
from alembic import op
import sqlalchemy as sa

revision = "20261101_13"
down_revision = "20261101_12"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("steam_connections", sa.Column("last_preview_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("steam_connections", "last_preview_at")
