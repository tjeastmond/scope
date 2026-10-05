def validate(payload: dict) -> list:
    problems = []
    email = payload.get("email", "")
    if "@" not in email:
        problems.append("email must contain @")
    return problems
