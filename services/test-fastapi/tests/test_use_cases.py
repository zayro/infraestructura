import unittest
from datetime import datetime, timezone

from application.use_cases import CreateItem, ListItems, PublishEvent
from domain.models import Item


class FakeRepository:
    def __init__(self, items=None):
        self.items = items or []
        self.created_names = []
        self.requested_limit = None

    async def create(self, name):
        self.created_names.append(name)
        return self.items[0]

    async def list_recent(self, limit):
        self.requested_limit = limit
        return self.items


class FakeCache:
    def __init__(self, value=None):
        self.value = value
        self.set_value = None
        self.invalidated = False

    async def get(self):
        return self.value

    async def set(self, items, ttl_seconds):
        self.set_value = (items, ttl_seconds)
        self.value = items

    async def invalidate(self):
        self.invalidated = True


class FakePublisher:
    def __init__(self):
        self.events = []

    async def publish(self, event):
        self.events.append(event)


class UseCaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.item = Item(
            id=1,
            name="demo",
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

    async def test_list_items_loads_database_and_populates_cache(self):
        repository = FakeRepository([self.item])
        cache = FakeCache()

        result = await ListItems(repository, cache).execute()

        self.assertEqual(result.source, "db")
        self.assertEqual(result.items, [self.item])
        self.assertEqual(repository.requested_limit, 20)
        self.assertEqual(cache.set_value, ([self.item], 30))

    async def test_list_items_uses_cached_values(self):
        repository = FakeRepository([self.item])
        cache = FakeCache([self.item])

        result = await ListItems(repository, cache).execute()

        self.assertEqual(result.source, "cache")
        self.assertEqual(result.items, [self.item])
        self.assertIsNone(repository.requested_limit)
        self.assertIsNone(cache.set_value)

    async def test_create_item_invalidates_cache(self):
        repository = FakeRepository([self.item])
        cache = FakeCache()

        result = await CreateItem(repository, cache).execute("demo")

        self.assertEqual(result, self.item)
        self.assertEqual(repository.created_names, ["demo"])
        self.assertTrue(cache.invalidated)

    async def test_publish_event_returns_published_event_id(self):
        publisher = FakePublisher()

        event_id = await PublishEvent(publisher).execute("demo")

        self.assertEqual(len(publisher.events), 1)
        self.assertEqual(publisher.events[0].event_id, event_id)
        self.assertEqual(publisher.events[0].name, "demo")


if __name__ == "__main__":
    unittest.main()
