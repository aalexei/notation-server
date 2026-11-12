"""Fan-out of server-sent events to every open browser tab."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator


class EventBroker:
    def __init__(self) -> None:
        self._queues: set[asyncio.Queue[str]] = set()

    @property
    def listeners(self) -> int:
        return len(self._queues)

    def publish(self, event: str, data: dict) -> int:
        """Queue EVENT for every subscriber; return how many there were."""
        message = f"event: {event}\ndata: {json.dumps(data)}\n\n"
        for q in self._queues:
            q.put_nowait(message)
        return len(self._queues)

    async def subscribe(self, keepalive: float = 15) -> AsyncIterator[str]:
        q: asyncio.Queue[str] = asyncio.Queue()
        self._queues.add(q)
        try:
            yield ": connected\n\n"
            while True:
                try:
                    yield await asyncio.wait_for(q.get(), timeout=keepalive)
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            self._queues.discard(q)
