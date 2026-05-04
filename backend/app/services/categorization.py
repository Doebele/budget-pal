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

import logging
import re
import threading
from functools import lru_cache
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# ── Normalisierungstabelle: Englisch → Deutsch ─────────────────
# Wird beim Startup als DB-Migration genutzt und in der Pipeline
# als Sicherheitsnetz (Legacy-Daten aus alten Imports).
EN_TO_DE_CATEGORY: Dict[str, str] = {
    "groceries": "Lebensmittel",
    "food & drink": "Restaurant & Takeaway",
    "transport": "Transport",
    "travel": "Reisen",
    "utilities": "Nebenkosten",
    "health": "Gesundheit",
    "insurance": "Versicherungen",
    "finance": "Finanzen",
    "housing": "Wohnen",
    "shopping": "Shopping",
    "entertainment": "Freizeit & Unterhaltung",
    "education": "Bildung",
    "services": "Dienstleistungen",
    "taxes": "Steuern",
    "salary": "Gehalt",
    "investment": "Investitionen",
    "dividend": "Dividende",
    "dividends": "Dividende",
    "interest": "Zinsen",
    "refund": "Rückerstattung",
    "bonus": "Bonus",
    "other": "Sonstiges",
    # Bereits teilweise deutsch — auf kanonische Schreibweise normieren
    "einzahlungen": "Einzahlungen",
    "gebühren": "Gebühren",
    "kontoübertrag": "Kontoübertrag",
    # ÖV-Varianten → ÖV-Kosten (kanonisch)
    "öv-abonnements": "ÖV-Kosten",
    "ov-abonnements": "ÖV-Kosten",
    "öv abonnements": "ÖV-Kosten",
    "öv-abo": "ÖV-Kosten",
    # Säule 3A Normierung
    "säule 3a": "Säule 3A",
    "pillar 3a": "Säule 3A",
    "pillar-3-a": "Säule 3A",
    "3. säule": "Säule 3A",
}

# ── Merchant Rules ─────────────────────────────────────────────
# Format: "pattern" → (kategorie, unterkategorie, normierter_name)
# Pattern wird case-insensitiv als Substring gesucht.

MERCHANT_RULES: Dict[str, Tuple[str, str, str]] = {
    # ── Lebensmittel ─────────────────────────────────────────
    "migros": ("Lebensmittel", "Supermarkt", "Migros"),
    "coop": ("Lebensmittel", "Supermarkt", "Coop"),
    "coop-": ("Lebensmittel", "Supermarkt", "Coop"),
    "denner": ("Lebensmittel", "Discounter", "Denner"),
    "aldi": ("Lebensmittel", "Discounter", "Aldi"),
    "lidl": ("Lebensmittel", "Discounter", "Lidl"),
    "rewe": ("Lebensmittel", "Supermarkt", "REWE"),
    "edeka": ("Lebensmittel", "Supermarkt", "Edeka"),
    "penny": ("Lebensmittel", "Discounter", "Penny"),
    "netto": ("Lebensmittel", "Discounter", "Netto"),
    "manor food": ("Lebensmittel", "Supermarkt", "Manor Food"),
    "pick pay": ("Lebensmittel", "Supermarkt", "Pick Pay"),
    "volg": ("Lebensmittel", "Supermarkt", "Volg"),
    "spar": ("Lebensmittel", "Supermarkt", "Spar"),
    "fenaco": ("Lebensmittel", "Grosshandel", "Fenaco"),
    # ── Restaurant & Takeaway ────────────────────────────────
    "mcdonald": ("Restaurant & Takeaway", "Fastfood", "McDonald's"),
    "mcdonalds": ("Restaurant & Takeaway", "Fastfood", "McDonald's"),
    "burger king": ("Restaurant & Takeaway", "Fastfood", "Burger King"),
    "kfc": ("Restaurant & Takeaway", "Fastfood", "KFC"),
    "subway": ("Restaurant & Takeaway", "Fastfood", "Subway"),
    "pizza hut": ("Restaurant & Takeaway", "Pizza", "Pizza Hut"),
    "domino": ("Restaurant & Takeaway", "Pizza", "Domino's"),
    "starbucks": ("Restaurant & Takeaway", "Café", "Starbucks"),
    "caffè": ("Restaurant & Takeaway", "Café", "Caffè"),
    "manor restaurant": ("Restaurant & Takeaway", "Restaurant", "Manor Restaurant"),
    "tibits": ("Restaurant & Takeaway", "Restaurant", "tibits"),
    "hiltl": ("Restaurant & Takeaway", "Restaurant", "Hiltl"),
    # ── Transport ────────────────────────────────────────────
    "sbb": ("Transport", "Zug", "SBB"),
    "sbb cff ffs": ("Transport", "Zug", "SBB"),
    "bls ag": ("Transport", "Zug", "BLS"),
    "zvv": ("Transport", "ÖV", "ZVV"),
    "bvb": ("Transport", "ÖV", "BVB"),
    "tnw": ("Transport", "ÖV", "TNW"),
    "rbs": ("Transport", "Zug", "RBS"),
    "flixbus": ("Transport", "Bus", "FlixBus"),
    "eurostar": ("Transport", "Zug", "Eurostar"),
    "deutsche bahn": ("Transport", "Zug", "Deutsche Bahn"),
    "db bahn": ("Transport", "Zug", "Deutsche Bahn"),
    "postbus": ("Transport", "Bus", "PostBus"),
    "uber": ("Transport", "Taxi", "Uber"),
    "mytaxi": ("Transport", "Taxi", "myTaxi"),
    "taxi": ("Transport", "Taxi", "Taxi"),
    "mobility": ("Transport", "Carsharing", "Mobility"),
    "sharenow": ("Transport", "Carsharing", "ShareNow"),
    "bird": ("Transport", "Roller", "Bird"),
    "lime": ("Transport", "Roller", "Lime"),
    "velospot": ("Transport", "Velo-Sharing", "Velospot"),
    "nextbike": ("Transport", "Velo-Sharing", "Nextbike"),
    "shell": ("Transport", "Tankstelle", "Shell"),
    "esso": ("Transport", "Tankstelle", "Esso"),
    "agrola": ("Transport", "Tankstelle", "Agrola"),
    "avia": ("Transport", "Tankstelle", "AVIA"),
    "migrol": ("Transport", "Tankstelle", "Migrol"),
    "bp ": ("Transport", "Tankstelle", "BP"),
    "tcs": ("Transport", "Automobil-Club", "TCS"),
    "amag": ("Transport", "Autohandel", "AMAG"),
    # ── Reisen ───────────────────────────────────────────────
    "swiss air": ("Reisen", "Flug", "Swiss Air"),
    "swiss intl": ("Reisen", "Flug", "SWISS"),
    "lufthansa": ("Reisen", "Flug", "Lufthansa"),
    "easyjet": ("Reisen", "Flug", "easyJet"),
    "ryanair": ("Reisen", "Flug", "Ryanair"),
    "air france": ("Reisen", "Flug", "Air France"),
    "british airways": ("Reisen", "Flug", "British Airways"),
    "booking.com": ("Reisen", "Hotel", "Booking.com"),
    "airbnb": ("Reisen", "Unterkunft", "Airbnb"),
    "hotels.com": ("Reisen", "Hotel", "Hotels.com"),
    # ── Kommunikation (Abonnements) ───────────────────────────
    "swisscom": ("Kommunikation", "Mobil & Internet", "Swisscom"),
    "salt": ("Kommunikation", "Mobil", "Salt"),
    "sunrise": ("Kommunikation", "Mobil & Internet", "Sunrise"),
    "m-budget mobile": ("Kommunikation", "Mobil", "M-Budget Mobile"),
    "yallo": ("Kommunikation", "Mobil", "Yallo"),
    "wingo": ("Kommunikation", "Mobil", "Wingo"),
    "upc": ("Kommunikation", "Internet / TV", "UPC"),
    "vodafone": ("Kommunikation", "Mobil", "Vodafone"),
    "telenet": ("Kommunikation", "Internet", "Telenet"),
    "1und1": ("Kommunikation", "Internet", "1&1"),
    "o2": ("Kommunikation", "Mobil", "O2"),
    # ── Nebenkosten (Strom, Gas, Wasser) ─────────────────────
    "ewz": ("Nebenkosten", "Strom", "EWZ"),
    "ewb": ("Nebenkosten", "Strom/Gas", "EWB"),
    "igs": ("Nebenkosten", "Gas", "IGS"),
    "stadtwerke": ("Nebenkosten", "Energieversorger", "Stadtwerke"),
    "iwo": ("Nebenkosten", "Energieversorger", "IWO"),
    "kehrichtverwertung": ("Nebenkosten", "Abfall", "Kehrichtverwertung"),
    # ── Gesundheit & Apotheke ────────────────────────────────
    "apotheke": ("Gesundheit", "Apotheke", "Apotheke"),
    "pharmacie": ("Gesundheit", "Apotheke", "Apotheke"),
    "amavita": ("Gesundheit", "Apotheke", "Amavita"),
    "coop vitality": ("Gesundheit", "Apotheke", "Coop Vitality"),
    "sunstore": ("Gesundheit", "Apotheke", "Sun Store"),
    "docmorris": ("Gesundheit", "Online-Apotheke", "DocMorris"),
    "arzt": ("Gesundheit", "Arzt", "Arzt"),
    "zahnarzt": ("Gesundheit", "Zahnarzt", "Zahnarzt"),
    "sanitarium": ("Gesundheit", "Gesundheitsladen", "Sanitarium"),
    "fitness": ("Gesundheit", "Fitnessstudio", "Fitnessstudio"),
    "fitnesspark": ("Gesundheit", "Fitnessstudio", "FitnessPark"),
    "mcfit": ("Gesundheit", "Fitnessstudio", "McFit"),
    "urban sports": ("Gesundheit", "Sport", "Urban Sports Club"),
    # ── Versicherungen ────────────────────────────────────────
    "helsana": ("Versicherungen", "Krankenkasse", "Helsana"),
    "css versicherung": ("Versicherungen", "Krankenkasse", "CSS Versicherung"),
    "swica": ("Versicherungen", "Krankenkasse", "SWICA"),
    "concordia": ("Versicherungen", "Krankenkasse", "Concordia"),
    "sanitas": ("Versicherungen", "Krankenkasse", "Sanitas"),
    "visana": ("Versicherungen", "Krankenkasse", "Visana"),
    "zurich versicherung": ("Versicherungen", "Allgemeinversicherung", "Zurich"),
    "axa": ("Versicherungen", "Allgemeinversicherung", "AXA"),
    "allianz": ("Versicherungen", "Allgemeinversicherung", "Allianz"),
    "helvetia": ("Versicherungen", "Allgemeinversicherung", "Helvetia"),
    "baloise": ("Versicherungen", "Allgemeinversicherung", "Baloise"),
    "mobiliar": ("Versicherungen", "Allgemeinversicherung", "Die Mobiliar"),
    "vaudoise": ("Versicherungen", "Allgemeinversicherung", "Vaudoise"),
    "generali": ("Versicherungen", "Allgemeinversicherung", "Generali"),
    "suva": ("Versicherungen", "Unfallversicherung", "SUVA"),
    # ── Finanzen (Bank, Zahlung, Transfer) ────────────────────
    "postfinance": ("Finanzen", "Bank", "PostFinance"),
    "post finance": ("Finanzen", "Bank", "PostFinance"),
    "ubs ag": ("Finanzen", "Bank", "UBS"),
    "credit suisse": ("Finanzen", "Bank", "Credit Suisse"),
    "raiffeisen": ("Finanzen", "Bank", "Raiffeisen"),
    "zkb": ("Finanzen", "Bank", "Zürcher Kantonalbank"),
    "zuercher kantonalbank": ("Finanzen", "Bank", "ZKB"),
    "migros bank": ("Finanzen", "Bank", "Migros Bank"),
    "cler": ("Finanzen", "Bank", "Bank Cler"),
    "revolut": ("Finanzen", "Bank", "Revolut"),
    "wise": ("Finanzen", "Geldüberweisung", "Wise"),
    "paypal": ("Finanzen", "Zahlungsdienst", "PayPal"),
    "twint": ("Finanzen", "Zahlungsdienst", "TWINT"),
    "neon": ("Finanzen", "Bank", "Neon"),
    # ── Wohnen ────────────────────────────────────────────────
    "miete": ("Wohnen", "Miete", "Miete"),
    "nebenkosten": ("Wohnen", "Nebenkosten", "Nebenkosten"),
    "hypothek": ("Hypothek", "Hypothek", "Hypothek"),
    "hypothekarzins": ("Hypothek", "Hypothekarzins", "Hypothekarzins"),
    "amortisation": ("Hypothek", "Amortisation", "Amortisation"),
    "hausverwaltung": ("Wohnen", "Hausverwaltung", "Hausverwaltung"),
    "stwe": ("Wohnen", "Stockwerkeigentum", "STWE"),
    "stockwerkeigentum": ("Wohnen", "Stockwerkeigentum", "STWE"),
    "garage": ("Wohnen", "Garage/Parkplatz", "Garage"),
    "einstellhalle": ("Wohnen", "Garage/Parkplatz", "Einstellhalle"),
    "abwasser": ("Nebenkosten", "Abwasser", "Abwasser"),
    "kehricht": ("Nebenkosten", "Kehricht", "Kehricht"),
    "kehrrichtsack": ("Nebenkosten", "Kehricht", "Kehrichtsack"),
    "wasserwerk": ("Nebenkosten", "Wasser", "Wasserwerk"),
    "wwz": ("Nebenkosten", "Strom/Wasser", "WWZ"),
    "aew": ("Nebenkosten", "Strom", "AEW"),
    "bkw": ("Nebenkosten", "Strom", "BKW"),
    "ckw": ("Nebenkosten", "Strom", "CKW"),
    "ekz": ("Nebenkosten", "Strom", "EKZ"),
    "eniwa": ("Nebenkosten", "Energie", "Eniwa"),
    "energie wasser bern": ("Nebenkosten", "Strom/Gas", "Energie Wasser Bern"),
    # ── Shopping & Kleidung ───────────────────────────────────
    "ikea": ("Shopping", "Möbel", "IKEA"),
    "h&m": ("Shopping", "Kleidung", "H&M"),
    "zara": ("Shopping", "Kleidung", "Zara"),
    "uniqlo": ("Shopping", "Kleidung", "Uniqlo"),
    "manor": ("Shopping", "Warenhaus", "Manor"),
    "globus": ("Shopping", "Warenhaus", "Globus"),
    "fnac": ("Shopping", "Elektronik", "FNAC"),
    "digitec": ("Shopping", "Elektronik", "Digitec"),
    "interdiscount": ("Shopping", "Elektronik", "Interdiscount"),
    "mediamarkt": ("Shopping", "Elektronik", "MediaMarkt"),
    "saturn": ("Shopping", "Elektronik", "Saturn"),
    "brack": ("Shopping", "Online-Shop", "Brack"),
    "amazon": ("Shopping", "Online-Shop", "Amazon"),
    "zalando": ("Shopping", "Kleidung", "Zalando"),
    "galaxus": ("Shopping", "Online-Shop", "Galaxus"),
    "microspot": ("Shopping", "Online-Shop", "Microspot"),
    "decathlon": ("Shopping", "Sporthandel", "Decathlon"),
    "intersport": ("Shopping", "Sporthandel", "Intersport"),
    # ── Freizeit & Unterhaltung ───────────────────────────────
    "netflix": ("Freizeit & Unterhaltung", "Streaming", "Netflix"),
    "spotify": ("Freizeit & Unterhaltung", "Musik-Streaming", "Spotify"),
    "apple": ("Freizeit & Unterhaltung", "Digitale Dienste", "Apple"),
    "google": ("Freizeit & Unterhaltung", "Digitale Dienste", "Google"),
    "disney": ("Freizeit & Unterhaltung", "Streaming", "Disney+"),
    "amazon prime": ("Freizeit & Unterhaltung", "Streaming", "Amazon Prime"),
    "youtube premium": ("Freizeit & Unterhaltung", "Streaming", "YouTube Premium"),
    "twitch": ("Freizeit & Unterhaltung", "Gaming / Streaming", "Twitch"),
    "steam": ("Freizeit & Unterhaltung", "Gaming", "Steam"),
    "playstation": ("Freizeit & Unterhaltung", "Gaming", "PlayStation"),
    "nintendo": ("Freizeit & Unterhaltung", "Gaming", "Nintendo"),
    "kino": ("Freizeit & Unterhaltung", "Kino", "Kino"),
    "cinema": ("Freizeit & Unterhaltung", "Kino", "Kino"),
    # ── Bildung ───────────────────────────────────────────────
    "coursera": ("Bildung", "Online-Kurs", "Coursera"),
    "udemy": ("Bildung", "Online-Kurs", "Udemy"),
    "eth": ("Bildung", "Universität", "ETH Zürich"),
    "universitaet": ("Bildung", "Universität", "Universität"),
    "bibliothek": ("Bildung", "Bibliothek", "Bibliothek"),
    # ── Dienstleistungen (Post, Logistik) ─────────────────────
    "die post": ("Dienstleistungen", "Post", "Swiss Post"),
    "post ch": ("Dienstleistungen", "Post", "Swiss Post"),
    "dhl": ("Dienstleistungen", "Versand", "DHL"),
    "fedex": ("Dienstleistungen", "Versand", "FedEx"),
    "ups": ("Dienstleistungen", "Versand", "UPS"),
    # ── Steuern ───────────────────────────────────────────────
    "steueramt": ("Steuern", "Einkommenssteuer", "Steueramt"),
    "steuerverwaltung": ("Steuern", "Steuerbehörde", "Steuerverwaltung"),
    "ahv": ("Steuern", "Sozialversicherung", "AHV"),
    "ausgleichskasse": ("Steuern", "Sozialversicherung", "Ausgleichskasse"),
    # ── Gebühren ──────────────────────────────────────────────
    "verwaltungsgebühr": ("Gebühren", "Verwaltungsgebühr", "Verwaltungsgebühr"),
    "gebühren": ("Gebühren", "Bankgebühren", "Gebühren"),
    "kontoführungsgebühr": ("Gebühren", "Bankgebühren", "Kontoführungsgebühr"),
    "jahresgebühr": ("Gebühren", "Bankgebühren", "Jahresgebühr"),
    "kartengebühr": ("Gebühren", "Bankgebühren", "Kartengebühr"),
    "saldo dienstleistungspreisabschluss": (
        "Gebühren",
        "Bankgebühren",
        "UBS Kontogebühr",
    ),
    "dienstleistungspreisabschluss": ("Gebühren", "Bankgebühren", "UBS Kontogebühr"),
    "bankgebühr": ("Gebühren", "Bankgebühren", "Bankgebühr"),
    "depotgebühr": ("Gebühren", "Bankgebühren", "Depotgebühr"),
    # ── ÖV-Abonnemente ───────────────────────────────────────
    "halbtax": ("ÖV-Kosten", "Abonnement", "SBB Halbtax"),
    "sbb ga": ("ÖV-Kosten", "Abonnement", "SBB GA"),
    "generalabonnement": ("ÖV-Kosten", "Abonnement", "GA"),
    "zvv abonnement": ("ÖV-Kosten", "Abonnement", "ZVV Abo"),
    "ÖV-abo": ("ÖV-Kosten", "Abonnement", "ÖV-Abo"),
    # ── Säule 3A ─────────────────────────────────────────────
    "säule 3a": ("Säule 3A", "Vorsorge", "Säule 3A"),
    "pillar 3a": ("Säule 3A", "Vorsorge", "Säule 3A"),
    "3a konto": ("Säule 3A", "Vorsorge", "Säule 3A"),
    "vorsorgekonto": ("Säule 3A", "Vorsorge", "Vorsorgekonto"),
    "frankly": ("Säule 3A", "Vorsorge", "Frankly"),
    "finpension": ("Säule 3A", "Vorsorge", "Finpension"),
    "viac": ("Säule 3A", "Vorsorge", "VIAC"),
    # ── Kontoüberträge ────────────────────────────────────────
    "kontoübertrag": ("Kontoübertrag", "Kontoübertrag", "Kontoübertrag"),
    "übertrag": ("Kontoübertrag", "Kontoübertrag", "Kontoübertrag"),
    "dauerauftrag": ("Kontoübertrag", "Dauerauftrag", "Dauerauftrag"),
    "interne umbuchung": ("Kontoübertrag", "Interne Umbuchung", "Umbuchung"),
    # ── Einzahlungen ──────────────────────────────────────────
    "einzahlung": ("Einzahlungen", "Einzahlung", "Einzahlung"),
    "gutschrift": ("Einzahlungen", "Gutschrift", "Gutschrift"),
    "bareinzahlung": ("Einzahlungen", "Bareinzahlung", "Bareinzahlung"),
}

# ── Kategorie-Beschreibungen für Sentence-Transformer ─────────
# Schlüssel = Kategoriename (Deutsch), Werte = englische Keywords
# für bessere Embedding-Qualität mit all-MiniLM-L6-v2.
CATEGORY_DESCRIPTIONS = {
    "Lebensmittel": "supermarket food shopping grocery store Migros Coop Denner",
    "Restaurant & Takeaway": "restaurant cafe bar meal drink takeaway delivery McDonald's Starbucks",
    "Transport": "train bus taxi uber public transport SBB ZVV fuel car",
    "Reisen": "hotel flight airbnb booking travel vacation Lufthansa",
    "Nebenkosten": "electricity gas water sewage waste utility provider Stadtwerke",
    "Kommunikation": "mobile phone internet TV Swisscom Sunrise Salt telecom",
    "Gesundheit": "pharmacy doctor dentist hospital medicine fitness gym sport",
    "Versicherungen": "insurance premium coverage policy Helsana AXA Zurich Helvetia",
    "Finanzen": "bank transfer fee interest PayPal TWINT Revolut banking",
    "Wohnen": "rent landlord apartment deposit housing Miete Hausverwaltung Stockwerkeigentum Nebenkosten",
    "Hypothek": "mortgage Hypothek Amortisation Hypothekarzins Annuität Zinsen Hypothekarkredit",
    "Shopping": "clothing electronics furniture online retail Amazon Zalando IKEA",
    "Freizeit & Unterhaltung": "netflix spotify streaming gaming cinema subscription entertainment",
    "Bildung": "course university school tuition book education ETH",
    "Dienstleistungen": "postal shipping delivery DHL FedEx Post admin fee",
    "Steuern": "tax income tax withholding government Steueramt AHV",
    "Gehalt": "salary wage payroll employer income payment",
    "Investitionen": "dividend interest ETF stock fund investment return",
    "Einzahlungen": "deposit payment incoming credit cash deposit Einzahlung Gutschrift",
    "Gebühren": "fee charge bank fee Gebühr Kontoführung Jahresgebühr service charge",
    "Kontoübertrag": "account transfer wire Übertrag Dauerauftrag standing order internal",
    "ÖV-Kosten": "public transport subscription Halbtax GA ZVV Abonnement SBB Jahreskarte",
    "Säule 3A": "pillar 3a pension savings retirement Vorsorge frankly VIAC finpension 3. Säule",
    "Sonstiges": "miscellaneous other unknown",
}


class CategorizationService:
    """Transaction categorization pipeline."""

    def __init__(self):
        self._embedding_model = None
        self._category_embeddings = None
        self._openai_client = None
        self._model_lock = threading.Lock()

    def _get_embedding_model(self):
        """Lazy-load the sentence transformer model (thread-safe)."""
        if self._embedding_model is None:
            with self._model_lock:
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
            r"\bKARTENZAHLUNG\b",
            r"\bEINKAUF\b",
            r"\bZAHLUNG\b",
            r"\bPURCHASE\b",
            r"\bPAYMENT\b",
            r"\bTRANSACTION\b",
            r"\d{4}-\d{2}-\d{2}",
            r"\d{2}\.\d{2}\.\d{4}",
            r"CH\d{2}\s?\d{4}",
            r"IBAN:\s?[A-Z]{2}\d+",
            r"REF\.\s?NR\.?\s?[\w\-]+",
            r"AUFTRAG\s+\d+",
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
            from rapidfuzz import fuzz, process
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

    def _embedding_classify(
        self, description: str
    ) -> Optional[Tuple[str, str, str, float]]:
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
                return (
                    category,
                    "",
                    self._normalize_description(description)[:50],
                    best_score,
                )

        except Exception as e:
            logger.warning(f"Embedding classification failed: {e}")

        return None

    async def _openai_fallback(
        self, description: str
    ) -> Optional[Tuple[str, str, str, float]]:
        """Use OpenAI GPT as last resort categorizer."""
        from app.core.config import settings

        if not settings.openai_enabled:
            return None

        try:
            import openai

            if self._openai_client is None:
                self._openai_client = openai.AsyncOpenAI(
                    api_key=settings.openai_api_key
                )

            categories_list = ", ".join(CATEGORY_DESCRIPTIONS.keys())
            response = await self._openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"Du bist ein Klassifikator für Schweizer Finanztransaktionen. "
                            f"Ordne die Transaktion einer der folgenden deutschen Kategorien zu: {categories_list}. "
                            f'Antworte mit JSON: {{"category": "...", "subcategory": "...", "merchant": "..."}}. '
                            f"Kategorie und Unterkategorie auf Deutsch. Bei Unklarheit: 'Sonstiges'."
                        ),
                    },
                    {"role": "user", "content": f"Transaktion: {description}"},
                ],
                temperature=0,
                max_tokens=100,
                response_format={"type": "json_object"},
            )

            import json

            result = json.loads(response.choices[0].message.content)
            category = result.get("category", "Sonstiges")
            subcategory = result.get("subcategory", "")
            merchant = result.get("merchant", description[:50])
            return category, subcategory, merchant, 0.75

        except Exception as e:
            logger.warning(f"OpenAI fallback failed: {e}")
            return None

    @staticmethod
    def normalize_category(category: str) -> str:
        """Normalisiert einen Kategorienamen auf Deutsch (Legacy-Mapping)."""
        return EN_TO_DE_CATEGORY.get(category.lower(), category)

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
                "category": "Sonstiges",
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
            "category": "Sonstiges",
            "subcategory": "",
            "merchant_normalized": cleaned[:50] if cleaned else description[:50],
            "confidence_score": 0.1,
        }
