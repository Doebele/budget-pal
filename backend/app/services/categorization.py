"""
AI-based transaction categorization service.

Pipeline (in order of priority):
1. Manual override cache (exact match)
2. Rule-based keyword matching (MERCHANT_RULES)
3. Fuzzy string matching with rapidfuzz
4. Sentence-transformer embedding similarity (all-MiniLM-L6-v2)
5. OpenAI GPT-4o-mini fallback (if API key configured and confidence still low)

Returns: {"category", "subcategory", "merchant_normalized", "confidence_score"}
"""
import re
import logging
from typing import Dict, Optional, Tuple
from functools import lru_cache

logger = logging.getLogger(__name__)

# ── Merchant Rules ─────────────────────────────────────────────
# Format: "pattern" → (category, subcategory, normalized_name)
# Patterns are matched case-insensitively as substrings.

MERCHANT_RULES: Dict[str, Tuple[str, str, str]] = {
    # ── Groceries (Lebensmittel) ─────────────────────────────
    "migros": ("Groceries", "Supermarket", "Migros"),
    "coop": ("Groceries", "Supermarket", "Coop"),
    "coop-": ("Groceries", "Supermarket", "Coop"),
    "denner": ("Groceries", "Discount Supermarket", "Denner"),
    "aldi": ("Groceries", "Discount Supermarket", "Aldi"),
    "lidl": ("Groceries", "Discount Supermarket", "Lidl"),
    "rewe": ("Groceries", "Supermarket", "REWE"),
    "edeka": ("Groceries", "Supermarket", "Edeka"),
    "penny": ("Groceries", "Discount Supermarket", "Penny"),
    "netto": ("Groceries", "Discount Supermarket", "Netto"),
    "manor food": ("Groceries", "Supermarket", "Manor Food"),
    "pick pay": ("Groceries", "Supermarket", "Pick Pay"),
    "volg": ("Groceries", "Supermarket", "Volg"),
    "spar": ("Groceries", "Supermarket", "Spar"),
    "fenaco": ("Groceries", "Wholesale", "Fenaco"),

    # ── Restaurants & Takeaway ─────────────────────────────
    "mcdonald": ("Food & Drink", "Fast Food", "McDonald's"),
    "mcdonalds": ("Food & Drink", "Fast Food", "McDonald's"),
    "burger king": ("Food & Drink", "Fast Food", "Burger King"),
    "kfc": ("Food & Drink", "Fast Food", "KFC"),
    "subway": ("Food & Drink", "Fast Food", "Subway"),
    "pizza hut": ("Food & Drink", "Pizza", "Pizza Hut"),
    "domino": ("Food & Drink", "Pizza", "Domino's"),
    "starbucks": ("Food & Drink", "Coffee", "Starbucks"),
    "caffè": ("Food & Drink", "Coffee", "Caffè"),
    "manor restaurant": ("Food & Drink", "Restaurant", "Manor Restaurant"),
    "tibits": ("Food & Drink", "Restaurant", "tibits"),
    "hiltl": ("Food & Drink", "Restaurant", "Hiltl"),

    # ── Transport ─────────────────────────────────────────
    "sbb": ("Transport", "Train", "SBB"),
    "sbb cff ffs": ("Transport", "Train", "SBB"),
    "bls ag": ("Transport", "Train", "BLS"),
    "zvv": ("Transport", "Public Transport", "ZVV"),
    "bvb": ("Transport", "Public Transport", "BVB"),
    "tnw": ("Transport", "Public Transport", "TNW"),
    "rbs": ("Transport", "Train", "RBS"),
    "flixbus": ("Transport", "Bus", "FlixBus"),
    "eurostar": ("Transport", "Train", "Eurostar"),
    "deutsche bahn": ("Transport", "Train", "Deutsche Bahn"),
    "db bahn": ("Transport", "Train", "Deutsche Bahn"),
    "postbus": ("Transport", "Bus", "PostBus"),
    "uber": ("Transport", "Taxi", "Uber"),
    "mytaxi": ("Transport", "Taxi", "myTaxi"),
    "taxi": ("Transport", "Taxi", "Taxi"),
    "mobility": ("Transport", "Car Sharing", "Mobility"),
    "sharenow": ("Transport", "Car Sharing", "ShareNow"),
    "bird": ("Transport", "Scooter", "Bird"),
    "lime": ("Transport", "Scooter", "Lime"),
    "velospot": ("Transport", "Bike Share", "Velospot"),
    "nextbike": ("Transport", "Bike Share", "Nextbike"),

    # ── Flights & Travel ──────────────────────────────────
    "swiss air": ("Travel", "Flight", "Swiss Air"),
    "swiss intl": ("Travel", "Flight", "SWISS"),
    "lufthansa": ("Travel", "Flight", "Lufthansa"),
    "easyjet": ("Travel", "Flight", "easyJet"),
    "ryanair": ("Travel", "Flight", "Ryanair"),
    "air france": ("Travel", "Flight", "Air France"),
    "british airways": ("Travel", "Flight", "British Airways"),
    "booking.com": ("Travel", "Hotel", "Booking.com"),
    "airbnb": ("Travel", "Accommodation", "Airbnb"),
    "hotels.com": ("Travel", "Hotel", "Hotels.com"),

    # ── Telecommunications ────────────────────────────────
    "swisscom": ("Utilities", "Mobile / Internet", "Swisscom"),
    "salt": ("Utilities", "Mobile", "Salt"),
    "sunrise": ("Utilities", "Mobile / Internet", "Sunrise"),
    "m-budget mobile": ("Utilities", "Mobile", "M-Budget Mobile"),
    "yallo": ("Utilities", "Mobile", "Yallo"),
    "wingo": ("Utilities", "Mobile", "Wingo"),
    "upc": ("Utilities", "Internet / TV", "UPC"),
    "vodafone": ("Utilities", "Mobile", "Vodafone"),
    "telenet": ("Utilities", "Internet", "Telenet"),
    "1und1": ("Utilities", "Internet", "1&1"),
    "o2": ("Utilities", "Mobile", "O2"),

    # ── Health & Pharmacy ─────────────────────────────────
    "apotheke": ("Health", "Pharmacy", "Pharmacy"),
    "pharmacie": ("Health", "Pharmacy", "Pharmacy"),
    "amavita": ("Health", "Pharmacy", "Amavita"),
    "coop vitality": ("Health", "Pharmacy", "Coop Vitality"),
    "sunstore": ("Health", "Pharmacy", "Sun Store"),
    "docmorris": ("Health", "Online Pharmacy", "DocMorris"),
    "arzt": ("Health", "Doctor", "Doctor"),
    "zahnarzt": ("Health", "Dentist", "Dentist"),
    "sanitarium": ("Health", "Health Store", "Sanitarium"),
    "helsana": ("Health", "Health Insurance", "Helsana"),
    "css versicherung": ("Health", "Health Insurance", "CSS Versicherung"),
    "swica": ("Health", "Health Insurance", "SWICA"),
    "concordia": ("Health", "Health Insurance", "Concordia"),
    "sanitas": ("Health", "Health Insurance", "Sanitas"),
    "visana": ("Health", "Health Insurance", "Visana"),

    # ── Insurance ─────────────────────────────────────────
    "zurich versicherung": ("Insurance", "General Insurance", "Zurich"),
    "axa": ("Insurance", "General Insurance", "AXA"),
    "allianz": ("Insurance", "General Insurance", "Allianz"),
    "helvetia": ("Insurance", "General Insurance", "Helvetia"),
    "baloise": ("Insurance", "General Insurance", "Baloise"),
    "mobiliar": ("Insurance", "General Insurance", "Die Mobiliar"),
    "vaudoise": ("Insurance", "General Insurance", "Vaudoise"),
    "generali": ("Insurance", "General Insurance", "Generali"),
    "suva": ("Insurance", "Accident Insurance", "SUVA"),

    # ── Banking & Finance ──────────────────────────────────
    "postfinance": ("Finance", "Banking", "PostFinance"),
    "post finance": ("Finance", "Banking", "PostFinance"),
    "ubs ag": ("Finance", "Banking", "UBS"),
    "credit suisse": ("Finance", "Banking", "Credit Suisse"),
    "raiffeisen": ("Finance", "Banking", "Raiffeisen"),
    "zkb": ("Finance", "Banking", "Zürcher Kantonalbank"),
    "zuercher kantonalbank": ("Finance", "Banking", "ZKB"),
    "migros bank": ("Finance", "Banking", "Migros Bank"),
    "cler": ("Finance", "Banking", "Bank Cler"),
    "revolut": ("Finance", "Banking", "Revolut"),
    "wise": ("Finance", "Money Transfer", "Wise"),
    "paypal": ("Finance", "Payment Service", "PayPal"),
    "twint": ("Finance", "Payment Service", "TWINT"),
    "neon": ("Finance", "Banking", "Neon"),

    # ── Housing & Utilities ───────────────────────────────
    "miete": ("Housing", "Rent", "Rent"),
    "nebenkosten": ("Housing", "Utilities", "Nebenkosten"),
    "ewz": ("Utilities", "Electricity", "EWZ"),
    "ewb": ("Utilities", "Electricity/Gas", "EWB"),
    "igs": ("Utilities", "Gas", "IGS"),
    "stadtwerke": ("Utilities", "Utility Provider", "Stadtwerke"),
    "iwo": ("Utilities", "Utility Provider", "IWO"),
    "kehrichtverwertung": ("Utilities", "Waste", "Kehrichtverwertung"),

    # ── Shopping & Retail ─────────────────────────────────
    "ikea": ("Shopping", "Furniture", "IKEA"),
    "h&m": ("Shopping", "Clothing", "H&M"),
    "zara": ("Shopping", "Clothing", "Zara"),
    "uniqlo": ("Shopping", "Clothing", "Uniqlo"),
    "manor": ("Shopping", "Department Store", "Manor"),
    "globus": ("Shopping", "Department Store", "Globus"),
    "fnac": ("Shopping", "Electronics", "FNAC"),
    "digitec": ("Shopping", "Electronics", "Digitec"),
    "interdiscount": ("Shopping", "Electronics", "Interdiscount"),
    "mediamarkt": ("Shopping", "Electronics", "MediaMarkt"),
    "saturn": ("Shopping", "Electronics", "Saturn"),
    "brack": ("Shopping", "Online Retail", "Brack"),
    "amazon": ("Shopping", "Online Retail", "Amazon"),
    "zalando": ("Shopping", "Clothing", "Zalando"),
    "galaxus": ("Shopping", "Online Retail", "Galaxus"),
    "microspot": ("Shopping", "Online Retail", "Microspot"),

    # ── Entertainment & Subscriptions ─────────────────────
    "netflix": ("Entertainment", "Streaming", "Netflix"),
    "spotify": ("Entertainment", "Music Streaming", "Spotify"),
    "apple": ("Entertainment", "Digital Services", "Apple"),
    "google": ("Entertainment", "Digital Services", "Google"),
    "disney": ("Entertainment", "Streaming", "Disney+"),
    "amazon prime": ("Entertainment", "Streaming", "Amazon Prime"),
    "youtube premium": ("Entertainment", "Streaming", "YouTube Premium"),
    "twitch": ("Entertainment", "Gaming / Streaming", "Twitch"),
    "steam": ("Entertainment", "Gaming", "Steam"),
    "playstation": ("Entertainment", "Gaming", "PlayStation"),
    "nintendo": ("Entertainment", "Gaming", "Nintendo"),
    "kino": ("Entertainment", "Cinema", "Cinema"),
    "cinema": ("Entertainment", "Cinema", "Cinema"),

    # ── Education ────────────────────────────────────────
    "coursera": ("Education", "Online Course", "Coursera"),
    "udemy": ("Education", "Online Course", "Udemy"),
    "eth": ("Education", "University", "ETH Zürich"),
    "universitaet": ("Education", "University", "University"),
    "bibliothek": ("Education", "Library", "Library"),

    # ── Post & Logistics ──────────────────────────────────
    "die post": ("Services", "Postal", "Swiss Post"),
    "post ch": ("Services", "Postal", "Swiss Post"),
    "dhl": ("Services", "Shipping", "DHL"),
    "fedex": ("Services", "Shipping", "FedEx"),
    "ups": ("Services", "Shipping", "UPS"),

    # ── Fitness & Sports ──────────────────────────────────
    "fitness": ("Health", "Gym", "Fitness Studio"),
    "fitnesspark": ("Health", "Gym", "FitnessPark"),
    "mcfit": ("Health", "Gym", "McFit"),
    "urban sports": ("Health", "Sports", "Urban Sports Club"),
    "decathlon": ("Shopping", "Sports Retail", "Decathlon"),
    "intersport": ("Shopping", "Sports Retail", "Intersport"),

    # ── Fuel & Cars ───────────────────────────────────────
    "shell": ("Transport", "Fuel", "Shell"),
    "esso": ("Transport", "Fuel", "Esso"),
    "agrola": ("Transport", "Fuel", "Agrola"),
    "avia": ("Transport", "Fuel", "AVIA"),
    "migrol": ("Transport", "Fuel", "Migrol"),
    "bp ": ("Transport", "Fuel", "BP"),
    "tcs": ("Transport", "Car Club", "TCS"),
    "amag": ("Transport", "Car Dealer", "AMAG"),

    # ── Government / Tax ──────────────────────────────────
    "steueramt": ("Taxes", "Income Tax", "Steueramt"),
    "steuerverwaltung": ("Taxes", "Tax Authority", "Steuerverwaltung"),
    "ahv": ("Taxes", "Social Security", "AHV"),
    "ausgleichskasse": ("Taxes", "Social Security", "Ausgleichskasse"),
    "verwaltungsgebühr": ("Gebühren", "Admin Fee", "Verwaltungsgebühr"),
    # ── Fees / Gebühren ──────────────────────────────────────
    "gebühren": ("Gebühren", "Bank Fees", "Gebühren"),
    "kontoführungsgebühr": ("Gebühren", "Bank Fees", "Kontoführungsgebühr"),
    "jahresgebühr": ("Gebühren", "Bank Fees", "Jahresgebühr"),
    "kartengebühr": ("Gebühren", "Bank Fees", "Kartengebühr"),
    "saldo dienstleistungspreisabschluss": ("Gebühren", "Bank Fees", "UBS Kontogebühr"),
    "dienstleistungspreisabschluss": ("Gebühren", "Bank Fees", "UBS Kontogebühr"),
    "bankgebühr": ("Gebühren", "Bank Fees", "Bankgebühr"),
    "depotgebühr": ("Gebühren", "Bank Fees", "Depotgebühr"),
    # ── Account Transfers / Kontoüberträge ────────────────────
    "kontoübertrag": ("Kontoübertrag", "Account Transfer", "Kontoübertrag"),
    "übertrag": ("Kontoübertrag", "Account Transfer", "Kontoübertrag"),
    "dauerauftrag": ("Kontoübertrag", "Standing Order", "Dauerauftrag"),
    "interne umbuchung": ("Kontoübertrag", "Internal Transfer", "Umbuchung"),
    # ── Deposits / Einzahlungen ───────────────────────────────
    "einzahlung": ("Einzahlungen", "Deposit", "Einzahlung"),
    "gutschrift": ("Einzahlungen", "Credit", "Gutschrift"),
    "bareinzahlung": ("Einzahlungen", "Cash Deposit", "Bareinzahlung"),
}

# ── Category embeddings for sentence-transformer fallback ─────
CATEGORY_DESCRIPTIONS = {
    "Groceries": "supermarket food shopping grocery store",
    "Food & Drink": "restaurant cafe bar meal drink takeaway delivery",
    "Transport": "train bus taxi uber public transport fuel car",
    "Travel": "hotel flight airbnb booking travel vacation",
    "Utilities": "electricity gas water internet phone bill",
    "Health": "pharmacy doctor dentist hospital medicine insurance",
    "Insurance": "insurance premium coverage policy",
    "Finance": "bank transfer fee interest investment",
    "Housing": "rent mortgage landlord apartment deposit",
    "Shopping": "clothing electronics furniture online retail",
    "Entertainment": "netflix spotify streaming gaming cinema subscription",
    "Education": "course university school tuition book",
    "Services": "postal shipping delivery admin fee government",
    "Taxes": "tax income tax withholding VAT government",
    "Salary": "salary wage payroll employer income payment",
    "Investment": "dividend interest ETF stock fund investment return",
    "Einzahlungen": "deposit payment incoming credit cash deposit Einzahlung Gutschrift",
    "Gebühren": "fee charge bank fee Gebühr Kontoführung Jahresgebühr service charge",
    "Kontoübertrag": "account transfer wire Übertrag Dauerauftrag standing order internal transfer",
    "Other": "miscellaneous other unknown",
}


class CategorizationService:
    """Transaction categorization pipeline."""

    def __init__(self):
        self._embedding_model = None
        self._category_embeddings = None
        self._openai_client = None

    def _get_embedding_model(self):
        """Lazy-load the sentence transformer model."""
        if self._embedding_model is None:
            try:
                from sentence_transformers import SentenceTransformer
                self._embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
                logger.info("Sentence transformer model loaded.")
            except Exception as e:
                logger.warning(f"Could not load sentence transformer: {e}")
        return self._embedding_model

    def _get_category_embeddings(self):
        """Precompute embeddings for all category descriptions."""
        if self._category_embeddings is None:
            model = self._get_embedding_model()
            if model is None:
                return None, None
            import numpy as np
            descriptions = list(CATEGORY_DESCRIPTIONS.values())
            categories = list(CATEGORY_DESCRIPTIONS.keys())
            embeddings = model.encode(descriptions, normalize_embeddings=True)
            self._category_embeddings = (categories, embeddings)
        return self._category_embeddings

    def _normalize_description(self, description: str) -> str:
        """Clean up description for matching."""
        text = description.upper()
        # Remove common noise tokens
        noise = [
            r"\bKARTENZAHLUNG\b", r"\bEINKAUF\b", r"\bZAHLUNG\b",
            r"\bPURCHASE\b", r"\bPAYMENT\b", r"\bTRANSACTION\b",
            r"\d{4}-\d{2}-\d{2}", r"\d{2}\.\d{2}\.\d{4}",
            r"CH\d{2}\s?\d{4}", r"IBAN:\s?[A-Z]{2}\d+",
            r"REF\.\s?NR\.?\s?[\w\-]+", r"AUFTRAG\s+\d+",
        ]
        for pattern in noise:
            text = re.sub(pattern, " ", text, flags=re.IGNORECASE)
        return " ".join(text.split())

    def _rule_based(self, description: str) -> Optional[Tuple[str, str, str, float]]:
        """Try exact keyword match against MERCHANT_RULES."""
        desc_lower = description.lower()
        for keyword, (category, subcategory, normalized) in MERCHANT_RULES.items():
            if keyword.lower() in desc_lower:
                return category, subcategory, normalized, 0.95
        return None

    def _fuzzy_match(self, description: str) -> Optional[Tuple[str, str, str, float]]:
        """Try fuzzy string matching against merchant names in rules."""
        try:
            from rapidfuzz import process, fuzz
        except ImportError:
            return None

        merchants = {v[2]: (v[0], v[1]) for v in MERCHANT_RULES.values()}
        merchant_names = list(merchants.keys())

        match, score, _ = process.extractOne(
            description,
            merchant_names,
            scorer=fuzz.token_set_ratio,
        )

        if score >= 85:
            category, subcategory = merchants[match]
            confidence = score / 100.0
            return category, subcategory, match, confidence

        return None

    def _embedding_classify(self, description: str) -> Optional[Tuple[str, str, str, float]]:
        """Classify using sentence transformer cosine similarity."""
        model = self._get_embedding_model()
        if model is None:
            return None

        try:
            import numpy as np

            categories, cat_embeddings = self._get_category_embeddings()
            if categories is None:
                return None

            desc_embedding = model.encode([description], normalize_embeddings=True)[0]

            # Cosine similarity (embeddings are already normalized)
            similarities = np.dot(cat_embeddings, desc_embedding)
            best_idx = int(np.argmax(similarities))
            best_score = float(similarities[best_idx])

            if best_score >= 0.45:
                category = categories[best_idx]
                return category, "", self._normalize_description(description)[:50], best_score

        except Exception as e:
            logger.warning(f"Embedding classification failed: {e}")

        return None

    async def _openai_fallback(self, description: str) -> Optional[Tuple[str, str, str, float]]:
        """Use OpenAI GPT as last resort categorizer."""
        from app.core.config import settings
        if not settings.openai_enabled:
            return None

        try:
            import openai

            if self._openai_client is None:
                self._openai_client = openai.AsyncOpenAI(api_key=settings.openai_api_key)

            categories_list = ", ".join(CATEGORY_DESCRIPTIONS.keys())
            response = await self._openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"You are a Swiss personal finance transaction classifier. "
                            f"Classify the transaction into one of these categories: {categories_list}. "
                            f"Return JSON: {{\"category\": \"...\", \"subcategory\": \"...\", \"merchant\": \"...\"}}. "
                            f"Be concise. If unsure, use 'Other'."
                        ),
                    },
                    {"role": "user", "content": f"Transaction: {description}"},
                ],
                temperature=0,
                max_tokens=100,
                response_format={"type": "json_object"},
            )

            import json
            result = json.loads(response.choices[0].message.content)
            category = result.get("category", "Other")
            subcategory = result.get("subcategory", "")
            merchant = result.get("merchant", description[:50])
            return category, subcategory, merchant, 0.75

        except Exception as e:
            logger.warning(f"OpenAI fallback failed: {e}")
            return None

    async def categorize(self, description: str) -> Dict:
        """
        Run the full categorization pipeline.

        Returns:
            {
                "category": str,
                "subcategory": str,
                "merchant_normalized": str,
                "confidence_score": float,
            }
        """
        if not description or not description.strip():
            return {
                "category": "Other",
                "subcategory": "",
                "merchant_normalized": "",
                "confidence_score": 0.0,
            }

        cleaned = self._normalize_description(description)

        # 1. Rule-based
        result = self._rule_based(cleaned)
        if result:
            cat, subcat, merchant, conf = result
            return {
                "category": cat,
                "subcategory": subcat,
                "merchant_normalized": merchant,
                "confidence_score": conf,
            }

        # 2. Fuzzy matching
        result = self._fuzzy_match(cleaned)
        if result:
            cat, subcat, merchant, conf = result
            return {
                "category": cat,
                "subcategory": subcat,
                "merchant_normalized": merchant,
                "confidence_score": conf,
            }

        # 3. Sentence transformer
        result = self._embedding_classify(cleaned)
        if result:
            cat, subcat, merchant, conf = result
            if conf >= 0.5:
                return {
                    "category": cat,
                    "subcategory": subcat,
                    "merchant_normalized": merchant,
                    "confidence_score": conf,
                }

        # 4. OpenAI fallback
        openai_result = await self._openai_fallback(description)
        if openai_result:
            cat, subcat, merchant, conf = openai_result
            return {
                "category": cat,
                "subcategory": subcat,
                "merchant_normalized": merchant,
                "confidence_score": conf,
            }

        # 5. Default fallback
        return {
            "category": "Other",
            "subcategory": "",
            "merchant_normalized": cleaned[:50] if cleaned else description[:50],
            "confidence_score": 0.1,
        }
