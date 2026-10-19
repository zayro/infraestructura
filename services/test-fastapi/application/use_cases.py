import asyncio
import uuid
from dataclasses import dataclass

from application.ports import EventPublisher, ItemsCache, ItemsRepository
from domain.models import Event, Item

CACHE_TTL_SECONDS = 30
ITEMS_LIMIT = 20


@dataclass(frozen=True)
class ItemsResult:
    source: str
    items: list[Item]


class SimulateTest:
    async def execute(self, delay_ms: int) -> None:
        await asyncio.sleep(delay_ms / 1000)


class CreateItem:
    def __init__(self, repository: ItemsRepository, cache: ItemsCache):
        self._repository = repository
        self._cache = cache

    async def execute(self, name: str) -> Item:
        item = await self._repository.create(name)
        await self._cache.invalidate()
        return item


class ListItems:
    def __init__(self, repository: ItemsRepository, cache: ItemsCache):
        self._repository = repository
        self._cache = cache

    async def execute(self) -> ItemsResult:
        cached_items = await self._cache.get()
        if cached_items is not None:
            return ItemsResult(source="cache", items=cached_items)

        items = await self._repository.list_recent(ITEMS_LIMIT)
        await self._cache.set(items, CACHE_TTL_SECONDS)
        return ItemsResult(source="db", items=items)


class PublishEvent:
    def __init__(self, publisher: EventPublisher):
        self._publisher = publisher

    async def execute(self, name: str) -> str:
        event = Event(event_id=str(uuid.uuid4()), name=name)
        await self._publisher.publish(event)
        return event.event_id
