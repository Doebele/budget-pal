export type BankWithLogo = {
  id: string;
  name: string;
  category: "swiss" | "eu" | "us";
  logoUrl: string;
  website?: string;
};

export const BANKS_WITH_LOGOS: BankWithLogo[] = [
  // 🇨🇭 Schweizer Banken
  {
    id: "ubs",
    name: "UBS",
    category: "swiss",
    logoUrl: "/logos/ubs.svg",
    website: "https://www.ubs.com/ch/",
  },
  {
    id: "credit-suisse",
    name: "Credit Suisse",
    category: "swiss",
    logoUrl: "/logos/credit-suisse.svg",
    website: "https://www.credit-suisse.com/ch/",
  },
  {
    id: "swissquote",
    name: "Swissquote",
    category: "swiss",
    logoUrl: "/logos/swissquote.svg",
    website: "https://www.swissquote.ch",
  },
  {
    id: "postfinance",
    name: "PostFinance",
    category: "swiss",
    logoUrl: "/logos/postfinance.svg",
    website: "https://www.postfinance.ch",
  },
  {
    id: "zkb",
    name: "Zürcher Kantonalbank",
    category: "swiss",
    logoUrl: "/logos/zkb.svg",
    website: "https://www.zkb.ch",
  },
  {
    id: "raiffeisen",
    name: "Raiffeisen",
    category: "swiss",
    logoUrl: "/logos/raiffeisen.svg",
    website: "https://www.raiffeisen.ch",
  },
  {
    id: "migros-bank",
    name: "Migros Bank",
    category: "swiss",
    logoUrl: "/logos/migros-bank.svg",
    website: "https://www.migrosbank.ch",
  },
  {
    id: "bcg",
    name: "Banque Cantonale de Genève",
    category: "swiss",
    logoUrl: "/logos/bcg.svg",
    website: "https://www.bcg.ch",
  },
  {
    id: "valiant",
    name: "Valiant Bank",
    category: "swiss",
    logoUrl: "/logos/valiant.svg",
    website: "https://www.valiant.ch",
  },
  {
    id: "glarnerkb",
    name: "Glarner Kantonalbank",
    category: "swiss",
    logoUrl: "/logos/glarnerkb.svg",
    website: "https://www.gkb.ch",
  },

  // 🇪🇺 Europäische FinTechs & Banken
  {
    id: "revolut",
    name: "Revolut",
    category: "eu",
    logoUrl: "/logos/revolut.svg",
    website: "https://www.revolut.com",
  },
  {
    id: "n26",
    name: "N26",
    category: "eu",
    logoUrl: "/logos/n26.svg",
    website: "https://www.n26.com",
  },
  {
    id: "bunq",
    name: "Bunq",
    category: "eu",
    logoUrl: "/logos/bunq.svg",
    website: "https://www.bunq.com",
  },
  {
    id: "starling",
    name: "Starling Bank",
    category: "eu",
    logoUrl: "/logos/starling.svg",
    website: "https://www.starlingbank.com",
  },
  {
    id: "monzo",
    name: "Monzo",
    category: "eu",
    logoUrl: "/logos/monzo.svg",
    website: "https://www.monzo.com",
  },
  {
    id: "wise",
    name: "Wise",
    category: "eu",
    logoUrl: "/logos/wise.svg",
    website: "https://www.wise.com",
  },
  {
    id: "ing-diba",
    name: "ING DiBa",
    category: "eu",
    logoUrl: "/logos/ing.svg",
    website: "https://www.ing.de",
  },
  {
    id: "dkb",
    name: "DKB",
    category: "eu",
    logoUrl: "/logos/dkb.svg",
    website: "https://www.dkb.de",
  },
  {
    id: "commerzbank",
    name: "Commerzbank",
    category: "eu",
    logoUrl: "/logos/commerzbank.svg",
    website: "https://www.commerzbank.de",
  },
  {
    id: "santander",
    name: "Santander",
    category: "eu",
    logoUrl: "/logos/santander.svg",
    website: "https://www.santander.de",
  },
  {
    id: "barclays",
    name: "Barclays",
    category: "eu",
    logoUrl: "/logos/barclays.svg",
    website: "https://www.barclays.co.uk",
  },
  {
    id: "hsbc",
    name: "HSBC",
    category: "eu",
    logoUrl: "/logos/hsbc.svg",
    website: "https://www.hsbc.co.uk",
  },

  // 🇺🇸 US-Anbieter & Neobanks
  {
    id: "chime",
    name: "Chime",
    category: "us",
    logoUrl: "/logos/chime.svg",
    website: "https://www.chime.com",
  },
  {
    id: "capital-one",
    name: "Capital One",
    category: "us",
    logoUrl: "/logos/capital-one.svg",
    website: "https://www.capitalone.com",
  },
  {
    id: "sofi",
    name: "SoFi",
    category: "us",
    logoUrl: "/logos/sofi.svg",
    website: "https://www.sofi.com",
  },
  {
    id: "ally",
    name: "Ally Bank",
    category: "us",
    logoUrl: "/logos/ally.svg",
    website: "https://www.ally.com",
  },
  {
    id: "discover",
    name: "Discover",
    category: "us",
    logoUrl: "/logos/discover.svg",
    website: "https://www.discover.com",
  },
  {
    id: "schwab",
    name: "Charles Schwab",
    category: "us",
    logoUrl: "/logos/schwab.svg",
    website: "https://www.schwab.com",
  },
  {
    id: "fidelity",
    name: "Fidelity",
    category: "us",
    logoUrl: "/logos/fidelity.svg",
    website: "https://www.fidelity.com",
  },
  {
    id: "wells-fargo",
    name: "Wells Fargo",
    category: "us",
    logoUrl: "/logos/wells-fargo.svg",
    website: "https://www.wellsfargo.com",
  },
  {
    id: "bank-of-america",
    name: "Bank of America",
    category: "us",
    logoUrl: "/logos/bank-of-america.svg",
    website: "https://www.bankofamerica.com",
  },
  {
    id: "chase",
    name: "Chase",
    category: "us",
    logoUrl: "/logos/chase.svg",
    website: "https://www.chase.com",
  },
  {
    id: "citibank",
    name: "Citibank",
    category: "us",
    logoUrl: "/logos/citibank.svg",
    website: "https://www.citi.com",
  },

  // 🌐 Globale Krypto-Börsen & Broker
  {
    id: "interactive-brokers",
    name: "Interactive Brokers",
    category: "us",
    logoUrl: "/logos/interactive-brokers.svg",
    website: "https://www.interactivebrokers.com",
  },
  {
    id: "degiro",
    name: "DEGIRO",
    category: "eu",
    logoUrl: "/logos/degiro.svg",
    website: "https://www.degiro.com",
  },
];

export const getBankCategoryLabel = (category: string) => {
  switch (category) {
    case "swiss":
      return "🇨🇭 Schweiz";
    case "eu":
      return "🇪🇺 Europa";
    case "us":
      return "🇺🇸 USA";
    default:
      return category;
  }
};

export const getBankById = (id: string): BankWithLogo | undefined => {
  return BANKS_WITH_LOGOS.find((bank) => bank.id === id);
};

export const getBankByName = (name: string): BankWithLogo | undefined => {
  return BANKS_WITH_LOGOS.find(
    (bank) => bank.name.toLowerCase() === name.toLowerCase()
  );
};
