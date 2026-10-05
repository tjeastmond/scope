GREETINGS = {"de": "Grüß dich", "ja": "こんにちは", "ru": "Здравствуйте"}


def grüßen(name: str, lang: str = "de") -> str:
    return f"{GREETINGS[lang]}, {name} 🎉"


class Kundin:
    """Eine Kundin mit Zahlungsziel."""

    def __init__(self, name: str, tage: int = 30) -> None:
        self.name = name
        self.tage = tage

    def fällig_in(self) -> str:
        return f"{self.name}: fällig in {self.tage} Tagen"
