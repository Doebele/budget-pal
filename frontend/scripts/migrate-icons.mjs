// Einmaliges Codemod: lucide-react → iconoir-react (via @/lib/icons Adapter).
// Ersetzt Importe und benennt Icon-Identifier gemäss Mapping um.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const MAP = {
  Activity: "Activity",
  AlertCircle: "WarningCircle",
  AlertTriangle: "WarningTriangle",
  Archive: "Archive",
  ArrowDownRight: "ArrowDownRight",
  ArrowDownUp: "DataTransferBoth",
  ArrowLeftRight: "DataTransferBoth",
  ArrowRight: "ArrowRight",
  ArrowUpDown: "DataTransferBoth",
  ArrowUpRight: "ArrowUpRight",
  Banknote: "Cash",
  BarChart2: "StatsReport",
  BarChart3: "Reports",
  Bell: "Bell",
  BellRing: "BellNotification",
  Bitcoin: "BitcoinCircle",
  BookOpen: "OpenBook",
  Brain: "Brain",
  Briefcase: "Suitcase",
  Building2: "Building",
  Calendar: "Calendar",
  CalendarClock: "Calendar",
  CalendarDays: "Calendar",
  CalendarRange: "Calendar",
  Car: "Car",
  Check: "Check",
  CheckCircle2: "CheckCircle",
  CheckSquare: "CheckSquare",
  ChevronDown: "NavArrowDown",
  ChevronLeft: "NavArrowLeft",
  ChevronRight: "NavArrowRight",
  ChevronUp: "NavArrowUp",
  Clapperboard: "Movie",
  Clock: "Clock",
  Cloud: "Cloud",
  Coins: "Coins",
  CreditCard: "CreditCard",
  Database: "Database",
  DollarSign: "Dollar",
  Download: "Download",
  Edit2: "EditPencil",
  ExternalLink: "OpenNewWindow",
  Eye: "Eye",
  EyeOff: "EyeClosed",
  FileBarChart2: "StatsReport",
  FileText: "Page",
  FileUp: "PageUp",
  FlaskConical: "Flask",
  Gauge: "DashboardSpeed",
  GitMerge: "GitMerge",
  Globe: "Globe",
  GraduationCap: "GraduationCap",
  GripVertical: "Drag",
  Heart: "Heart",
  Home: "Home",
  Info: "InfoCircle",
  Landmark: "Bank",
  Layers: "Component",
  LayoutDashboard: "DashboardDots",
  LayoutGrid: "ViewGrid",
  Library: "BookStack",
  Lightbulb: "LightBulb",
  LogOut: "LogOut",
  MapPin: "MapPin",
  Menu: "Menu",
  Minus: "Minus",
  Music: "MusicDoubleNote",
  Newspaper: "Journal",
  PenLine: "EditPencil",
  Pencil: "EditPencil",
  PencilLine: "EditPencil",
  PieChart: "PercentageCircle",
  PiggyBank: "PiggyBank",
  Plane: "Airplane",
  Plus: "Plus",
  RefreshCw: "Refresh",
  Repeat: "Repeat",
  RotateCcw: "Undo",
  Save: "FloppyDisk",
  Scissors: "Scissor",
  Search: "Search",
  Settings: "Settings",
  Settings2: "Settings",
  Shield: "Shield",
  ShieldCheck: "ShieldCheck",
  ShoppingBag: "ShoppingBag",
  ShoppingCart: "Cart",
  Smartphone: "SmartphoneDevice",
  Sparkles: "Sparks",
  Square: "Square",
  Table2: "Table",
  TableProperties: "TableRows",
  Tag: "Label",
  Target: "Position",
  Train: "Train",
  Trash2: "Trash",
  TrendingDown: "GraphDown",
  TrendingUp: "GraphUp",
  Trophy: "Trophy",
  Tv: "Tv",
  Upload: "Upload",
  User: "User",
  UserMinus: "UserXmark",
  Users: "Group",
  Users2: "Community",
  Wallet: "Wallet",
  Wand2: "MagicWand",
  X: "Xmark",
};

const files = execSync("grep -rl 'lucide-react' src", { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const importRe = /import\s*\{([^}]*)\}\s*from\s*["']lucide-react["'];?/gs;

for (const file of files) {
  let src = fs.readFileSync(file, "utf8");
  const renames = new Map(); // oldName -> newName (nur wenn verschieden)
  const targets = new Set();

  src = src.replace(importRe, (_m, names) => {
    for (let raw of names.split(",")) {
      raw = raw.trim();
      if (!raw) continue;
      // "Foo as Bar" — Alias behalten, nur Quelle mappen
      const aliasMatch = raw.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        const mapped = MAP[aliasMatch[1]];
        if (!mapped) throw new Error(`Kein Mapping für ${aliasMatch[1]} in ${file}`);
        targets.add(`${mapped} as ${aliasMatch[2]}`);
        continue;
      }
      const mapped = MAP[raw];
      if (!mapped) throw new Error(`Kein Mapping für ${raw} in ${file}`);
      if (mapped !== raw) renames.set(raw, mapped);
      targets.add(mapped);
    }
    return `import { ${[...targets].sort().join(", ")} } from "@/lib/icons";`;
  });

  // Identifier ausserhalb des Imports umbenennen (word-boundary).
  for (const [from, to] of renames) {
    src = src.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }

  fs.writeFileSync(file, src);
  console.log(`${file}: ${targets.size} icons${renames.size ? `, ${renames.size} umbenannt` : ""}`);
}

// Adapter generieren: alle Ziel-Icons + Rail-Extras
const allTargets = new Set(Object.values(MAP));
for (const extra of ["SunLight", "HalfMoon", "Sofa"]) allTargets.add(extra);
const sorted = [...allTargets].sort();

// Hinweis: src/lib/icons.tsx wird seit der Erstmigration manuell gepflegt —
// hier nur noch die Export-Liste ausgeben, nicht überschreiben.
console.log(`Ziel-Icons (${sorted.length}):\n${sorted.join(", ")}`);
void fs; void path;
