from __future__ import annotations

from datetime import timedelta

from app.repositories.mixins.common import RealtimeTicket, _from_db, _to_db, utcnow


class TicketMixin:
    def put_realtime_ticket(
        self,
        *,
        ticket_id: str,
        token: str,
        owner_session_id: str,
        session_id: str,
        ttl_seconds: int,
    ) -> RealtimeTicket:
        created_at = utcnow()
        expires_at = created_at + timedelta(seconds=ttl_seconds)
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            conn.execute(
                (
                    "INSERT OR REPLACE INTO realtime_tickets"
                    "(id, token_hash, owner_session_id, session_id, expires_at, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)"
                ),
                (
                    ticket_id,
                    token_hash,
                    owner_session_id,
                    session_id,
                    _to_db(expires_at),
                    _to_db(created_at),
                ),
            )
        return RealtimeTicket(
            id=ticket_id,
            token_hash=token_hash,
            owner_session_id=owner_session_id,
            session_id=session_id,
            expires_at=expires_at,
            created_at=created_at,
        )

    def get_realtime_ticket(self, token: str) -> RealtimeTicket | None:
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            row = conn.execute(
                (
                    "SELECT id, token_hash, owner_session_id, session_id, expires_at, created_at "
                    "FROM realtime_tickets WHERE token_hash = ?"
                ),
                (token_hash,),
            ).fetchone()
        if not row:
            return None
        ticket = RealtimeTicket(
            id=row["id"],
            token_hash=row["token_hash"],
            owner_session_id=row["owner_session_id"],
            session_id=row["session_id"],
            expires_at=_from_db(row["expires_at"]) or utcnow(),
            created_at=_from_db(row["created_at"]) or utcnow(),
        )
        if ticket.expires_at <= utcnow():
            self.delete_realtime_ticket_by_id(ticket.id)
            return None
        return ticket

    def delete_realtime_ticket(self, token: str) -> None:
        token_hash = self.hash_token(token)
        with self.connection() as conn:
            conn.execute("DELETE FROM realtime_tickets WHERE token_hash = ?", (token_hash,))

    def delete_realtime_ticket_by_id(self, ticket_id: str) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM realtime_tickets WHERE id = ?", (ticket_id,))

    def delete_all_realtime_tickets(self) -> int:
        with self.connection() as conn:
            cursor = conn.execute("DELETE FROM realtime_tickets")
        return cursor.rowcount
