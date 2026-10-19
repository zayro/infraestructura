from typing import Protocol

from domain.models import Event, Item


class ItemsRepository(Protocol):
    async def create(self, name: str) -> Item: ...

    async def list_recent(self, limit: int) -> list[Item]: ...


class ItemsCache(Protocol):
    async def get(self) -> list[Item] | None: ...

    async def set(self, items: list[Item], ttl_seconds: int) -> None: ...

    async def invalidate(self) -> None: ...


class EventPublisher(Protocol):
    async def publish(self, event: Event) -> None: ...
