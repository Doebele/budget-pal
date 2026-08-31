/**
 * Übersetzung der Katalogtexte in Step5AccordionExpenses.
 *
 * Der Anbieterkatalog ist eine Datenstruktur mit ~200 kurzen Texten (Tarifnamen,
 * Taglines, Varianten-Zusätze). Statt jedem Objektliteral ein zweites Feld zu
 * verpassen, steht hier eine Nachschlagetabelle Deutsch → Englisch. Was nicht
 * drinsteht, ist sprachneutral (Eigennamen, "Premium", "100 GB") und bleibt stehen.
 */
import i18n from "@/i18n";

const EN: Record<string, string> = {
  // ── Kategorien ──────────────────────────────────────────────
  "Streaming & TV": "Streaming & TV",
  "Video-Streaming und TV-Dienste": "Video streaming and TV services",
  "Musik": "Music",
  "Musik-Streaming Dienste": "Music streaming services",
  "Cloud & Software": "Cloud & software",
  "Cloud-Speicher und Software-Abos": "Cloud storage and software subscriptions",
  "Internet, Mobile und Festnetz": "Internet, mobile and landline",
  "Zeitungen, Magazine und Nachrichtenangebote": "Newspapers, magazines and news services",
  "Fitness & Sport": "Fitness & sport",
  "Fitnesscenter, Sport-Apps und Clubs": "Gyms, sports apps and clubs",
  "Mobilität (ÖV-Abos)": "Mobility (public transport passes)",
  "SBB und weitere ÖV-Abonnements": "SBB and other public transport passes",
  "Business & Weiterbildung": "Business & training",
  "Business-Tools, Weiterbildung und KI-Dienste": "Business tools, training and AI services",
  "Haushaltshilfe, Gartenpflege und Heimdienste": "Household help, gardening and home services",
  "Konto-, Karten- und Depotgebühren": "Account, card and custody fees",
  "Shopping & Loyalität": "Shopping & loyalty",
  "Kundenprogramme und Shopping-Abos": "Loyalty programmes and shopping subscriptions",

  // ── Taglines ────────────────────────────────────────────────
  "Serien, Filme und Dokus": "Series, films and documentaries",
  "Hi-Res Audio, für Apple-Nutzer": "Hi-res audio, for Apple users",
  "Breitband & TV von Sunrise": "Broadband & TV from Sunrise",
  "Günstiges Glasfaser-Internet": "Affordable fibre internet",
  "Bestes Netz der Schweiz": "Switzerland's best network",
  "Günstig und schnell": "Cheap and fast",
  "Günstige Alternative": "Affordable alternative",
  "Neue Zürcher Zeitung – Premium-Journalismus": "Neue Zürcher Zeitung – premium journalism",
  "Unabhängiger Qualitätsjournalismus (EN)": "Independent quality journalism (EN)",
  "Online-Workouts von Apple": "Online workouts from Apple",
  "GPS-Tracking für Läufer & Radfahrer": "GPS tracking for runners & cyclists",
  "Alle ÖV-Tickets zum halben Preis": "All public transport tickets at half price",
  "Unlimitiert Reisen in der ganzen Schweiz": "Unlimited travel across Switzerland",
  "Carsharing mit 3'000+ Autos schweizweit": "Car sharing with 3,000+ cars nationwide",
  "Karriere-Netzwerk mit erweiterten Funktionen": "Career network with advanced features",
  "Anthropic Claude mit erweitertem Kontext": "Anthropic Claude with extended context",
  "Google AI mit Gemini-Modellen": "Google AI with Gemini models",
  "KI-Editor für Entwicklung": "AI editor for development",
  "Design und Prototyping": "Design and prototyping",
  "Moonshot AI mit langem Kontext": "Moonshot AI with long context",
  "GLM-Modelle, günstiger Coding-Plan": "GLM models, affordable coding plan",
  "KI-Generierung für Bild und Video": "AI generation for image and video",
  "Monatliche Gartenpflege": "Monthly garden maintenance",
  "Abo für Heimsicherheit (z.B. Securitas)": "Home security subscription (e.g. Securitas)",
  "Konto und Karte mit Fremdwährungen": "Account and card with foreign currencies",
  "Broker mit Verrechnungskonto": "Broker with settlement account",
  "Schweizer Smartphone-Konto": "Swiss smartphone account",
  "Konto, Anlegen und Vorsorge in einer App": "Account, investing and pension in one app",
  "Digitales Konto mit Karte": "Digital account with card",
  "Erweiterte Cumulus-Vorteile + Rabattpässe": "Extended Cumulus benefits + discount passes",

  // ── Varianten und Zusätze ───────────────────────────────────
  "Standard mit Werbung": "Standard with ads",
  "Standard (Werbung)": "Standard (with ads)",
  "HD, 2 Geräte": "HD, 2 devices",
  "4K, 4 Geräte": "4K, 4 devices",
  "Nur Prime Video": "Prime Video only",
  "Prime Mitgliedschaft": "Prime membership",
  "Video + Shopping": "Video + shopping",
  "Einzeln": "Individual",
  "Einzel": "Individual",
  "Apple One Einzel": "Apple One Individual",
  "Apple One Familie": "Apple One Family",
  "Bis zu 5 Personen": "Up to 5 people",
  "Familie": "Family",
  "Familie (bis 5)": "Family (up to 5)",
  "Familie (bis 6)": "Family (up to 6)",
  "Jährlich (pro Monat)": "Annual (per month)",
  "Dolby Atmos, 360° Audio": "Dolby Atmos, 360° audio",
  "Alle Apps": "All apps",
  "Höchste Limits": "Highest limits",
  "1. Klasse": "1st class",
  "2. Klasse": "2nd class",
  "Nur Nutzungsgebühren": "Usage fees only",
  "2h/Woche": "2h/week",
  "4h/Woche": "4h/week",
  "1 Tagespauschale/Mo": "1 day rate/month",
  "Depotgebühr (geschätzt)": "Custody fee (estimated)",
  "Ordergebühren (geschätzt)": "Order fees (estimated)",
  "Personal (1 Nutzer)": "Personal (1 user)",
  "Pro (pro Nutzer)": "Pro (per user)",
  "Business+ (pro Nutzer)": "Business+ (per user)",
  "Professional (pro Platz)": "Professional (per seat)",
  "Organization (pro Platz)": "Organization (per seat)",
  "inOne home M (TV + Festnetz)": "inOne home M (TV + landline)",
  "z. B. 3 Trades/Monat": "e.g. 3 trades/month",
  "ca. CHF 25/h × 8h/Monat": "approx. CHF 25/h × 8h/month",
  "ca. CHF 25/h × 16h/Monat": "approx. CHF 25/h × 16h/month",
  "CHF 233/Jahr": "CHF 233/year",
  "CHF 239.88/Jahr": "CHF 239.88/year",
  "CHF 4'140/Jahr": "CHF 4,140/year",
  "CHF 6'780/Jahr": "CHF 6,780/year",
};

/** Übersetzt einen Katalogtext; sprachneutrale Texte bleiben unverändert. */
export function catalogText(value: string | null | undefined): string {
  if (!value) return "";
  if (i18n.language?.startsWith("de")) return value;
  return EN[value] ?? value;
}
