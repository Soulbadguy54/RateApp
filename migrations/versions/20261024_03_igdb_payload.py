"""Store complete IGDB Game payloads alongside normalized searchable fields.

Revision ID: 20261024_03
Revises: 20261024_02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import JSONB

revision = "20261024_03"
down_revision = "20261024_02"
branch_labels = None
depends_on = None


def upgrade():
    # The historical baseline creates ORM tables in empty CI databases.
    # On a populated staging database, add the nullable column without
    # rewriting historical game rows or impacting existing ratings.
    cols = {column["name"] for column in inspect(op.get_bind()).get_columns("games")}
    if "igdb_payload" not in cols:
        op.add_column("games", sa.Column("igdb_payload", JSONB(), nullable=True))


def downgrade():
    op.drop_column("games", "igdb_payload")
