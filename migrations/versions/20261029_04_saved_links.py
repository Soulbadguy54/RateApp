"""User-scoped saved URLs and extracted game names (no content blobs).

Revision ID: 20261029_04
Revises: 20261024_03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20261029_04"
down_revision = "20261024_03"
branch_labels = None
depends_on = None


def upgrade():
    inspector = inspect(op.get_bind())
    # Legacy bootstrap creates ORM tables on a new CI database; populated
    # staging/production receives these additive tables via Alembic.
    if not inspector.has_table("saved_links"):
        op.create_table(
            "saved_links",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("url", sa.String(2048), nullable=False),
            sa.Column("url_hash", sa.String(64), nullable=False),
            sa.Column("title", sa.String(200)),
            sa.Column("status", sa.String(16), nullable=False, server_default=sa.text("'pending'")),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("lease_token", sa.String(64)),
            sa.Column("lease_until", sa.DateTime(timezone=True)),
            sa.Column("error", sa.String(300)),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("finished_at", sa.DateTime(timezone=True)),
            sa.UniqueConstraint("user_id", "url_hash", name="uq_saved_links_user_url"),
            sa.CheckConstraint("status IN ('pending', 'processing', 'ready', 'failed')", name="ck_saved_links_status"),
        )
        op.create_index("ix_saved_links_user_id", "saved_links", ["user_id"])
        op.create_index("ix_saved_links_status", "saved_links", ["status"])
    if not inspector.has_table("saved_link_games"):
        op.create_table(
            "saved_link_games",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("saved_link_id", sa.Integer(), sa.ForeignKey("saved_links.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("normalized_name", sa.String(255), nullable=False),
            sa.Column("game_id", sa.Integer(), sa.ForeignKey("games.id", ondelete="SET NULL")),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("saved_link_id", "normalized_name", name="uq_saved_link_game_name"),
        )
        op.create_index("ix_saved_link_games_saved_link_id", "saved_link_games", ["saved_link_id"])
        op.create_index("ix_saved_link_games_game_id", "saved_link_games", ["game_id"])


def downgrade():
    op.drop_table("saved_link_games")
    op.drop_table("saved_links")
