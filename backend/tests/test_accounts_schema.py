from app.api.accounts import AccountCreate


def test_account_create_currency_defaults_to_chf() -> None:
    payload = AccountCreate(name="Main", bank="UBS")
    assert payload.currency == "CHF"

