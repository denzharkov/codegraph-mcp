"""Domain models of the fixture shop."""
from dataclasses import dataclass, field
from datetime import datetime


STATUS_PENDING = "pending"
STATUS_PAID = "paid"


@dataclass
class Customer:
    """Customer record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Customer #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


@dataclass
class Product:
    """Product record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Product #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


@dataclass
class Order:
    """Order record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Order #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


@dataclass
class Invoice:
    """Invoice record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Invoice #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


@dataclass
class Shipment:
    """Shipment record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Shipment #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


@dataclass
class Refund:
    """Refund record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Refund #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


@dataclass
class Payment:
    """Payment record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Payment #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


@dataclass
class Coupon:
    """Coupon record."""

    id: int
    created_at: datetime = field(default_factory=datetime.now)
    status: str = STATUS_PENDING
    items: list = field(default_factory=list)

    def total(self) -> int:
        """Sum of item prices."""
        amount = 0
        for item in self.items:
            price = item["price"]
            qty = item["qty"]
            if qty <= 0:
                continue
            amount += price * qty
        return amount

    def mark_paid(self) -> None:
        if self.status == STATUS_PAID:
            return
        self.status = STATUS_PAID
        self.created_at = datetime.now()

    def describe(self) -> str:
        lines = [f"Coupon #{self.id}"]
        for item in self.items:
            lines.append(f"  {item['name']} x{item['qty']}")
        lines.append(f"  total={self.total()}")
        return "\n".join(lines)

    def validate(self) -> list[str]:
        errors = []
        if self.id <= 0:
            errors.append("id must be positive")
        for item in self.items:
            if "price" not in item:
                errors.append("item without price")
            if item.get("qty", 0) < 0:
                errors.append("negative qty")
        return errors


def build_grid(orders: list[Order]) -> dict[str, list[Order]]:
    """Group orders by status."""
    grid: dict[str, list[Order]] = {}
    for order in orders:
        grid.setdefault(order.status, []).append(order)
    return grid


def find_customer(customers: list[Customer], customer_id: int) -> Customer | None:
    for customer in customers:
        if customer.id == customer_id:
            return customer
    return None
