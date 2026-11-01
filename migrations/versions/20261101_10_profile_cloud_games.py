"""Public IGDB IDs for three user-selected profile clouds; NULL slots stay automatic.

Revision ID: 20261101_10
Revises: 20261101_09
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision = "20261101_10"
down_revision = "20261101_09"
branch_labels = None
depends_on = None


def upgrade():
    # Empty test databases bootstrap the current ORM schema at baseline.
    names = {column["name"] for column in inspect(op.get_bind()).get_columns("users")}
    if "profile_cloud_game_ids" not in names:
        op.add_column("users", sa.Column(
            "profile_cloud_game_ids", postgresql.ARRAY(sa.Integer()), nullable=False,
            server_default=sa.text("ARRAY[NULL,NULL,NULL]::integer[]")))


def downgrade():
    op.drop_column("users", "profile_cloud_game_ids")
